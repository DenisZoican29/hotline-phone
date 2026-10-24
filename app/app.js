'use strict';

const $ = (s) => document.querySelector(s);
const MUSIC_LEVEL = 0.8;
const DUCK_LEVEL = 0.18;

let content;
let ctx, voiceGain, fxGain, musicGain;
const cache = new Map();
// Songs stream through one <audio> element (full songs are too big to decode into memory on a phone).
const music = { track: null, el: null };
let voice = null; // the line currently playing
let wakeLock = null;

// ---------- shuffle: everything plays once before anything repeats ----------

function shuffleBag(items) {
  let bag = [];
  let last = null;
  return () => {
    if (!bag.length) {
      bag = [...items];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      // Don't repeat the last pick across a refill.
      if (bag.length > 1 && bag[bag.length - 1] === last) bag.unshift(bag.pop());
    }
    last = bag.pop();
    return last;
  };
}
let nextLine, nextSong;

// ---------- audio ----------

// Must run inside a tap handler: iOS only starts audio from a user gesture.
function initAudio() {
  if (ctx) {
    if (ctx.state !== 'running') ctx.resume();
    return;
  }
  try { if ('audioSession' in navigator) navigator.audioSession.type = 'playback'; } catch {} // play even with the silent switch on
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -8;
  glue.ratio.value = 4;
  glue.connect(ctx.destination);
  const bus = (v) => { const g = ctx.createGain(); g.gain.value = v; g.connect(glue); return g; };
  voiceGain = bus(1.35);
  fxGain = bus(0.75);
  musicGain = bus(MUSIC_LEVEL);
  music.el = new Audio();
  music.el.preload = 'auto';
  ctx.createMediaElementSource(music.el).connect(musicGain);
  music.el.addEventListener('ended', () => { if (music.track) playSong(); }); // the tape keeps going
  const s = ctx.createBufferSource();
  s.buffer = ctx.createBuffer(1, 1, 22050);
  s.connect(ctx.destination);
  s.start(0);
  ctx.resume();
  keepAwake();
  // Warm the cache so the voice button reacts instantly.
  setTimeout(() => content.messages.forEach((m) => load(msgUrl(m.id)).catch(() => {})), 1000);
}

function load(url) {
  if (!cache.has(url)) {
    const p = fetch(url)
      .then((r) => { if (!r.ok) throw new Error(url); return r.arrayBuffer(); })
      .then((ab) => new Promise((res, rej) => ctx.decodeAudioData(ab, res, rej)));
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return cache.get(url);
}

function playBuf(buf, when, dest, gain = 1) {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  if (gain !== 1) {
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(dest);
  } else {
    src.connect(dest);
  }
  src.start(when);
  return src;
}

function stopSrc(src) { try { src.onended = null; src.stop(); } catch {} }

function duck(on) {
  musicGain.gain.setTargetAtTime(on ? DUCK_LEVEL : MUSIC_LEVEL, ctx.currentTime, on ? 0.08 : 0.4);
}

const msgUrl = (id) => `audio/msg/${id}.mp3`;
const fxUrl = (id) => `audio/fx/${id}.mp3`;

// ---------- voice button ----------

async function playVoice() {
  initAudio();
  stopVoice();
  const msg = nextLine();
  const v = { msg, srcs: [], start: 0, buf: null };
  voice = v;
  updateUI();
  duck(true);

  // Answering-machine calls start with the beep, the masks with a tape click.
  const isCall = msg.group === 'call';
  let buf, pre;
  try {
    [buf, pre] = await Promise.all([load(msgUrl(msg.id)), load(fxUrl(isCall ? 'beep' : 'click'))]);
  } catch {
    if (voice === v) stopVoice();
    return;
  }
  if (voice !== v) return;

  const t0 = ctx.currentTime + 0.03;
  v.srcs.push(playBuf(pre, t0, fxGain, isCall ? 0.3 : 1));
  v.start = t0 + (isCall ? 0.75 : 0.12);
  v.buf = buf;
  const src = playBuf(buf, v.start, voiceGain);
  v.srcs.push(src);
  src.onended = () => { if (voice === v) stopVoice(); };
}

function stopVoice() {
  if (!voice) return;
  voice.srcs.forEach(stopSrc);
  voice = null;
  duck(false);
  updateUI();
}

// ---------- songs ----------

// Songs ship with the app in audio/songs/ (from songs/ on the public site, my-songs/ on private copies).
let songs = [];

async function loadSongList() {
  const list = await fetch('audio/songs/index.json').then((r) => (r.ok ? r.json() : [])).catch(() => []);
  songs = list.map((s) => ({ title: s.title, url: `audio/songs/${s.file}` }));
  nextSong = shuffleBag(songs);
}

let labelTimer;
function flashLabel(text) {
  clearTimeout(labelTimer);
  $('#cassette-title').textContent = text;
  labelTimer = setTimeout(() => { $('#cassette-title').textContent = 'HOTLINE'; }, 2500);
}

// ---------- song button ----------

function playSong() {
  initAudio();
  const t = nextSong();
  music.track = t;
  music.el.src = t.url;
  music.el.play().catch(() => { if (music.track === t) stopSong(); });
  load(fxUrl('click')).then((b) => playBuf(b, 0, fxGain)).catch(() => {});
  updateUI();
}

function stopSong() {
  music.track = null;
  music.el?.pause();
  updateUI();
}

// ---------- the player ----------

function updateUI() {
  $('#voice').classList.toggle('on', !!voice);
  $('#song').classList.toggle('on', !!music.track);
  $('#cassette').classList.toggle('spinning', !!voice || !!music.track);
  $('#cassette-side').textContent = !voice && music.track ? 'SIDE B' : 'SIDE A';
}

// Tape moves from the left reel to the right one as the sound plays.
function frame() {
  let p = 0;
  if (voice && voice.buf) p = (ctx.currentTime - voice.start) / voice.buf.duration;
  else if (music.track && music.el.duration) p = music.el.currentTime / music.el.duration;
  p = Math.min(1, Math.max(0, p));
  $('#reel-tape-l').setAttribute('r', (13 + 13 * (1 - p)).toFixed(1));
  $('#reel-tape-r').setAttribute('r', (13 + 13 * p).toFixed(1));
  requestAnimationFrame(frame);
}

// Keep the screen on during the party (where supported).
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ctx) {
    if (ctx.state !== 'running') ctx.resume();
    keepAwake();
  }
});
document.addEventListener('touchstart', () => {}, { passive: true }); // enables :active styles on iOS

fetch('content.json')
  .then((r) => r.json())
  .then((c) => {
    content = c;
    nextLine = shuffleBag(c.messages.filter((m) => !m.silent));
    $('#voice').addEventListener('click', () => (voice ? stopVoice() : playVoice()));
    $('#song').addEventListener('click', () => {
      if (music.track) stopSong();
      else if (songs.length) playSong();
      else flashLabel('NO SONGS');
    });
    loadSongList();
    try { navigator.storage?.persist?.(); } catch {} // ask the phone not to clear the offline copy
    updateUI();
    requestAnimationFrame(frame);
    if ('serviceWorker' in navigator && !window.HOTLINE_ARTIFACT) navigator.serviceWorker.register('sw.js').catch(() => {});
  });
