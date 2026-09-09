// readAgentVersion and readNewestRelease both read a file off disk at module
// load. Dropped once while resolving the M11 merge, which made every version
// read return 'unknown' with a `fs is not defined` warning - the agent still
// booted and still answered, which is exactly why only a test caught it.
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// The single default_base_folder was replaced by the shared_folders set at M9;
// resolveSharedFolders is the only reader. T54 then deleted resolveBaseDir
// outright - it had no production caller.
import {
  resolveSharedFolders, isAcknowledged, acknowledge, readStatusFacts,
} from './config.js';
import { listProjects, createProject, rootsFrom } from './projects.js';
import { listDrives } from './drives.js';
import { listFolders } from './folders.js';
import { putSharedFolders, describeSharedRoots } from './shared.js';
import { launchSession, endSession } from './sessions.js';
import { listSessions, dropSession } from './registry.js';
import { serveStatic } from './static.js';
import { isConfigured, setPasscode, attemptUnlock, changePasscode, authStatus, authorize } from './auth.js';

export const HOST = '127.0.0.1';
// 8787 is permanently held on this host by the WhatsApp channel plugin
// (bun.exe server.ts). Verified 2026-08-25. Any Windows Firewall rule for
// this agent's port must match whatever this is.
export const DEFAULT_PORT = 8790;

const AGENT_PACKAGE_PATH = fileURLToPath(new URL('./package.json', import.meta.url));

/**
 * The agent's own version, from the package.json sitting BESIDE this file.
 * Adjacent deliberately - no '../' - so the agent never depends on where in a
 * repo (or a plugin install) it was dropped. Anything unreadable or
 * unparseable degrades to 'unknown': a version string is a display value, and
 * a broken read must not stop the agent from booting or answering.
 */
export function readAgentVersion(packagePath = AGENT_PACKAGE_PATH) {
  try {
    const version = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
    return typeof version === 'string' && version.trim() !== '' ? version : 'unknown';
  } catch (err) {
    console.warn(`claude-remote agent: could not read version from '${packagePath}': ${err.code || err.message}`);
    return 'unknown';
  }
}

export const AGENT_VERSION = readAgentVersion();

const RELEASE_NOTES_PATH = fileURLToPath(new URL('../release-notes.json', import.meta.url));

/**
 * The newest release-notes entry, or null. `../` out of agent/ is a
 * deliberate exception to readAgentVersion's adjacent-file rule: the version
 * is load-bearing so it must never depend on repo layout, but release notes
 * are not - an agent dropped somewhere without a repo root simply omits the
 * key, the same graceful path as a missing file. The file is committed by
 * the owner at a fixed path; no request input ever reaches it, so returning
 * entries[0] as-is (not a re-picked shape) is fine.
 *
 * console.warn on read failure is deliberately skipped: an agent installed
 * without a repo root around it has no notes file, and that is not a fault
 * worth a line of noise on every boot.
 */
export function readLatestRelease(notesPath = RELEASE_NOTES_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(notesPath, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 1) return null;
  const entry = parsed[0];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.version !== 'string' || entry.version === '') return null;
  if (typeof entry.date !== 'string' || entry.date === '') return null;
  if (!Array.isArray(entry.notes) || entry.notes.length < 1) return null;
  return entry;
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

const MAX_BODY_BYTES = 8 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // Do not req.destroy() here: req and res share one socket, and
        // destroying it before the 413 response is written races the
        // client's read and surfaces as a bare socket reset instead of the
        // response (verified live). reject() past the first call is a
        // no-op, so it is safe to call again on every subsequent chunk;
        // returning without pushing to chunks keeps memory bounded.
        const err = new Error('payload too large');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// POST /api/sessions still inlines this same parse. Fold that route into
// this helper the next time it is touched - avoid a broader restructure of
// server.js while it is under active edits elsewhere.
async function readJsonObject(req) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err.code === 'PAYLOAD_TOO_LARGE') return { ok: false, status: 413, error: 'payload_too_large' };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, error: 'invalid_request' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: 'invalid_request' };
  }
  return { ok: true, value: parsed };
}

