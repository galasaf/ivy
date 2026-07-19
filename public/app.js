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
// Rank browser voices by how human they sound. Edge's "Online (Natural)"
// neural voices are far better than anything else; Google's cloud voices come
// next; plain local system voices (Zira, David…) are the robotic last resort.
function voiceScore(v) {
  let score = 0;
  if (/Online \(Natural\)|Natural/i.test(v.name)) score += 100;
  if (/Aria|Jenny|Sonia|Libby|Michelle/i.test(v.name)) score += 10;
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
  if (!voices.length) return;
  preferredVoice = pickVoice();
  voiceSelect.innerHTML = "";
  for (const v of voices) {
    const opt = document.createElement("option");
    opt.value = v.name;
    // Trim the verbose vendor names down to something readable.
    opt.textContent = v.name
      .replace(/^Microsoft |^Google /, "")
      .replace(" Online (Natural) - English", "")
      .replace(" - English", "");
    if (/Online \(Natural\)/.test(v.name)) opt.textContent += " ★";
    voiceSelect.appendChild(opt);
  }
  if (preferredVoice) voiceSelect.value = preferredVoice.name;
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

function speak(text) {
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
      setState("speaking", "Ivy is speaking…");
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
  setState("thinking", "Ivy is thinking…");
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript, topic: selectedTopic }),
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
  return data.reply;
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
// Topic picker — gives the conversation a clear direction. "Surprise me"
// lets Ivy choose and announce a topic herself.
// ---------------------------------------------------------------------------
const TOPICS = [
  "Surprise me",
  "Daily life",
  "Food & cooking",
  "Travel",
  "Family & friends",
  "Work & school",
  "Hobbies & fun",
  "Movies & music",
];
let selectedTopic = localStorage.getItem("ivy_topic") || TOPICS[0];
if (!TOPICS.includes(selectedTopic)) selectedTopic = TOPICS[0];

for (const topic of TOPICS) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "topic-chip" + (topic === selectedTopic ? " selected" : "");
  chip.textContent = topic;
  chip.addEventListener("click", () => {
    selectedTopic = topic;
    localStorage.setItem("ivy_topic", topic);
    for (const c of topicChipsEl.children) {
      c.classList.toggle("selected", c === chip);
    }
  });
  topicChipsEl.appendChild(chip);
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
