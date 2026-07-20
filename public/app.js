// Voice-only conversation loop:
//   listen (speech recognition) -> send transcript -> think (Claude) ->
//   speak (speech synthesis + avatar lip animation) -> listen again.

import { createAvatar3D } from "./avatar3d.js";

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const avatarWrap = document.getElementById("avatarWrap");
const mouth = document.getElementById("mouth");
const smile = document.getElementById("smile");
const masteredCountEl = document.getElementById("masteredCount");
const learningCountEl = document.getElementById("learningCount");
const modelSelect = document.getElementById("modelSelect");
const voiceSelect = document.getElementById("voiceSelect");
const topicChipsEl = document.getElementById("topicChips");
const agendaPanel = document.getElementById("agendaPanel");
const agendaTitle = document.getElementById("agendaTitle");
const agendaList = document.getElementById("agendaList");
const wordsToggle = document.getElementById("wordsToggle");
const wordsCaret = document.getElementById("wordsCaret");
const wordsPanel = document.getElementById("wordsPanel");
const masteredList = document.getElementById("masteredList");
const learningList = document.getElementById("learningList");

// 3D avatar (Ready Player Me + three.js). If WebGL or the model fails,
// avatar3d stays null and the built-in SVG avatar keeps working.
let avatar3d = null;
createAvatar3D(document.getElementById("avatar3d"))
  .then((api) => {
    if (api) {
      avatar3d = api;
      document.getElementById("avatar").style.display = "none";
    }
  })
  .catch((err) => console.warn("3D avatar unavailable:", err));
const loginOverlay = document.getElementById("loginOverlay");
const loginForm = document.getElementById("loginForm");
const loginName = document.getElementById("loginName");
const loginError = document.getElementById("loginError");
const userChip = document.getElementById("userChip");
const userNameEl = document.getElementById("userName");
const switchUserBtn = document.getElementById("switchUserBtn");

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

let running = false;
let recognition = null;
let mouthTimer = null;
let preferredVoice = null;

// ---------------------------------------------------------------------------
// UI state helpers
// ---------------------------------------------------------------------------
function setState(state, message) {
  avatarWrap.classList.remove("listening", "thinking", "speaking");
  if (state) avatarWrap.classList.add(state);
  if (avatar3d) avatar3d.setMode(state || "idle");
  statusEl.textContent = message;
}

function setIdleFace() {
  mouth.setAttribute("ry", "3");
  smile.setAttribute("stroke-width", "4");
}

let lastWordAt = 0;
let boundarySupported = false;

