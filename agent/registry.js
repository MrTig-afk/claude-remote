import fs from 'node:fs';
import path from 'node:path';

import { getRegistryFilePath, getPidDirPath, getSessionDirPaths } from './config.js';
import { resolveProjectPath, deriveSessionName, sessionNameFor } from './sessions.js';
import { listProjects, rootsFrom } from './projects.js';

// How long a launch with no pid file yet is still called `starting` rather
// than `failed`. It was 30s, and 30s is a desk figure: on a WARM machine the
// launcher writes the pid file in two or three seconds. Right after a cold
// boot it does not. Measured on this host 2026-08-28, two minutes after a
// restart: the agent recorded the launch at 22:40:41 and the launcher's
// cmd.exe was not created until 22:40:56 - 15s for the SECOND launcher, and
// ~45s for the first one, which paid the cold powershell.exe + .NET load
// while Windows was still doing its own startup work.
// Calling that `failed` was a lie the owner acted on: the tile said "no
// session confirmed... tap the project to try again", he tapped, and a
// second session came up (inFlightLaunches in sessions.js is the guard that
// now makes that tap harmless). 120s is the cold-boot measurement with
// headroom, not a round number picked for looks. CONFIRM_GAPS_MS in
// agent/public/app.js is anchored to this - its last gap must land PAST this
// window or a genuine failure never gets its banner.
export const STARTING_GRACE_MS = 120_000;
export const REGISTRY_VERSION = 1;

// A launch whose pid file never landed is kept as `failed` this long so the
// owner, who may be out for the day, still finds out why nothing appeared.
// Fixed window, no acknowledge endpoint: a failure older than this vanishes
// with no trace. Upgrade path if that bites: a dismiss flag written by the
// PWA. Not worth an endpoint for one banner.
export const FAILED_RETENTION_MS = 24 * 60 * 60 * 1000;

// A handoff run the agent is no longer watching (it restarted mid-run) is
// reported as an ended-with-failure record past this window, so a `handoff`
// entry can never block a relaunch forever.
export const HANDOFF_TIMEOUT_MS = 10 * 60 * 1000;

/** process.kill(pid, 0): true if a process with that pid exists. Never throws. */
// Known ceiling: Windows recycles pids, and nothing in node's builtins can tell a
// recycled pid from the original. A session whose pid is later reused by an
// unrelated process reports "running" forever, so the owner can never relaunch
// that project from the phone. sessions.js's endSession narrows this for the
// STOP path only, by checking the pid's image name is cmd.exe before killing
// (see the comment there) - that is a name check, not an identity check, and
// this function has no such guard at all. Upgrade path if it ever bites: store
// the process start time alongside the pid and compare both here too. Not
// worth it until someone actually hits it - pid space is large and sessions
// are short-lived.
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The pid FILE name for a session name. A project's session name carries at
 * least one '/' - the root prefix, plus one more for a container child
 * (deriveSessionName / sessionNameFor). A single-mode root is the one shape
 * with none: its whole name IS the root prefix. Any '/' that is there,
 * path.join would turn into a subdirectory that nothing creates - the pid
 * file would never be written and the session would report `failed` while
 * running. Collapsing it to '.' is safe and
 * collision-free, not a sanitization of untrusted input: the slug rule maps
 * every '.' and every whitespace run to '-', so no segment - root prefix
 * included, digest included - can ever contain a '.', and
 * 'pull-requests.vercel.pid' is therefore unreachable by any flat project.
 * The confinement check below is unchanged and still runs on the joined
 * result.
 */
export function pidFileNameFor(sessionName) {
  return `${sessionName.replace(/\//g, '.')}.pid`;
}

/**
 * Resolves <pidDir>/<sessionName>.pid, refusing to act on it unless it is a
 * direct child of pidDir. sessionName always comes from deriveSessionName in
 * practice, so this never trips - it exists as a defensive backstop, not a
 * sanitizer.
 */
function pidFilePathFor(pidDir, sessionName) {
  const resolvedDir = path.resolve(pidDir);
  const pidFilePath = path.join(resolvedDir, pidFileNameFor(sessionName));
  if (path.dirname(pidFilePath) !== resolvedDir) {
    return null;
  }
  return pidFilePath;
}

