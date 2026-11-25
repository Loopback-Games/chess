// Tiny chiptune sound effects synthesized with WebAudio square/triangle waves.
import { storage } from './net.js';

let ctx = null;
let muted = storage.get('chess:muted') === '1';

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// Browsers only allow audio after a user gesture; unlock on the first one.
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => audio(), { once: true, capture: true });

/** Play a sequence of [frequencyHz, durationSec] notes. */
function seq(notes, { type = 'square', gain = 0.06 } = {}) {
  if (muted) return;
  const ac = audio();
  if (!ac) return;
  let t = ac.currentTime + 0.01;
  for (const [freq, dur] of notes) {
    if (freq) {
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(ac.destination);
      osc.start(t);
      osc.stop(t + dur);
    }
    t += dur;
  }
}

export const sfx = {
  move: () => seq([[660, 0.05], [880, 0.06]]),
  capture: () => seq([[330, 0.05], [220, 0.05], [165, 0.09]]),
  check: () => seq([[988, 0.07], [0, 0.03], [988, 0.09]], { gain: 0.07 }),
  win: () => seq([[523, 0.1], [659, 0.1], [784, 0.1], [1047, 0.25]]),
  lose: () => seq([[392, 0.14], [330, 0.14], [262, 0.3]], { type: 'triangle', gain: 0.12 }),
  draw: () => seq([[523, 0.12], [523, 0.12], [392, 0.25]], { type: 'triangle', gain: 0.12 }),
  join: () => seq([[440, 0.06], [660, 0.08]], { type: 'triangle', gain: 0.1 }),
  tick: () => seq([[1200, 0.025]], { gain: 0.03 }),
};

export const isMuted = () => muted;
export function toggleMute() {
  muted = !muted;
  storage.set('chess:muted', muted ? '1' : '0');
  if (!muted) sfx.move();
  return muted;
}
