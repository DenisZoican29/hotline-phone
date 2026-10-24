// Builds every audio file the app uses into app/audio/.
//   node tools/build-audio.js          -> TTS + synth + effects + encode
//   node tools/build-audio.js --fast   -> skip TTS/synth, only re-run effects + encode
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RAW = path.join(ROOT, 'build', 'raw');
const TTS = path.join(ROOT, 'build', 'tts');
const AUDIO = path.join(ROOT, 'app', 'audio');
const content = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'content.json'), 'utf8'));
const fast = process.argv.includes('--fast');

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
const ffmpeg = (args) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

if (!fast) {
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'tts.ps1')], { stdio: 'inherit' });
  execFileSync('node', [path.join(__dirname, 'synth.js'), RAW], { stdio: 'inherit' });
}
for (const d of ['msg', 'fx', 'songs']) fs.mkdirSync(path.join(AUDIO, d), { recursive: true });

const LOUD = 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100,aformat=sample_fmts=s16';
const MP3_VOICE = ['-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k'];

// Tape hiss bed mixed under every voice line.
const hiss = (amp, lp) => `anoisesrc=color=pink:amplitude=${amp}:sample_rate=44100:seed=1986,lowpass=f=${lp},highpass=f=200[hiss]`;

const VOICE_FX = {
  // Slowed + pitched down, doubled an octave-ish lower, roomy echo: the masks.
  mask: (p) => [
    `[0:a]adelay=250,apad=pad_dur=0.7,asplit=2[a][b]`,
    `[a]asetrate=${22050 * p},aresample=44100[lo]`,
    `[b]asetrate=${22050 * p * 0.93},aresample=44100,volume=0.4[lo2]`,
    `[lo][lo2]amix=inputs=2:duration=longest:normalize=0,highpass=f=70,lowpass=f=4800,vibrato=f=0.7:d=0.15,` +
      `aecho=0.8:0.55:95|180:0.32|0.18,acompressor=threshold=0.12:ratio=4:attack=5:release=120[v]`,
    hiss(0.012, 3500),
    `[v][hiss]amix=inputs=2:duration=first:normalize=0,${LOUD}`,
  ].join(';'),
  // Narrow-band, slightly crunchy, wobbly answering-machine tape.
  phone: (p) => [
    `[0:a]adelay=200,apad=pad_dur=0.6,asetrate=${22050 * p},aresample=44100,` +
      `highpass=f=380,lowpass=f=3200,equalizer=f=1600:t=q:w=1:g=6,` +
      `volume=3,asoftclip=type=atan,volume=0.4,vibrato=f=0.9:d=0.25,vibrato=f=7:d=0.02,` +
      `acompressor=threshold=0.1:ratio=6:attack=3:release=80[v]`,
    hiss(0.03, 5000),
    `[v][hiss]amix=inputs=2:duration=first:normalize=0,${LOUD}`,
  ].join(';'),
  // Robotic machine announcer.
  machine: (p) => [
    `[0:a]adelay=100,apad=pad_dur=0.4,asetrate=${22050 * p},aresample=44100,` +
      `afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75,` +
      `highpass=f=300,lowpass=f=3500,aecho=0.8:0.5:25:0.3[v]`,
    hiss(0.02, 5000),
    `[v][hiss]amix=inputs=2:duration=first:normalize=0,${LOUD}`,
  ].join(';'),
};

for (const line of [...content.messages, ...content.system]) {
  const out = path.join(AUDIO, 'msg', line.id + '.mp3');
  if (line.silent) {
    ffmpeg(['-i', path.join(RAW, 'fx_hiss.wav'), ...MP3_VOICE, out]);
  } else {
    ffmpeg(['-i', path.join(TTS, line.id + '.wav'), '-filter_complex', VOICE_FX[line.fx](line.pitch), ...MP3_VOICE, out]);
  }
  console.log('msg  ', line.id);
}

const fxIds = [...content.fx.map((f) => f.id), 'click', 'rewind'];
for (const id of new Set(fxIds)) {
  ffmpeg(['-i', path.join(RAW, `fx_${id}.wav`), ...MP3_VOICE, path.join(AUDIO, 'fx', id + '.mp3')]);
  console.log('fx   ', id);
}

// Songs: every audio file in my-songs/. Both folders are git-ignored, so the songs only
// ship with private copies of the app; the public one loads them from the phone instead.
// Two-pass loudness matching keeps every song at the same level without squashing it.
const SONGS_IN = path.join(ROOT, 'my-songs');
const SONGS_OUT = path.join(AUDIO, 'songs');
const SONG_LOUD = 'I=-14:TP=-1.5:LRA=20';
for (const f of fs.readdirSync(SONGS_OUT)) fs.rmSync(path.join(SONGS_OUT, f));
const songFiles = fs.existsSync(SONGS_IN) ? fs.readdirSync(SONGS_IN).filter((f) => /\.(mp3|m4a|wav|flac|ogg)$/i.test(f)).sort() : [];
const songIndex = [];
for (const f of songFiles) {
  const input = path.join(SONGS_IN, f);
  const title = path.parse(f).name.split(/ [-–] /).pop().trim(); // "Soundtrack - Le Perv" -> "Le Perv"
  const file = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.mp3';
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', input, '-af', `loudnorm=${SONG_LOUD}:print_format=json`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const m = JSON.parse(probe.match(/{[^{}]*"input_i"[^{}]*}/)[0]);
  ffmpeg(['-i', input, '-map', '0:a', '-map_metadata', '-1',
    '-af', `loudnorm=${SONG_LOUD}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=44100`,
    '-c:a', 'libmp3lame', '-b:a', '192k', path.join(SONGS_OUT, file)]);
  songIndex.push({ title, file });
  console.log('song ', file, `(${m.input_i} LUFS -> -14)`);
}
if (songIndex.length) fs.writeFileSync(path.join(SONGS_OUT, 'index.json'), JSON.stringify(songIndex, null, 2));