/**
 * The two unauthenticated auth POSTs must carry Content-Type: application/json.
 * A cross-origin POST with text/plain is a CORS *simple* request - no preflight,
 * so it lands - and this agent sits on loopback, reachable by any page the
 * owner's browser loads. Requiring a non-simple content type forces a preflight
 * that fails closed, because no CORS header is ever emitted. Preferred over an
 * Origin allowlist: requests arrive both from localhost and, through
 * `tailscale serve`, from a *.ts.net origin, so an allowlist would have two
 * correct values to keep in step.
 */
function isJsonRequest(req) {
  const ct = req.headers['content-type'];
  return typeof ct === 'string' && ct.split(';')[0].trim().toLowerCase() === 'application/json';
}

/**
 * Handles the three unauthenticated /api/auth/* routes, returning true iff it
 * wrote a response. Owns the HTTP plumbing (body read, 413, JSON parse,
 * status codes); agent/auth.js owns storage, crypto and the limiter - the
 * same split server.js already has with sessions.js/registry.js.
 */
async function handleAuthRoute(req, res, ctx, url) {
  if (req.method === 'GET' && url.pathname === '/api/auth/status') {
    sendJson(res, 200, authStatus(ctx));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/passcode') {
    if (!isJsonRequest(req)) {
      sendJson(res, 415, { error: 'unsupported_media_type' });
      return true;
    }
    const parsed = await readJsonObject(req);
    if (!parsed.ok) {
      sendJson(res, parsed.status, { error: parsed.error });
      return true;
    }
    const result = setPasscode(ctx, parsed.value.passcode, parsed.value.confirm);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    sendJson(res, result.status, { token: result.token, expires_at: result.expiresAt });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/unlock') {
    // Before the body read and before attemptUnlock, so a hostile page cannot
    // burn the owner's three free attempts with malformed cross-origin posts.
    if (!isJsonRequest(req)) {
      sendJson(res, 415, { error: 'unsupported_media_type' });
      return true;
    }
    const parsed = await readJsonObject(req);
    if (!parsed.ok) {
      sendJson(res, parsed.status, { error: parsed.error });
      return true;
    }
    const result = attemptUnlock(ctx, parsed.value.passcode);
    if (!result.ok) {
      const body = { error: result.error };
      if (result.failures !== undefined) body.failures = result.failures;
      if (result.retryAfterMs !== undefined) body.retry_after_ms = result.retryAfterMs;
      const extraHeaders = result.status === 429 ? { 'Retry-After': String(Math.ceil(result.retryAfterMs / 1000)) } : {};
      sendJson(res, result.status, body, extraHeaders);
      return true;
    }
    sendJson(res, result.status, { token: result.token, expires_at: result.expiresAt });
    return true;
  }

  return false;
}

