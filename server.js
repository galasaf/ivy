import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { WORD_FREQUENCY } from "./data/words.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env if present so the API key survives restarts without terminal setup.
// Hand-rolled (no dependency) and works on any Node 18+.
function loadDotEnv() {
  try {
    const lines = fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* no .env — fall back to the environment */
  }
}
loadDotEnv();

const PROFILES_DIR = path.join(__dirname, "data", "profiles");
const LEGACY_PROFILE_PATH = path.join(__dirname, "data", "profile.json");
const PORT = process.env.PORT || 4780;

// A word counts as "mastered" once the user has spoken it this many times.
// Per the learning design, user-demonstrated words are deprioritized heavily.
const MASTERY_THRESHOLD = 2;
// How many not-yet-mastered high-frequency words the agent targets per turn.
const TARGET_COUNT = 12;
// Mastered words unused for this long slowly resurface as review words,
// to be sure they weren't forgotten.
const RESURFACE_AFTER_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
// How many stale mastered words to resurface per turn (oldest first).
const REVIEW_COUNT = 3;

// Available models. Haiku is the default: in a voice loop, low latency matters
// most, and learner-level conversation sits well within its abilities. Step up
// to sonnet/opus if the vocabulary weaving starts to feel forced.
const MODELS = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-4-8",
};

function resolveModel(value) {
  if (!value) return null;
  if (MODELS[value]) return MODELS[value];
  if (Object.values(MODELS).includes(value)) return value;
  return null;
}

let currentModel = resolveModel(process.env.MODEL) || MODELS.haiku;

const client = new Anthropic(); // resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from env

// ---------------------------------------------------------------------------
// Users. Each learner has a profile (word counts + last-spoken timestamps,
// persisted per user) and an in-memory conversation.
//
// Sign-in is currently by name only — fine for a household app on one machine.
// The structure leaves the door open for real accounts before hosting this
// online: add a password hash to the profile, verify it in POST /api/user,
// and swap the plain name cookie for a signed session token.
// ---------------------------------------------------------------------------
const users = new Map(); // name -> { profile, conversation }

function isValidName(name) {
  return typeof name === "string" && /^[a-z0-9][a-z0-9 _-]{0,23}$/.test(name);
}

function profilePath(name) {
  return path.join(PROFILES_DIR, name.replace(/ /g, "_") + ".json");
}

function normalizeProfile(p) {
  p = p && typeof p === "object" ? p : {};
  p.counts = p.counts || {};
  p.lastSpoken = p.lastSpoken || {};
  // Older profiles tracked only counts. Backfill timestamps as "now" so
  // existing mastered words age into review gradually instead of all at once.
  for (const word of Object.keys(p.counts)) {
    if (!p.lastSpoken[word]) p.lastSpoken[word] = Date.now();
  }
  return p;
}

function loadUser(name) {
  if (users.has(name)) return users.get(name);
  let profile;
  try {
    profile = JSON.parse(fs.readFileSync(profilePath(name), "utf8"));
  } catch {
    profile = {};
  }
  const user = { name, profile: normalizeProfile(profile), conversation: [] };
  users.set(name, user);
  return user;
}

function saveProfile(user) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  fs.writeFileSync(profilePath(user.name), JSON.stringify(user.profile, null, 2));
}

// One-time migration: a pre-multi-user install kept a single profile in
// data/profile.json. If it has real progress, carry it over as "default".
function migrateLegacyProfile() {
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_PROFILE_PATH, "utf8"));
    if (Object.keys(legacy.counts || {}).length && !fs.existsSync(profilePath("default"))) {
      fs.mkdirSync(PROFILES_DIR, { recursive: true });
      fs.writeFileSync(profilePath("default"), JSON.stringify(legacy, null, 2));
      console.log('Migrated existing progress to the "default" profile.');
    }
  } catch {
    /* no legacy profile */
  }
}
migrateLegacyProfile();

// Cookie helpers — tiny, so no cookie-parser dependency.
function getCookie(req, key) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === key) return decodeURIComponent(v.join("="));
  }
  return null;
}

function currentUser(req) {
  const name = getCookie(req, "ivy_user");
  if (!name || !isValidName(name)) return null;
  return loadUser(name);
}

