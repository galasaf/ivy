// Static (GitHub Pages) build of Ivy: the whole app runs in the browser.
// The learning engine lives here, progress is kept in localStorage, and the
// Claude API is called directly with the visitor's own key.
//
// Voice-only conversation loop:
//   listen (speech recognition) -> think (Claude) ->
//   speak (speech synthesis + avatar lip animation) -> listen again.

import { WORD_FREQUENCY } from "./words.js";

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const avatarWrap = document.getElementById("avatarWrap");
const mouth = document.getElementById("mouth");
const smile = document.getElementById("smile");
const masteredCountEl = document.getElementById("masteredCount");
const modelSelect = document.getElementById("modelSelect");
const loginOverlay = document.getElementById("loginOverlay");
const loginForm = document.getElementById("loginForm");
const loginName = document.getElementById("loginName");
const loginError = document.getElementById("loginError");
const userChip = document.getElementById("userChip");
const userNameEl = document.getElementById("userName");
const switchUserBtn = document.getElementById("switchUserBtn");
const keyOverlay = document.getElementById("keyOverlay");
const keyForm = document.getElementById("keyForm");
const keyInput = document.getElementById("keyInput");
const keyError = document.getElementById("keyError");
const changeKeyBtn = document.getElementById("changeKeyBtn");

// Optional shared-access proxy (see proxy/ivy-proxy.php in the repo): a PHP
// endpoint that holds the owner's API key server-side behind a passphrase.
// Leave empty to require every visitor to bring their own key.
const PROXY_URL = "https://asafgal.com/ivy/ivy-proxy.php";

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

let running = false;
let recognition = null;
let mouthTimer = null;
let preferredVoice = null;

// ---------------------------------------------------------------------------
// Learning engine (ported from server.js; see the repo README for the design)
// ---------------------------------------------------------------------------
const MASTERY_THRESHOLD = 2;
const TARGET_COUNT = 12;
const RESURFACE_AFTER_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const REVIEW_COUNT = 3;

let currentUser = null; // { name, profile: {counts, lastSpoken} }
let conversation = [];

function profileKey(name) {
  return `ivy_profile_${name}`;
}

function loadProfile(name) {
  let p;
  try {
    p = JSON.parse(localStorage.getItem(profileKey(name))) || {};
  } catch {
    p = {};
  }
  p.counts = p.counts || {};
  p.lastSpoken = p.lastSpoken || {};
  for (const word of Object.keys(p.counts)) {
    if (!p.lastSpoken[word]) p.lastSpoken[word] = Date.now();
  }
  return p;
}

function saveProfile() {
  localStorage.setItem(profileKey(currentUser.name), JSON.stringify(currentUser.profile));
}

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z']+/g) || []).map((w) =>
    w.replace(/^'+|'+$/g, ""),
  ).filter(Boolean);
}

function isMastered(word) {
  return (currentUser.profile.counts[word] || 0) >= MASTERY_THRESHOLD;
}

function recordUserSpeech(transcript) {
  const now = Date.now();
  for (const word of tokenize(transcript)) {
    currentUser.profile.counts[word] = (currentUser.profile.counts[word] || 0) + 1;
    currentUser.profile.lastSpoken[word] = now;
  }
  saveProfile();
}

function currentTargetWords() {
  return WORD_FREQUENCY.filter((w) => !isMastered(w)).slice(0, TARGET_COUNT);
}

function masteredWords() {
  return WORD_FREQUENCY.filter(isMastered);
}

function reviewWords() {
  const cutoff = Date.now() - RESURFACE_AFTER_MS;
  return masteredWords()
    .filter((w) => (currentUser.profile.lastSpoken[w] || 0) <= cutoff)
    .sort(
      (a, b) =>
        (currentUser.profile.lastSpoken[a] || 0) -
        (currentUser.profile.lastSpoken[b] || 0),
    )
    .slice(0, REVIEW_COUNT);
}

// ---------------------------------------------------------------------------
// Claude conversation (direct browser -> Anthropic API with the user's key)
// ---------------------------------------------------------------------------
const STABLE_SYSTEM = `You are Ivy, a warm and friendly English conversation partner inside a voice-only language learning app. The user talks to you out loud and hears your reply through text-to-speech. There is no screen text at all, so everything you write will be spoken aloud.

Speaking style rules:
- Keep every reply short: one to three sentences, at most about forty words, like natural spoken conversation.
- Plain speakable prose only. Never use lists, headings, markdown, emoji, symbols, parentheses, or abbreviations that sound wrong when read aloud.
- Speak simply and clearly for a language learner. Prefer short sentences and everyday grammar.
- End most replies with one easy follow-up question so the conversation keeps flowing, and choose topics that invite the user to use your target words.

Vocabulary policy:
- Each turn you receive a list of TARGET WORDS. These are the most common English words the learner has not yet used themselves. Give them very high priority: weave several of them naturally into every reply, and steer the topic so the learner is likely to say them back to you.
- You also receive MASTERED WORDS the learner already uses. Give these low priority: do not build your reply around them. Unavoidable little grammar words are fine.
- You may also receive REVIEW WORDS: words the learner once knew but has not said in a long time. Gently weave one or two of them into the conversation to check they still remember, without making it feel like a quiz.
- Never mention target words, mastered words, review words, or this vocabulary system to the user. It must feel like a normal friendly chat.`;

