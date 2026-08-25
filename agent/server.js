import fs from 'node:fs';
import http from 'node:http';

import { resolveBaseDir } from './config.js';
import { listProjects } from './projects.js';
import { launchSession } from './sessions.js';

export const HOST = '127.0.0.1';
// 8787 is permanently held on this host by the WhatsApp channel plugin
// (bun.exe server.ts). Verified 2026-08-25. T34's firewall rule must
// match whatever this is.
export const DEFAULT_PORT = 8790;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
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

export async function handleRequest(req, res, ctx) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/api/projects') {
      sendJson(res, 200, { projects: listProjects(ctx.baseDir) });
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

      const result = launchSession(
        { baseDir: ctx.baseDir, spawner: ctx.spawner },
        parsed.project,
      );
      if (!result.ok) {
        sendJson(res, result.status, { error: result.error });
        return;
      }
      sendJson(res, 202, result.session);
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
  const baseDir = resolveBaseDir();

  let baseDirOk = false;
  try {
    baseDirOk = fs.statSync(baseDir).isDirectory();
  } catch {
    baseDirOk = false;
  }
  if (!baseDirOk) {
    console.warn(`claude-remote agent: base directory '${baseDir}' does not exist or is not a directory; /api/projects will return an empty list`);
  }

  const port = Number(process.env.CLAUDE_REMOTE_AGENT_PORT) || DEFAULT_PORT;
  const server = createAgentServer({ baseDir });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`claude-remote agent: port ${port} is already in use`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, HOST, () => {
    console.log(`Local Agent listening on http://${HOST}:${port} (base: ${baseDir})`);
  });
}
