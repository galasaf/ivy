// 3D avatar for Max: a realistic photo-scanned human model (Avatar SDK
// example from the TalkingHead project, non-commercial use) with Oculus
// viseme and ARKit blendshape morph targets, rendered with three.js.
//
// createAvatar3D(container) resolves to an API object, or null if WebGL or
// the model fails — callers keep the SVG avatar as fallback in that case.
//
//   api.setMode("idle" | "listening" | "thinking" | "speaking")
//   api.setEmotion("surprised" | "playful" | …) — face to hold this reply
//   api.speechStart(fullText)   — a reply is about to be spoken (browser TTS)
//   api.speechBoundary(charIdx) — speech synthesis reached a word
//   api.speechAudio(text, audioEl, analyser) — a reply plays from an <audio>
//     element; lips follow the real waveform via the analyser (studio TTS)
//   api.speechEnd()

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const AVATAR_URL = "ivy.glb";

// Grapheme-to-viseme rules. Two-letter clusters are matched before single
// letters so "th", "sh", "oo" and friends map to the right mouth shape
// instead of two wrong ones — a big part of why lips used to look random.
const DIGRAPH_VISEME = {
  th: "viseme_TH", ch: "viseme_CH", sh: "viseme_CH", tch: "viseme_CH",
  ph: "viseme_FF", wh: "viseme_U", ng: "viseme_nn", ck: "viseme_kk",
  qu: "viseme_kk", oo: "viseme_U", ee: "viseme_I", ea: "viseme_I",
  ai: "viseme_E", ay: "viseme_E", oa: "viseme_O", ow: "viseme_O",
  ou: "viseme_O", oi: "viseme_O", aw: "viseme_O", er: "viseme_RR",
};

const LETTER_VISEME = {
  a: "viseme_aa", e: "viseme_E", i: "viseme_I", o: "viseme_O", u: "viseme_U",
  b: "viseme_PP", p: "viseme_PP", m: "viseme_PP",
  f: "viseme_FF", v: "viseme_FF",
  t: "viseme_DD", d: "viseme_DD",
  k: "viseme_kk", g: "viseme_kk", c: "viseme_kk", q: "viseme_kk",
  j: "viseme_CH", s: "viseme_SS", z: "viseme_SS",
  n: "viseme_nn", l: "viseme_nn",
  r: "viseme_RR", w: "viseme_U", y: "viseme_I", h: "viseme_I", x: "viseme_SS",
};

function wordToVisemes(word) {
  let w = word.toLowerCase();
  // Silent trailing e: "make" should end on kk, not open into an E.
  if (w.length > 3 && w.endsWith("e") && !"aeiou".includes(w[w.length - 2])) {
    w = w.slice(0, -1);
  }
  const out = [];
  for (let i = 0; i < w.length; ) {
    const tri = DIGRAPH_VISEME[w.slice(i, i + 3)];
    const di = DIGRAPH_VISEME[w.slice(i, i + 2)];
    const v = tri || di || LETTER_VISEME[w[i]];
    i += tri ? 3 : di ? 2 : 1;
    if (v && v !== out[out.length - 1]) out.push(v);
    if (out.length >= 7) break;
  }
  return out.length ? out : ["viseme_aa"];
}

