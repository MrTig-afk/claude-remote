import fs from 'node:fs';
import path from 'node:path';

import { readConfig, writeConfig, getConfigFilePath } from './config.js';
import { listDrives } from './drives.js';
import { resolveRealFolderPath } from './folders.js';

/** Hard cap on shared roots. */
export const MAX_SHARED_ROOTS = 32;

// Same construction as folders.js's CONTROL_CHAR_RE (and projects.js's
// CONTROL_CHAR_RE before it) - built from String.fromCharCode so this
// source carries no raw control bytes.
const CONTROL_CHAR_RE = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);

// The same drive-rooted shape folders.js's V4 requires - a relative or empty
// env var must contribute nothing rather than anchor to the process's
// current drive.
const DRIVE_ROOTED_RE = /^[A-Za-z]:[\\/]/;

const SYSTEM_DIR_ENV_KEYS = ['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData'];

/**
 * The five forbidden system locations, derived from env, absolute and
 * resolved. Exported for test. Pure (the realpath probe below never throws
 * out of this function - a host without the folder just contributes no
 * canonical form for it).
 * -> string[]
 */
export function systemDirsFor(env) {
  const candidates = SYSTEM_DIR_ENV_KEYS.map((key) => env[key]);
  // USERPROFILE\AppData - only when USERPROFILE itself is usable, so a
  // relative or empty value never anchors to the process's current drive.
  candidates.push(
    typeof env.USERPROFILE === 'string' && DRIVE_ROOTED_RE.test(env.USERPROFILE)
      ? path.join(env.USERPROFILE, 'AppData')
      : undefined,
  );

  const out = [];
  for (const value of candidates) {
    if (typeof value !== 'string' || !DRIVE_ROOTED_RE.test(value)) continue;
    const resolved = path.resolve(value);
    out.push(resolved);

    // Also add the canonical form, best-effort: the candidate this function
    // is checked against is compared canonically (system_directory below
    // runs on `real`), so a system directory reached through a junction, or
    // whose canonical spelling differs, would not match a lexical-only
    // list. Five extra syscalls on a route that runs a handful of times.
    try {
      let real = fs.realpathSync.native(resolved);
      // Strip a \\?\ prefix the same way folders.js's realPathVerdict does,
      // or this entry can never match a plain-rooted candidate.
      if (real.startsWith('\\\\?\\')) real = real.slice(4);
      out.push(real);
    } catch {
      // Not present on this host - contributes nothing, not an error.
    }
  }
  return out;
}

// path.resolve emits '\' on win32 and strips trailing separators from
// everything except a drive root, so the only stripping needed here is the
// root case ('F:\' -> 'F:').
function pathKey(p) {
  return p.replace(/[\\/]+$/, '').toUpperCase();
}

/**
 * Segment-aware, case-folded containment. `candidate` is inside `ancestor`,
 * or is the same folder. Pure. Exported for test.
 * -> boolean
 */
export function isInsideOrEqual(candidate, ancestor) {
  const a = pathKey(ancestor);
  const c = pathKey(candidate);
  return c === a || c.startsWith(a + path.sep);
}

function isPlainExcludeName(name) {
  if (typeof name !== 'string') return false;
  if (name.trim() === '') return false;
  if (name.length > 255) return false;
  if (CONTROL_CHAR_RE.test(name)) return false;
  if (name === '.' || name === '..') return false;
  if (/[\\/:]/.test(name)) return false;
  return true;
}

/**
 * One entry, all checks except overlap (which is cross-entry).
 * `drives` is listDrives()'s `drives` array. `systemDirs` is systemDirsFor()'s
 * output. Pure except for the filesystem calls resolveRealFolderPath makes.
 * -> { ok: true, entry, real } | { ok: false, error }
 *    `entry` is the four-key object to store; `real` is the CANONICAL path,
 *    returned so the caller can run overlap on it and so a test can assert
 *    canonicalisation happened at all.
 */
export function validateSharedEntry(entry, drives, systemDirs) {
  // 1 - plain object.
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, error: 'invalid_entry' };
  }

  // 2 - mode. Absent-defaults but present-and-wrong-rejects: defaulting a
  // key the client did not send is not sanitizing a bad value; rewriting a
  // value the client DID send would be. Same posture as validateProjectName
  // - reject bad input, never invent a correction.
  const mode = entry.mode === undefined ? 'container' : entry.mode;
  if (mode !== 'container' && mode !== 'single') {
    return { ok: false, error: 'invalid_mode' };
  }

  // 3 - new_folders, same posture.
  const newFolders = entry.new_folders === undefined ? 'show' : entry.new_folders;
  if (newFolders !== 'show' && newFolders !== 'hide') {
    return { ok: false, error: 'invalid_new_folders' };
  }

  // 4 - excludes, same posture. Each member is a plain NAME - no separators,
  // no '..' - never sanitized, only accepted or rejected whole.
  const excludes = entry.excludes === undefined ? [] : entry.excludes;
  if (!Array.isArray(excludes) || !excludes.every(isPlainExcludeName)) {
    return { ok: false, error: 'invalid_excludes' };
  }

  // 5 - path through the boundary. resolveRealFolderPath, NEVER
  // validateFolderPath - see the module-level note in folders.js. This one
  // call covers V1-V7: shape, control chars, %, UNC, \\?\, the lexical
  // drive check, exists + isDirectory with a junction refused, and the
  // canonical drive re-check.
  const pathVerdict = resolveRealFolderPath(entry.path, drives);
  if (!pathVerdict.ok) {
    return { ok: false, error: pathVerdict.error };
  }
  const { resolved, real } = pathVerdict;

  // 6 - not a drive root. path.resolve leaves a drive root as 'F:\' WITH the
  // separator, so this comparison is exact and needs no stripping. The
  // `real` half is a structural backstop - V6 already refuses a
  // final-component junction, so `real` can only be a root when `resolved`
  // is - kept for the same reason folders.js keeps its UNC backstop behind V4.
  if (resolved === path.parse(resolved).root || real === path.parse(real).root) {
    return { ok: false, error: 'drive_root' };
  }

  // 7 - not a system directory, or inside one. The `real` half is
  // load-bearing: a lexical-only check is defeated by an intermediate
  // junction, which is the exact T93 hole.
  if (systemDirs.some((dir) => isInsideOrEqual(resolved, dir) || isInsideOrEqual(real, dir))) {
    return { ok: false, error: 'system_directory' };
  }

  return {
    ok: true,
    entry: { path: resolved, mode, excludes, new_folders: newFolders },
    real,
  };
}