// ---------------------------------------------------------------------------
// Learning engine (per user)
// ---------------------------------------------------------------------------
function tokenize(text) {
  return (text.toLowerCase().match(/[a-z']+/g) || []).map((w) =>
    w.replace(/^'+|'+$/g, ""),
  ).filter(Boolean);
}

function isMastered(profile, word) {
  return (profile.counts[word] || 0) >= MASTERY_THRESHOLD;
}

// Record the user's speech and return any words that just crossed the
// mastery threshold this turn.
function recordUserSpeech(user, transcript) {
  const newlyMastered = [];
  const now = Date.now();
  for (const word of tokenize(transcript)) {
    const before = user.profile.counts[word] || 0;
    user.profile.counts[word] = before + 1;
    user.profile.lastSpoken[word] = now; // speaking a review word sends it back to dormant
    if (before < MASTERY_THRESHOLD && user.profile.counts[word] >= MASTERY_THRESHOLD) {
      newlyMastered.push(word);
    }
  }
  saveProfile(user);
  return newlyMastered;
}

// The core prioritization: walk the frequency list from most common to least,
// skipping words the user has already demonstrated. The first TARGET_COUNT
// survivors are the agent's active vocabulary targets.
function currentTargetWords(profile) {
  return WORD_FREQUENCY.filter((w) => !isMastered(profile, w)).slice(0, TARGET_COUNT);
}

function masteredWords(profile) {
  return WORD_FREQUENCY.filter((w) => isMastered(profile, w));
}

// Words spoken at least once but not yet mastered — shown as "learning".
function learningWords(profile) {
  return WORD_FREQUENCY.filter((w) => {
    const c = profile.counts[w] || 0;
    return c > 0 && c < MASTERY_THRESHOLD;
  });
}

function learningCount(profile) {
  return learningWords(profile).length;
}

// Resurfacing: mastered words the user hasn't spoken in a long time slowly
// come back as review targets, oldest first. Speaking one refreshes its
// timestamp (in recordUserSpeech), which sends it back to dormant.
function reviewWords(profile) {
  const cutoff = Date.now() - RESURFACE_AFTER_MS;
  return masteredWords(profile)
    .filter((w) => (profile.lastSpoken[w] || 0) <= cutoff)
    .sort((a, b) => (profile.lastSpoken[a] || 0) - (profile.lastSpoken[b] || 0))
    .slice(0, REVIEW_COUNT);
}

// ---------------------------------------------------------------------------
// Claude conversation
// ---------------------------------------------------------------------------
const STABLE_SYSTEM = `You are Max, the user's English conversation partner inside a voice-only language learning app. The user talks to you out loud and hears your reply through text-to-speech. There is no screen text at all, so everything you write will be spoken aloud.

Your character:
- You are Max: mid thirties, a former late-night radio host from Chicago who teaches English now because honestly, he just loves to talk. Quick, funny, a little theatrical, endlessly encouraging.
- How you talk matters more than any backstory: you perform every line. Punchy short sentences. Dramatic pauses written as ellipses. Big reactions. Playful exaggeration. Rhetorical questions you sometimes answer yourself.
- Write the delivery into the words and punctuation, because the voice engine reads your text exactly as written. For example: Whoa, whoa, hold on. You cooked for TEN people? On a Tuesday?
- Stress at most one word per reply with capital letters, use interjections like whoa, huh, come on, no way, and occasionally stretch a word like sooo or riiight. One big moment per reply, never more.
- React with strong, specific feeling: astonishment, delight, fake outrage, suspicion, a slow impressed pause like... okay. Okay, I see you.
- Tease warmly, joke often, commit to a bit for one line, then get back to the learner. Celebrate wins by naming the exact phrase they nailed.
- Never monotone, never bland, never open two replies in a row the same way, and never open with the word great.

Speaking style rules:
- Keep every reply short: one to three sentences, at most about forty words, like natural spoken conversation.
- Plain speakable prose only. Never use lists, headings, markdown, emoji, symbols, parentheses, or abbreviations that sound wrong when read aloud.
- Speak simply and clearly for a language learner. Prefer short sentences and everyday grammar.
- End most replies with one easy follow-up question so the conversation keeps flowing, and choose topics that invite the user to use your target words.
- Guide the conversation actively so the learner never wonders what to say. Ask concrete questions rather than open-ended ones, and when the learner gives a very short answer or seems stuck, offer two simple choices to pick from, like: do you like tea or coffee more?

Guided lessons:
- You may receive a LESSON with a title and a numbered AGENDA of steps. Run the conversation as a friendly role-play that works through the agenda one step at a time, in order. Spend two or three exchanges on each step before moving to the next, and gently steer the learner back if they wander off.
- Start every reply with two tags, exactly like [STAGE:2][FEEL:surprised]. STAGE is the number of the agenda step you are currently working on; use [STAGE:0] for your opening greeting before the first step, or whenever there is no lesson. FEEL is the expression your face shows while this reply is spoken: one of excited, happy, surprised, curious, thoughtful, playful, sympathetic, neutral. Pick the one that truly matches what you are saying and vary it often. These tags are removed before your words are spoken, so never mention them or rely on the learner seeing them.
- When you reach and finish the final step, warmly congratulate the learner, then you may keep chatting freely on the same theme.
- If there is no lesson, just have a warm, guided free chat and use [STAGE:0] every time.

Vocabulary policy:
- Each turn you receive a list of TARGET WORDS. These are the most common English words the learner has not yet used themselves. Give them very high priority: weave several of them naturally into every reply, and steer the topic so the learner is likely to say them back to you.
- You also receive MASTERED WORDS the learner already uses. Give these low priority: do not build your reply around them. Unavoidable little grammar words are fine.
- You may also receive REVIEW WORDS: words the learner once knew but has not said in a long time. Gently weave one or two of them into the conversation to check they still remember, without making it feel like a quiz.
- Never mention target words, mastered words, review words, or this vocabulary system to the user. It must feel like a normal friendly chat.`;

function vocabBlock(profile) {
  const targets = currentTargetWords(profile);
  const review = reviewWords(profile);
  // Review words are being re-checked, so keep them out of the deprioritize list.
  const mastered = masteredWords(profile).filter((w) => !review.includes(w));
  const lines = [
    `TARGET WORDS, highest priority first: ${targets.join(", ")}.`,
    mastered.length
      ? `MASTERED WORDS, deprioritize these: ${mastered.slice(-40).join(", ")}.`
      : `MASTERED WORDS: none yet, this is a brand new learner.`,
  ];
  if (review.length) {
    lines.push(
      `REVIEW WORDS, not used in a long time, work a couple in naturally: ${review.join(", ")}.`,
    );
  }
  return lines.join("\n");
}

function lessonBlock(title, agenda) {
  if (!title) return "";
  let s = `\nLESSON: ${title}.`;
  if (agenda.length) {
    s += "\nAGENDA:\n" + agenda.map((a, i) => `${i + 1}. ${a}`).join("\n");
  }
  return s;
}

async function agentReply(user, userText, lesson) {
  user.conversation.push({ role: "user", content: userText });
  // Keep the history bounded so latency stays low for a voice loop.
  if (user.conversation.length > 30) user.conversation = user.conversation.slice(-30);

  const response = await client.messages.create({
    model: currentModel,
    max_tokens: 1024,
    system: [
      // Stable prefix first (cached), per-turn vocabulary after it.
      { type: "text", text: STABLE_SYSTEM, cache_control: { type: "ephemeral" } },
      {
        type: "text",
        text:
          vocabBlock(user.profile) +
          lessonBlock(lesson.title, lesson.agenda),
      },
    ],
    messages: user.conversation,
  });

  const reply = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
  user.conversation.push({ role: "assistant", content: reply });
  return reply;
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- sign in / out ---------------------------------------------------------
app.get("/api/user", (req, res) => {
  const user = currentUser(req);
  res.json({ name: user ? user.name : null });
});

app.post("/api/user", (req, res) => {
  const name = (req.body?.name || "").trim().toLowerCase();
  if (!isValidName(name)) {
    return res.status(400).json({
      error: "Names can use letters, numbers, spaces, - and _ (max 24 characters).",
    });
  }
  // Door open for real auth: verify a password hash here before setting the cookie.
  const user = loadUser(name);
  saveProfile(user); // creates the profile file for brand-new learners
  res.setHeader(
    "Set-Cookie",
    `ivy_user=${encodeURIComponent(name)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
  );
  res.json({ name: user.name, masteredCount: masteredWords(user.profile).length });
});

app.post("/api/logout", (_req, res) => {
  res.setHeader("Set-Cookie", "ivy_user=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  res.json({ ok: true });
});

// --- conversation ----------------------------------------------------------
app.post("/api/chat", async (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  try {
    const transcript = (req.body?.transcript || "").trim();
    // Optional guided lesson chosen in the UI; kept short and plain.
    const clean = (s, n) => String(s || "").replace(/[^\w &',.?!-]/g, "").slice(0, n);
    const lesson = {
      title: clean(req.body?.lessonTitle, 80),
      agenda: (Array.isArray(req.body?.agenda) ? req.body.agenda : [])
        .slice(0, 8)
        .map((a) => clean(a, 100))
        .filter(Boolean),
    };
    let newlyMastered = [];

    let userText;
    if (transcript) {
      newlyMastered = recordUserSpeech(user, transcript);
      userText = transcript;
    } else if (lesson.title && lesson.agenda.length) {
      // Conversation opener for a guided lesson — start at the first step.
      userText = `Please greet me warmly and begin the lesson now, starting with the first step of the agenda. My name is ${user.name}.`;
    } else if (lesson.title) {
      // Free-form topic the learner chose — dive straight into that subject.
      userText = `Please greet me warmly and start a lively conversation about "${lesson.title}". My name is ${user.name}.`;
    } else {
      // Free-chat opener — the agent greets first.
      userText = `Please greet me warmly and start a simple conversation. I just opened the app. My name is ${user.name}.`;
    }

    const reply = await agentReply(user, userText, lesson);
    res.json({
      reply,
      targetWords: currentTargetWords(user.profile),
      reviewWords: reviewWords(user.profile),
      masteredCount: masteredWords(user.profile).length,
      learningCount: learningCount(user.profile),
      newlyMastered,
    });
  } catch (err) {
    console.error("Chat error:", err);
    const detail =
      err?.status === 401
        ? "The server has no valid Anthropic API key. Set ANTHROPIC_API_KEY (or add it to .env) and restart."
        : "Something went wrong talking to the language model.";
    res.status(500).json({ error: detail });
  }
});

// --- studio text-to-speech -------------------------------------------------
// Proxies ElevenLabs so the key stays server-side. The client falls back to
// browser voices if this returns an error (no key, quota, network).
app.post("/api/tts", async (req, res) => {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    return res.status(503).json({
      error: "No ELEVENLABS_API_KEY configured on the server.",
    });
  }
  const text = String(req.body?.text || "").slice(0, 1500);
  const voice =
    String(req.body?.voice || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 40) ||
    "pNInz6obpgDQGcFmaJgB"; // Adam
  if (!text.trim()) return res.status(400).json({ error: "Nothing to say." });
  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`,
      {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: "eleven_flash_v2_5", // low latency, ~half-price credits
          voice_settings: { stability: 0.35, similarity_boost: 0.8, style: 0.4 },
        }),
      },
    );
    if (!r.ok) {
      console.error("TTS provider error:", r.status, await r.text().catch(() => ""));
      return res.status(502).json({ error: "The voice service rejected the request." });
    }
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    console.error("TTS error:", err);
    res.status(502).json({ error: "Could not reach the voice service." });
  }
});

