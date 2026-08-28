import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { getPidDirPath } from './config.js';
import {
  findLiveSession, clearPidFile, recordLaunch, markSessionState, dropSession,
  isPidAlive, HANDOFF_TIMEOUT_MS, claimDeskSession, resolveDeskSessionId,
  pidFileNameFor,
} from './registry.js';
import { containerChildrenOf } from './projects.js';

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
 * Port of ConvertTo-SessionName (ClaudeRemote.psm1:1-16) for the
 * ONE-ARGUMENT form, which is byte-for-byte what it always was. Known,
 * accepted divergence: .NET \s includes U+0085 and JS \s includes U+FEFF.
 *
 * The TWO-ARGUMENT form has NO PowerShell counterpart - ConvertTo-SessionName
 * has no concept of a container folder, and the Pester suite does not cover
 * this branch. Called with baseDir, a project exactly two levels below it
 * derives '<parent-slug>/<child-slug>', so 'Pull Requests\Vercel' can never
 * share a registry key with a top-level 'Vercel'. A single-segment path with
 * baseDir is unchanged. The '/' is a private separator: no single-segment
 * name can contain one, because path.basename never yields a separator and
 * the slug rule only ever introduces '-'.
 *
 * This MUST return the same string as deriveDeskSessionName (registry.js)
 * for the same path, or listSessions emits two views for one live session.
 *
 * ponytail: the caller must opt in by passing baseDir. Three call sites do
 * (launchSession, endSession, registry.js's prune); every other caller -
 * projects.js, the tests - passes a bare name or a flat path and is
 * unaffected.
 */
export function deriveSessionName(projectPath, baseDir) {
  const slug = (s) => s.replace(/[\s.]+/g, '-').toLowerCase();
  if (baseDir !== undefined) {
    const rel = path.relative(path.resolve(baseDir), path.resolve(projectPath));
    // Same "is it really underneath" test isInsideProject uses (registry.js):
    // a path outside baseDir yields '..' segments and must NEVER be slugged.
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      const segs = rel.split(path.sep).filter(Boolean);
      if (segs.length === 2) return segs.map(slug).join('/');
    }
  }
  return slug(path.basename(projectPath));
}

// Used by both the single- and two-segment branches of resolveProjectPath.
// Predicate set and order preserved verbatim from the pre-T68 whole-string
// check: '\' '/' ':' control-chars leading-'.' absolute.
const badSegment = (s) => /[\\/]/.test(s) || s.includes(':')
  || /[\u0000-\u001f]/.test(s) || s.startsWith('.') || path.isAbsolute(s);

/**
 * Resolves and validates a client-supplied project identifier against
 * baseDir. This is the trust boundary: reject, never sanitize-and-continue.
 * Accepts either a single segment (a direct child of baseDir, unchanged
 * behaviour) or exactly two ('<container>/<child>', never deeper - one level
 * only, forever). Returns { ok: true, path } or { ok: false, status, error }.
 */
