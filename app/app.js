'use strict';

const $ = (s) => document.querySelector(s);
const MUSIC_LEVEL = 0.8;
const DUCK_LEVEL = 0.3;

let content;
let ctx, voiceGain, fxGain, musicGain;
const cache = new Map();
// Songs stream through one <audio> element (full songs are too big to decode into memory on a phone).
const music = { track: null, el: null, playing: false };
let played = [], pos = -1; // songs in the order they played, for the previous key
let voice = null; // the line currently playing
let wakeLock = null;

// ---------- shuffle: everything plays once before anything repeats ----------

// Only ticked items (see the menu) are picked; returns null when none are ticked.
function shuffleBag(items) {
  let bag = [];
  let last = null;
  return () => {
    bag = bag.filter(isOn);
    if (!bag.length) {
      bag = items.filter(isOn);
      if (!bag.length) return null;
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
let nextLine, pickSong;

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
  music.el.addEventListener('ended', () => { if (music.playing && !nextSong()) { music.playing = false; updateUI(); } }); // the tape keeps going
  const s = ctx.createBufferSource();
  s.buffer = ctx.createBuffer(1, 1, 22050);
  s.connect(ctx.destination);
  s.start(0);
  ctx.resume();
  keepAwake();
  // Warm the cache so voice lines start instantly.
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

// ---------- voice lines (double-tap next) ----------

async function playVoice() {
  initAudio();
  const msg = nextLine();
  if (!msg) return flashLabel('NO LINES');
  stopVoice();
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
  songs = list.map((s) => ({ key: `song:${s.file}`, title: s.title, url: `audio/songs/${s.file}` }));
  pickSong = shuffleBag(songs);
  menuGroup('#menu-songs', songs, (s) => s.title);
}

let labelTimer;
function flashLabel(text) {
  clearTimeout(labelTimer);
  $('#cassette-title').textContent = text;
  labelTimer = setTimeout(() => { $('#cassette-title').textContent = 'HOTLINE'; }, 2500);
}

// ---------- transport keys ----------

const tapeClick = () => load(fxUrl('click')).then((b) => playBuf(b, 0, fxGain)).catch(() => {});

function resumeSong() {
  const t = music.track;
  music.playing = true;
  // AbortError only means another key changed or paused the song before it started.
  music.el.play().catch((e) => { if (music.track === t && e.name !== 'AbortError') { music.playing = false; updateUI(); } });
  updateUI();
}

function startSong(t) {
  music.track = t;
  music.el.src = t.url;
  flashLabel(t.title.toUpperCase());
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: 'Hotline', artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }] });
  }
  resumeSong();
}

function nextSong() {
  if (!songs.length) return flashLabel('NO SONGS');
  if (pos < played.length - 1) pos++;
  else {
    const t = pickSong();
    if (!t) return flashLabel('NO SONGS');
    pos = played.push(t) - 1;
  }
  startSong(played[pos]);
  tapeClick();
  return true;
}

function prevSong() {
  if (!music.track) return nextSong();
  // Past the first few seconds, previous restarts the current song.
  if (music.el.currentTime > 3 || pos === 0) {
    music.el.currentTime = 0;
    resumeSong();
  } else {
    startSong(played[--pos]);
  }
  tapeClick();
}

function togglePlay() {
  if (!music.track) return nextSong();
  if (music.playing) {
    music.playing = false;
    music.el.pause();
    updateUI();
  } else {
    resumeSong();
  }
  tapeClick();
}

// Next waits a moment so a second tap can turn it into a voice line instead.
let nextTimer = null;
function onNextTap() {
  if (nextTimer) {
    clearTimeout(nextTimer);
    nextTimer = null;
    playVoice();
  } else {
    nextTimer = setTimeout(() => { nextTimer = null; nextSong(); }, 300);
  }
}

// Lock screen, Control Center and headphone buttons.
function setupMediaKeys() {
  if (!('mediaSession' in navigator)) return;
  const on = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch {} };
  on('play', () => { if (!music.playing) togglePlay(); });
  on('pause', () => { if (music.playing) togglePlay(); });
  on('nexttrack', nextSong);
  on('previoustrack', prevSong);
}

// ---------- the menu: which songs and voice lines play ----------

// Unticked items are remembered (not ticked ones), so newly added songs and lines start out on.
const OFF_KEY = 'hotline-off';
let off = new Set();
try { off = new Set(JSON.parse(localStorage.getItem(OFF_KEY)) || []); } catch {}
const isOn = (item) => !off.has(item.key);

function setOn(item, on) {
  if (on) off.delete(item.key);
  else off.add(item.key);
  try { localStorage.setItem(OFF_KEY, JSON.stringify([...off])); } catch {}
}

// One checkbox per item, plus the group's heading checkbox to tick or untick them all.
function menuGroup(sel, items, name) {
  const group = $(sel);
  const all = group.querySelector('.menu-head input');
  group.hidden = !items.length;
  const boxes = items.map((item) => {
    const li = document.createElement('li');
    li.innerHTML = '<label><input type="checkbox"><span></span></label>';
    li.querySelector('span').textContent = name(item);
    const box = li.querySelector('input');
    box.checked = isOn(item);
    box.addEventListener('change', () => { setOn(item, box.checked); sync(); });
    group.querySelector('ul').append(li);
    return box;
  });
  const sync = () => {
    const n = boxes.filter((b) => b.checked).length;
    all.checked = n === boxes.length;
    all.indeterminate = n > 0 && n < boxes.length;
  };
  all.addEventListener('change', () => {
    items.forEach((item, i) => { boxes[i].checked = all.checked; setOn(item, all.checked); });
    sync();
  });
  sync();
}

function toggleMenu(open) {
  $('#menu').classList.toggle('open', open);
  $('#menu-shade').hidden = !open;
  $('#menu-btn').setAttribute('aria-expanded', open);
}

// ---------- the player ----------

function updateUI() {
  if ('mediaSession' in navigator && music.track) navigator.mediaSession.playbackState = music.playing ? 'playing' : 'paused';
  $('#play').classList.toggle('on', music.playing);
  $('#play').setAttribute('aria-label', music.playing ? 'Pause' : 'Play');
  $('#cassette').classList.toggle('spinning', !!voice || music.playing);
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
    const lines = c.messages.filter((m) => !m.silent).map((m) => ({ ...m, key: `line:${m.id}` }));
    nextLine = shuffleBag(lines);
    menuGroup('#menu-lines', lines, (m) => `${m.icon} ${m.label}`);
    $('#menu-btn').addEventListener('click', () => toggleMenu(!$('#menu').classList.contains('open')));
    $('#menu-shade').addEventListener('click', () => toggleMenu(false));
    // initAudio runs straight in each tap: iOS only unlocks audio inside the gesture itself.
    const key = (id, fn) => $(id).addEventListener('click', () => { initAudio(); fn(); });
    key('#prev', prevSong);
    key('#play', togglePlay);
    key('#next', onNextTap);
    setupMediaKeys();
    loadSongList();
    try { navigator.storage?.persist?.(); } catch {} // ask the phone not to clear the offline copy
    updateUI();
    requestAnimationFrame(frame);
    if ('serviceWorker' in navigator && !window.HOTLINE_ARTIFACT) {
      // A new deploy takes over in the background; reload once so it shows right away.
      if (navigator.serviceWorker.controller) navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  });