/** Reads a pid file, returning a positive integer pid or null (no file / junk). */
function readPidFile(pidDir, sessionName) {
  const pidFilePath = pidFilePathFor(pidDir, sessionName);
  if (pidFilePath === null) return null;

  let raw;
  try {
    raw = fs.readFileSync(pidFilePath, 'utf8');
  } catch {
    return null;
  }

  raw = raw.replace(/^﻿/, '').trim();
  if (raw === '') return null;

  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** Best-effort unlink of <pidDir>/<sessionName>.pid. Never throws. */
export function clearPidFile(ctx, sessionName) {
  const pidDir = ctx.pidDir || getPidDirPath();
  const pidFilePath = pidFilePathFor(pidDir, sessionName);
  if (pidFilePath === null) return;
  try {
    fs.unlinkSync(pidFilePath);
  } catch {
    // ENOENT (already gone) or anything else - best effort, never throw.
  }
}

/** Reads sessions[] from registryPath, or [] on missing/corrupt/wrong-shape. Never throws. */
function readEntries(registryPath) {
  try {
    const raw = fs.readFileSync(registryPath, 'utf8');
    if (raw.trim() === '') return [];
    const parsed = JSON.parse(raw);
    if (
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      parsed.version === REGISTRY_VERSION && Array.isArray(parsed.sessions)
    ) {
      return parsed.sessions;
    }
  } catch {
    // Missing or corrupt - treated as empty, same contract everywhere it's used.
  }
  return [];
}

function writeRegistry(registryPath, sessions) {
  try {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const json = JSON.stringify({ version: REGISTRY_VERSION, sessions }, null, 2);
    const tmp = `${registryPath}.tmp`;
    // Known ceiling: read-modify-write with no lock. Two concurrent POSTs for
    // different projects can interleave so the second overwrites the first's
    // entry, losing it from the registry (worst case: a duplicate session
    // later). Single-user agent on loopback, so the window is theoretical.
    // Upgrade path: an O_EXCL lockfile around read+write, or an append-only
    // log compacted on read.
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, registryPath);
    return true;
  } catch (err) {
    console.warn(`claude-remote agent: could not write registry '${registryPath}': ${err.code || err.message}`);
    return false;
  }
}

/**
 * Every live, interactive session record from ctx.sessionDirs. Returns
 * [{ pid, sessionId, cwd, startedAtMs, configDir, activity }]. Never throws: a missing dir, an
 * unreadable file, junk JSON or a missing field yields fewer records, never
 * an error. Only names ending '.json' are opened - every other file in these
 * directories is a credential.
 */
function readSessionFiles(ctx) {
  const dirs = ctx.sessionDirs ?? getSessionDirPaths();
  const isAlive = ctx.isPidAlive || isPidAlive;
  const records = [];

  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;   // ENOENT (profile does not exist) or anything else = empty
    }

    for (const name of names) {
      // Filtered on the NAME before any other fs call touches this entry -
      // every non-.json file in a Claude Code profile sessions dir is a
      // credential and must never be opened.
      if (!name.toLowerCase().endsWith('.json')) continue;

      let raw;
      try {
        raw = fs.readFileSync(path.join(dir, name), 'utf8');
      } catch {
        continue;
      }

      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        continue;
      }
      if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;

      // Exact string. Anything else, including a missing key, is skipped -
      // this is what keeps the hidden `claude -p` handoff run (kind:'print')
      // from ever surfacing as a session. Verified live 2026-08-27: a
      // `--remote-control` session (a plain desk-started one on the dev host,
      // pid 23724, the session driving this run) ALSO writes kind:'interactive' -
      // it carries an extra `bridgeSessionId` field this reader ignores -
      // so it is correctly NOT excluded by this filter; Q14's launched-STOP
      // id resolution depends on that being true.
      if (data.kind !== 'interactive') continue;
      if (!Number.isInteger(data.pid) || data.pid <= 0) continue;
      if (typeof data.cwd !== 'string' || data.cwd === '') continue;
      // Claude Code writes startedAt as epoch MILLISECONDS (a number), not
      // an ISO string - Date.parse(number) is NaN and silently dropped every
      // real session on 2026-08-27. Accept either shape.
      const startedAtMs = typeof data.startedAt === 'number' ? data.startedAt : Date.parse(data.startedAt);
      if (!Number.isFinite(startedAtMs)) continue;
      if (!isAlive(data.pid)) continue;

      // sessionId is optional and validated: it is later handed to
      // PowerShell as an argument value. A record with no usable id is
      // still listed - visibility is the point - it just falls back to
      // --continue at STOP time.
      const sessionId = typeof data.sessionId === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(data.sessionId)
        ? data.sessionId
        : null;

      // Claude Code's own word for what the session is doing right now.
      // Its writer (string-searched in claude.exe 2.1.247) has THREE values:
      // 'busy' while a query runs, 'idle' when nothing is running, and
      // 'waiting' when it is blocked on a prompt or question for you
      // (the record then also carries `waitingFor`). Anything else - a
      // value this version has never seen, or no key at all - is undefined,
      // and the tile then says nothing rather than guessing.
      const activity = ['busy', 'idle', 'waiting'].includes(data.status) ? data.status : undefined;

      records.push({
        pid: data.pid,
        sessionId,
        cwd: data.cwd,
        startedAtMs,
        // The parent of the sessions dir this record was read from - e.g.
        // ~/.claude-pro when read from ~/.claude-pro/sessions. Carried
        // through so the handoff resumes in the SAME profile the desk
        // session actually lived in, not whichever one is hardcoded as the
        // default.
        configDir: path.dirname(dir),
        activity,
      });
    }
  }

  return records;
}

