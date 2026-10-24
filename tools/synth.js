// Renders the original synthwave tracks and sound effects to WAV.
// Everything is synthesized from scratch: no samples, no game audio.
//   node tools/synth.js [outDir]
const fs = require('fs');
const path = require('path');

const SR = 44100;
const OUT = process.argv[2] || path.join(__dirname, '..', 'build', 'raw');

// ---------- utils ----------

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = rng(1984);
const noise = () => rand() * 2 - 1;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const NOTES = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const n = (s) => { const m = s.match(/^([A-G][#b]?)(-?\d)$/); return NOTES[m[1]] + (parseInt(m[2]) + 1) * 12; };

function writeWav(file, chans) {
  const len = chans[0].length, nc = chans.length;
  const buf = Buffer.alloc(44 + len * nc * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + len * nc * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(nc, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * nc * 2, 28); buf.writeUInt16LE(nc * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(len * nc * 2, 40);
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < nc; c++) {
    const v = Math.max(-1, Math.min(1, chans[c][i]));
    buf.writeInt16LE(Math.round(v * 32767), o); o += 2;
  }
  fs.writeFileSync(file, buf);
  console.log('wrote', path.basename(file), (len / SR).toFixed(1) + 's');
}

class Bus {
  constructor(len) { this.L = new Float32Array(len); this.R = new Float32Array(len); }
  // equal-power pan, -1..1
  addMono(src, pan = 0, gain = 1) {
    const a = (pan + 1) * Math.PI / 4, gl = Math.cos(a) * gain, gr = Math.sin(a) * gain;
    for (let i = 0; i < src.length; i++) { this.L[i] += src[i] * gl; this.R[i] += src[i] * gr; }
  }
  addStereo(L, R, gain = 1) {
    for (let i = 0; i < L.length; i++) { this.L[i] += L[i] * gain; this.R[i] += R[i] * gain; }
  }
  mul(env) { for (let i = 0; i < this.L.length; i++) { this.L[i] *= env[i]; this.R[i] *= env[i]; } }
}

// ---------- DSP building blocks ----------

// Zavalishin TPT state-variable filter
class SVF {
  constructor() { this.ic1 = 0; this.ic2 = 0; }
  run(x, fc, q, mode = 'lp') {
    const g = Math.tan(Math.PI * Math.min(Math.max(fc, 10), SR * 0.45) / SR), k = 1 / q;
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = x - this.ic2, v1 = a1 * this.ic1 + a2 * v3, v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    if (mode === 'lp') return v2;
    if (mode === 'bp') return v1;
    return x - k * v1 - v2; // hp
  }
}

function polyblep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
function osc(wave, ph, dt) {
  switch (wave) {
    case 'saw': return 2 * ph - 1 - polyblep(ph, dt);
    case 'square': return (ph < 0.5 ? 1 : -1) + polyblep(ph, dt) - polyblep((ph + 0.5) % 1, dt);
    case 'tri': return 1 - 4 * Math.abs(ph - 0.5);
    default: return Math.sin(2 * Math.PI * ph);
  }
}

function adsr(t, dur, a, d, s, r) {
  let v;
  if (t < a) v = t / a;
  else if (t < a + d) v = 1 - (1 - s) * ((t - a) / d);
  else v = s;
  if (t > dur) v *= Math.max(0, 1 - (t - dur) / r);
  return v;
}

const SYNTH_DEFAULTS = {
  wave: 'saw', unison: 1, detune: 0, sub: 0, cutoff: 2000, fenv: 0, fdecay: 0.1, q: 0.7, mode: 'lp',
  a: 0.005, d: 0.1, s: 0.8, r: 0.1, gain: 0.2, vibRate: 0, vibDepth: 0, drive: 0, fmIndex: 0, fmRatio: 2, fmDecay: 0.3,
};

// Adds one note into a mono buffer.
function note(out, startSec, durSec, freq, params) {
  const p = { ...SYNTH_DEFAULTS, ...params };
  const start = Math.floor(startSec * SR), len = Math.floor((durSec + p.r) * SR);
  const ratios = [], phases = [];
  for (let v = 0; v < p.unison; v++) {
    const spread = p.unison === 1 ? 0 : (v / (p.unison - 1)) * 2 - 1;
    ratios.push(Math.pow(2, (spread * p.detune) / 1200));
    phases.push(rand());
  }
  let subPh = 0, modPh = 0;
  const f = new SVF();
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx >= out.length) break;
    const t = i / SR;
    const vib = p.vibDepth ? Math.pow(2, (p.vibDepth / 1200) * Math.sin(2 * Math.PI * p.vibRate * t) * Math.min(1, t / 0.25)) : 1;
    const fr = freq * vib;
    let s = 0;
    if (p.wave === 'fm') {
      modPh += (fr * p.fmRatio) / SR;
      const idxMod = p.fmIndex * Math.exp(-t / p.fmDecay);
      phases[0] += fr / SR;
      s = Math.sin(2 * Math.PI * phases[0] + idxMod * Math.sin(2 * Math.PI * modPh));
    } else {
      for (let v = 0; v < p.unison; v++) {
        const dt = (fr * ratios[v]) / SR;
        s += osc(p.wave, phases[v], dt);
        phases[v] = (phases[v] + dt) % 1;
      }
      s /= Math.sqrt(p.unison);
    }
    if (p.sub) { subPh = (subPh + fr / 2 / SR) % 1; s += p.sub * Math.sin(2 * Math.PI * subPh); }
    let y = p.cutoff ? f.run(s, p.cutoff + p.fenv * Math.exp(-t / p.fdecay), p.q, p.mode) : s;
    if (p.drive) y = Math.tanh(y * p.drive) / Math.tanh(p.drive);
    out[idx] += y * adsr(t, durSec, p.a, p.d, p.s, p.r) * p.gain;
  }
}

// ---------- drums ----------

function kick(out, t0, gain = 1, tone = 1) {
  const st = Math.floor(t0 * SR), len = Math.floor(0.5 * SR);
  let ph = 0;
  for (let i = 0; i < len && st + i < out.length; i++) {
    const t = i / SR;
    const f = 42 * tone + 120 * Math.exp(-t / 0.03);
    ph += f / SR;
    let s = Math.sin(2 * Math.PI * ph) * Math.exp(-t / 0.32);
    s += noise() * Math.exp(-t / 0.002) * 0.25;
    out[st + i] += Math.tanh(s * 1.8) * 0.9 * gain;
  }
}
function snare(out, t0, gain = 1) {
  const st = Math.floor(t0 * SR), len = Math.floor(0.35 * SR), f = new SVF();
  let ph = 0;
  for (let i = 0; i < len && st + i < out.length; i++) {
    const t = i / SR;
    ph += (180 + 60 * Math.exp(-t / 0.01)) / SR;
    const tone = Math.sin(2 * Math.PI * ph) * Math.exp(-t / 0.07) * 0.5;
    const nz = f.run(noise(), 2200, 0.6, 'bp') * Math.exp(-t / 0.13) * 1.6;
    out[st + i] += (tone + nz) * gain;
  }
}
function clap(out, t0, gain = 1) {
  const st = Math.floor(t0 * SR), len = Math.floor(0.3 * SR), f = new SVF();
  for (let i = 0; i < len && st + i < out.length; i++) {
    const t = i / SR;
    let e = Math.exp(-t / 0.11);
    for (const b of [0, 0.011, 0.022]) if (t >= b && t < b + 0.01) e = Math.max(e, Math.exp(-(t - b) / 0.004));
    out[st + i] += f.run(noise(), 1300, 1.4, 'bp') * e * 1.8 * gain;
  }
}
function hat(out, t0, gain = 1, open = false) {
  const st = Math.floor(t0 * SR), dec = open ? 0.22 : 0.035, len = Math.floor(dec * 6 * SR), f = new SVF();
  for (let i = 0; i < len && st + i < out.length; i++) {
    const t = i / SR;
    out[st + i] += f.run(noise(), 7500, 0.9, 'hp') * Math.exp(-t / dec) * 0.35 * gain;
  }
}
function crash(out, t0, gain = 1) {
  const st = Math.floor(t0 * SR), len = Math.floor(2.5 * SR), f = new SVF();
  for (let i = 0; i < len && st + i < out.length; i++) {
    const t = i / SR;
    out[st + i] += f.run(noise(), 4500, 0.7, 'hp') * Math.exp(-t / 0.7) * 0.4 * gain;
  }
}
function riser(out, t0, dur, gain = 1) {
  const st = Math.floor(t0 * SR), len = Math.floor(dur * SR), f = new SVF();
  for (let i = 0; i < len && st + i < out.length; i++) {
    const x = i / len;
    out[st + i] += f.run(noise(), 300 + 9000 * x * x, 2, 'bp') * x * x * 0.6 * gain;
  }
}

// ---------- effects ----------

function reverb(inL, inR, { room = 0.84, damp = 0.35 } = {}) {
  const combLens = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const apLens = [556, 441, 341, 225];
  const mk = (lens, off) => lens.map((l) => ({ buf: new Float32Array(l + off), i: 0, store: 0 }));
  const sides = [[mk(combLens, 0), mk(apLens, 0)], [mk(combLens, 23), mk(apLens, 23)]];
  const len = inL.length, out = [new Float32Array(len), new Float32Array(len)];
  for (let i = 0; i < len; i++) {
    const x = (inL[i] + inR[i]) * 0.015;
    for (let c = 0; c < 2; c++) {
      const [combs, aps] = sides[c];
      let s = 0;
      for (const cb of combs) {
        const o = cb.buf[cb.i];
        cb.store = o * (1 - damp) + cb.store * damp;
        cb.buf[cb.i] = x + cb.store * room;
        if (++cb.i >= cb.buf.length) cb.i = 0;
        s += o;
      }
      for (const ap of aps) {
        const o = ap.buf[ap.i];
        ap.buf[ap.i] = s + o * 0.5;
        if (++ap.i >= ap.buf.length) ap.i = 0;
        s = o - s;
      }
      out[c][i] = s;
    }
  }
  return out;
}

function delay(inL, inR, time, fb, pingpong = true) {
  const d = Math.floor(time * SR), len = inL.length;
  const L = new Float32Array(len), R = new Float32Array(len);
  const fl = new SVF(), fr = new SVF();
  for (let i = 0; i < len; i++) {
    const dl = i >= d ? L[i - d] : 0, dr = i >= d ? R[i - d] : 0;
    if (pingpong) {
      L[i] = fl.run((inL[i] + inR[i]) * 0.5 + dr * fb, 4000, 0.7);
      R[i] = fr.run(dl * fb, 4000, 0.7);
    } else {
      L[i] = fl.run(inL[i] + dl * fb, 4000, 0.7);
      R[i] = fr.run(inR[i] + dr * fb, 4000, 0.7);
    }
  }
  return [L, R];
}

// Ducking envelope that dips after every kick hit.
function sidechain(len, hits, depth = 0.6, rel = 0.18) {
  const env = new Float32Array(len).fill(1);
  for (const t of hits) {
    const st = Math.floor(t * SR), n2 = Math.floor(rel * 4 * SR);
    for (let i = 0; i < n2 && st + i < len; i++) {
      const tt = i / SR;
      const g = 1 - depth * Math.min(1, tt / 0.004) * Math.exp(-tt / rel);
      env[st + i] = Math.min(env[st + i], g);
    }
  }
  return env;
}

// Gated reverb: only lets the tail through for `open` seconds after each hit.
function gate(len, hits, open = 0.28) {
  const env = new Float32Array(len);
  for (const t of hits) {
    const st = Math.floor(t * SR), n2 = Math.floor((open + 0.03) * SR);
    for (let i = 0; i < n2 && st + i < len; i++) {
      const tt = i / SR;
      env[st + i] = Math.max(env[st + i], tt < open ? 1 : 1 - (tt - open) / 0.03);
    }
  }
  return env;
}

// Tape: saturation, wow & flutter, hiss, gentle top-end roll-off.
function tape(bus, { wow = 0.0012, flutter = 0.00015, hiss = 0.006, drive = 1.3 } = {}) {
  const len = bus.L.length;
  const out = [new Float32Array(len), new Float32Array(len)];
  const lps = [new SVF(), new SVF()], hs = new SVF();
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const dSec = 0.004 + wow * Math.sin(2 * Math.PI * 0.55 * t) + flutter * Math.sin(2 * Math.PI * 7.1 * t);
    const pos = i - dSec * SR;
    const h = hs.run(noise(), 6000, 0.5, 'bp') * hiss;
    [bus.L, bus.R].forEach((src, c) => {
      const i0 = Math.floor(pos), fr = pos - i0;
      const a = i0 >= 0 && i0 < len ? src[i0] : 0, b = i0 + 1 >= 0 && i0 + 1 < len ? src[i0 + 1] : 0;
      let s = a + (b - a) * fr;
      s = Math.tanh(s * drive) / drive;
      out[c][i] = lps[c].run(s, 13000, 0.6) + h;
    });
  }
  bus.L = out[0]; bus.R = out[1];
}

function finish(bus, { fadeIn = 0, fadeOut = 3, peak = 0.92 } = {}) {
  const len = bus.L.length;
  let m = 0;
  for (let i = 0; i < len; i++) m = Math.max(m, Math.abs(bus.L[i]), Math.abs(bus.R[i]));
  const g = peak / m;
  for (let i = 0; i < len; i++) {
    const t = i / SR, rem = (len - i) / SR;
    let e = 1;
    if (fadeIn && t < fadeIn) e *= t / fadeIn;
    if (fadeOut && rem < fadeOut) e *= rem / fadeOut;
    bus.L[i] *= g * e; bus.R[i] *= g * e;
  }
  return [bus.L, bus.R];
}

// ---------- songwriting helpers ----------

function song(bpm, bars, tail = 3) {
  const beat = 60 / bpm, step = beat / 4, bar = beat * 4;
  const len = Math.floor((bars * bar + tail) * SR);
  const mono = () => new Float32Array(len);
  return { bpm, beat, step, bar, bars, len, mono, at: (b, s = 0) => b * bar + s * step };
}
const inRange = (b, ranges) => ranges.some(([a, z]) => b >= a && b < z);

// 4-bar phrase: [step, length16, midi]
function playPhrase(buf, S, bar0, phrase, params, transpose = 0) {
  for (const [st, l, m] of phrase) note(buf, S.at(bar0, st), l * S.step * 0.95, mtof(m + transpose), params);
}

function mixdown(S, layers, opts) {
  const master = new Bus(S.len);
  for (const l of layers) {
    const L = l.L || l.buf, R = l.R || l.buf;
    const dry = new Bus(S.len);
    if (l.R) dry.addStereo(L, R, 1); else dry.addMono(l.buf, l.pan || 0, 1);
    if (l.delay) {
      const [dL, dR] = delay(dry.L, dry.R, l.delay.time, l.delay.fb, l.delay.pingpong !== false);
      dry.addStereo(dL, dR, l.delay.wet);
    }
    if (l.rev) {
      const [rL, rR] = reverb(dry.L, dry.R, l.revOpts);
      if (l.revGate) { for (let i = 0; i < S.len; i++) { rL[i] *= l.revGate[i]; rR[i] *= l.revGate[i]; } }
      dry.addStereo(rL, rR, l.rev);
    }
    if (l.duck) dry.mul(l.duck);
    master.addStereo(dry.L, dry.R, l.gain ?? 1);
  }
  tape(master, opts.tape);
  return finish(master, opts.finish);
}

// ---------- TRACK 1: MIDNIGHT CALL (118 bpm, A minor, driving) ----------

function midnightCall() {
  rand = rng(118);
  const S = song(118, 40);
  const chords = [['A', 'C', 'E'], ['F', 'A', 'C'], ['C', 'E', 'G'], ['G', 'B', 'D']];
  const roots = [n('A1'), n('F1'), n('C2'), n('G1')];
  const kickB = S.mono(), snB = S.mono(), hatB = S.mono(), bassB = S.mono(), arpB = S.mono(), leadB = S.mono();
  const padL = S.mono(), padR = S.mono();
  const kicks = [], snares = [];

  const bassPat = [0, 0, 12, 0, 0, 0, 12, 0, 0, 0, 12, 0, 0, 7, 12, 0];
  const arpPat = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1, 2, 3];

  for (let b = 0; b < S.bars; b++) {
    const ci = b % 4, ch = chords[ci];
    const drums = inRange(b, [[4, 20], [24, 38]]);
    const full = inRange(b, [[12, 20], [24, 36]]);

    // pad
    if (b < 38) {
      const tones = [n(ch[0] + '3'), ...ch.map((c) => n(c + '4'))].map((m, i) => (i > 0 && m > n('E4') + 2 ? m - 12 : m));
      for (const m of tones) {
        const pp = { wave: 'saw', unison: 3, detune: 14, cutoff: full ? 1800 : 1100, q: 0.8, a: 0.5, d: 0.6, s: 0.8, r: 0.8, gain: 0.05 };
        note(padL, S.at(b), S.bar, mtof(m), pp);
        note(padR, S.at(b), S.bar, mtof(m), { ...pp, detune: 17 });
      }
    }
    // arp
    const arpTones = [n(ch[0] + '4'), n(ch[1] + '4'), n(ch[2] + '4'), n(ch[0] + '5'), n(ch[1] + '5')].map((m, i, a) => (i > 0 && m < a[0] ? m + 12 : m));
    for (let s = 0; s < 16; s++) {
      const open = Math.min(1, b / 8);
      note(arpB, S.at(b, s), S.step * 0.5, mtof(arpTones[arpPat[s]]), { wave: 'square', cutoff: 600 + 1400 * open, fenv: 2500, fdecay: 0.05, q: 1.5, a: 0.001, d: 0.1, s: 0, r: 0.04, gain: 0.1 });
    }
    // bass
    if (inRange(b, [[4, 20], [24, 38]])) {
      for (let s = 0; s < 16; s++) {
        note(bassB, S.at(b, s), S.step * 0.7, mtof(roots[ci] + bassPat[s]), { wave: 'saw', sub: 0.6, cutoff: 260, fenv: 1600, fdecay: 0.07, q: 1.3, a: 0.002, d: 0.1, s: 0.6, r: 0.03, gain: 0.3 });
      }
    } else if (inRange(b, [[20, 24]])) {
      note(bassB, S.at(b), S.bar * 0.95, mtof(roots[ci]), { wave: 'saw', sub: 0.8, cutoff: 300, a: 0.2, r: 0.4, gain: 0.25 });
    }
    // drums
    if (drums) {
      for (let s = 0; s < 16; s += 4) { kick(kickB, S.at(b, s)); kicks.push(S.at(b, s)); }
    }
    if (full) {
      for (const s of [4, 12]) { snare(snB, S.at(b, s)); snares.push(S.at(b, s)); }
      for (let s = 0; s < 16; s++) hat(hatB, S.at(b, s), s % 4 === 2 ? 1 : 0.35, s % 8 === 6);
    } else if (drums) {
      for (let s = 2; s < 16; s += 4) hat(hatB, S.at(b, s), 0.6);
    }
    if (b === 11 || b === 23) for (let s = 12; s < 16; s++) { snare(snB, S.at(b, s), 0.4 + s * 0.04); snares.push(S.at(b, s)); }
  }
  for (const b of [12, 24]) crash(hatB, S.at(b));

  const ph1 = [[0, 6, n('E5')], [6, 2, n('D5')], [8, 4, n('C5')], [12, 4, n('A4')],
    [16, 6, n('C5')], [22, 2, n('A4')], [24, 4, n('C5')], [28, 4, n('D5')],
    [32, 6, n('E5')], [38, 2, n('G5')], [40, 4, n('E5')], [44, 4, n('D5')],
    [48, 8, n('D5')], [56, 4, n('B4')], [60, 4, n('G4')]];
  const ph2 = [...ph1.slice(0, 12), [48, 6, n('D5')], [54, 2, n('E5')], [56, 8, n('A5')]];
  const lead = { wave: 'saw', unison: 2, detune: 9, cutoff: 2200, fenv: 1800, fdecay: 0.15, q: 1, a: 0.01, d: 0.2, s: 0.7, r: 0.2, gain: 0.11, vibRate: 5.5, vibDepth: 14 };
  for (const [b, ph] of [[12, ph1], [16, ph2], [24, ph1], [28, ph2], [32, ph1]]) playPhrase(leadB, S, b, ph, lead);

  const duck = sidechain(S.len, kicks, 0.55);
  return mixdown(S, [
    { buf: kickB, gain: 0.9 },
    { buf: snB, gain: 0.55, rev: 1.6, revOpts: { room: 0.88 }, revGate: gate(S.len, snares) },
    { buf: hatB, gain: 0.5, pan: 0.25 },
    { buf: bassB, gain: 0.8, duck },
    { buf: arpB, gain: 0.7, pan: -0.2, delay: { time: S.beat * 0.75, fb: 0.38, wet: 0.45 }, duck },
    { L: padL, R: padR, gain: 0.8, rev: 0.6, duck },
    { buf: leadB, gain: 0.8, delay: { time: S.beat * 0.75, fb: 0.3, wet: 0.3 }, rev: 0.5 },
  ], { tape: {}, finish: { fadeIn: 0.5, fadeOut: 6 } });
}

// ---------- TRACK 2: FIFTY BLESSINGS (90 bpm, D minor, hazy) ----------

function fiftyBlessings() {
  rand = rng(90);
  const S = song(90, 32, 4);
  const chords = [['D', 'F', 'A'], ['Bb', 'D', 'F'], ['G', 'Bb', 'D'], ['A', 'C#', 'E']];
  const roots = [n('D2'), n('Bb1'), n('G1'), n('A1')];
  const kickB = S.mono(), snB = S.mono(), hatB = S.mono(), bassB = S.mono(), bellB = S.mono(), leadB = S.mono();
  const padL = S.mono(), padR = S.mono();
  const kicks = [], snares = [];
  const bellPat = [0, 1, 2, 3, 4, 3, 2, 1];

  for (let b = 0; b < S.bars; b++) {
    const ci = b % 4, ch = chords[ci];
    const drums = inRange(b, [[4, 20], [24, 31]]);
    const full = inRange(b, [[12, 20], [24, 31]]);

    for (const m of [n(ch[0] + '3'), n(ch[1] + '3'), n(ch[2] + '3'), n(ch[0] + '4')].map((m, i, a) => (m < a[0] ? m + 12 : m))) {
      const pp = { wave: 'saw', unison: 4, detune: 22, cutoff: 850, q: 0.7, a: 1.0, d: 0.5, s: 0.85, r: 1.4, gain: 0.05 };
      note(padL, S.at(b), S.bar, mtof(m), pp);
      note(padR, S.at(b), S.bar, mtof(m), { ...pp, detune: 26 });
    }
    const tones = [n(ch[0] + '5'), n(ch[1] + '5'), n(ch[2] + '5'), n(ch[0] + '6'), n(ch[1] + '6')].map((m, i, a) => (m < a[0] ? m + 12 : m));
    if (b < 30) for (let s = 0; s < 8; s++) {
      note(bellB, S.at(b, s * 2), S.step * 1.5, mtof(tones[bellPat[s]]), { wave: 'fm', fmRatio: 3.5, fmIndex: 2.2, fmDecay: 0.15, cutoff: 0, a: 0.001, d: 0.6, s: 0, r: 0.3, gain: 0.06 });
    }
    if (inRange(b, [[4, 31]])) {
      note(bassB, S.at(b), S.bar * 0.97, mtof(roots[ci]), { wave: 'tri', sub: 0.7, cutoff: 500, a: 0.02, d: 0.4, s: 0.8, r: 0.2, gain: 0.35 });
    }
    if (drums) {
      for (const s of [0, 10]) { kick(kickB, S.at(b, s), 0.9, 0.95); kicks.push(S.at(b, s)); }
    }
    if (full) {
      snare(snB, S.at(b, 8)); snares.push(S.at(b, 8));
      for (let s = 2; s < 16; s += 4) hat(hatB, S.at(b, s), 0.5);
      for (const s of [7, 15]) hat(hatB, S.at(b, s), 0.2);
    }
  }
  crash(hatB, S.at(12), 0.7); crash(hatB, S.at(24), 0.7);

  const ph1 = [[0, 12, n('A4')], [12, 4, n('G4')], [16, 8, n('F4')], [24, 8, n('D4')],
    [32, 8, n('G4')], [40, 8, n('Bb4')], [48, 12, n('A4')], [60, 4, n('C#5')]];
  const ph2 = [[0, 12, n('D5')], [12, 4, n('C5')], [16, 8, n('Bb4')], [24, 8, n('A4')],
    [32, 8, n('G4')], [40, 4, n('Bb4')], [44, 4, n('A4')], [48, 16, n('A4')]];
  const lead = { wave: 'tri', cutoff: 2500, a: 0.08, d: 0.3, s: 0.8, r: 0.5, gain: 0.16, vibRate: 4.5, vibDepth: 18 };
  for (const [b, ph] of [[12, ph1], [16, ph2], [20, ph2], [24, ph1], [28, ph2]]) playPhrase(leadB, S, b, ph, lead);

  const duck = sidechain(S.len, kicks, 0.45, 0.3);
  return mixdown(S, [
    { buf: kickB, gain: 0.85 },
    { buf: snB, gain: 0.5, rev: 2.2, revOpts: { room: 0.92 } },
    { buf: hatB, gain: 0.45, pan: -0.3 },
    { buf: bassB, gain: 0.8, duck },
    { buf: bellB, gain: 0.8, delay: { time: S.beat * 0.75, fb: 0.5, wet: 0.55 }, rev: 0.8, duck },
    { L: padL, R: padR, gain: 0.85, rev: 1.0, revOpts: { room: 0.9 }, duck },
    { buf: leadB, gain: 0.75, delay: { time: S.beat, fb: 0.35, wet: 0.35 }, rev: 1.0 },
  ], { tape: { wow: 0.0028, flutter: 0.0002, hiss: 0.009 }, finish: { fadeIn: 1.5, fadeOut: 7 } });
}

// ---------- TRACK 3: ROOSTER (138 bpm, E phrygian, aggressive) ----------

function rooster() {
  rand = rng(138);
  const S = song(138, 48, 3);
  const roots = [0, 0, 1, -2]; // E E F D
  const kickB = S.mono(), snB = S.mono(), hatB = S.mono(), bassB = S.mono(), stabB = S.mono(), leadB = S.mono(), fxB = S.mono();
  const kicks = [], snares = [];
  const bassPat = [0, 12, 0, 0, 12, 0, 0, 12, 0, 0, 12, 0, 0, 12, 10, 12];
  const riff = [n('E5'), n('F5'), n('E5'), n('B4'), n('G4'), n('B4'), n('E5'), n('F5'), n('G5'), n('F5'), n('E5'), n('B4'), n('C5'), n('B4'), n('G4'), n('B4')];

  for (let b = 0; b < S.bars; b++) {
    const tr = roots[b % 4];
    const drums = inRange(b, [[4, 32], [36, 47]]);
    const full = inRange(b, [[16, 32], [36, 47]]);

    if (b < 47) {
      const open = b < 4 ? 0.25 + b * 0.15 : 1;
      for (let s = 0; s < 16; s++) {
        note(bassB, S.at(b, s), S.step * 0.6, mtof(n('E1') + tr + bassPat[s]), { wave: 'saw', unison: 2, detune: 8, sub: 0.5, cutoff: 300 * open, fenv: 2600 * open, fdecay: 0.05, q: 1.8, a: 0.001, d: 0.08, s: 0.5, r: 0.02, gain: 0.3, drive: 3 });
      }
    }
    if (drums) {
      for (let s = 0; s < 16; s += 4) { kick(kickB, S.at(b, s), 1, 1.1); kicks.push(S.at(b, s)); }
      for (const s of [4, 12]) { clap(snB, S.at(b, s)); snare(snB, S.at(b, s), 0.5); snares.push(S.at(b, s)); }
      for (let s = 0; s < 16; s++) hat(hatB, S.at(b, s), s % 4 === 2 ? 0.9 : 0.3, s % 4 === 2);
    } else if (b < 4) {
      for (let s = 0; s < 16; s += 2) hat(hatB, S.at(b, s), 0.4);
    }
    if (b === 15 || b === 31 || b === 46) for (let s = 8; s < 16; s++) { snare(snB, S.at(b, s), 0.35 + s * 0.04); snares.push(S.at(b, s)); }
    if (full) {
      for (const s of [0, 3, 6, 10, 12]) {
        for (const m of [n('E4'), n('B4'), n('E5')]) note(stabB, S.at(b, s), S.step * 1.2, mtof(m + tr), { wave: 'saw', unison: 3, detune: 15, cutoff: 1800, fenv: 3500, fdecay: 0.08, q: 1, a: 0.002, d: 0.15, s: 0.2, r: 0.1, gain: 0.055 });
      }
      if (inRange(b, [[24, 32], [36, 47]])) {
        for (let s = 0; s < 16; s++) note(leadB, S.at(b, s), S.step * 0.6, mtof(riff[s] + tr), { wave: 'square', cutoff: 1500, fenv: 3000, fdecay: 0.06, q: 2, a: 0.001, d: 0.08, s: 0.3, r: 0.03, gain: 0.09 });
      }
    }
  }
  riser(fxB, S.at(32), S.bar * 4);
  for (const b of [16, 36]) crash(hatB, S.at(b));
  kick(kickB, S.at(47)); crash(hatB, S.at(47), 1.2);
  note(stabB, S.at(47), S.bar, mtof(n('E3')), { wave: 'saw', unison: 4, detune: 20, cutoff: 1200, a: 0.002, d: 1.5, s: 0, r: 1, gain: 0.2 });

  const duck = sidechain(S.len, kicks, 0.6, 0.12);
  return mixdown(S, [
    { buf: kickB, gain: 1 },
    { buf: snB, gain: 0.5, rev: 1.2, revGate: gate(S.len, snares, 0.2) },
    { buf: hatB, gain: 0.45, pan: 0.3 },
    { buf: bassB, gain: 0.75, duck },
    { buf: stabB, gain: 0.8, rev: 0.6, delay: { time: S.beat * 0.5, fb: 0.25, wet: 0.25 }, duck },
    { buf: leadB, gain: 0.7, pan: -0.15, delay: { time: S.beat * 0.75, fb: 0.35, wet: 0.35 }, duck },
    { buf: fxB, gain: 0.6, rev: 0.8 },
  ], { tape: { drive: 1.6 }, finish: { fadeIn: 0, fadeOut: 2.5 } });
}

// ---------- SOUND EFFECTS ----------

function fx(seconds, fn, { rev = 0, peak = 0.9, stereo = false } = {}) {
  const len = Math.floor(seconds * SR), buf = new Float32Array(len);
  fn(buf, len);
  const bus = new Bus(len);
  bus.addMono(buf);
  if (rev) { const [rL, rR] = reverb(bus.L, bus.R, { room: 0.8 }); bus.addStereo(rL, rR, rev); }
  const out = finish(bus, { fadeOut: 0.05, peak });
  return stereo ? out : [out[0].map((v, i) => (v + out[1][i]) / 2)];
}

const SFX = {
  // Old electromechanical phone bell: double ring, twice.
  ring: () => fx(4.2, (b) => {
    for (const t0 of [0, 0.6, 2.4, 3.0]) {
      const st = Math.floor(t0 * SR), len = Math.floor(0.45 * SR);
      for (let i = 0; i < len; i++) {
        const t = i / SR, strike = 0.5 + 0.5 * Math.sign(Math.sin(2 * Math.PI * 22 * t));
        let s = 0;
        for (const [f, a] of [[1180, 1], [1630, 0.6], [2480, 0.35], [3510, 0.2]]) s += a * Math.sin(2 * Math.PI * f * t);
        const env = Math.min(1, t / 0.01) * Math.min(1, (0.45 - t) / 0.06);
        b[st + i] += s * env * (0.55 + 0.45 * strike) * 0.3;
      }
    }
  }, { rev: 0.25 }),
  beep: () => fx(0.7, (b) => {
    for (let i = 0; i < 0.55 * SR; i++) {
      const t = i / SR, env = Math.min(1, t / 0.005) * Math.min(1, (0.55 - t) / 0.01);
      b[i] = (Math.sin(2 * Math.PI * 1000 * t) + 0.15 * Math.sign(Math.sin(2 * Math.PI * 1000 * t))) * env * 0.5;
    }
  }),
  click: () => fx(0.35, (b) => {
    const f = new SVF();
    for (let i = 0; i < 0.35 * SR; i++) {
      const t = i / SR;
      let s = f.run(noise(), 3000, 1, 'bp') * (Math.exp(-t / 0.003) + 0.6 * (t > 0.09 ? Math.exp(-(t - 0.09) / 0.004) : 0));
      s += Math.sin(2 * Math.PI * 90 * t) * Math.exp(-t / 0.03) * 0.5;
      b[i] = s;
    }
  }, { peak: 0.6 }),
  hangup: () => fx(2.6, (b) => {
    const f = new SVF();
    for (let i = 0; i < b.length; i++) {
      const t = i / SR;
      let s = f.run(noise(), 2000, 1, 'bp') * Math.exp(-t / 0.01) * 1.5 + Math.sin(2 * Math.PI * 70 * t) * Math.exp(-t / 0.05);
      if (t > 0.5) s += 0.25 * (Math.sin(2 * Math.PI * 350 * t) + Math.sin(2 * Math.PI * 440 * t)) * Math.min(1, (t - 0.5) / 0.02);
      b[i] = s;
    }
  }),
  punch: () => fx(0.6, (b) => {
    const f = new SVF(), f2 = new SVF();
    let ph = 0;
    for (let i = 0; i < b.length; i++) {
      const t = i / SR;
      ph += (45 + 90 * Math.exp(-t / 0.02)) / SR;
      let s = Math.sin(2 * Math.PI * ph) * Math.exp(-t / 0.09) * 1.2;
      s += f.run(noise(), 900, 0.8) * Math.exp(-t / 0.05) * 1.4;
      s += f2.run(noise(), 4000, 1, 'hp') * Math.exp(-t / 0.008) * 0.8;
      b[i] = Math.tanh(s * 2.5);
    }
  }, { rev: 0.1 }),
  door: () => fx(1.4, (b) => {
    const f = new SVF(), f2 = new SVF();
    let ph = 0;
    for (let i = 0; i < b.length; i++) {
      const t = i / SR;
      ph += (55 + 60 * Math.exp(-t / 0.03)) / SR;
      let s = Math.sin(2 * Math.PI * ph) * Math.exp(-t / 0.18) * 1.3;
      s += f.run(noise(), 550, 1.6, 'bp') * Math.exp(-t / 0.12) * 2.5;
      if (t > 0.12) s += f2.run(noise(), 1800, 3, 'bp') * Math.exp(-(t - 0.12) / 0.15) * 0.8 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 38 * t));
      b[i] = Math.tanh(s * 2);
    }
  }, { rev: 0.35 }),
  bat: () => fx(0.9, (b) => {
    const f = new SVF(), f2 = new SVF();
    for (let i = 0; i < b.length; i++) {
      const t = i / SR;
      let s = 0;
      if (t < 0.18) s += f.run(noise(), 400 + 3000 * (t / 0.18), 2.5, 'bp') * (t / 0.18) * 0.6; // whoosh
      const tt = t - 0.18;
      if (tt >= 0) {
        s += f2.run(noise(), 2600, 1.2, 'bp') * Math.exp(-tt / 0.02) * 2.5;
        s += Math.sin(2 * Math.PI * 820 * tt) * Math.exp(-tt / 0.05) * 0.6;
        s += Math.sin(2 * Math.PI * 70 * tt) * Math.exp(-tt / 0.08) * 0.9;
      }
      b[i] = Math.tanh(s * 1.8);
    }
  }, { rev: 0.2 }),
  shotgun: () => fx(2.2, (b) => {
    const f = new SVF(), f2 = new SVF();
    let ph = 0;
    for (let i = 0; i < b.length; i++) {
      const t = i / SR;
      ph += (40 + 120 * Math.exp(-t / 0.015)) / SR;
      let s = f.run(noise(), 200 + 7000 * Math.exp(-t / 0.05), 0.7) * Math.exp(-t / 0.18) * 2;
      s += Math.sin(2 * Math.PI * ph) * Math.exp(-t / 0.15) * 1.5;
      if (t > 0.45 && t < 0.75) s += f2.run(noise(), 2500, 2, 'bp') * Math.exp(-(t - 0.45) / 0.02) * 0.8; // pump
      if (t > 0.6) s += f2.run(noise(), 1800, 2, 'bp') * Math.exp(-(t - 0.6) / 0.02) * 0.7;
      b[i] = Math.tanh(s * 3);
    }
  }, { rev: 0.5 }),
  // Rising arpeggio sting.
  clear: () => {
    rand = rng(7);
    return fx(2.5, (b) => {
      [n('A4'), n('C5'), n('E5'), n('A5'), n('C6'), n('E6')].forEach((m, i) =>
        note(b, i * 0.07, i === 5 ? 1.0 : 0.12, mtof(m), { wave: 'square', cutoff: 3000, fenv: 2000, a: 0.002, d: 0.2, s: 0.5, r: 0.4, gain: 0.25, vibRate: i === 5 ? 6 : 0, vibDepth: 20 }));
    }, { rev: 0.5 });
  },
  rewind: () => fx(1.0, (b) => {
    const f = new SVF();
    let ph = 0;
    for (let i = 0; i < b.length; i++) {
      const t = i / SR, x = t / 1.0;
      ph += (900 + 2500 * x + 300 * Math.sin(2 * Math.PI * 13 * t)) / SR;
      b[i] = (f.run(noise(), 2500 + 3000 * x, 3, 'bp') * 0.5 + Math.sin(2 * Math.PI * ph) * 0.08) * Math.min(1, t / 0.05) * Math.min(1, (1 - t) / 0.08);
    }
  }, { peak: 0.5 }),
  // Jacket's "line": nothing but tape hiss.
  hiss: () => fx(3.0, (b) => {
    const f = new SVF();
    for (let i = 0; i < b.length; i++) {
      const t = i / SR;
      b[i] = f.run(noise(), 5000, 0.4, 'bp') * Math.min(1, t / 0.2) * Math.min(1, (3 - t) / 0.3) + (rand() < 0.0004 ? noise() * 4 : 0);
    }
  }, { peak: 0.25 }),
};

// ---------- main ----------

fs.mkdirSync(OUT, { recursive: true });
const only = process.argv[3];
const jobs = {
  t1: midnightCall, t2: fiftyBlessings, t3: rooster,
  ...Object.fromEntries(Object.entries(SFX).map(([k, f]) => ['fx_' + k, f])),
};
for (const [name, job] of Object.entries(jobs)) {
  if (only && !name.startsWith(only)) continue;
  const t = Date.now();
  writeWav(path.join(OUT, name + '.wav'), job());
  console.log('   ', ((Date.now() - t) / 1000).toFixed(1) + 's render');
}