function startMouthAnimation() {
  if (avatar3d) return; // 3D avatar handles its own lip-sync
  smile.setAttribute("stroke-width", "0");
  stopMouthAnimation();
  mouthTimer = setInterval(() => {
    let openness;
    if (boundarySupported) {
      // Sync to real speech rhythm: open wide on each spoken word, settle between.
      const sinceWord = Date.now() - lastWordAt;
      openness = sinceWord < 260 ? 5 + Math.random() * 9 : 1.5 + Math.random() * 3;
    } else {
      // Fallback when the voice emits no word-boundary events: randomized movement.
      openness = 2 + Math.random() * 11;
    }
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
// Two tiers: "studio" voices (ElevenLabs neural TTS — genuinely human, the
// audio waveform drives the avatar's lips) and free browser voices as
// fallback. Studio voice values look like "11labs:<voiceId>".
const STUDIO_VOICES = [
  { id: "pNInz6obpgDQGcFmaJgB", label: "Adam — studio ★★" },
  { id: "TxGEqnHWrfWFTfGW9XjX", label: "Josh — studio ★★" },
  { id: "ErXwobaYiN019PkySvjV", label: "Antoni — studio ★★" },
];

// Rank browser voices by how human they sound. Edge's "Online (Natural)"
// neural voices are far better than anything else; Google's cloud voices come
// next; plain local system voices (Zira, David…) are the robotic last resort.
function voiceScore(v) {
  let score = 0;
  if (/Online \(Natural\)|Natural/i.test(v.name)) score += 100;
  if (/Guy|Ryan|Eric|Andrew|Brian|Christopher|Davis|Tony/i.test(v.name)) score += 15;
  if (/^Google/i.test(v.name)) score += 50;
  if (!v.localService) score += 20; // cloud voices are consistently better
  if (v.lang === "en-US") score += 8;
  else if (v.lang.startsWith("en")) score += 4;
  else score -= 100;
  return score;
}

function englishVoices() {
  return speechSynthesis
    .getVoices()
    .filter((v) => v.lang.startsWith("en"))
    .sort((a, b) => voiceScore(b) - voiceScore(a));
}

function pickVoice() {
  const voices = englishVoices();
  if (!voices.length) return speechSynthesis.getVoices()[0] || null;
  const savedName = localStorage.getItem("ivy_voice");
  return voices.find((v) => v.name === savedName) || voices[0];
}

function populateVoices() {
  const voices = englishVoices();
  preferredVoice = pickVoice();
  voiceSelect.innerHTML = "";
  const studioGroup = document.createElement("optgroup");
  studioGroup.label = "Most realistic";
  for (const sv of STUDIO_VOICES) {
    const opt = document.createElement("option");
    opt.value = "11labs:" + sv.id;
    opt.textContent = sv.label;
    studioGroup.appendChild(opt);
  }
  voiceSelect.appendChild(studioGroup);
  const browserGroup = document.createElement("optgroup");
  browserGroup.label = "Browser voices (free)";
  for (const v of voices) {
    const opt = document.createElement("option");
    opt.value = v.name;
    // Trim the verbose vendor names down to something readable.
    opt.textContent = v.name
      .replace(/^Microsoft |^Google /, "")
      .replace(" Online (Natural) - English", "")
      .replace(" - English", "");
    if (/Online \(Natural\)/.test(v.name)) opt.textContent += " ★";
    browserGroup.appendChild(opt);
  }
  voiceSelect.appendChild(browserGroup);
  const saved = localStorage.getItem("ivy_voice");
  if (saved && [...voiceSelect.options].some((o) => o.value === saved)) {
    voiceSelect.value = saved;
  } else if (preferredVoice) {
    voiceSelect.value = preferredVoice.name;
  }
}

speechSynthesis.onvoiceschanged = populateVoices;
populateVoices();

voiceSelect.addEventListener("change", () => {
  localStorage.setItem("ivy_voice", voiceSelect.value);
  preferredVoice = pickVoice();
  // Quick audition so you hear the change immediately.
  if (!running) {
    speak("Hi, this is how I sound now.").then(() =>
      setState(null, "Press start to begin talking"),
    );
  }
});

// ---- studio voice playback: real audio, lips follow the waveform ---------
let audioCtx = null;
let currentAudio = null;

async function playWithLipSync(text, blob, alignment) {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  const audio = new Audio(URL.createObjectURL(blob));
  const src = audioCtx.createMediaElementSource(audio);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  analyser.connect(audioCtx.destination);
  currentAudio = audio;
  await new Promise((resolve) => {
    audio.onended = resolve;
    audio.onerror = resolve;
    setState("speaking", "Max is speaking…");
    if (avatar3d) avatar3d.speechAudio(text, audio, analyser, alignment);
    startMouthAnimation();
    audio.play().catch(resolve);
  });
  if (avatar3d) avatar3d.speechEnd();
  stopMouthAnimation();
  URL.revokeObjectURL(audio.src);
  currentAudio = null;
}

async function fetchStudioAudio(text, voiceId) {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice: voiceId }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || "Studio voice unavailable.");
  }
  const data = await res.json();
  const bytes = Uint8Array.from(atob(data.audio_base64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: "audio/mpeg" });
  return { blob, alignment: data.alignment || null };
}

async function speak(text) {
  const sel = voiceSelect.value;
  if (sel.startsWith("11labs:")) {
    try {
      const { blob, alignment } = await fetchStudioAudio(text, sel.slice(7));
      return await playWithLipSync(text, blob, alignment);
    } catch (err) {
      console.warn("Studio voice failed, using browser voice:", err);
      statusEl.textContent = "Studio voice unavailable — using a browser voice.";
    }
  }
  return speakBrowser(text);
}

function speakBrowser(text) {
  return new Promise((resolve) => {
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    if (!preferredVoice) preferredVoice = pickVoice();
    if (preferredVoice) utterance.voice = preferredVoice;
    utterance.rate = 0.95;
    utterance.pitch = 1.05;

    utterance.onboundary = (event) => {
      boundarySupported = true;
      lastWordAt = Date.now();
      if (avatar3d) avatar3d.speechBoundary(event.charIndex);
    };
    utterance.onstart = () => {
      setState("speaking", "Max is speaking…");
      if (avatar3d) avatar3d.speechStart(text);
      startMouthAnimation();
    };
    const finish = () => {
      if (avatar3d) avatar3d.speechEnd();
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
async function sendToAgent(transcript) {
  setState("thinking", "Max is thinking…");
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transcript,
      lessonTitle: currentLesson()?.title || "",
      agenda: currentLesson()?.agenda || [],
    }),
  });
  const data = await res.json();
  if (res.status === 401) {
    showLogin();
    throw new Error("Please sign in first.");
  }
  if (!res.ok) throw new Error(data.error || "Server error");
  if (typeof data.masteredCount === "number") {
    masteredCountEl.textContent = data.masteredCount;
  }
  if (typeof data.learningCount === "number") {
    learningCountEl.textContent = data.learningCount;
  }
  if (!wordsPanel.hidden) refreshWordLists(); // keep the open panel live
  return stripStage(data.reply);
}

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
  if (currentAudio) {
    try { currentAudio.pause(); } catch { /* already stopped */ }
    currentAudio = null;
  }
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
  running = true;
  startBtn.hidden = true;
  stopBtn.hidden = false;
  conversationLoop();
});

