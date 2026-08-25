import fs from 'node:fs';
import http from 'node:http';

import { resolveBaseDir } from './config.js';
import { listProjects } from './projects.js';

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

export function handleRequest(req, res, ctx) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/api/projects') {
      const projects = listProjects(ctx.baseDir);
      sendJson(res, 200, { projects });
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
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
