// Caches the whole app (including all audio) on first visit so it works offline at the party.
// Bump VERSION after changing any file so phones pick up the new copy.
const VERSION = 'hotline-v8';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'content.json', 'manifest.webmanifest',
  'fonts/bungee.woff2', 'fonts/vt323.woff2',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    const content = await (await cache.match('content.json')).json();
    const audio = [
      ...[...content.messages, ...content.system].map((m) => `audio/msg/${m.id}.mp3`),
      ...[...content.fx.map((f) => f.id), 'click', 'beep', 'rewind'].map((id) => `audio/fx/${id}.mp3`),
    ];
    await cache.addAll([...new Set(audio)]);
    // Built-in songs come from songs/ (the public site) or my-songs/ (private copies).
    const index = await fetch('audio/songs/index.json').catch(() => null);
    if (index && index.ok) {
      const list = await index.clone().json();
      await cache.put('audio/songs/index.json', index);
      await cache.addAll(list.map((s) => `audio/songs/${s.file}`));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

// Safari's <audio> asks for byte ranges and refuses to play a plain 200 response.
async function partial(res, range) {
  const buf = await res.arrayBuffer();
  const [, from, to] = /bytes=(\d*)-(\d*)/.exec(range) || [];
  const start = from ? Number(from) : 0;
  const end = Math.min(to ? Number(to) : buf.byteLength - 1, buf.byteLength - 1);
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const range = e.request.headers.get('range');
    if (hit && range) return partial(hit, range);
    if (hit) return hit;
    if (e.request.mode === 'navigate') return (await cache.match('index.html')) || fetch(e.request);
    return fetch(e.request);
  })());
});
