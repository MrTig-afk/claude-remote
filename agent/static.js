import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.resolve(fileURLToPath(new URL('./public/', import.meta.url)));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const MAX_SEGMENTS = 4;
const MAX_SEGMENT_LEN = 64;
const SEG = /^[A-Za-z0-9_-]+$/; // directory segments
const FILE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/; // final segment: name + one ext
const BAD_CHARS = /[%\\:]|\/\//; // percent, backslash, colon, double-slash
const CONTROL_CHARS = /[\x00-\x1f]/;

// On every static 200. The two frame headers keep the passcode screen out of
// any other site's frame (XFO for older engines, frame-ancestors for current
// ones); no-referrer keeps the tailnet hostname off every outbound request.
const STATIC_HEADERS = {
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
};

// The shell files the service worker precaches are what the cache key is
// derived from. Kept in step with PRECACHE in sw.js by a test, not by hope.
//
// sw.js ITSELF IS NOT IN THIS LIST, and the comment here used to claim it was.
// It cannot be: the key is stamped INTO sw.js, so hashing sw.js to compute the
// key it then contains is circular. Nothing is lost by its absence - editing
// sw.js changes the bytes the browser fetches, so it installs a new worker and
// install() re-fetches the whole PRECACHE into the same key. Corrected rather
// than "fixed" by adding the entry, which would not have worked.
const SHELL_FILES = [
  'index.html', 'app.css', 'app.js', 'api.js', 'lock.js', 'copy.js', 'folders-ui.js',
  'update-ui.js', 'handoff-ui.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

// Recomputed per request rather than cached in a module variable, because
// every other file here is read from disk per request too - that is what lets
// an edit reach the phone without restarting the agent, and a memoised hash
// would be the one thing that did not move. Eleven small files on a local
// disk; the read is not worth optimising away, and a stale hash is exactly
// the bug this function exists to kill.
function shellHash() {
  const h = crypto.createHash('sha256');
  for (const rel of SHELL_FILES) {
    h.update(rel);
    try {
      h.update(fs.readFileSync(path.resolve(PUBLIC_DIR, ...rel.split('/'))));
    } catch {
      // A missing shell file is itself a state worth busting the cache for,
      // and it must not throw on the way to serving sw.js.
      h.update('MISSING');
    }
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * sw.js is the one asset served with a substitution: its CACHE placeholder
 * becomes a hash of the actual shell. Returned as a Buffer so Content-Length
 * is the real byte count - the placeholder and the hash are different lengths,
 * so st.size would be wrong and the response would truncate.
 */
export function readServiceWorker() {
  const src = fs.readFileSync(path.resolve(PUBLIC_DIR, 'sw.js'), 'utf8');
  return Buffer.from(src.replace('__SHELL_HASH__', shellHash()), 'utf8');
}
/**
 * Serves a single static asset from agent/public/ if pathname resolves to
 * one, writing the response directly. Returns true only once a real file has
 * begun streaming; every rejection returns false and does not touch res, so
 * the caller's existing 404 JSON handles it - a traversal attempt and a
 * typo'd URL come out byte-identical. Reject, never sanitize-and-continue -
 * same posture as resolveProjectPath (sessions.js).
 */
export function serveStatic(res, pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return false;

  // Defensive: the API routes already matched first in server.js, but
  // nothing under /api may ever be read from disk.
  if (pathname.startsWith('/api/') || pathname === '/api') return false;

  if (pathname === '/') pathname = '/index.html';

  // '%' rejection kills every percent-encoded and double-encoded traversal
  // in one line - no asset name needs encoding. new URL() in server.js
  // already decodes %2e%2e away, so a surviving '%' can only be a
  // double-encoding attempt (%252e) or an unnecessary escape. Never decode
  // again - that would re-create '..'.
  if (BAD_CHARS.test(pathname) || CONTROL_CHARS.test(pathname)) return false;

  const segs = pathname.slice(1).split('/');
  if (segs.length === 0 || segs.length > MAX_SEGMENTS) return false;

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg.length > MAX_SEGMENT_LEN) return false;
    const re = i === segs.length - 1 ? FILE : SEG;
    if (!re.test(seg)) return false;
  }

  const ext = path.extname(segs.at(-1)).toLowerCase();
  const type = TYPES[ext];
  if (!type) return false;

  const full = path.resolve(PUBLIC_DIR, ...segs);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) return false;

  let st;
  try {
    // lstat, not stat: a symlink/junction planted in public/ is refused,
    // matching the link posture of projects.js.
    st = fs.lstatSync(full);
  } catch {
    return false;
  }
  // Windows' filesystem is case-insensitive, so /INDEX.HTML serves
  // index.html. No security consequence (still inside PUBLIC_DIR, still an
  // allowlisted extension) - left as-is, not worth a directory read to
  // enforce case.
  if (!st.isFile()) return false;

  // sw.js is stamped on the way out; everything else streams untouched.
  if (segs.length === 1 && segs[0] === 'sw.js') {
    let body;
    try {
      body = readServiceWorker();
    } catch {
      return false;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, ...STATIC_HEADERS });
    res.end(body);
    return true;
  }

  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, ...STATIC_HEADERS });
  const stream = fs.createReadStream(full);
  stream.on('error', () => { res.destroy(); });
  stream.pipe(res);
  return true;
}
