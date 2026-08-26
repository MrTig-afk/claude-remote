// Classic script (not a module) - testable under node:vm and for wider iOS
// support. Registered from app.js with a .catch(() => {}), since over plain
// HTTP on a Tailscale IP the origin is not a secure context and
// registration throws there - the app must keep working with no cache.

const CACHE = 'claude-remote-shell-v4'; // bump on any shell change
const PRECACHE = [
  '/', '/index.html', '/app.css', '/app.js', '/api.js', '/lock.js',
  '/manifest.webmanifest', '/icons/icon.svg',
  '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok && res.status === 200 && res.type === 'basic') {
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    if (req.mode === 'navigate') {
      const shell = await caches.match('/index.html');
      if (shell) return shell;
    }
    return new Response('claude-remote: agent unreachable', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // /api/* is NEVER cached and never even intercepted. A cached project
  // list showing "running" when nothing is running would be worse than no
  // PWA at all - the whole point of this app is telling the owner the
  // truth about a machine he cannot see. Returning without calling
  // event.respondWith() leaves the request entirely to the network.
  if (url.pathname.startsWith('/api/')) return;
  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(req));
});