function vocabBlock() {
  const targets = currentTargetWords();
  const review = reviewWords();
  const mastered = masteredWords().filter((w) => !review.includes(w));
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

function hasAccess() {
  return Boolean(
    localStorage.getItem("ivy_api_key") ||
      (PROXY_URL && localStorage.getItem("ivy_passphrase")),
  );
}

async function agentReply(userText) {
  conversation.push({ role: "user", content: userText });
  if (conversation.length > 30) conversation = conversation.slice(-30);

  const system = [
    { type: "text", text: STABLE_SYSTEM, cache_control: { type: "ephemeral" } },
    { type: "text", text: vocabBlock() },
  ];

  const personalKey = localStorage.getItem("ivy_api_key");
  let res;
  if (personalKey) {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": personalKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: modelSelect.value,
        max_tokens: 1024,
        system,
        messages: conversation,
      }),
    });
  } else {
    res = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        passphrase: localStorage.getItem("ivy_passphrase") || "",
        model: modelSelect.value,
        system,
        messages: conversation,
      }),
    });
  }

  if (res.status === 401 || res.status === 403) {
    const what = personalKey ? "API key" : "passphrase";
    showKeyOverlay(`That ${what} was rejected. Please check it and try again.`);
    throw new Error(`Your ${what} was rejected. Please enter it again.`);
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail?.error?.message || "Something went wrong talking to Claude.");
  }

  const data = await res.json();
  const reply = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
  conversation.push({ role: "assistant", content: reply });
  return reply;
}

async function sendToAgent(transcript) {
  setState("thinking", "Ivy is thinking…");
  let userText;
  if (transcript) {
    recordUserSpeech(transcript);
    userText = transcript;
  } else {
    userText = `Please greet me warmly and start a simple conversation. I just opened the app. My name is ${currentUser.name}.`;
  }
  const reply = await agentReply(userText);
  masteredCountEl.textContent = masteredWords().length;
  return reply;
}

// ---------------------------------------------------------------------------
// UI state helpers
// ---------------------------------------------------------------------------
function setState(state, message) {
  avatarWrap.classList.remove("listening", "thinking", "speaking");
  if (state) avatarWrap.classList.add(state);
  statusEl.textContent = message;
}

function setIdleFace() {
  mouth.setAttribute("ry", "3");
  smile.setAttribute("stroke-width", "4");
}

function startMouthAnimation() {
  smile.setAttribute("stroke-width", "0");
  stopMouthAnimation();
  mouthTimer = setInterval(() => {
    // Randomized mouth opening approximates natural lip movement.
    const openness = 2 + Math.random() * 11;
    const width = 13 + Math.random() * 5;
    mouth.setAttribute("ry", openness.toFixed(1));
    mouth.setAttribute("rx", width.toFixed(1));
  }, 85);
}

function stopMouthAnimation() {
  if (mouthTimer) clearInterval(mouthTimer);
  mouthTimer = null;
  mouth.setAttribute("rx", "16");
  setIdleFace();
}

// ---------------------------------------------------------------------------
// Text to speech
// ---------------------------------------------------------------------------
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  const preferredNames = [
    "Microsoft Aria Online (Natural) - English (United States)",
    "Microsoft Jenny Online (Natural) - English (United States)",
    "Google US English",
    "Microsoft Zira - English (United States)",
  ];
  for (const name of preferredNames) {
    const v = voices.find((v) => v.name === name);
    if (v) return v;
  }
  return (
    voices.find((v) => v.lang === "en-US") ||
    voices.find((v) => v.lang.startsWith("en")) ||
    voices[0]
  );
}

speechSynthesis.onvoiceschanged = () => {
  preferredVoice = pickVoice();
};

function speak(text) {
  return new Promise((resolve) => {
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    if (!preferredVoice) preferredVoice = pickVoice();
    if (preferredVoice) utterance.voice = preferredVoice;
    utterance.rate = 0.95;
    utterance.pitch = 1.05;

    utterance.onstart = () => {
      setState("speaking", "Ivy is speaking…");
      startMouthAnimation();
    };
    const finish = () => {
      stopMouthAnimation();
      resolve();
    };
    utterance.onend = finish;
    utterance.onerror = finish;

    speechSynthesis.speak(utterance);
  });
}

// ---------------------------------------------------------------------------
// Speech recognition
// ---------------------------------------------------------------------------
function listenOnce() {
  return new Promise((resolve, reject) => {
    recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    let gotResult = false;

    recognition.onstart = () => setState("listening", "Listening… your turn to talk");
    recognition.onresult = (event) => {
      gotResult = true;
      resolve(event.results[0][0].transcript);
    };
    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") {
        if (!gotResult) resolve(null); // silence — just listen again
      } else {
        reject(new Error(event.error));
      }
    };
    recognition.onend = () => {
      if (!gotResult) resolve(null);
    };

    recognition.start();
  });
}

