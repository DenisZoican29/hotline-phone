// Packs app/ into a single page for a claude.ai Artifact preview (build/artifact/index.html).
// Audio and content.json are published next to it as separate files; fonts come from Google Fonts.
//   node tools/build-artifact.js
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const OUT = path.join(__dirname, '..', 'build', 'artifact');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');

const html = read('index.html');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace('<script src="app.js"></script>', '').trim();
const css = read('style.css').replace(/^@font-face.*\n/gm, '');
const js = read('app.js');

const page = `<title>Hotline Machine</title>
<meta name='claude:viewport-fit-sides' content='cover'>
<link rel='preconnect' href='https://fonts.googleapis.com'>
<link rel='preconnect' href='https://fonts.gstatic.com' crossorigin>
<link rel='stylesheet' href='https://fonts.googleapis.com/css2?family=Bungee&family=VT323&display=block'>
<style>
${css}
</style>
${body}
<script>window.HOTLINE_ARTIFACT = true;</script>
<script>
${js}
</script>
`;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), page);

const content = JSON.parse(read('content.json'));
const files = { 'content.json': 'app/content.json' };
for (const m of [...content.messages, ...content.system]) files[`audio/msg/${m.id}.mp3`] = `app/audio/msg/${m.id}.mp3`;
for (const id of new Set([...content.fx.map((f) => f.id), 'click', 'beep', 'rewind'])) files[`audio/fx/${id}.mp3`] = `app/audio/fx/${id}.mp3`;
const songIndex = path.join(APP, 'audio', 'songs', 'index.json');
if (fs.existsSync(songIndex)) {
  files['audio/songs/index.json'] = 'app/audio/songs/index.json';
  for (const s of JSON.parse(fs.readFileSync(songIndex, 'utf8'))) files[`audio/songs/${s.file}`] = `app/audio/songs/${s.file}`;
}
fs.writeFileSync(path.join(OUT, 'files.json'), JSON.stringify(files, null, 2));
console.log('wrote build/artifact/index.html,', Object.keys(files).length, 'files');
