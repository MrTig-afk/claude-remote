import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { getPidDirPath } from './config.js';
import { findLiveSession, clearPidFile, recordLaunch } from './registry.js';

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
 * ctx also threads the registry seams (registryPath, pidDir, isPidAlive, now)
 * straight through to findLiveSession/clearPidFile/recordLaunch untouched.
 */
export function launchSession(ctx, project) {
  const { baseDir, spawner = spawn } = ctx;
  const r = resolveProjectPath(baseDir, project);
  if (!r.ok) return r;

  const sessionName = deriveSessionName(r.path);

  // ponytail: two folders can derive the same session name ('Foo Bar' and
  // 'Foo.Bar' both -> 'foo-bar'), so they share one registry entry and the
  // second tap returns the first's entry - whose project/path are not the
  // ones the client asked for. Launching both would collide on the same
  // --remote-control name in the Code tab anyway, so sharing is the honest
  // behaviour. No folder under Repos collides today. Upgrade path if one
  // ever does: key by resolved path and return a 409 on the name collision.
  const existing = findLiveSession(ctx, sessionName);
  if (existing) {
    return { ok: true, reused: true, session: existing };
  }

  // MUST happen before the spawn: a stale pid file from an earlier run must
  // not be adopted by a launch that silently writes nothing, which would
  // produce a phantom "running" entry that never expires.
  clearPidFile(ctx, sessionName);

  const pidDir = ctx.pidDir || getPidDirPath();

  // Production never created this directory - only tests did, which is why 98
  // green tests missed it. Without it, launch-session.ps1's Set-Content fails
  // with DirectoryNotFoundException, its catch{} swallows the error and
  // stdio:'ignore' hides it, so readPidFile returns null forever. Every entry
  // then falls through the 30s grace window and is pruned, and the next tap
  // spawns a DUPLICATE session - the outcome the brief called "worse than no
  // registry at all". Found in review 2026-08-25.
  try {
    fs.mkdirSync(pidDir, { recursive: true });
  } catch {
    // Non-fatal by design: the pid write no-ops and the entry falls through
    // the grace window. Better a duplicate later than a failed launch now.
  }

  const pidFilePath = path.join(pidDir, `${sessionName}.pid`);

  const child = spawner('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', LAUNCH_SCRIPT,
    '-ProjectPath', r.path,
    '-SessionName', sessionName,
    '-PidFile', pidFilePath,
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

  const view = recordLaunch(ctx, { sessionName, project, projectPath: r.path });

  return { ok: true, reused: false, session: view };
}
