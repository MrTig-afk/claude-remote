import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LAUNCH_SCRIPT = fileURLToPath(new URL('./launch-session.ps1', import.meta.url));

/**
 * Byte-for-byte port of ConvertTo-SessionName (ClaudeRemote.psm1:1-16).
 * Known, accepted divergence: .NET \s includes U+0085 and JS \s includes
 * U+FEFF. Neither appears in a Windows folder name the owner created.
 */
export function deriveSessionName(projectPath) {
  return path.basename(projectPath).replace(/[\s.]+/g, '-').toLowerCase();
}

/**
 * Resolves and validates a client-supplied project identifier against
 * baseDir. This is the trust boundary: reject, never sanitize-and-continue.
 * Returns { ok: true, path } or { ok: false, status, error }.
 */
export function resolveProjectPath(baseDir, project) {
  if (typeof project !== 'string' || project.trim() === '' || project.length > 255) {
    return { ok: false, status: 400, error: 'invalid_request' };
  }

  if (
    /[\\/]/.test(project) ||
    project.includes(':') ||
    /[\u0000-\u001f]/.test(project) ||
    project.startsWith('.') ||
    path.isAbsolute(project)
  ) {
    return { ok: false, status: 400, error: 'invalid_project' };
  }

  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, project);
  if (path.dirname(resolved) !== base || resolved === base) {
    return { ok: false, status: 400, error: 'invalid_project' };
  }

  let st;
  try {
    st = fs.lstatSync(resolved);
  } catch {
    return { ok: false, status: 404, error: 'project_not_found' };
  }
  if (!st.isDirectory()) {
    return { ok: false, status: 404, error: 'project_not_found' };
  }

  const sessionName = deriveSessionName(resolved);
  if (sessionName === '' || sessionName.startsWith('-')) {
    return { ok: false, status: 400, error: 'invalid_project' };
  }

  return { ok: true, path: resolved };
}

/**
 * Launches a detached Claude Code session for project, rooted at baseDir.
 * ctx.spawner is the injectable seam for tests; defaults to child_process.spawn.
 */
export function launchSession({ baseDir, spawner = spawn }, project) {
  const r = resolveProjectPath(baseDir, project);
  if (!r.ok) return r;

  const sessionName = deriveSessionName(r.path);
  const child = spawner('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', LAUNCH_SCRIPT,
    '-ProjectPath', r.path,
    '-SessionName', sessionName,
  ], {
    // NO `detached: true`. On Windows it maps to libuv's DETACHED_PROCESS,
    // and powershell.exe 5.1 spawned that way exits 0 IMMEDIATELY WITHOUT
    // running -File - measured on this host 2026-08-25. The endpoint would
    // return 202 "starting" and nothing would ever start, silently, because
    // spawn() itself succeeds so 'error' never fires. Real detachment comes
    // from the Start-Process inside launch-session.ps1, which is verified to
    // outlive this agent. Do not re-add it, and do not "fix" it with
    // shell:true or cmd.exe /c - that reintroduces string interpolation of a
    // client-influenced path.
    stdio: 'ignore',
    windowsHide: true,
    cwd: r.path,
  });

  child.on('error', (err) => {
    console.error(`claude-remote agent: launch of '${sessionName}' failed to spawn:`, err);
  });
  child.unref();

  return { ok: true, session: { session_name: sessionName, project, status: 'starting' } };
}