/**
 * SessionViews for live desk-started sessions - one per distinct cwd, so a
 * session working in a subfolder of a project gets its OWN tile, named by
 * that subfolder (owner, 2026-08-27 - supersedes 2ed64f5's "attribute to
 * the parent tile" rule: a session in `Pull Requests\Whatsapp Plugin` reads
 * as "Whatsapp Plugin", not "Pull Requests"). projects is listProjects's
 * output over EVERY usable root, used both as the "is this cwd under SOME
 * listed project" gate and to resolve the OWNING root (each top-level entry
 * carries `root`) so a cwd under the second root is named under that root's
 * slug, not the first; claimedSessionNames is the Set of session_name values
 * the registry already produced a view for (registry wins, disjoint sets).
 * Never throws.
 */
// True when cwd is projectPath itself or anywhere below it - the gate for
// "is this a project's own working tree at all", not an attribution rule.
// Roots never overlap (T94's 409 overlapping_root at write time, projects.js's
// usableRoots' D2 at read time), and within a root projects are flat
// siblings - so a cwd sits inside at most one LISTED project. The .find()
// below makes that deterministic even if it ever stopped holding.
function isInsideProject(projectPath, cwd) {
  const rel = path.relative(projectPath, cwd);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// PowerShell/URL-safe and collision-proof against a root project's own
// name: 'f-dev-projects-repos/pull-requests/whatsapp-plugin', never just
// 'whatsapp-plugin' - deriveSessionName(cwd) alone could equal a REAL
// top-level project's own session_name, and END for that real project would
// then resolve to the wrong session entirely (a live danger: wrong kill
// target, handoff written into the wrong folder - not merely a cosmetic
// collision).
// Exported ONLY so the invariant below can be tested against
// deriveSessionName directly. A source-scanning test is a proxy for it and a
// proxy missed a real divergence once. A ONE-LINE DELEGATE to sessionNameFor
// (sessions.js) - THE ONE IMPLEMENTATION of the naming rule - so this
// function and deriveSessionName cannot drift: a second copy of the rule is
// exactly how one live session renders as two tiles, and since T72 that same
// string is the identity a nested session's STOP resolves on, so a
// divergence would end the wrong session.
export function deriveDeskSessionName(root, cwd) {
  return sessionNameFor(root, cwd);
}

export function discoverDeskSessions(ctx, projects, claimedSessionNames) {
  const best = new Map(); // resolved cwd -> { record, sessionName }

  for (const record of readSessionFiles(ctx)) {
    const cwd = path.resolve(record.cwd);
    const owner = projects.find((p) => isInsideProject(p.path, cwd));
    if (!owner) continue;   // outside every listed project

    const sessionName = deriveDeskSessionName(owner.root, cwd);
    if (sessionName === null) continue;   // structurally unreachable after the gate above
    if (claimedSessionNames.has(sessionName)) continue;   // registry wins

    const existing = best.get(cwd);
    if (!existing || record.startedAtMs > existing.record.startedAtMs) {
      best.set(cwd, { record, sessionName });
    }
  }

  const views = [];
  for (const [cwd, kept] of best) {   // Map preserves insertion (discovery) order, stable across polls
    views.push({
      session_name: kept.sessionName,
      project: path.basename(cwd),
      path: cwd,
      status: 'running',
      started_at: new Date(kept.record.startedAtMs).toISOString(),
      pid: kept.record.pid,
      source: 'desk',
      session_id: kept.record.sessionId,
      config_dir: kept.record.configDir,
      ...(kept.record.activity ? { activity: kept.record.activity } : {}),
    });
  }
  return views;
}

/** The newest live interactive record whose cwd IS EXACTLY targetPath, or
 *  null. Every caller passes a path the SERVER owns (a view's own `path`),
 *  never one a client supplied. */
function newestRecordAt(ctx, targetPath) {
  const target = path.resolve(targetPath);
  let best = null;
  for (const record of readSessionFiles(ctx)) {
    if (path.resolve(record.cwd) !== target) continue;
    if (!best || record.startedAtMs > best.startedAtMs) best = record;
  }
  return best;
}

/** { sessionId, configDir } of the newest live interactive session whose
 *  cwd IS EXACTLY targetPath (owner, 2026-08-27: a subfolder session is now
 *  its own tile with its own STOP, not folded into an ancestor's), or
 *  { sessionId: null, configDir: null } when none matches. Called with the
 *  view's OWN path in both callers (a launched session's root, or a desk
 *  session's own cwd - see endSession), never with a path a client
 *  supplied. configDir is set whenever a record matched at all, even if
 *  that record's own sessionId failed validation, because the profile (not
 *  the id) is what --continue also needs to run in the right place. */
export function resolveDeskSessionId(ctx, targetPath) {
  const best = newestRecordAt(ctx, targetPath);
  return best ? { sessionId: best.sessionId, configDir: best.configDir } : { sessionId: null, configDir: null };
}

/**
 * Inserts a `handoff` registry entry for a session the agent did NOT launch,
 * ONLY IF no entry with that session_name exists. Returns true iff it wrote.
 * The insert is the claim - the same "the write IS the claim" contract as
 * markSessionState (below) - and it is what makes discovery stop
 * reporting the session the instant a STOP is accepted.
 */
export function claimDeskSession(ctx, { sessionName, project, projectPath, startedAt, handoffStartedAt }) {
  const { registryPath = getRegistryFilePath() } = ctx;

  const sessions = readEntries(registryPath);
  if (sessions.some((e) => e && typeof e === 'object' && e.session_name === sessionName)) {
    return false;
  }

  sessions.push({
    session_name: sessionName,
    project,
    original_path: projectPath,
    started_at: startedAt,
    status: 'handoff',
    handoff_started_at: handoffStartedAt,
    // The prune loop below cannot validate this entry the normal way -
    // `project` is a display label (a subfolder's basename), not something
    // resolveProjectPath(roots, project) would ever resolve - so it needs
    // its own rule, keyed off this marker.
    source: 'desk',
  });
  return writeRegistry(registryPath, sessions);
}

/**
 * Every live session, pruned and re-validated against rootsFrom(ctx) (the
 * shared set). Writes the pruned registry back only if entries were dropped.
 * Never throws: any read/parse/validate failure yields [].
 */
export function listSessions(ctx) {
  const {
    registryPath = getRegistryFilePath(),
    pidDir = getPidDirPath(),
    isPidAlive: isAlive = isPidAlive,
    now = Date.now,
  } = ctx;

  // rootsFrom(ctx), never a bare ctx.baseDir read - it is the only door onto
  // the shared set (projects.js).
  const roots = rootsFrom(ctx);

  // Computed once, reused by the desk-entry prune check below AND by
  // discovery at the end of this function - both need "is this cwd inside
  // some listed project", and listProjects() is a filesystem read.
  const projects = listProjects(roots);

  // A missing, empty or corrupt registry is treated as zero registry
  // entries, NOT as an early exit: discovery (below) must still run, or a
  // desk-started session would be invisible on a machine that has never
  // launched anything through the agent - exactly the case desk-started session discovery exists for.
  let raw = null;
  try {
    raw = fs.readFileSync(registryPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`claude-remote agent: could not read registry '${registryPath}': ${err.code || err.message}`);
    }
  }

  let entries = [];
  if (raw !== null && raw.trim() !== '') {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    if (
      data !== null &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      data.version === REGISTRY_VERSION &&
      Array.isArray(data.sessions)
    ) {
      entries = data.sessions;
    }
    // else: wrong shape - treated the same as absent, and never repaired
    // here (droppedAny, below, only ever fires from inside the loop).
  }

  const nowMs = now();
  const survivors = [];
  const views = [];
  let droppedAny = false;
  // Set when an entry is normalised IN PLACE rather than removed. Without it
  // the write-back below never fires for a mutation, and the normalisation
  // would be recomputed - and lost - on every single request.
  let rewroteAny = false;

  for (const entry of entries) {
    const drop = (sessionNameForCleanup) => {
      droppedAny = true;
      if (typeof sessionNameForCleanup === 'string' && sessionNameForCleanup !== '') {
        clearPidFile({ pidDir }, sessionNameForCleanup);
      }
    };

    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      drop(undefined);
      continue;
    }

    const {
      session_name: sessionName, project, original_path: originalPath, started_at: startedAt,
      source: entrySource,
    } = entry;

    if (
      typeof sessionName !== 'string' || sessionName === '' ||
      typeof project !== 'string' || project === '' ||
      typeof originalPath !== 'string' || originalPath === '' ||
      !Number.isFinite(Date.parse(startedAt))
    ) {
      drop(sessionName);
      continue;
    }

    // A desk claim's `project` is a display label only (a subfolder's
    // basename) - resolveProjectPath(roots, project) would 404 it, since it
    // is never a direct child of any root. Its honesty rests on
    // original_path instead: it must sit inside SOME listed project, and
    // its OWN derived name (the same rule discovery used to name it) must
    // match session_name. A launched entry (no `source` marker) keeps the
    // original resolveProjectPath contract unchanged.
    let resolvedPath;
    if (entrySource === 'desk') {
      const resolved = path.resolve(originalPath);
      const owner = projects.find((p) => isInsideProject(p.path, resolved));
      if (!owner) {
        drop(sessionName);
        continue;
      }
      if (deriveDeskSessionName(owner.root, resolved) !== sessionName) {
        drop(sessionName);
        continue;
      }
      resolvedPath = resolved;
    } else {
      // MUST NOT go through resolveProjectPath's multi-root form-2 scan: an
      // identifier that is ambiguous across two roots would return 400, and
      // the prune drops on !r.ok - so a legitimately running session would
      // be SILENTLY KILLED OFF THE REGISTRY on the 5s poll. Resolve the
      // owning root from original_path first (the server-side truth this
      // entry already carries), then resolve `project` within THAT ONE root.
      // One root in the array makes form 2 unambiguous by construction - one
      // lstat per entry, and the full resolveProjectPath trust boundary
      // still runs. Both identifier forms round-trip this way: a stored
      // form-1 `project` matches that root's slug and is stripped; a stored
      // legacy `project` resolves against that one root.
      const resolvedOriginal = path.resolve(originalPath);
      const owningRoot = roots.find((rt) => isInsideProject(path.resolve(rt.path), resolvedOriginal));
      if (!owningRoot) {
        drop(sessionName);
        continue;
      }
      const r = resolveProjectPath([owningRoot], project);
      if (!r.ok) {
        drop(sessionName);
        continue;
      }
      if (r.path !== resolvedOriginal) {
        drop(sessionName);
        continue;
      }
      if (deriveSessionName(r.path, owningRoot.path) !== sessionName) {
        drop(sessionName);
        continue;
      }
      resolvedPath = r.path;
    }

    // handoff / ended / any other explicit status are handled here, each
    // exiting the loop via `continue`; entry.status === undefined falls
    // through to the original status-derivation block below unchanged.
    if (entry.status === 'handoff') {
      // No pid-file read here: it is unlinked the moment the kill is
      // confirmed, so its absence carries no information for this branch.
      if (!Number.isFinite(Date.parse(entry.handoff_started_at))) {
        drop(sessionName);
        continue;
      }
      const age = nowMs - Date.parse(entry.handoff_started_at);
      // Same clock-tamper rule the `starting` branch uses below - without a
      // drop here a tampered timestamp blocks every future relaunch.
      if (age < -STARTING_GRACE_MS) {
        drop(sessionName);
        continue;
      }
      const eff = Math.max(0, age);
      if (eff < HANDOFF_TIMEOUT_MS) {
        survivors.push(entry);
        views.push({
          session_name: sessionName,
          project,
          path: resolvedPath,
          status: 'handoff',
          started_at: startedAt,
          pid: null,
          source: 'launched',
          session_id: null,
        });
      } else if (eff >= FAILED_RETENTION_MS) {
        drop(sessionName);
        continue;
      } else {
        // Past the timeout but inside 24h: the agent restarted mid-run and
        // never got to record a verdict. Report it as an interrupted end
        // rather than leaving the entry stuck as `handoff` forever.
        //
        // The entry is REWRITTEN, not merely re-reported. dismissSession is a
        // compare-and-swap on the STORED status (dropSession, fromStatus
        // 'ended'), so an entry still saying `handoff` matched nothing and the
        // record could never be dismissed: the PWA re-announced "the handoff
        // was not written" on EVERY open for a full 24h (owner hit this
        // 2026-08-27). Normalising the stored status is what lets the one
        // banner be the last one.
        const settled = {
          ...entry,
          status: 'ended',
          ended_at: entry.handoff_started_at,
          handoff_ok: false,
          handoff_result: 'interrupted',
        };
        delete settled.handoff_started_at;
        survivors.push(settled);
        rewroteAny = true;
        views.push({
          session_name: sessionName,
          project,
          path: resolvedPath,
          status: 'ended',
          started_at: startedAt,
          pid: null,
          ended_at: entry.handoff_started_at,
          handoff_ok: false,
          handoff_result: 'interrupted',
          source: 'launched',
          session_id: null,
        });
      }
      continue;
    }

    if (entry.status === 'ended') {
      if (!Number.isFinite(Date.parse(entry.ended_at)) || typeof entry.handoff_ok !== 'boolean') {
        drop(sessionName);
        continue;
      }
      if (typeof entry.handoff_result !== 'string' || entry.handoff_result === '') {
        drop(sessionName);
        continue;
      }
      // Clamped, never dropped for a future timestamp - losing the record
      // loses the only report the owner gets.
      const age = Math.max(0, nowMs - Date.parse(entry.ended_at));
      if (age >= FAILED_RETENTION_MS) {
        drop(sessionName);
        continue;
      }
      survivors.push(entry);
      views.push({
        session_name: sessionName,
        project,
        path: resolvedPath,
        status: 'ended',
        started_at: startedAt,
        pid: null,
        ended_at: entry.ended_at,
        handoff_ok: entry.handoff_ok,
        handoff_result: entry.handoff_result,
        source: 'launched',
        session_id: null,
      });
      continue;
    }

    if (entry.status !== undefined) {
      drop(sessionName);
      continue;
    }

    const pid = readPidFile(pidDir, sessionName);
    let status;
    if (pid !== null) {
      if (isAlive(pid)) {
        status = 'running';
      } else {
        drop(sessionName);          // unchanged: a session that ran and exited
        continue;                   // is finished, not failed - keep pruning it
      }
    } else {
      const age = nowMs - Date.parse(startedAt);
      // A started_at in the future is either a tampered file or a clock that
      // moved backwards. Only a clearly impossible future is dropped: without
      // some drop the entry stays `starting` forever and blocks every future
      // relaunch. A SMALL backward step is tolerated and clamped instead,
      // because deleting here would erase a launch that is very likely
      // running - and the next tap would then spawn a duplicate session with
      // the same name, which is the outcome this whole status exists to
      // prevent. w32time slews small offsets but steps larger ones.
      if (age < -STARTING_GRACE_MS) {
        drop(sessionName);
        continue;
      }
      const effectiveAge = Math.max(0, age);
      if (effectiveAge < STARTING_GRACE_MS) {
        status = 'starting';
      } else if (effectiveAge < FAILED_RETENTION_MS) {
        // No pid file past the grace window. The agent cannot tell "never
        // started" from "started but the pid write failed" - `failed` here
        // means only "never confirmed, and never will be". The UI must say
        // that, not "it failed".
        status = 'failed';
      } else {
        drop(sessionName);
        continue;
      }
    }

    // A LAUNCHED session's registry pid is the cmd.exe wrapper, so activity
    // cannot come off the pid - it is matched by cwd instead (see
    // newestRecordAt). Only `running` asks: `starting` has no session file
    // yet, and `handoff`/`ended` return above this point.
    // ponytail: one extra readSessionFiles pass per running launched entry
    // (0-2 in practice, poll every 5s). Thread the records through
    // discoverDeskSessions too if that ever shows up in a profile.
    const activity = status === 'running' ? newestRecordAt(ctx, resolvedPath)?.activity : undefined;

    survivors.push(entry);
    views.push({
      session_name: sessionName,
      project,
      path: resolvedPath,
      status,
      started_at: startedAt,
      pid: status === 'running' ? pid : null,
      source: 'launched',
      session_id: null,
      ...(activity ? { activity } : {}),
    });
  }

  if (droppedAny || rewroteAny) {
    writeRegistry(registryPath, survivors);
  }

  // Discovery runs AFTER the prune/write and never writes anything itself -
  // a read of /api/sessions must not mutate the registry on account of a
  // desk session.
  const claimed = new Set(views.map((v) => v.session_name));
  views.push(...discoverDeskSessions(ctx, projects, claimed));
  return views;
}

