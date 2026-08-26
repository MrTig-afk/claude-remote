import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { getPidDirPath } from './config.js';
import {
  findLiveSession, clearPidFile, recordLaunch, markSessionState, dropSession,
  isPidAlive, HANDOFF_TIMEOUT_MS, claimDeskSession, resolveDeskSessionId,
} from './registry.js';

const LAUNCH_SCRIPT = fileURLToPath(new URL('./launch-session.ps1', import.meta.url));
const HANDOFF_SCRIPT = fileURLToPath(new URL('./handoff-session.ps1', import.meta.url));

// The kill is confirmed by polling the pid, not by trusting taskkill's exit.
// Bounded by ITERATIONS, not wall clock, so an injected fast interval cannot
// turn this into a spin loop.
export const KILL_POLL_ATTEMPTS = 20;
export const KILL_POLL_INTERVAL_MS = 250;   // 20 x 250ms = 5s ceiling

const execFileAsync = promisify(execFile);

// The pid file names a pid at launch time and is never re-checked until
// STOP. If the session already ended outside the agent, Windows can have
// handed that pid to anything by the time STOP is tapped. Before killing it,
// confirm the pid is still SOME cmd.exe - `tasklist /FI "PID eq <pid>"` is
// the cheapest check that does not require changing the pid-file format.
// This proves the pid belongs to a cmd.exe, not that it is specifically the
// wrapper launch-session.ps1 started: a recycled pid landing on any other
// resident cmd.exe still passes and gets tree-killed. Upgrade path if that
// residual window ever bites: write the process start time into the pid
// file at launch and compare it here before killing. pid is always a
// validated positive integer from readPidFile by the time this is called,
// never request-derived. The caller now compares this against a
// source-dependent expected image ('cmd.exe' for a launched session,
// 'claude.exe' for a desk one), not a single hardcoded value.
async function defaultPidImageName(pid) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      windowsHide: true,
      timeout: 5000,
    }));
  } catch {
    return null;
  }
  const line = stdout.split(/\r?\n/).find((l) => l.trim() !== '');
  if (!line) return null;
  const match = line.match(/^"([^"]*)"/);      // CSV, first field, quoted
  return match ? match[1] : null;
}

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

  // Known ceiling: two folders can derive the same session name ('Foo Bar' and
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

/** mtimeMs of <projectPath>/HANDOFF.md, or null if it does not (yet) exist. */
function handoffMtime(projectPath) {
  try {
    return fs.statSync(path.join(projectPath, 'HANDOFF.md')).mtimeMs;
  } catch {
    return null;            // file may simply not exist yet
  }
}

/**
 * Force tree-kills pid via ctx.killSpawner (default child_process.spawn) and
 * attaches an error logger if the returned child supports it. label
 * identifies the target in that log line only - never awaited, never throws.
 */
function killTree(ctx, pid, label) {
  const killer = ctx.killSpawner || spawn;
  const killChild = killer('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (killChild && typeof killChild.on === 'function') {
    killChild.on('error', (err) => {
      console.error(`claude-remote agent: taskkill for ${label} failed to spawn:`, err);
    });
  }
  return killChild;
}

// The session id is resolved from the Claude Code profile sessions file
// (endSession, above) and passed to handoff-session.ps1 as -SessionId, so
// the handoff resumes THAT conversation, not merely the most recent one in
// the folder. `--continue` remains the fallback when no live record matches.
//
// Races the runner's exit against a timeout and never rejects: whichever
// settles first wins, and the loser is a no-op.
function watchHandoff(ctx, sessionName, projectPath, mtimeBefore, runner) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (handoffOk, handoffResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      markSessionState(ctx, sessionName, 'handoff', {
        status: 'ended',
        ended_at: new Date((ctx.now || Date.now)()).toISOString(),
        handoff_ok: handoffOk,
        handoff_result: handoffResult,
      });
      resolve({ handoff_ok: handoffOk, handoff_result: handoffResult });
    };

    const timer = setTimeout(() => {
      if (Number.isInteger(runner.pid) && runner.pid > 0) {
        killTree(ctx, runner.pid, `handoff runner of '${sessionName}'`);
      }
      finish(false, 'timeout');
    }, ctx.handoffTimeoutMs ?? HANDOFF_TIMEOUT_MS);

    runner.on('exit', () => {
      // The exit code is never consulted - a declined write exits 0 having
      // written nothing (verified on this host 2026-08-26). The file is the
      // verdict.
      const after = handoffMtime(projectPath);
      const written = after !== null && (mtimeBefore === null || after > mtimeBefore);
      finish(written, written ? 'written' : 'not_written');
    });

    runner.on('error', () => {
      finish(false, 'spawn_failed');
    });
  });
}

