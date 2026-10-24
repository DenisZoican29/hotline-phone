// Downloads the Google Fonts the app uses into app/fonts so it works offline.
const fs = require('fs');
const path = require('path');

const FAMILIES = { Bungee: 'bungee', VT323: 'vt323' };
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

(async () => {
  for (const [family, file] of Object.entries(FAMILIES)) {
    const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${family}&display=swap&text=`.replace('&text=', ''), { headers: { 'User-Agent': UA } })).text();
    // Last @font-face block is the "latin" subset.
    const urls = [...css.matchAll(/url\((https:[^)]+\.woff2)\)/g)].map((m) => m[1]);
    const url = urls[urls.length - 1];
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    fs.writeFileSync(path.join(__dirname, '..', 'app', 'fonts', file + '.woff2'), buf);
    console.log(family, url, buf.length);
  }
})();