export async function handleRequest(req, res, ctx) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');

    // --- Passcode gate -------------------------------------------------
    // Everything under /api is gated. Static assets are NOT: they are the
    // lock screen itself, and agent/static.js only ever serves agent/public/,
    // which holds no project data. Placed above every API route so an
    // unauthenticated request can never reach a handler, a body read, or a
    // route-shaped 404.
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      if (await handleAuthRoute(req, res, ctx, url)) return;
      const gate = authorize(req, ctx);
      if (!gate.ok) { sendJson(res, gate.status, gate.body); return; }
    }
    // -----------------------------------------------------------------------

    // Both halves of the accept screen (M9), on one pathname because they are
    // one thing. The POST reads NO request body: the body is empty by
    // contract, and running it through readJsonObject would turn a
    // correctly-empty POST into a 400. Nothing in the body could change what
    // this route does, so there is nothing to parse.
    if (url.pathname === '/api/acknowledge') {
      if (req.method === 'GET') {
        // shared_folders is T100's OQ-A: the phone cannot otherwise tell
        // "nothing shared" from "shared, empty", or notice a root that has
        // vanished. rootsFrom(ctx), never a fresh config read - it is the
        // same set /api/projects lists from, so the two can never disagree.
        sendJson(res, 200, {
          acknowledged: isAcknowledged(ctx.configPath),
          shared_folders: describeSharedRoots(rootsFrom(ctx)),
        });
        return;
      }
      if (req.method === 'POST') {
        const result = acknowledge(ctx.configPath);
        if (!result.ok) {
          sendJson(res, result.status, { error: result.error });
          return;
        }
        sendJson(res, 200, { acknowledged: true, acknowledged_at: result.acknowledged_at });
        return;
      }
      // Any other method falls through to the 404 at the bottom.
    }

    // Lane 7's Change passcode. Deliberately NOT under /api/auth/*: those
    // three are the routes that run BEFORE the gate, and this one is their
    // opposite - it sits behind the token gate above and re-checks the
    // current passcode on top of it. The prefix matters on the client too:
    // api.js excludes /api/auth/ from its 401 re-lock, which is right for the
    // lock screen and wrong for a screen reached from Settings.
    // No isJsonRequest guard, for the same reason PUT /api/shared has none:
    // the token header alone forces a preflight that fails closed.
    if (req.method === 'POST' && url.pathname === '/api/passcode') {
      const parsed = await readJsonObject(req);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { error: parsed.error });
        return;
      }
      const result = changePasscode(ctx, parsed.value.current, parsed.value.passcode, parsed.value.confirm);
      if (!result.ok) {
        const body = { error: result.error };
        if (result.failures !== undefined) body.failures = result.failures;
        if (result.retryAfterMs !== undefined) body.retry_after_ms = result.retryAfterMs;
        const extraHeaders = result.status === 429 ? { 'Retry-After': String(Math.ceil(result.retryAfterMs / 1000)) } : {};
        sendJson(res, result.status, body, extraHeaders);
        return;
      }
      // No token in the reply, by design: every one was just dropped,
      // including the caller's. The phone re-locks on this answer.
      sendJson(res, 200, { changed: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/projects') {
      sendJson(res, 200, { projects: listProjects(rootsFrom(ctx)) });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/drives') {
      sendJson(res, 200, await listDrives(ctx));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/folders') {
      const result = await listFolders(ctx, url.searchParams.get('path'));
      if (!result.ok) {
        sendJson(res, result.status, { error: result.error });
        return;
      }
      sendJson(res, 200, result.body);
      return;
    }

    // PUT is never a CORS simple method - it always preflights, and this
    // agent emits no CORS header, so the preflight fails closed. No
    // isJsonRequest check here: that guard exists only for the two
    // UNAUTHENTICATED auth POSTs, where a cross-origin text/plain POST is a
    // CORS simple request that skips the preflight. POST /api/projects and
    // POST /api/sessions do not have it either.
    if (req.method === 'PUT' && url.pathname === '/api/shared') {
      const parsed = await readJsonObject(req);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { error: parsed.error });
        return;
      }
      const result = await putSharedFolders(ctx, parsed.value);
      if (!result.ok) {
        const body = { error: result.error };
        if (result.index !== undefined) body.index = result.index;
        sendJson(res, result.status, body);
        return;
      }
      // The set every route reads is ctx.sharedFolders, not the file
      // putSharedFolders just wrote - rootsFrom(ctx) never re-reads disk.
      // ponytail: an agent restart is still needed if the file is ever
      // hand-edited instead of written through this route - unchanged ceiling.
      ctx.sharedFolders = result.shared_folders;
      sendJson(res, 200, { shared_folders: result.shared_folders });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const facts = readStatusFacts(ctx.configPath);
      const body = { version: AGENT_VERSION, acknowledged: facts.acknowledged, shared_count: facts.shared_count };
      const release = readLatestRelease(ctx.releaseNotesPath);
      if (release) body.release = release;
      sendJson(res, 200, body);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/projects') {
      const parsed = await readJsonObject(req);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { error: parsed.error });
        return;
      }
      // The client sends only { name } - picking a root is UI (T97) and out
      // of scope here, so: the FIRST container root in the shared set. A
      // `single` root has no children to create into. No container root ->
      // 400 base_unavailable BEFORE calling createProject (which itself maps
      // an mkdirSync ENOENT failure to a 500 of the same code - app.js maps
      // on the code, not the status, so no client change is needed for
      // either status).
      const containerRoot = rootsFrom(ctx).find((r) => r.mode === 'container');
      if (!containerRoot) {
        sendJson(res, 400, { error: 'base_unavailable' });
        return;
      }
      const result = createProject(containerRoot.path, parsed.value.name);
      if (!result.ok) {
        sendJson(res, result.status, { error: result.error });
        return;
      }
      sendJson(res, 201, { project: result.project });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      sendJson(res, 200, { sessions: listSessions(ctx) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        if (err.code === 'PAYLOAD_TOO_LARGE') {
          sendJson(res, 413, { error: 'payload_too_large' });
          return;
        }
        throw err;
      }

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: 'invalid_request' });
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendJson(res, 400, { error: 'invalid_request' });
        return;
      }

      const result = launchSession(ctx, parsed.project);
      if (!result.ok) {
        sendJson(res, result.status, { error: result.error });
        return;
      }
      sendJson(res, result.reused ? 200 : 202, result.session);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/sessions/end') {
      const parsed = await readJsonObject(req);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { error: parsed.error });
        return;
      }
      // Two keys, one contract. `project` is what the client sends for
      // anything resolveProjectPath will accept: a top-level project and,
      // since T68, a project exactly one level inside a container. A desk
      // session sitting anywhere else under a project - deeper than one
      // level, or under a folder that is not a container - has no `project`
      // the client could legally name, so it sends session_name instead, and
      // endSession resolves that key against its own server-side view, never
      // a client-supplied path. Neither key bypasses validation: the
      // `project` branch runs resolveProjectPath exactly as it always has,
      // and the session_name branch never takes a path from the request at
      // all.
      const { session_name: sessionName, project } = parsed.value;
      const target = typeof sessionName === 'string' && sessionName !== '' ? { session_name: sessionName } : project;
      const result = await endSession(ctx, target);
      if (!result.ok) {
        sendJson(res, result.status, { error: result.error });
        return;
      }
      sendJson(res, result.status, result.body);
      return;
    }

    // The phone announces an ended record once, then dismisses it here so the
    // banner does not come back on every open for the rest of the 24h window.
    if (req.method === 'POST' && url.pathname === '/api/sessions/dismiss') {
      const parsed = await readJsonObject(req);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { error: parsed.error });
        return;
      }
      if (typeof parsed.value.session_name !== 'string' || parsed.value.session_name === '') {
        sendJson(res, 400, { error: 'invalid_request' });
        return;
      }
      dropSession(ctx, parsed.value.session_name, 'ended');
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && serveStatic(res, url.pathname)) {
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
    if (res.headersSent) { res.destroy(); return; }
    console.error('claude-remote agent: request handler error:', err);
    sendJson(res, 500, { error: 'internal_error' });
  }
}

export function createAgentServer(ctx) {
  return http.createServer((req, res) => handleRequest(req, res, ctx));
}

if (import.meta.main) {
  const sharedFolders = resolveSharedFolders();
  const port = Number(process.env.CLAUDE_REMOTE_AGENT_PORT) || DEFAULT_PORT;

  // listProjects already warns PER ROOT, PER CALL (projects.js) - no need to
  // stat each one again here. The one thing worth a boot-time warn is the
  // empty set itself: on THIS install (no config.json yet) it means every
  // /api/projects call returns [] until the owner completes the accept
  // screen (T96) and ticks a folder in the picker (T97).
  if (sharedFolders.length === 0) {
    console.warn('claude-remote agent: no folders are shared yet; /api/projects will return an empty list until the picker is used');
  }

  if (!isConfigured({})) {
    console.warn(`claude-remote agent: NO PASSCODE SET. Open http://${HOST}:${port} at this desk and set one - every API route returns 403 until you do. Do NOT run 'tailscale serve' before it is set.`);
  }

  const server = createAgentServer({ sharedFolders });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`claude-remote agent: port ${port} is already in use`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, HOST, () => {
    console.log(`Local Agent listening on http://${HOST}:${port} (${sharedFolders.length} shared folder(s))`);
  });
}
