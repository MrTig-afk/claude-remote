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

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  const stream = fs.createReadStream(full);
  stream.on('error', () => { res.destroy(); });
  stream.pipe(res);
  return true;
}