stopBtn.addEventListener("click", () => stopConversation());

// ---------------------------------------------------------------------------
// Guided lessons — specific, real-life scenarios, each with a visible agenda
// that Max walks through step by step. The current step lights up as he
// signals it with a hidden [STAGE:n] tag on each reply.
// ---------------------------------------------------------------------------
const LESSONS = [
  { id: "restaurant", title: "Ordering at a restaurant", agenda: [
    "Greet the waiter and ask for a table",
    "Ask about the menu and today's special",
    "Order your food and a drink",
    "Ask for the bill and say thank you",
  ] },
  { id: "smalltalk", title: "Small talk with a neighbor", agenda: [
    "Say hello and mention the weather",
    "Ask about their weekend or family",
    "Share something about your own day",
    "Make a friendly plan or say goodbye",
  ] },
  { id: "interview", title: "A job interview", agenda: [
    "Introduce yourself",
    "Talk about your experience",
    "Explain why you want the job",
    "Ask the interviewer a question",
  ] },
  { id: "doctor", title: "A visit to the doctor", agenda: [
    "Describe how you feel",
    "Answer questions about your symptoms",
    "Understand the doctor's advice",
    "Ask about medicine and next steps",
  ] },
  { id: "hotel", title: "Checking into a hotel", agenda: [
    "Give your booking details",
    "Ask about the room and breakfast",
    "Ask for a local recommendation",
    "Sort out a small problem with the room",
  ] },
  { id: "shopping", title: "Shopping and returns", agenda: [
    "Ask a shop assistant for help",
    "Ask about size, color, or price",
    "Decide and pay",
    "Return an item and explain why",
  ] },
  { id: "directions", title: "Asking for directions", agenda: [
    "Politely stop someone",
    "Ask the way to a place",
    "Follow left, right, and straight ahead",
    "Repeat it back to check you understood",
  ] },
  { id: "phone", title: "Calling customer service", agenda: [
    "Explain your problem",
    "Give your account details",
    "Answer their questions",
    "Confirm the solution and thank them",
  ] },
  { id: "weekend", title: "Talking about your weekend", agenda: [
    "Say what you did",
    "Add details and how you felt",
    "Ask about their weekend",
    "Make a plan for next time",
  ] },
  { id: "free", title: "Free chat (Max picks)", agenda: [] },
];

// The learner can also type their own topic; it's kept as a free-form lesson
// with no fixed agenda so Max just chats about whatever they chose.
let customTopic = localStorage.getItem("ivy_topic") || "";

let selectedLesson = localStorage.getItem("ivy_lesson") || LESSONS[0].id;
const knownLesson = (id) => id === "custom" || LESSONS.some((l) => l.id === id);
if (!knownLesson(selectedLesson) || (selectedLesson === "custom" && !customTopic)) {
  selectedLesson = LESSONS[0].id;
}

function currentLesson() {
  if (selectedLesson === "custom" && customTopic) {
    return { id: "custom", title: customTopic, agenda: [] };
  }
  return LESSONS.find((l) => l.id === selectedLesson) || null;
}

function renderAgenda() {
  const lesson = currentLesson();
  agendaList.innerHTML = "";
  if (!lesson || !lesson.agenda.length) {
    agendaPanel.hidden = true;
    return;
  }
  agendaPanel.hidden = false;
  agendaTitle.textContent = lesson.title;
  lesson.agenda.forEach((step) => {
    const li = document.createElement("li");
    li.textContent = step;
    agendaList.appendChild(li);
  });
}

// Highlight the step Max is on: earlier steps done, current one active.
function setStage(n) {
  [...agendaList.children].forEach((li, i) => {
    const idx = i + 1;
    li.classList.toggle("done", idx < n);
    li.classList.toggle("active", idx === n);
  });
}

function selectLesson(id) {
  selectedLesson = id;
  localStorage.setItem("ivy_lesson", id);
  renderTopicChips();
  renderAgenda();
}

