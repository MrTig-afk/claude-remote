// Classic script (not a module) - testable under node:vm and for wider iOS
// support. Registered from app.js with a .catch(() => {}), since over plain
// HTTP on a Tailscale IP the origin is not a secure context and
// registration throws there - the app must keep working with no cache.

const CACHE = 'claude-remote-shell-v23'; // bump on any shell change
const PRECACHE = [
  '/', '/index.html', '/app.css', '/app.js', '/api.js', '/lock.js', '/copy.js', '/folders-ui.js',
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

// The shell is answered from the CACHE first and refreshed in the background.
// It used to be network-first, and network-first is what made the app take
// tens of seconds to open on a PC that was still booting (owner, 2026-08-28:
// "it took WAyyyyyyyyyyy too long for the PWA to open"). Every shell file -
// index.html, app.css, app.js, api.js, lock.js - went to the network first
// and only reached its cached copy after that request had FAILED, and a
// request to a host that is not answering yet does not fail fast: it sits
// until the connection times out. Five files, one after another, each
// waiting out its own timeout, before a single pixel could be painted.
//
// Cache-first is safe here only because of the discipline this repo already
// has: CACHE is bumped on every shell change, and `install` re-fetches the
// whole PRECACHE list from the network, so a new version is never more than
// one launch away. Losing that discipline is what would make this stale.
// /api/* is untouched by any of it - never cached, never intercepted.
async function staleWhileRevalidate(req, event) {
  // The cache write is deliberately NOT inside the chain that produces the
  // response. caches.open/cache.put can reject on their own (storage blocked
  // in a private window, quota exhausted), and folding them in would turn a
  // response the network served perfectly well into the 503 below whenever
  // the write failed rather than the fetch.
  const fromNetwork = fetch(req).then((res) => {
    if (res.ok && res.status === 200 && res.type === 'basic') {
      const copy = res.clone();
      // Fire and forget, with its own catch: nothing waits on the write.
      caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
    }
    return res;
  }).catch(() => null); // an agent that is not up yet is not an error worth logging

  // waitUntil, or the revalidate half of "stale-while-revalidate" is a
  // fiction: once respondWith settles from the cache the worker is eligible
  // for termination, and the in-flight fetch and its cache write go with it.
  // Without this the CACHE bump in install() would be the ONLY way a shell
  // file is ever refreshed. Guarded because the fetch listener is also driven
  // by the test harness, which passes no event.
  if (event && typeof event.waitUntil === 'function') event.waitUntil(fromNetwork);

  const cached = await caches.match(req);
  if (cached) return cached;

  const res = await fromNetwork;
  if (res) return res;

  if (req.mode === 'navigate') {
    const shell = await caches.match('/index.html');
    if (shell) return shell;
  }
  return new Response('claude-remote: agent unreachable', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
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

  event.respondWith(staleWhileRevalidate(req, event));
});