/** The live SessionView whose session_name === sessionName, or null.
 *  `failed` and `ended` are deliberately NOT live: both are retained only to
 *  be shown, and treating either as live would make the project permanently
 *  unlaunchable. `handoff` IS live - it blocks relaunch while the run is in
 *  flight, which keeps the session inside the agent's own knowledge until a
 *  verdict is recorded. */
export function findLiveSession(ctx, sessionName) {
  const sessions = listSessions(ctx);
  return sessions.find((s) => s.session_name === sessionName
    && s.status !== 'failed' && s.status !== 'ended') || null;
}

/**
 * Appends a launch record, creating the data directory if absent, and
 * returns the SessionView for it (status 'starting', pid null). Never
 * throws; a write failure is logged and the SessionView is still returned.
 */
export function recordLaunch(ctx, { sessionName, project, projectPath }) {
  const { registryPath = getRegistryFilePath(), now = Date.now } = ctx;

  const startedAt = new Date(now()).toISOString();

  let sessions = readEntries(registryPath);

  // A retained `failed` entry for this session name is superseded by the new
  // launch, not accumulated beside it.
  sessions = sessions.filter(
    (e) => !(e && typeof e === 'object' && e.session_name === sessionName),
  );

  sessions.push({
    session_name: sessionName,
    project,
    original_path: projectPath,
    started_at: startedAt,
  });

  writeRegistry(registryPath, sessions);

  return {
    session_name: sessionName,
    project,
    path: projectPath,
    status: 'starting',
    started_at: startedAt,
    pid: null,
  };
}

