// 3D avatar for Ivy: a Ready Player Me human model with Oculus viseme and
// ARKit blendshape morph targets, rendered with three.js and animated from
// conversation state plus real word timings from speech synthesis.
//
// createAvatar3D(container) resolves to an API object, or null if WebGL or
// the model fails — callers keep the SVG avatar as fallback in that case.
//
//   api.setMode("idle" | "listening" | "thinking" | "speaking")
//   api.speechStart(fullText)   — a reply is about to be spoken
//   api.speechBoundary(charIdx) — speech synthesis reached a word
//   api.speechEnd()

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Self-hosted model (TalkingHead project's example avatar, non-commercial
// use): a Ready Player Me-style rig with Oculus visemes + ARKit blendshapes.
const AVATAR_URL = "ivy.glb";

// Rough letter-to-viseme mapping; good enough to read as natural lip motion.
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
  const out = [];
  for (const ch of word.toLowerCase()) {
    const v = LETTER_VISEME[ch];
    if (v && v !== out[out.length - 1]) out.push(v);
    if (out.length >= 6) break;
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
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 10);

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

  scene.add(new THREE.HemisphereLight(0xffffff, 0x445577, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-0.4, 1.9, 1.2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
  fill.position.set(0.8, 1.5, 0.6);
  scene.add(fill);

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
  camera.position.set(0, headPos.y + 0.02, 0.78);
  camera.lookAt(0, headPos.y + 0.0, 0);

  // ---- morph target control: lerp current values toward targets ----------
  const morphTargets = {}; // name -> desired 0..1
  function applyMorphs(dt) {
    const k = Math.min(1, dt * 14);
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
      visemeQueue.push({ name, at: startAt + i * per, dur: per + 40 });
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

  function speechBoundary(charIdx) {
    boundarySeen = true;
    const word = wordAt(charIdx || 0);
    if (word) queueWordVisemes(word, performance.now());
  }

  function speechEnd() {
    clearTimeout(fallbackTimer);
    visemeQueue = [];
  }

  const VISEME_NAMES = Object.values(LETTER_VISEME).filter((v, i, a) => a.indexOf(v) === i);

  function applyVisemes() {
    const now = performance.now();
    for (const name of VISEME_NAMES) morphTargets[name] = 0;
    morphTargets.jawOpen = 0;
    visemeQueue = visemeQueue.filter((v) => now < v.at + v.dur);
    for (const v of visemeQueue) {
      if (now >= v.at) {
        const phase = (now - v.at) / v.dur; // 0..1 attack/decay envelope
        const strength = Math.sin(Math.min(1, phase) * Math.PI) * 0.85;
        morphTargets[v.name] = Math.max(morphTargets[v.name] || 0, strength);
        morphTargets.jawOpen = Math.max(morphTargets.jawOpen, strength * 0.25);
      }
    }
  }

  // ---- conversation modes ------------------------------------------------
  let mode = "idle";
  function setMode(next) {
    mode = next || "idle";
    morphTargets.browInnerUp = 0;
    morphTargets.browOuterUpLeft = 0;
    morphTargets.browOuterUpRight = 0;
    morphTargets.browDownLeft = 0;
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
    } else if (mode === "speaking") {
      morphTargets.mouthSmileLeft = 0.15;
      morphTargets.mouthSmileRight = 0.15;
    }
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
    if (mode === "listening") {
      set(head, 0.04, 0.06, 0.05 + breathe);
      set(neck, 0.02, 0.03, 0.02);
      set(eyeL, saccade.x, saccade.y, 0);
      set(eyeR, saccade.x, saccade.y, 0);
    } else if (mode === "thinking") {
      set(head, -0.07, 0.12, -0.03 + breathe);
      set(neck, -0.02, 0.05, 0);
      set(eyeL, -0.18, 0.12, 0);
      set(eyeR, -0.18, 0.12, 0);
    } else if (mode === "speaking") {
      const bob = Math.sin(t * 2.6) * 0.02;
      set(head, bob, Math.sin(t * 1.7) * 0.03, breathe);
      set(neck, bob * 0.5, 0, 0);
      set(eyeL, saccade.x * 0.5, saccade.y * 0.5, 0);
      set(eyeR, saccade.x * 0.5, saccade.y * 0.5, 0);
    } else {
      set(head, breathe, Math.sin(t * 0.6) * 0.02, 0);
      set(spine, breathe * 0.4, 0, 0);
      set(eyeL, saccade.x, saccade.y, 0);
      set(eyeR, saccade.x, saccade.y, 0);
    }
  }

  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta();
    if (mode === "speaking") applyVisemes();
    pose(clock.elapsedTime);
    applyMorphs(dt);
    renderer.render(scene, camera);
  });

  setMode("idle");
  return { setMode, speechStart, speechBoundary, speechEnd };
}