function renderTopicChips() {
  topicChipsEl.innerHTML = "";
  for (const lesson of LESSONS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "topic-chip" + (lesson.id === selectedLesson ? " selected" : "");
    chip.textContent = lesson.title;
    chip.addEventListener("click", () => selectLesson(lesson.id));
    topicChipsEl.appendChild(chip);
  }
  // Custom topic the learner types themselves.
  const custom = document.createElement("button");
  custom.type = "button";
  custom.className = "topic-chip" + (selectedLesson === "custom" ? " selected" : "");
  custom.textContent = customTopic ? `🎙 ${customTopic}` : "＋ My own topic…";
  custom.title = "Type a topic you want to talk about";
  custom.addEventListener("click", () => {
    const topic = window.prompt(
      "What would you like to talk about?",
      customTopic || ""
    );
    if (topic === null) return; // cancelled
    const trimmed = topic.trim().slice(0, 80);
    if (!trimmed) return;
    customTopic = trimmed;
    localStorage.setItem("ivy_topic", customTopic);
    selectLesson("custom");
  });
  topicChipsEl.appendChild(custom);
}
renderTopicChips();
renderAgenda();

// Pull the hidden [STAGE:n][FEEL:x] tags off a reply: STAGE advances the
// agenda, FEEL sets the avatar's facial expression for this reply. Returns
// the clean text to speak.
function stripStage(reply) {
  const stage = reply.match(/\[STAGE:(\d+)\]/i);
  if (stage) setStage(parseInt(stage[1], 10));
  const feel = reply.match(/\[FEEL:([a-z]+)\]/i);
  if (feel && avatar3d) avatar3d.setEmotion(feel[1].toLowerCase());
  return reply.replace(/\[(STAGE|FEEL):[^\]]*\]/gi, "").trim();
}

// ---------------------------------------------------------------------------
// Expandable word lists — click the counters to see what's behind them.
// ---------------------------------------------------------------------------
function renderWordList(el, words) {
  el.innerHTML = "";
  if (!words.length) {
    el.innerHTML = '<span class="empty">Nothing yet</span>';
    return;
  }
  for (const w of words) {
    const chip = document.createElement("span");
    chip.className = "word-chip";
    chip.textContent = w;
    el.appendChild(chip);
  }
}

function refreshWordLists() {
  fetch("/api/stats")
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((s) => {
      renderWordList(masteredList, s.masteredWords || []);
      renderWordList(learningList, s.learningWords || []);
    })
    .catch(() => {});
}

wordsToggle.addEventListener("click", () => {
  wordsPanel.hidden = !wordsPanel.hidden;
  wordsCaret.innerHTML = wordsPanel.hidden ? "&#9662;" : "&#9652;";
  if (!wordsPanel.hidden) refreshWordLists();
});

// ---------------------------------------------------------------------------
// Model selector — takes effect on the next reply, mid-conversation is fine.
// ---------------------------------------------------------------------------
fetch("/api/model")
  .then((r) => r.json())
  .then(({ model, options }) => {
    const alias = Object.keys(options).find((k) => options[k] === model);
    if (alias) modelSelect.value = alias;
  })
  .catch(() => {});

modelSelect.addEventListener("change", () => {
  fetch("/api/model", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelSelect.value }),
  }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Sign in — each learner has their own remembered vocabulary.
// ---------------------------------------------------------------------------
function showLogin() {
  stopConversation(true);
  loginOverlay.hidden = false;
  userChip.hidden = true;
  loginName.focus();
}

function showSignedIn(name) {
  loginOverlay.hidden = true;
  loginError.hidden = true;
  userNameEl.textContent = name;
  userChip.hidden = false;
  refreshStats();
}

function refreshStats() {
  fetch("/api/stats")
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((s) => {
      masteredCountEl.textContent = s.masteredCount;
      learningCountEl.textContent = s.learningCount;
    })
    .catch(() => {});
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const res = await fetch("/api/user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: loginName.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not sign in.");
    showSignedIn(data.name);
    setState(null, "Press start to begin talking");
  } catch (err) {
    loginError.textContent = err.message;
    loginError.hidden = false;
  }
});

switchUserBtn.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  loginName.value = "";
  showLogin();
});

// On load: restore the remembered learner, or ask who's practicing.
fetch("/api/user")
  .then((r) => r.json())
  .then(({ name }) => (name ? showSignedIn(name) : showLogin()))
  .catch(() => showLogin());

// Natural blinking: randomized intervals, both eyes together, occasional double blink.
const avatarSvg = document.getElementById("avatar");
function doBlink() {
  if (avatar3d) return; // 3D avatar blinks on its own
  avatarSvg.classList.add("blink");
  setTimeout(() => avatarSvg.classList.remove("blink"), 130);
}
(function scheduleBlink() {
  setTimeout(() => {
    doBlink();
    if (Math.random() < 0.18) setTimeout(doBlink, 280);
    scheduleBlink();
  }, 2200 + Math.random() * 3800);
})();

setIdleFace();