/**
 * Force tree-kills the session's process, then spawns a hidden handoff run
 * in the project folder. ctx.killSpawner and ctx.handoffSpawner are the two
 * injectable seams, mirroring ctx.spawner; both default to child_process.spawn.
 */
export async function endSession(ctx, project) {
  const r = resolveProjectPath(ctx.baseDir, project);
  if (!r.ok) return r;

  const sessionName = deriveSessionName(r.path);
  const existing = findLiveSession(ctx, sessionName);
  const isDesk = existing !== null && existing.source === 'desk';

  if (!existing) {
    // listSessions has already pruned the dead entry and unlinked its pid
    // file as part of that read; this is a belt-and-braces no-op.
    clearPidFile(ctx, sessionName);
    return { ok: true, status: 200, body: { result: 'already_ended', project, session_name: sessionName } };
  }

  if (existing.status !== 'running' || !Number.isInteger(existing.pid)) {
    // Covers `starting` (no pid to kill yet) and `handoff` (already being
    // ended). Unreachable from a healthy UI - neither state draws a STOP
    // control - so one code and one message is the whole surface.
    return { ok: false, status: 409, error: 'session_not_running' };
  }

  const pid = existing.pid;

  // Guard against two concurrent STOPs (and a START racing a STOP): claim
  // the transition BEFORE touching a real process. The registry write is
  // the mutex - markSessionState only patches an entry whose status is
  // still exactly `fromStatus` (null = "no status field", i.e. `running`),
  // so a second concurrent STOP for the same project sees `claimed ===
  // false` and gets 409 here, and a START in the same window sees the
  // `handoff` entry as live and returns `reused` (launchSession /
  // findLiveSession, unchanged). Do NOT prune the entry here - its survival
  // until the handoff finishes is what prevents that collision.
  const startedIso = new Date((ctx.now || Date.now)()).toISOString();
  const claimed = isDesk
    ? claimDeskSession(ctx, {
        sessionName, project, projectPath: r.path,
        startedAt: existing.started_at, handoffStartedAt: startedIso,
      })
    : markSessionState(ctx, sessionName, null, { status: 'handoff', handoff_started_at: startedIso });
  if (!claimed) {
    return { ok: false, status: 409, error: 'session_not_running' };
  }

  // Revert helper for the one path below that decides NOT to proceed with a
  // real kill but a real, still-live process remains: puts the entry back to
  // status-less (`running`) so a later STOP or a relaunch is not blocked by
  // a claim this call is abandoning. JSON.stringify drops the undefined keys.
  // For a desk session there is no pre-existing entry to revert TO, so
  // dropping the claim instead restores the truth: no registry entry, and
  // the next listSessions rediscovers the still-live process.
  const revertClaim = () => (isDesk
    ? dropSession(ctx, sessionName, 'handoff')
    : markSessionState(ctx, sessionName, 'handoff', { status: undefined, handoff_started_at: undefined }));

  // Guard against pid reuse before taskkill ever runs. The pid file is
  // written once at launch and never re-checked; if the session already
  // ended outside the agent, Windows can have handed that pid to anything.
  // process.kill(pid, 0) on OUR OWN pid always succeeds, so that case must
  // be refused explicitly - it is never the session's cmd.exe wrapper.
  if (pid === process.pid) {
    clearPidFile(ctx, sessionName);
    // Drop rather than revert: there is no process behind this entry (it
    // was never the agent's own pid to begin with), so leaving it
    // status-less would just have listSessions age it into a false `failed`
    // for a session that in fact ran and ended.
    dropSession(ctx, sessionName, 'handoff');
    return { ok: true, status: 200, body: { result: 'already_ended', project, session_name: sessionName } };
  }

  // Not wrapped in try/catch: a missing seam (helper-auth's refusePidImageName)
  // must propagate and fail loudly, same as a missing killSpawner/
  // handoffSpawner. A genuine real-world lookup failure is handled INSIDE
  // defaultPidImageName, which never throws - it resolves to null, and null
  // is not 'cmd.exe', so it already falls into the mismatch branch below.
  const pidImageName = ctx.pidImageName || defaultPidImageName;
  // Exactly one allowed image per source - a desk session's pid IS
  // claude.exe itself, a launched session's pid is the cmd.exe wrapper. Do
  // NOT accept claude.exe for a launched session or cmd.exe for a desk one;
  // that would widen the only thing standing between a recycled pid and
  // `taskkill /T /F`.
  const expectedImage = isDesk ? 'claude.exe' : 'cmd.exe';
  const image = await pidImageName(pid);
  if (image !== expectedImage) {
    // Not the process this source expects (or the lookup failed) - treat as
    // already dead. Clear the stale pid file: unlike kill_failed below,
    // there is no real process here whose truth the entry should keep
    // deriving. Drop rather than revert, same reasoning as above.
    clearPidFile(ctx, sessionName);
    dropSession(ctx, sessionName, 'handoff');
    return { ok: true, status: 200, body: { result: 'already_ended', project, session_name: sessionName } };
  }

  // Resolved BEFORE the kill: after the kill the process is gone and its
  // sessions file with it. A desk session's id and profile are the ones
  // findLiveSession already carries; a launched session resolves both by
  // matching cwd against the profile sessions files (its registry pid is
  // the cmd.exe wrapper, so it cannot be matched by pid). configDir matters
  // even when sessionId does not: --continue still has to run in the SAME
  // profile the desk session lived in, or it resumes the wrong store's most
  // recent conversation (review round 1, ISSUE 2).
  const { sessionId, configDir } = isDesk
    ? { sessionId: existing.session_id, configDir: existing.config_dir }
    : resolveDeskSessionId(ctx, r.path);

  killTree(ctx, pid, `'${sessionName}'`);

  // Bounded post-kill liveness poll. Never process.kill(0) - on Windows that
  // kills the agent itself; registry.js's isPidAlive is the only liveness
  // check in the codebase.
  const isAlive = ctx.isPidAlive || isPidAlive;
  let dead = !isAlive(pid);
  for (let i = 0; !dead && i < KILL_POLL_ATTEMPTS; i += 1) {
    await new Promise((res) => setTimeout(res, ctx.killPollIntervalMs ?? KILL_POLL_INTERVAL_MS));
    dead = !isAlive(pid);
  }

  if (!dead) {
    // Do NOT unlink the pid file. Revert the claim so the entry keeps
    // deriving `running`, which is the truth - do NOT spawn the handoff.
    revertClaim();
    return { ok: true, status: 200, body: { result: 'kill_failed', project, session_name: sessionName } };
  }

  // For a desk session there is no pid file to begin with - this is a
  // documented no-op (clearPidFile never throws), not branched around.
  clearPidFile(ctx, sessionName);
  // Registry is already at `status: 'handoff'` from the claim above - no
  // second write needed here.

  const mtimeBefore = handoffMtime(r.path);  // read BEFORE the spawn

  const handoffSpawn = ctx.handoffSpawner || spawn;
  const handoffArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', HANDOFF_SCRIPT,
    '-ProjectPath', r.path,
  ];
  // Only appended when there is one - never `-SessionId ''` / `-ConfigDir ''`.
  if (typeof sessionId === 'string' && sessionId !== '') handoffArgs.push('-SessionId', sessionId);
  if (typeof configDir === 'string' && configDir !== '') handoffArgs.push('-ConfigDir', configDir);
  const runner = handoffSpawn('powershell.exe', handoffArgs, {
    // NO shell, NO detached, NO unref() - the agent must still get the exit
    // event. windowsHide is what keeps a console window off the owner's desk.
    stdio: 'ignore',
    windowsHide: true,
    cwd: r.path,
  });

  return {
    ok: true,
    status: 200,
    body: { result: 'handoff_started', project, session_name: sessionName },
    handoff: watchHandoff(ctx, sessionName, r.path, mtimeBefore, runner),
  };
}