/**
 * Patches the registry entry named sessionName IF its current `status` field
 * equals fromStatus (pass null to mean "the entry has no status field").
 * Returns true iff it patched. NEVER appends - a name that is gone stays gone,
 * which is what stops a finishing handoff from marking a freshly relaunched
 * session as ended. Never throws.
 */
export function markSessionState(ctx, sessionName, fromStatus, patch) {
  const { registryPath = getRegistryFilePath() } = ctx;

  const sessions = readEntries(registryPath);

  const entry = sessions.find((e) => e && typeof e === 'object' && e.session_name === sessionName);
  if (!entry || (entry.status ?? null) !== fromStatus) {
    return false;
  }

  Object.assign(entry, patch);
  // The write IS the claim. A swallowed rename failure must not report a
  // transition that never reached disk, or two stops could both "win".
  return writeRegistry(registryPath, sessions);
}

/**
 * Removes the registry entry named sessionName outright (not a status
 * patch). Used when a claimed transition backs out to a state with no
 * process behind it, so the entry does not linger as a status-less ghost
 * that listSessions would otherwise age into `failed` after STARTING_GRACE_MS
 * and draw a false "no session confirmed" banner for a session that in fact
 * ran and ended. Never throws.
 */
export function dropSession(ctx, sessionName, fromStatus) {
  const { registryPath = getRegistryFilePath() } = ctx;
  // Compare-and-swap like markSessionState: only the entry whose status is
  // still fromStatus is removed, so a concurrent relaunch's fresh entry
  // (status-less) is never deleted by a stop that lost the race.
  const all = readEntries(registryPath);
  const sessions = all.filter(
    (e) => !(e && typeof e === 'object' && e.session_name === sessionName
      && (e.status ?? null) === fromStatus),
  );
  if (sessions.length === all.length) return;   // nothing matched: leave the file untouched
  writeRegistry(registryPath, sessions);
}
