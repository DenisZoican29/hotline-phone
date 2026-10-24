// Builds the GitHub Pages site in _site/: app/ plus every audio file in songs/.
// Run by the deploy workflow; also works locally (node tools/build-site.js, then serve _site/).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '_site');
const SONGS_IN = path.join(ROOT, 'songs');
const SONGS_OUT = path.join(OUT, 'audio', 'songs');

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'app'), OUT, { recursive: true });
fs.rmSync(SONGS_OUT, { recursive: true, force: true }); // locally built songs never go on the public site
fs.mkdirSync(SONGS_OUT, { recursive: true });

const songFiles = fs.existsSync(SONGS_IN) ? fs.readdirSync(SONGS_IN).filter((f) => /\.(mp3|m4a|wav|ogg)$/i.test(f)).sort() : [];
const songIndex = [];
for (const f of songFiles) {
  const { name, ext } = path.parse(f);
  const title = name.split(/ [-–] /).pop().trim(); // "Soundtrack - Le Perv" -> "Le Perv"
  const file = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + ext.toLowerCase();
  fs.copyFileSync(path.join(SONGS_IN, f), path.join(SONGS_OUT, file));
  songIndex.push({ title, file });
  console.log('song ', file);
}
if (songIndex.length) fs.writeFileSync(path.join(SONGS_OUT, 'index.json'), JSON.stringify(songIndex, null, 2));

// A new service worker version on every deploy, so installed phones re-download songs and app files.
const sw = path.join(OUT, 'sw.js');
const stamp = (process.env.GITHUB_SHA || Date.now().toString(36)).slice(0, 7);
fs.writeFileSync(sw, fs.readFileSync(sw, 'utf8').replace(/const VERSION = '([^']+)'/, `const VERSION = '$1-${stamp}'`));

console.log(`wrote _site/ with ${songIndex.length} songs`);
