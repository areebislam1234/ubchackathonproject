// Chiptune sound effects made on the fly with square, triangle and noise channels. No files.
let ctx = null;
let enabled = localStorage.getItem("stakeclash.sound") !== "off";
export const sound = {
  get on() {
    return enabled;
  },
  toggle() {
    enabled = !enabled;
    localStorage.setItem("stakeclash.sound", enabled ? "on" : "off");
    return enabled;
  },
};
function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}
function tone(freq, start, dur, { type = "square", vol = 0.08, slide = 0 } = {}) {
  const a = ac();
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, a.currentTime + start);
  if (slide) o.frequency.linearRampToValueAtTime(freq + slide, a.currentTime + start + dur);
  g.gain.setValueAtTime(vol, a.currentTime + start);
  g.gain.setValueAtTime(vol, a.currentTime + start + dur * 0.7);
  g.gain.linearRampToValueAtTime(0, a.currentTime + start + dur);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + start);
  o.stop(a.currentTime + start + dur + 0.02);
}
function noise(start, dur, vol = 0.08, hp = 800) {
  const a = ac();
  const len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    if (i % 4 === 0) last = Math.random() * 2 - 1; // crunchy 8-bit noise
    d[i] = last * (1 - i / len);
  }
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = "highpass";
  f.frequency.value = hp;
  const g = a.createGain();
  g.gain.value = vol;
  src.connect(f).connect(g).connect(a.destination);
  src.start(a.currentTime + start);
}
const N = { C4: 262, D4: 294, E4: 330, F4: 349, G4: 392, A4: 440, B4: 494, C5: 523, D5: 587, E5: 659, G5: 784, A5: 880, C6: 1047 };
const SFX = {
  click: () => tone(880, 0, 0.04, { vol: 0.05 }),
  open: () => (tone(N.E5, 0, 0.05), tone(N.A5, 0.05, 0.07)),
  close: () => (tone(N.A5, 0, 0.05), tone(N.E5, 0.05, 0.06)),
  coin: () => (tone(N.B4 * 2, 0, 0.05), tone(N.E5 * 2, 0.05, 0.12)),
  enter: () => [N.C5, N.E5, N.G5].forEach((f, i) => tone(f, i * 0.07, 0.09)),
  discover: () => [N.G4, N.C5, N.E5, N.G5, N.C6].forEach((f, i) => tone(f, i * 0.06, 0.08, { vol: 0.06 })),
  swing: () => noise(0, 0.06, 0.05, 2000),
  arrow: () => tone(1400, 0, 0.05, { vol: 0.025, slide: -600 }),
  boom: () => (noise(0, 0.25, 0.12, 200), tone(90, 0, 0.2, { type: "triangle", vol: 0.15, slide: -40 })),
  die: () => tone(300, 0, 0.12, { vol: 0.04, slide: -200 }),
  victory: () => [N.C5, N.E5, N.G5, N.C6, N.G5, N.C6].forEach((f, i) => tone(f, i * 0.11, i === 5 ? 0.4 : 0.1, { vol: 0.07 })),
  defeat: () => [N.G4, N.F4, N.D4, N.C4].forEach((f, i) => tone(f, i * 0.16, 0.18, { type: "triangle", vol: 0.12 })),
  reveal: () => (noise(0, 0.3, 0.05, 3000), [N.C5, N.G5, N.C6].forEach((f, i) => tone(f, 0.25 + i * 0.09, 0.12, { type: "triangle", vol: 0.1 }))),
  error: () => (tone(160, 0, 0.09, { vol: 0.06 }), tone(120, 0.1, 0.12, { vol: 0.06 })),
  upgrade: () => [N.C4, N.G4, N.C5, N.E5, N.G5].forEach((f, i) => tone(f, i * 0.05, 0.06, { vol: 0.06 })),
  rumble: () => (noise(0, 0.9, 0.14, 120), tone(55, 0, 0.9, { type: "triangle", vol: 0.18, slide: -15 }), tone(41, 0.3, 0.7, { type: "triangle", vol: 0.14 })),
  waystone: () => [N.C6, N.G5, N.E5, N.C5, N.G4].forEach((f, i) => tone(f, i * 0.05, 0.07, { type: "triangle", vol: 0.1 })),
};
export function sfx(name) {
  if (!enabled) return;
  try {
    SFX[name]?.();
  } catch {
    /* audio not available */
  }
}