export async function createAvatar3D(container) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return null; // no WebGL — caller keeps the SVG avatar
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 10);

  // Filmic tone mapping + image-based lighting is most of the difference
  // between "video game" and "photo" for skin and hair.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const size = () => {
    const s = Math.min(container.clientWidth, container.clientHeight) || 260;
    renderer.setSize(s, s);
    camera.aspect = 1;
    camera.updateProjectionMatrix();
  };
  size();
  window.addEventListener("resize", size);
  container.appendChild(renderer.domElement);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // Soft portrait three-point lighting on top of the environment.
  const key = new THREE.DirectionalLight(0xfff1e0, 1.5);
  key.position.set(-0.5, 1.8, 1.3);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbfd4ff, 0.5);
  fill.position.set(0.9, 1.4, 0.8);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xaaccff, 0.8);
  rim.position.set(0.2, 1.6, -1.2);
  scene.add(rim);

  let gltf;
  try {
    gltf = await new GLTFLoader().loadAsync(AVATAR_URL);
  } catch (err) {
    console.warn("3D avatar failed to load, keeping 2D fallback:", err);
    renderer.dispose();
    renderer.domElement.remove();
    return null;
  }
  const model = gltf.scene;
  scene.add(model);

  // Collect every mesh that has morph targets, and the bones we animate.
  const morphMeshes = [];
  model.traverse((obj) => {
    if (obj.isMesh && obj.morphTargetDictionary) morphMeshes.push(obj);
  });
  const bone = (name) => model.getObjectByName(name) || null;
  const head = bone("Head");
  const neck = bone("Neck");
  const spine = bone("Spine2") || bone("Spine1") || bone("Spine");
  const eyeL = bone("LeftEye");
  const eyeR = bone("RightEye");
  const base = new Map();
  for (const b of [head, neck, spine, eyeL, eyeR]) {
    if (b) base.set(b, b.rotation.clone());
  }

  // Frame the head like a portrait.
  const headPos = new THREE.Vector3();
  (head || model).getWorldPosition(headPos);
  camera.position.set(0, headPos.y + 0.02, 0.75);
  camera.lookAt(0, headPos.y + 0.0, 0);

  // ---- morph target control: lerp current values toward targets ----------
  const morphTargets = {}; // name -> desired 0..1
  function applyMorphs(dt) {
    const k = Math.min(1, dt * 16);
    for (const mesh of morphMeshes) {
      const dict = mesh.morphTargetDictionary;
      for (const name in dict) {
        const want = morphTargets[name] || 0;
        const idx = dict[name];
        const cur = mesh.morphTargetInfluences[idx] || 0;
        mesh.morphTargetInfluences[idx] = cur + (want - cur) * k;
      }
    }
  }

  // ---- blinking ----------------------------------------------------------
  function blinkOnce() {
    morphTargets.eyeBlinkLeft = 1;
    morphTargets.eyeBlinkRight = 1;
    setTimeout(() => {
      morphTargets.eyeBlinkLeft = 0;
      morphTargets.eyeBlinkRight = 0;
    }, 120);
  }
  (function scheduleBlink() {
    setTimeout(() => {
      blinkOnce();
      if (Math.random() < 0.18) setTimeout(blinkOnce, 300);
      scheduleBlink();
    }, 2200 + Math.random() * 3800);
  })();

  // ---- idle micro-saccades ----------------------------------------------
  let saccade = { x: 0, y: 0 };
  (function scheduleSaccade() {
    setTimeout(() => {
      saccade = { x: (Math.random() - 0.5) * 0.12, y: (Math.random() - 0.5) * 0.16 };
      setTimeout(() => { saccade = { x: 0, y: 0 }; }, 500 + Math.random() * 900);
      scheduleSaccade();
    }, 1800 + Math.random() * 3200);
  })();

  // ---- speech: visemes scheduled from word boundaries --------------------
  let speechText = "";
  let boundarySeen = false;
  let fallbackTimer = null;
  let visemeQueue = []; // [{name, at, dur}] in ms timestamps (performance.now)

  function queueWordVisemes(word, startAt) {
    const visemes = wordToVisemes(word);
    const per = Math.min(110, Math.max(55, 320 / visemes.length));
    visemes.forEach((name, i) => {
      // Slight overlap between consecutive visemes reads as co-articulation.
      visemeQueue.push({ name, at: startAt + i * per, dur: per + 60 });
    });
  }

  function wordAt(charIdx) {
    const rest = speechText.slice(charIdx);
    const m = rest.match(/[A-Za-z']+/);
    return m ? m[0] : "";
  }

  function speechStart(text) {
    speechText = text || "";
    boundarySeen = false;
    visemeQueue = [];
    pulseQueue = [];
    audioSync = null;
    // Some voices never emit word boundaries; after a grace period, schedule
    // the whole reply on an estimated cadence instead.
    clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => {
      if (boundarySeen) return;
      let t = performance.now();
      for (const m of speechText.matchAll(/[A-Za-z']+/g)) {
        queueWordVisemes(m[0], t);
        t += 200 + m[0].length * 55;
      }
    }, 700);
  }

  // While speaking, occasionally punctuate a word with a tiny nod or brow
  // raise, the way people naturally emphasize speech.
  let nodUntil = 0;
  let browUntil = 0;
  let tiltUntil = 0;

  function punctuateWord() {
    const now = performance.now();
    if (Math.random() < 0.14) nodUntil = now + 240;
    if (Math.random() < 0.08) browUntil = now + 420;
  }

  // ---- expression acting -------------------------------------------------
  // Two layers on top of lip-sync. A per-reply baseline emotion (set from the
  // hidden [FEEL:x] tag on each reply) holds while the reply is spoken, and
  // short "pulses" fire at meaningful moments: brows shoot up on a question,
  // a grin lands on an exclamation, eyes widen on emphasis words. This is
  // what makes the face look like it means what it's saying.
  const EMOTIONS = {
    neutral: { mouthSmileLeft: 0.15, mouthSmileRight: 0.15 },
    happy: { mouthSmileLeft: 0.45, mouthSmileRight: 0.45, cheekSquintLeft: 0.25, cheekSquintRight: 0.25 },
    excited: { mouthSmileLeft: 0.4, mouthSmileRight: 0.4, browInnerUp: 0.35, browOuterUpLeft: 0.4, browOuterUpRight: 0.4, eyeWideLeft: 0.25, eyeWideRight: 0.25 },
    surprised: { browInnerUp: 0.55, browOuterUpLeft: 0.6, browOuterUpRight: 0.6, eyeWideLeft: 0.5, eyeWideRight: 0.5, mouthSmileLeft: 0.15, mouthSmileRight: 0.15 },
    curious: { browOuterUpLeft: 0.55, browDownRight: 0.15, eyeSquintRight: 0.2, mouthSmileLeft: 0.25, mouthSmileRight: 0.1 },
    thoughtful: { browDownLeft: 0.3, browDownRight: 0.2, eyeSquintLeft: 0.2, eyeSquintRight: 0.2, mouthPressLeft: 0.3, mouthPressRight: 0.3 },
    playful: { mouthSmileLeft: 0.5, mouthSmileRight: 0.2, browOuterUpLeft: 0.45, eyeSquintRight: 0.25 },
    sympathetic: { browInnerUp: 0.5, mouthSmileLeft: 0.15, mouthSmileRight: 0.15, mouthFrownLeft: 0.12, mouthFrownRight: 0.12 },
  };
  const EMOTION_MORPHS = [...new Set(Object.values(EMOTIONS).flatMap(Object.keys))];

  let emotion = "neutral";
  function setEmotion(name) {
    emotion = EMOTIONS[name] ? name : "neutral";
  }

  const PULSE_SURPRISE = { browInnerUp: 0.5, browOuterUpLeft: 0.55, browOuterUpRight: 0.55, eyeWideLeft: 0.45, eyeWideRight: 0.45 };
  const PULSE_SMILE = { mouthSmileLeft: 0.55, mouthSmileRight: 0.55, cheekSquintLeft: 0.35, cheekSquintRight: 0.35 };
  const PULSE_QUESTION = { browInnerUp: 0.45, browOuterUpLeft: 0.55, browOuterUpRight: 0.55, eyeWideLeft: 0.2, eyeWideRight: 0.2 };
  const EMPHASIS_WORD =
    /^(wow|whoa|no|way|really|amazing|incredible|love|never|huge|best|worst|seriously|unbelievable|perfect|exactly|yes|ten|hundred|thousand)$/i;

  // Pulses for browser-TTS mode live in wall-clock ms; audio mode builds its
  // own list in clip seconds inside the timeline.
  let pulseQueue = []; // [{at, dur, morphs}]

  function schedulePulse(morphs, dur, delay = 0) {
    pulseQueue.push({ at: performance.now() + delay, dur, morphs });
  }

  function applyPulses() {
    const now = performance.now();
    pulseQueue = pulseQueue.filter((p) => now < p.at + p.dur);
    for (const p of pulseQueue) {
      if (now < p.at) continue;
      const env = Math.sin(Math.min(1, (now - p.at) / p.dur) * Math.PI);
      for (const m in p.morphs) {
        morphTargets[m] = Math.max(morphTargets[m] || 0, p.morphs[m] * env);
      }
    }
  }

  function applyEmotion() {
    const e = EMOTIONS[emotion];
    for (const m of EMOTION_MORPHS) morphTargets[m] = e[m] || 0;
  }

  // Sentence-shape reactions for browser TTS: peek at the punctuation that
  // follows the word the synthesizer just reached.
  function wordExpression(word, followingPunct) {
    const now = performance.now();
    if (EMPHASIS_WORD.test(word)) {
      schedulePulse(PULSE_SURPRISE, 500);
      nodUntil = now + 260;
    }
    if (followingPunct.includes("?")) {
      schedulePulse(PULSE_QUESTION, 700, 100);
      tiltUntil = now + 800;
    } else if (followingPunct.includes("!")) {
      schedulePulse(PULSE_SMILE, 650, 80);
      nodUntil = now + 280;
    }
  }

  function speechBoundary(charIdx) {
    boundarySeen = true;
    const word = wordAt(charIdx || 0);
    if (word) {
      queueWordVisemes(word, performance.now());
      const after = speechText.slice(charIdx + word.length, charIdx + word.length + 3);
      wordExpression(word, after);
    }
    punctuateWord();
  }

  // ---- speech from real audio: the waveform drives the mouth -------------
  // A viseme timeline is laid out across the clip (weighted by word length,
  // with pauses at punctuation), then every frame the live RMS level from the
  // analyser scales how far the mouth actually opens. Loud syllables open
  // wide, quiet ones barely move — exactly what text-only timing can't do.
  let audioSync = null;

  function speechAudio(text, audioEl, analyser) {
    clearTimeout(fallbackTimer);
    visemeQueue = [];
    pulseQueue = [];
    audioSync = {
      audio: audioEl,
      analyser,
      buf: new Uint8Array(analyser.fftSize),
      timeline: null, // built once audio duration is known
      expr: null, // expression events in clip seconds
      text: text || "",
      lastWord: -1,
      level: 0,
    };
  }

  function buildTimeline(sync) {
    const dur = sync.audio.duration;
    if (!isFinite(dur) || dur <= 0) return;
    const tokens = [...sync.text.matchAll(/[A-Za-z']+|[.,;:!?…]+/g)].map((m) => m[0]);
    let total = 0;
    const weights = tokens.map((tok) => {
      const w = /^[A-Za-z']/.test(tok) ? tok.length + 2 : 3.5; // punctuation = pause
      total += w;
      return w;
    });
    const events = [];
    const expr = [];
    let t = 0;
    tokens.forEach((tok, i) => {
      const slot = (weights[i] / total) * dur;
      if (/^[A-Za-z']/.test(tok)) {
        const visemes = wordToVisemes(tok);
        const per = (slot * 0.72) / visemes.length; // ~28% closing gap per word
        visemes.forEach((name, j) => {
          events.push({ name, at: t + j * per, dur: per * 1.15, word: i });
        });
        // Emphasis words get wide eyes and a nod right when they land.
        if (EMPHASIS_WORD.test(tok)) {
          expr.push({ at: t, dur: 0.55, morphs: PULSE_SURPRISE, nod: true });
        }
        // Words stressed in CAPS by the script get the same treatment.
        else if (tok.length > 2 && tok === tok.toUpperCase()) {
          expr.push({ at: t, dur: 0.5, morphs: PULSE_SURPRISE, nod: true });
        }
      } else {
        // Sentence shape: brows rise into a question, a grin lands on an
        // exclamation, ellipses read as a thinking beat.
        if (tok.includes("?")) {
          expr.push({ at: Math.max(0, t - 0.45), dur: 0.9, morphs: PULSE_QUESTION, tilt: true });
        } else if (tok.includes("!")) {
          expr.push({ at: Math.max(0, t - 0.35), dur: 0.75, morphs: PULSE_SMILE, nod: true });
        } else if (tok.includes("…") || tok.includes("...")) {
          expr.push({ at: t, dur: 0.8, morphs: EMOTIONS.thoughtful });
        }
      }
      t += slot;
    });
    sync.timeline = events;
    sync.expr = expr;
  }

  function speechEnd() {
    clearTimeout(fallbackTimer);
    visemeQueue = [];
    pulseQueue = [];
    audioSync = null;
  }

  const VISEME_NAMES = [
    ...new Set([...Object.values(LETTER_VISEME), ...Object.values(DIGRAPH_VISEME)]),
  ];

  // How much each viseme opens the jaw: open vowels drop it a lot, closed
  // consonants like P/B/M and S barely at all. Uniform jaw was a big part of
  // why the mouth looked artificial.
  const VISEME_JAW = {
    viseme_aa: 0.45, viseme_E: 0.26, viseme_I: 0.16, viseme_O: 0.38, viseme_U: 0.22,
    viseme_PP: 0.0, viseme_FF: 0.06, viseme_DD: 0.12, viseme_kk: 0.16,
    viseme_CH: 0.1, viseme_SS: 0.03, viseme_nn: 0.1, viseme_RR: 0.15,
    viseme_TH: 0.12,
  };

  function clearMouth() {
    for (const name of VISEME_NAMES) morphTargets[name] = 0;
    morphTargets.jawOpen = 0;
  }

  function setViseme(name, strength) {
    morphTargets[name] = Math.max(morphTargets[name] || 0, strength);
    morphTargets.jawOpen = Math.max(
      morphTargets.jawOpen,
      strength * (VISEME_JAW[name] ?? 0.2),
    );
  }

  function mouthShaping() {
    // Lips round on O/U, press on P/B/M — co-articulation cues.
    morphTargets.mouthPucker =
      Math.max(morphTargets.viseme_O || 0, morphTargets.viseme_U || 0) * 0.5;
    morphTargets.mouthPressLeft = Math.max(
      morphTargets.mouthPressLeft || 0, (morphTargets.viseme_PP || 0) * 0.6);
    morphTargets.mouthPressRight = Math.max(
      morphTargets.mouthPressRight || 0, (morphTargets.viseme_PP || 0) * 0.6);
    // Word-emphasis brow raise.
    if (performance.now() < browUntil) {
      morphTargets.browInnerUp = Math.max(morphTargets.browInnerUp || 0, 0.35);
    }
  }

  function applyVisemesTimed() {
    const now = performance.now();
    clearMouth();
    applyEmotion();
    visemeQueue = visemeQueue.filter((v) => now < v.at + v.dur);
    for (const v of visemeQueue) {
      if (now >= v.at) {
        const phase = (now - v.at) / v.dur; // 0..1 attack/decay envelope
        setViseme(v.name, Math.sin(Math.min(1, phase) * Math.PI) * 0.9);
      }
    }
    applyPulses();
    mouthShaping();
  }

  function applyVisemesAudio(sync) {
    clearMouth();
    applyEmotion();
    if (!sync.timeline) buildTimeline(sync);
    // Live loudness, smoothed a little so the jaw doesn't flutter.
    sync.analyser.getByteTimeDomainData(sync.buf);
    let sum = 0;
    for (let i = 0; i < sync.buf.length; i++) {
      const d = (sync.buf[i] - 128) / 128;
      sum += d * d;
    }
    const rms = Math.sqrt(sum / sync.buf.length);
    sync.level += (rms - sync.level) * 0.3;
    // Noise gate + gamma: quiet passages and consonant/pause gaps fall to
    // zero so the mouth actually closes instead of hanging open.
    const gated = Math.max(0, sync.level - 0.035);
    const loud = Math.min(1, Math.pow(gated * 6.5, 1.35));

    if (sync.timeline) {
      const t = sync.audio.currentTime;
      for (const v of sync.timeline) {
        if (t >= v.at && t < v.at + v.dur) {
          const phase = (t - v.at) / v.dur;
          const env = Math.sin(Math.min(1, phase) * Math.PI);
          setViseme(v.name, env * (0.12 + loud * 0.9));
          if (v.word !== sync.lastWord) {
            sync.lastWord = v.word;
            punctuateWord();
          }
        }
      }
    }
    // Expression events timed against the clip: questions, exclamations,
    // emphasis words, thinking beats.
    if (sync.expr) {
      const t = sync.audio.currentTime;
      for (const p of sync.expr) {
        if (t >= p.at && t < p.at + p.dur) {
          const env = Math.sin(Math.min(1, (t - p.at) / p.dur) * Math.PI);
          for (const m in p.morphs) {
            morphTargets[m] = Math.max(morphTargets[m] || 0, p.morphs[m] * env);
          }
          if (p.nod && !p.fired) { p.fired = true; nodUntil = performance.now() + 280; }
          if (p.tilt && !p.fired) { p.fired = true; tiltUntil = performance.now() + 800; }
        }
      }
    }
    // The waveform never opens the mouth on its own — it only scales the jaw
    // the visemes already opened for a vowel. So consonants, gaps, and pauses
    // (where no viseme is active) let the mouth fully close instead of hanging
    // open and twitching with the audio.
    morphTargets.jawOpen = Math.min(0.45, morphTargets.jawOpen * (0.55 + loud * 0.45));
    mouthShaping();
  }

  // ---- conversation modes ------------------------------------------------
  let mode = "idle";
  function setMode(next) {
    mode = next || "idle";
    for (const m of EMOTION_MORPHS) morphTargets[m] = 0;
    morphTargets.mouthSmileLeft = 0.12;
    morphTargets.mouthSmileRight = 0.12;
    if (mode === "listening") {
      morphTargets.browInnerUp = 0.45;
      morphTargets.browOuterUpLeft = 0.25;
      morphTargets.browOuterUpRight = 0.25;
      morphTargets.mouthSmileLeft = 0.22;
      morphTargets.mouthSmileRight = 0.22;
    } else if (mode === "thinking") {
      morphTargets.browInnerUp = 0.2;
      morphTargets.browDownLeft = 0.3;
    }
    // "speaking" needs no preset: the per-reply emotion baseline plus timed
    // expression pulses are applied every frame while the reply plays.
  }

  // ---- render loop -------------------------------------------------------
  const clock = new THREE.Clock();
  function pose(t) {
    const set = (b, x, y, z) => {
      if (!b) return;
      const r = base.get(b);
      b.rotation.set(r.x + x, r.y + y, r.z + z);
    };
    const breathe = Math.sin(t * 1.4) * 0.012;
    // Layered incommensurate sines read as organic drift instead of a
    // metronome — heads are never perfectly still or perfectly periodic.
    const driftX = Math.sin(t * 0.31) * 0.012 + Math.sin(t * 0.83) * 0.008;
    const driftY = Math.sin(t * 0.47) * 0.02 + Math.sin(t * 1.13) * 0.008;
    if (mode === "listening") {
      set(head, 0.04 + driftX, 0.06 + driftY, 0.05 + breathe);
      set(neck, 0.02, 0.03, 0.02);
      set(eyeL, saccade.x, saccade.y, 0);
      set(eyeR, saccade.x, saccade.y, 0);
    } else if (mode === "thinking") {
      set(head, -0.07 + driftX, 0.12 + driftY, -0.03 + breathe);
      set(neck, -0.02, 0.05, 0);
      set(eyeL, -0.18, 0.12, 0);
      set(eyeR, -0.18, 0.12, 0);
    } else if (mode === "speaking") {
      // Word-emphasis nod scheduled from speech, on top of drift, plus a
      // brief head tilt that lands on questions.
      const nodPhase = Math.max(0, nodUntil - performance.now()) / 240;
      const nod = Math.sin(nodPhase * Math.PI) * 0.045;
      const tiltPhase = Math.max(0, tiltUntil - performance.now()) / 800;
      const tilt = Math.sin(tiltPhase * Math.PI) * 0.07;
      set(head, nod + driftX * 1.5, driftY * 1.5, breathe + tilt);
      set(neck, nod * 0.5, 0, tilt * 0.4);
      set(eyeL, saccade.x * 0.5, saccade.y * 0.5, 0);
      set(eyeR, saccade.x * 0.5, saccade.y * 0.5, 0);
    } else {
      set(head, breathe + driftX, driftY, 0);
      set(spine, breathe * 0.4, 0, 0);
      set(eyeL, saccade.x, saccade.y, 0);
      set(eyeR, saccade.x, saccade.y, 0);
    }
  }

  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta();
    if (mode === "speaking") {
      if (audioSync) applyVisemesAudio(audioSync);
      else applyVisemesTimed();
    }
    pose(clock.elapsedTime);
    applyMorphs(dt);
    renderer.render(scene, camera);
  });

  setMode("idle");
  return { setMode, setEmotion, speechStart, speechBoundary, speechAudio, speechEnd };
}