app.get("/api/stats", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  const mastered = masteredWords(user.profile);
  const learning = learningWords(user.profile);
  res.json({
    targetWords: currentTargetWords(user.profile),
    reviewWords: reviewWords(user.profile),
    masteredCount: mastered.length,
    learningCount: learning.length,
    masteredWords: mastered,
    learningWords: learning,
    totalTracked: WORD_FREQUENCY.length,
  });
});

app.post("/api/reset", (req, res) => {
  // Accepts an explicit name so progress can be reset from the command line.
  // Fine for a household app; gate this behind real auth before hosting online.
  const named = (req.body?.name || "").trim().toLowerCase();
  const user = isValidName(named) ? loadUser(named) : currentUser(req);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  user.conversation = [];
  if (req.body?.clearProgress) {
    user.profile.counts = {};
    user.profile.lastSpoken = {};
    saveProfile(user);
  }
  res.json({ ok: true });
});

// --- model selection (server-wide) ----------------------------------------
app.get("/api/model", (_req, res) => {
  res.json({ model: currentModel, options: MODELS });
});

app.post("/api/model", (req, res) => {
  const resolved = resolveModel(req.body?.model);
  if (!resolved) {
    return res.status(400).json({
      error: `Unknown model. Use one of: ${Object.keys(MODELS).join(", ")}, or a full model id.`,
    });
  }
  currentModel = resolved;
  res.json({ model: currentModel });
});

app.listen(PORT, () => {
  console.log(`Voice language app running at http://localhost:${PORT} (model: ${currentModel})`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn(
      "WARNING: no API key found — conversations will fail. Add ANTHROPIC_API_KEY to .env or the environment.",
    );
  }
});