// ---------------------------------------------------------------------------
// Conversation loop
// ---------------------------------------------------------------------------
async function conversationLoop() {
  // Agent greets first.
  try {
    const greeting = await sendToAgent("");
    if (!running) return;
    await speak(greeting);
  } catch (err) {
    await handleError(err);
    return;
  }

  while (running) {
    let transcript;
    try {
      transcript = await listenOnce();
    } catch (err) {
      await handleError(err);
      return;
    }
    if (!running) return;
    if (!transcript || !transcript.trim()) continue; // silence — listen again

    try {
      const reply = await sendToAgent(transcript);
      if (!running) return;
      await speak(reply);
    } catch (err) {
      await handleError(err);
      return;
    }
  }
}

async function handleError(err) {
  console.error(err);
  stopMouthAnimation();
  const message =
    err.message === "not-allowed"
      ? "Microphone access was blocked. Allow the microphone and press start."
      : err.message || "Something went wrong.";
  setState(null, message);
  await speak("Sorry, something went wrong. " + message);
  stopConversation(true);
}

function stopConversation(keepStatus = false) {
  running = false;
  if (recognition) {
    try { recognition.abort(); } catch { /* already stopped */ }
  }
  speechSynthesis.cancel();
  stopMouthAnimation();
  startBtn.hidden = false;
  stopBtn.hidden = true;
  if (!keepStatus) setState(null, "Conversation ended. Press start to talk again.");
}

startBtn.addEventListener("click", () => {
  if (!SpeechRecognition) {
    setState(null, "This browser does not support speech recognition. Please use Chrome or Edge.");
    return;
  }
  if (!hasAccess()) {
    showKeyOverlay();
    return;
  }
  running = true;
  startBtn.hidden = true;
  stopBtn.hidden = false;
  conversationLoop();
});

stopBtn.addEventListener("click", () => stopConversation());

// ---------------------------------------------------------------------------
// API key management — stored only in this browser.
// ---------------------------------------------------------------------------
function showKeyOverlay(errorMessage) {
  stopConversation(true);
  if (PROXY_URL) {
    document.getElementById("keyHelp").innerHTML =
      'Enter the <strong>shared passphrase</strong> if you were given one, or your own Anthropic API key (<a href="https://platform.claude.com" target="_blank" rel="noopener">get one here</a>). Either is stored only in this browser.';
    keyInput.placeholder = "Passphrase or sk-ant-...";
  }
  keyOverlay.hidden = false;
  keyError.hidden = !errorMessage;
  if (errorMessage) keyError.textContent = errorMessage;
  keyInput.focus();
}

keyForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const value = keyInput.value.trim();
  if (value.startsWith("sk-ant-")) {
    localStorage.setItem("ivy_api_key", value);
    localStorage.removeItem("ivy_passphrase");
  } else if (PROXY_URL && value) {
    // Not a key — treat it as the shared-access passphrase.
    localStorage.setItem("ivy_passphrase", value);
    localStorage.removeItem("ivy_api_key");
  } else {
    keyError.textContent = "That doesn't look like an Anthropic key (should start with sk-ant-).";
    keyError.hidden = false;
    return;
  }
  keyInput.value = "";
  keyOverlay.hidden = true;
  setState(null, "Press start to begin talking");
});

changeKeyBtn.addEventListener("click", () => showKeyOverlay());

// ---------------------------------------------------------------------------
// Sign in — each learner has their own remembered vocabulary (per browser).
// ---------------------------------------------------------------------------
function isValidName(name) {
  return /^[a-z0-9][a-z0-9 _-]{0,23}$/.test(name);
}

function showLogin() {
  stopConversation(true);
  loginOverlay.hidden = false;
  userChip.hidden = true;
  loginName.focus();
}

function showSignedIn(name) {
  currentUser = { name, profile: loadProfile(name) };
  conversation = [];
  loginOverlay.hidden = true;
  loginError.hidden = true;
  userNameEl.textContent = name;
  userChip.hidden = false;
  masteredCountEl.textContent = masteredWords().length;
}

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = loginName.value.trim().toLowerCase();
  if (!isValidName(name)) {
    loginError.textContent = "Names can use letters, numbers, spaces, - and _ (max 24 characters).";
    loginError.hidden = false;
    return;
  }
  localStorage.setItem("ivy_user", name);
  showSignedIn(name);
  if (!hasAccess()) showKeyOverlay();
  else setState(null, "Press start to begin talking");
});

switchUserBtn.addEventListener("click", () => {
  localStorage.removeItem("ivy_user");
  loginName.value = "";
  showLogin();
});

// Model choice persists per browser.
modelSelect.value = localStorage.getItem("ivy_model") || "claude-haiku-4-5";
if (!modelSelect.value) modelSelect.value = "claude-haiku-4-5";
modelSelect.addEventListener("change", () => {
  localStorage.setItem("ivy_model", modelSelect.value);
});

// On load: restore the remembered learner, or ask who's practicing.
const rememberedUser = localStorage.getItem("ivy_user");
if (rememberedUser && isValidName(rememberedUser)) {
  showSignedIn(rememberedUser);
} else {
  showLogin();
}

setIdleFace();
