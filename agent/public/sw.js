// Classic script (not a module) - testable under node:vm and for wider iOS
// support. Registered from app.js with a .catch(() => {}), since over plain
// HTTP on a Tailscale IP the origin is not a secure context and
// registration throws there - the app must keep working with no cache.

// The cache key is STAMPED BY THE AGENT, not maintained by hand: static.js
// replaces the placeholder below with a sha256 of every file in PRECACHE
// before this script is ever sent. Any shell edit changes the hash, which
// changes these bytes, which is what makes the browser install a new worker.
//
// It used to be a hand-bumped `-v27`, and the discipline failed exactly the
// way hand-maintained constants do: the owner opened the app after a shipped
// change and got the old one, twice. A number a human has to remember to
// increment is not a cache-busting mechanism, it is a cache-busting ritual.
// Do not put a literal version back here.
//
// The placeholder is a valid key on its own, so opening this file straight
// off disk (a test, a `file://` load) still parses - it simply never varies,
// which is correct for a context that has no agent to stamp it.
const CACHE = 'claude-remote-shell-__SHELL_HASH__';
const PRECACHE = [
  '/', '/index.html', '/app.css', '/app.js', '/api.js', '/lock.js', '/copy.js', '/folders-ui.js',
  '/update-ui.js', '/handoff-ui.js', '/push-ui.js', '/phone.js', '/qr.js',
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

  // SCOPED TO THIS WORKER'S OWN CACHE. Bare caches.match queries EVERY cache in
  // the origin, oldest first, so an old cache that outlived its delete would
  // permanently shadow the new one - and nothing would ever refresh it, because
  // install's addAll and the revalidate write above both target CACHE only. The
  // app would be stuck on the old shell across every launch, with Settings >
  // Reset as the only escape. activate does delete the old caches, but its
  // Promise.all sits in a waitUntil whose rejection is swallowed, so one failed
  // delete (quota, storage pressure, an eviction race) is enough. Naming the
  // cache is correct whether or not that ever happens.
  // The .catch is T109: under the older Service Worker spec a NAMED lookup
  // rejects with NotFoundError when that cache is gone, where the bare form
  // resolved undefined - so an evicted cache must fall through, not throw.
  const cached = await caches.match(req, { cacheName: CACHE }).catch(() => undefined);
  if (cached) return cached;

  const res = await fromNetwork;
  if (res) return res;

  if (req.mode === 'navigate') {
    const shell = await caches.match('/index.html', { cacheName: CACHE }).catch(() => undefined);
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

// Fixed text only, keyed by `type`; nothing else from the payload is
// ever read, so a future field (a project name) can never reach the lock
// screen's notification tray.
const PUSH_TEXT = {
  launch_failed: 'A session couldn’t start. Open claude-remote to see why.',
  launch_unconfirmed: 'A session hasn’t confirmed it started. Open claude-remote to check.',
  serve_missing: 'This phone can’t reach your PC right now. It needs fixing at the PC.',
  test: 'Test from claude-remote. Notifications work on this device.',
};

self.addEventListener('push', (event) => {
  let type;
  try {
    type = event.data.json().type;
  } catch {
    return;
  }
  if (!PUSH_TEXT[type]) return;
  event.waitUntil(self.registration.showNotification('claude-remote', {
    body: PUSH_TEXT[type],
    icon: '/icons/icon-192.png',
    data: { type },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const type = event.notification.data && event.notification.data.type;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
      if (all.length > 0) {
        all[0].focus();
        if (type === 'serve_missing') all[0].postMessage({ type: 'serve_missing' });
        return undefined;
      }
      return self.clients.openWindow(type === 'serve_missing' ? '/#serve_missing' : '/');
    }),
  );
});