/**
 * The route body. NEVER throws, NEVER rejects. Reads `configPath`,
 * `systemDirs`, and (through listDrives) `driveExec` / `systemDrive` off ctx.
 * Reads NOTHING from the request except the already-parsed body object.
 * -> { ok: true, shared_folders } | { ok: false, status, error, index? }
 */
export async function putSharedFolders(ctx, body) {
  try {
    // 4.0 - body shape.
    if (body === null || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.shared_folders)) {
      return { ok: false, status: 400, error: 'invalid_request' };
    }
    const rawEntries = body.shared_folders;

    // 4.1 - count, before any per-entry work and before the drive read, so a
    // 33-root body never spawns PowerShell.
    if (rawEntries.length > MAX_SHARED_ROOTS) {
      return { ok: false, status: 400, error: 'too_many_roots' };
    }

    // 4.2 - the drive list. Call listDrives(ctx) DIRECTLY, never
    // folders.js's cachedDrives: its 60s TTL is deliberate for browsing and
    // wrong for the write boundary. folders.js's own comment says the
    // staleness is acceptable *because* this route re-checks the drive
    // independently. One PowerShell spawn on an explicit SAVE - an action
    // that happens a handful of times in this app's life - is the correct
    // cost. Unconditional even for an empty array, so the success path is
    // one shape.
    const driveResult = await listDrives(ctx);
    if (driveResult.error) {
      return { ok: false, status: 503, error: 'drives_unavailable' };
    }
    const { drives } = driveResult;

    // 4.3 - system dirs, computed once per request.
    const systemDirs = ctx.systemDirs || systemDirsFor(process.env);

    // 4.4 - per entry, in array order, first failure wins. Nothing is
    // written and no later entry is examined.
    const entries = [];
    const reals = [];
    for (let i = 0; i < rawEntries.length; i += 1) {
      const verdict = validateSharedEntry(rawEntries[i], drives, systemDirs);
      if (!verdict.ok) {
        return { ok: false, status: 400, error: verdict.error, index: i };
      }
      entries.push(verdict.entry);
      reals.push(verdict.real);
    }

    // 4.5 - overlap (B3), after every entry has validated, on the CANONICAL
    // paths. index is the LATER row - the one the picker asks the owner to
    // untick.
    // ponytail: O(n^2) over at most 32 roots is 496 comparisons on a route
    // that runs a handful of times per install. Upgrade path if it ever
    // matters: sort the keys and compare neighbours.
    for (let j = 1; j < reals.length; j += 1) {
      for (let i = 0; i < j; i += 1) {
        if (isInsideOrEqual(reals[i], reals[j]) || isInsideOrEqual(reals[j], reals[i])) {
          return { ok: false, status: 409, error: 'overlapping_root', index: j };
        }
      }
    }

    // 4.6 - the write. Everything above completes first, and this is the
    // LAST statement in the function - a rejection above is structurally
    // byte-identical to no call at all.
    const { configPath = getConfigFilePath() } = ctx;
    let config;
    try {
      config = readConfig(configPath);
    } catch {
      // readConfig THROWS on invalid JSON. Catch it and refuse rather than
      // let a fresh object be written over a file we could not read, which
      // would silently destroy acknowledged_at.
      return { ok: false, status: 500, error: 'config_unreadable' };
    }
    // Merged into the existing object so acknowledged_at and any unrelated
    // key survive untouched. This route never writes acknowledged_at - not
    // to set it, not to clear it.
    config.shared_folders = entries;
    if (!writeConfig(configPath, config)) {
      return { ok: false, status: 500, error: 'write_failed' };
    }

    return { ok: true, shared_folders: entries };
  } catch (err) {
    // Backstop only - every step above already has its own failure path.
    // Reaching this is a bug in this module, not a designed path.
    console.warn(`claude-remote agent: PUT /api/shared failed unexpectedly: ${err.code || err.message}`);
    return { ok: false, status: 500, error: 'write_failed' };
  }
}