export function resolveProjectPath(baseDir, project) {
  // S1 - whole raw string, unchanged. Binds the 255 guard across BOTH
  // segments: it runs before any split, so a second segment cannot be used
  // to get past it.
  if (typeof project !== 'string' || project.trim() === '' || project.length > 255) {
    return { ok: false, status: 400, error: 'invalid_request' };
  }

  const base = path.resolve(baseDir);

  // S2 - split on '/' ONLY, never on '\'. '\' stays a rejected character
  // inside every segment (badSegment) - a client sending 'Pull
  // Requests\Vercel' is REJECTED, not normalised.
  const segments = project.split('/');
  if (segments.length > 2) {
    return { ok: false, status: 400, error: 'invalid_project' };
  }

  if (segments.length === 1) {
    // --- SINGLE branch - byte-identical to today ------------------------
    if (badSegment(project)) {
      return { ok: false, status: 400, error: 'invalid_project' };
    }

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

  // --- NESTED branch ------------------------------------------------------
  const [seg1, seg2] = segments;

  // S3n - per-segment, in order. Must run before S6n: S6n's
  // containerChildrenOf console.warn's the folder path on a failed readdir,
  // and control characters are already rejected here, so no crafted segment
  // can inject terminal escapes into that log line.
  for (const seg of [seg1, seg2]) {
    if (seg === '' || seg.trim() === '') {
      return { ok: false, status: 400, error: 'invalid_project' };
    }
    if (badSegment(seg)) {
      return { ok: false, status: 400, error: 'invalid_project' };
    }
  }

  // S5n - STRUCTURAL CONFINEMENT, two resolved-path comparisons, no string
  // tests. Exactly one level, twice. Even if a segment smuggled a traversal
  // past S3n, path.resolve normalises it and dirname catches it here; S3n is
  // only defence in depth. This is the PATH-ARITHMETIC half of confinement
  // and it is purely lexical - it never touches the filesystem, so it cannot
  // see a reparse point. S6n-pre below is the other half.
  const parent = path.resolve(base, seg1);
  if (path.dirname(parent) !== base || parent === base) {
    return { ok: false, status: 400, error: 'invalid_project' };
  }
  const resolved = path.resolve(parent, seg2);
  if (path.dirname(resolved) !== parent || resolved === parent) {
    return { ok: false, status: 400, error: 'invalid_project' };
  }

  // S6n-pre - THE PARENT MUST BE A REAL DIRECTORY, NOT A REPARSE POINT.
  // Without this the nested branch follows a junction straight out of the
  // base dir: S5n above is purely lexical, containerChildrenOf below does a
  // readdirSync that FOLLOWS a reparse point and lists the link TARGET's
  // children, and S7n only lstats the final component. Reproduced before
  // this guard existed - 'Link/Secret' resolved ok with a realpath outside
  // the base dir, while the flat branch correctly rejected 'Link'. This
  // restores that symmetry.
  // lstatSync, NEVER statSync: statSync follows the link and reports a
  // directory, which is exactly the answer that lets the escape through.
  // 400 invalid_project, not 404: 'sub/dir' (a nonexistent parent) is pinned
  // to invalid_project in the rejection table in sessions.test.js, and a
  // caller must not be able
  // to tell a junction from a folder that simply is not there.
  let pst;
  try {
    pst = fs.lstatSync(parent);
  } catch {
    return { ok: false, status: 400, error: 'invalid_project' };
  }
  if (!pst.isDirectory()) {
    return { ok: false, status: 400, error: 'invalid_project' };
  }

  // S6n - CONTAINER GATE: the first segment must be a genuine container.
  // containerChildrenOf never throws and returns null for an ordinary
  // project, an empty folder AND an unreadable one. A NONEXISTENT parent
  // never reaches here at all - S6n-pre's lstatSync throws on it first.
  // (This paragraph used to claim the opposite, that no separate existence
  // check was needed. It was written before S6n-pre existed and left stale;
  // read that way it argues the guard above is redundant, and deleting that
  // guard reopens a real filesystem escape. Do not.)
  // Its children are dirent.isDirectory()-filtered, so a junction or
  // symlink child is not in the list and cannot be named. Case-insensitive
  // membership match deliberately: Windows resolves 'Pull Requests/vercel'
  // to the real 'Vercel' folder anyway, and the flat branch has always
  // accepted 'email-Lint' - matching the platform keeps the two branches
  // symmetric.
  // ponytail: container status is RECOMPUTED from disk on every call, so it
  // is not stable state. Drop a README.md into 'Pull Requests' and it stops
  // being a container: every nested identifier under it stops resolving, and
  // because registry.js's prune drops any entry whose resolveProjectPath call
  // returns !ok, the LIVE registry entries of running nested sessions are
  // silently dropped on the next 5s poll. Verified by reading that branch,
  // not assumed. The cost is one readdirSync; the ceiling is this coupling.
  // Upgrade path if it ever bites: record container-ness in the registry
  // entry at launch and trust that for the lifetime of the session, rather
  // than re-deriving it. Not built now - the owner has one container and
  // does not keep loose files in it.
  const children = containerChildrenOf(parent);
  if (children === null || !children.some((c) => c.name.toLowerCase() === seg2.toLowerCase())) {
    return { ok: false, status: 400, error: 'invalid_project' };
  }

  // S7n - belt and braces: unreachable in practice because S6n already
  // proved the child is a real directory. Kept as the second, independent
  // symlink guard and to narrow the TOCTOU window between the readdir and
  // the launch. lstatSync, NEVER statSync.
  let st;
  try {
    st = fs.lstatSync(resolved);
  } catch {
    return { ok: false, status: 404, error: 'project_not_found' };
  }
  if (!st.isDirectory()) {
    return { ok: false, status: 404, error: 'project_not_found' };
  }

  // S8n - each segment checked SEPARATELY: testing only the joined string
  // would let a child named '-weird' through as 'pull-requests/-weird'.
  const slug1 = seg1.replace(/[\s.]+/g, '-').toLowerCase();
  const slug2 = seg2.replace(/[\s.]+/g, '-').toLowerCase();
  if (slug1 === '' || slug1.startsWith('-') || slug2 === '' || slug2.startsWith('-')) {
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

  const sessionName = deriveSessionName(r.path, baseDir);

  // Known ceiling: two folders can derive the same session name ('Foo Bar' and
  // 'Foo.Bar' both -> 'foo-bar'), so they share one registry entry and the
  // second tap returns the first's entry - whose project/path are not the
  // ones the client asked for. Launching both would collide on the same
  // --remote-control name in the Code tab anyway, so sharing is the honest
  // behaviour. This now applies PER SEGMENT: 'Pull Requests/Vercel' and
  // 'Pull.Requests/Vercel' collide the same way, one level down. No folder
  // under Repos collides today. Upgrade path if one ever does: key by
  // resolved path and return a 409 on the name collision.
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

  const pidFilePath = path.join(pidDir, pidFileNameFor(sessionName));

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
 *
 * `target` is either a project name (string, the original contract - a
 * launched session, a desk session sitting at a project ROOT, and SINCE T68
 * also a session exactly one level inside a container, which the client CAN
 * now legally name) or `{ session_name }` (a desk session in a subfolder the
 * client still cannot name: one DEEPER than one level, or one under a folder
 * that is not a container). Both funnel into endResolvedSession(), the one place that
 * ever claims a registry entry, calls taskkill or spawns the handoff - so
 * the security-sensitive bit exists exactly once regardless of which key
 * the phone sent.
 */
export async function endSession(ctx, target) {
  if (target !== null && typeof target === 'object') {
    return endSessionByName(ctx, target.session_name);
  }

  const project = target;
  const r = resolveProjectPath(ctx.baseDir, project);
  if (!r.ok) return r;

  const sessionName = deriveSessionName(r.path, ctx.baseDir);
  const existing = findLiveSession(ctx, sessionName);
  return endResolvedSession(ctx, { sessionName, projectPath: r.path, project, existing });
}

/**
 * The session_name counterpart of the project-string path above. The view
 * IS the trust boundary: path, pid, source, session id and config dir all
 * come from listSessions(ctx) (server-side discovery), never from the
 * request body. An unknown or no-longer-live session_name is 404, not
 * `already_ended` - a subfolder session that has vanished from discovery
 * leaves no registry entry to report an ending for, unlike a launched
 * project.
 */
function endSessionByName(ctx, sessionName) {
  if (typeof sessionName !== 'string' || sessionName === '') {
    return { ok: false, status: 400, error: 'invalid_request' };
  }
  const existing = findLiveSession(ctx, sessionName);
  if (!existing) {
    return { ok: false, status: 404, error: 'session_not_found' };
  }
  return endResolvedSession(ctx, {
    sessionName, projectPath: existing.path, project: existing.project, existing,
  });
}

async function endResolvedSession(ctx, { sessionName, projectPath, project, existing }) {
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
        sessionName, project, projectPath,
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
  // recent conversation.
  const { sessionId, configDir } = isDesk
    ? { sessionId: existing.session_id, configDir: existing.config_dir }
    : resolveDeskSessionId(ctx, projectPath);

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

  const mtimeBefore = handoffMtime(projectPath);  // read BEFORE the spawn

  const handoffSpawn = ctx.handoffSpawner || spawn;
  const handoffArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', HANDOFF_SCRIPT,
    '-ProjectPath', projectPath,
  ];
  // Only appended when there is one - never `-SessionId ''` / `-ConfigDir ''`.
  if (typeof sessionId === 'string' && sessionId !== '') handoffArgs.push('-SessionId', sessionId);
  if (typeof configDir === 'string' && configDir !== '') handoffArgs.push('-ConfigDir', configDir);
  const runner = handoffSpawn('powershell.exe', handoffArgs, {
    // NO shell, NO detached, NO unref() - the agent must still get the exit
    // event. windowsHide is what keeps a console window off the owner's desk.
    stdio: 'ignore',
    windowsHide: true,
    cwd: projectPath,
  });

  return {
    ok: true,
    status: 200,
    body: { result: 'handoff_started', project, session_name: sessionName },
    handoff: watchHandoff(ctx, sessionName, projectPath, mtimeBefore, runner),
  };
}
