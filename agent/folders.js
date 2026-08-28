import fs from 'node:fs';
import path from 'node:path';

import { listDrives } from './drives.js';

/**
 * GET /api/folders?path= - lets the picker drill into any FIXED, NON-BLOCKED
 * DRIVE, not the already-shared set. On first run nothing is shared yet
 * (resolveSharedFolders returns []), so a route that browsed only the shared
 * set would return nothing at all and the owner could never pick a first
 * folder - the whole M9 feature would be unreachable. This is the thing a
 * later reader will most want to "tighten" without realising it breaks
 * first-run completely. The narrowing happens at the WRITE route (T94),
 * which re-validates every ticked path server-side and independently.
 * Browsing is wide by design; sharing is narrow by enforcement.
 *
 * WHAT T94 MUST CALL: `resolveRealFolderPath`, never `validateFolderPath`.
 * `validateFolderPath` is V1-V5 only, purely lexical, and is confinement on
 * paper - not on the filesystem. `resolveRealFolderPath` is V1-V7, the only
 * function in this module that actually asks the filesystem what a path
 * resolves to, and it is the boundary every route (this one and T94) must
 * call.
 */

export const MAX_FOLDERS = 500;

const DRIVE_CACHE_TTL_MS = 60_000;

// Equivalent to /[\u0000-\u001f\u007f]/ - same construction as projects.js's
// CONTROL_CHAR_RE, built from String.fromCharCode so this source carries no
// raw control bytes.
const CONTROL_CHAR_RE = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);

// V3 - the device-namespace prefix forms: \\?\, \\.\ and their forward-slash
// spellings (//?/, //./). Windows accepts all four; they bypass Win32 path
// normalisation entirely and their path.parse().root is not a plain drive
// root, so the V5 comparison below cannot be trusted to speak about them.
// Reject them by shape, before resolve.
const DEVICE_NAMESPACE_RE = /^[\\/]{2}[?.][\\/]/;

// V4 - the positive shape allowlist. This is the check that kills THREE
// separate holes at once, and is a positive allowlist rather than a set of
// negative (UNC) checks for exactly that reason:
//   1. UNC (\\server\share) fails this regex - a UNC path would make the
//      agent reach out over SMB from a request parameter: network egress the
//      project's egress rule forbids, and a hang on an unreachable host.
//   2. Driveless-absolute (/etc, /) - path.isAbsolute('/etc') is TRUE on
//      win32, and path.resolve anchors it to the agent process's CURRENT
//      DRIVE (on this host /etc becomes F:\etc). path.isAbsolute alone is NOT
//      a sufficient check: the same string means a different folder
//      depending on where the agent happened to be started.
//   3. Drive-relative (C:foo, colon with no separator) - resolves against the
//      process's per-drive current directory, another ambient-state read.
//      The mandatory separator after the colon is what rejects it.
// Forward slashes after the drive letter (F:/Dev) are allowed - path.resolve
// normalises them, so this is normalisation of a form already inside the
// allowlist, not sanitization of a rejected one.
const DRIVE_ROOT_RE = /^[A-Za-z]:[\\/]/;

/**
 * V1-V4 only. Pure, no filesystem call, NOT exported - `listFolders` calls
 * this directly (fix for the non-gate finding that `cachedDrives` used to run
 * BEFORE any validation, so a malformed request triggered a cold-cache
 * PowerShell spawn and returned 503 where 400 is the truth), and
 * `validateFolderPath` calls it too, so it runs twice per valid request. Four
 * cheap regex tests - deliberately, rather than threading a "already
 * shape-checked" flag through two call sites for one spawn's worth of
 * latency. -> null | { ok: false, status, error }
 */
function checkShape(rawPath) {
  // V1 - shape and ceiling. Measured on the RAW value, before any resolve:
  // V4 below forces a drive-rooted absolute path, so path.resolve can only
  // shorten a passing value, never grow it past the ceiling. 255 is the same
  // ceiling resolveProjectPath (sessions.js) uses, deliberately.
  if (
    typeof rawPath !== 'string' || rawPath === '' || rawPath.trim() === ''
    || rawPath.length > 255
  ) {
    return { ok: false, status: 400, error: 'invalid_request' };
  }

  // V2 - '%' and control characters, on the RAW value. `new URL` in
  // handleRequest has ALREADY decoded the query value once, so %2e%2e
  // arrived here as '..'; a surviving '%' can therefore only be a
  // double-encoding attempt (%252e) or an unnecessary escape - no legitimate
  // Windows folder path needs one. NEVER decode again: a second
  // decodeURIComponent re-creates '..' from %2e%2e and is the whole bug
  // class this rule exists to close. Same one-line rule agent/static.js uses
  // and the same reasoning.
  if (rawPath.includes('%')) return { ok: false, status: 400, error: 'invalid_path' };
  if (CONTROL_CHAR_RE.test(rawPath)) return { ok: false, status: 400, error: 'invalid_path' };

  // V3
  if (DEVICE_NAMESPACE_RE.test(rawPath)) return { ok: false, status: 400, error: 'invalid_path' };

  // V4
  if (!DRIVE_ROOT_RE.test(rawPath)) return { ok: false, status: 400, error: 'invalid_path' };

  return null;
}

/**
 * Pure. No filesystem call. `drives` is listDrives()'s `drives` array (each
 * entry carries `letter` in T92's "C:" normal form and a `blocked` boolean).
 * Order is load-bearing - reject, never sanitize; do not reorder these
 * checks. **NOT a boundary on its own** - a caller that uses this alone is
 * confined on paper, not on the filesystem; see `resolveRealFolderPath`.
 * -> { ok: true, resolved } | { ok: false, status, error }
 */
export function validateFolderPath(rawPath, drives) {
  const shapeRejection = checkShape(rawPath);
  if (shapeRejection) return shapeRejection;

  // V5 - resolve, then the root must be a fixed, non-blocked drive. This is
  // what makes '..' harmless: path.resolve normalises it away, and what
  // remains either is or is not under an allowed root. '..' cannot change
  // the drive on Windows (path.resolve('F:\\..\\Windows') clamps at the
  // root), so the root check is not defeatable by traversal. Do not add a
  // separate '..' string check - a string check on a value resolve has
  // already normalised is theatre and gives the next reader false
  // confidence. This check is PURELY LEXICAL and is duplicated, on purpose,
  // by `realPathVerdict` against the CANONICAL path after the filesystem has
  // been consulted - a lexical root and a canonical root answer different
  // questions and neither can stand in for the other.
  const resolved = path.resolve(rawPath);
  // path.parse(resolved).root returns "C:\\" WITH the trailing separator;
  // T92's normal form is "C:" WITHOUT it (normaliseLetter strips
  // /[\\/]+$/). Strip it before comparing - an unstripped comparison
  // silently never matches, which fails closed (everything 404s) and would
  // look like "the picker is broken", not like a security bug.
  const root = path.parse(resolved).root;
  // Structural UNC backstop - unreachable after V4 and kept deliberately,
  // the same way resolveProjectPath keeps its lexical confinement behind its
  // per-segment checks. A UNC root is the one root form that keeps a
  // trailing separator after resolve, so the stripped comparison below would
  // mis-handle it; rejecting it outright here is why that never matters.
  if (root.startsWith('\\\\')) return { ok: false, status: 400, error: 'invalid_path' };
  const letter = root.replace(/[\\/]+$/, '').toUpperCase();

  const entry = drives.find((d) => d.letter === letter);
  // The blocked check runs BEFORE any filesystem call (and before this
  // function ever makes one - it makes none). That ordering means a response
  // about the blocked system drive cannot be used to probe whether a folder
  // on it exists: C:\Windows and C:\definitely-not-here return the identical
  // 400 blocked_drive.
  if (entry && entry.blocked) return { ok: false, status: 400, error: 'blocked_drive' };
  if (!entry) return { ok: false, status: 404, error: 'not_found' };

  return { ok: true, resolved };
}

/**
 * Pure. path.dirname('F:\\') returns 'F:\\' - itself - so a naive dirname
 * would give the picker a back button that navigates to the screen it is
 * already on. null is the explicit "you are at the top of this drive; the
 * back button goes to the DRIVE LIST" signal, a value the client cannot
 * mistake for a path. (path.resolve leaves a drive root as 'F:\', with the
 * separator, so this `resolved === root` comparison is exact and needs no
 * stripping - unlike V5's letter comparison above; the two are easy to
 * conflate.)
 */
export function parentOf(resolved) {
  const root = path.parse(resolved).root;
  return resolved === root ? null : path.dirname(resolved);
}

/**
 * The only honest readability test on Windows: fs.accessSync does not
 * respect NTFS ACLs there, so it would report readable: true for a folder
 * that then fails to open. opendirSync + immediate closeSync is cheaper than
 * a full readdir.
 * ponytail: up to 500 handle opens on a huge directory, one per row. Upgrade
 * path if it ever feels slow: compute `readable` for the first screenful
 * only and fill the rest lazily from the client.
 */
function defaultDirProbe(childPath) {
  try {
    const dir = fs.opendirSync(childPath);
    dir.closeSync(); // close IMMEDIATELY - 500 leaked handles otherwise
    return true;
  } catch {
    // A closeSync throw here is a one-in-a-million wrong "unreadable" label,
    // never a crash - folded into the same catch as the open, rather than a
    // nested try, so it cannot escape into listFolders's 500 backstop.
    return false;
  }
}

/**
 * One helper, used by both the lstat and the readdir catch. By err.code
 * only - never an OS error string or a filesystem path reaches the response.
 * ENOTDIR is grouped with ENOENT: a deliberate one-word extension of the
 * brief's map (ENOENT -> 404; EACCES/EPERM -> 403; else 500) - a path under a
 * file is "not a folder", not a server fault, and 500 for a client typo is a
 * lie. Every other code stays exactly as the brief has it.
 */
function mapFsError(err) {
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { ok: false, status: 404, error: 'not_found' };
  if (err.code === 'EACCES' || err.code === 'EPERM') return { ok: false, status: 403, error: 'not_readable' };
  // Safe to build only because V2 already rejected control characters, so a
  // crafted path cannot inject terminal escapes into the owner's console.
  console.warn(`claude-remote agent: /api/folders failed: ${err.code || err.message}`);
  return { ok: false, status: 500, error: 'list_failed' };
}

/**
 * The V7 verdict on a CANONICAL path (the output of
 * `fs.realpathSync.native`). Pure - no filesystem call. `null` means allowed.
 * Every failure - blocked drive, unknown letter, UNC, no plain drive root -
 * collapses to the SAME 404 not_found, deliberately: after the filesystem
 * has been consulted, a distinct status would tell a caller that their
 * planted junction resolved and where it pointed. Same posture V6 takes - a
 * caller cannot tell a junction from a typo.
 * Duplicates validateFolderPath's root-extraction on purpose - see that
 * function's V5 comment for why the duplication is kept.
 * -> null | { ok: false, status: 404, error: 'not_found' }
 */
export function realPathVerdict(real, drives) {
  const NOT_FOUND = { ok: false, status: 404, error: 'not_found' };

  // 1 - strip ONE optional \\?\ prefix. realpathSync.native can hand back a
  // \\?\-prefixed path on Windows (long paths in particular). Un-stripped,
  // path.parse().root on that form is not a plain drive root and every such
  // path would 404 - failing closed, but breaking legitimate deep browsing.
  const stripped = real.startsWith('\\\\?\\') ? real.slice(4) : real;

  // 2 - a UNC root (\\server\share, or the \\?\UNC\... device form, which
  // after stripping becomes UNC\server\share and parses with NO root at
  // all) is rejected below by the drive-letter check failing to match. A
  // directory symlink can target a UNC path; canonicalising into one must
  // not become browsable - the same forbidden SMB egress V4 rejects
  // lexically.
  const root = path.parse(stripped).root;
  if (root.startsWith('\\\\')) return NOT_FOUND;

  // 3 - T92's "C:" normal form, the same normalisation V5 does.
  const letter = root.replace(/[\\/]+$/, '').toUpperCase();
  if (!/^[A-Z]:$/.test(letter)) return NOT_FOUND; // no plain drive root at all

  // 4 - look the letter up. Not present, or blocked -> reject.
  const entry = drives.find((d) => d.letter === letter);
  if (!entry || entry.blocked) return NOT_FOUND;

  return null;
}

/**
 * V1-V7. **THIS IS THE BOUNDARY. EVERY ROUTE CALLS THIS, INCLUDING T94.**
 * -> { ok: true, resolved, real } | { ok: false, status, error }
 */
export function resolveRealFolderPath(rawPath, drives) {
  const validated = validateFolderPath(rawPath, drives);
  if (!validated.ok) return validated;
  const { resolved } = validated;

  // V6 - lstatSync, NEVER statSync, and isDirectory(). statSync FOLLOWS a
  // junction and reports a directory - exactly the answer that would let a
  // link planted on an allowed drive be browsed as though it were a real
  // folder. Same rule, same reasoning as resolveProjectPath's S6n-pre
  // (sessions.js) and serveStatic's lstat (static.js). A junction fails
  // isDirectory() on the lstat result and comes back 404 not_found,
  // indistinguishable from a folder that is simply not there - a caller
  // cannot tell a junction from a typo. A drive root (F:\) passes this and
  // IS browsable - the picker's entry point after the drive list.
  let st;
  try {
    st = fs.lstatSync(resolved);
  } catch (err) {
    return mapFsError(err);
  }
  if (!st.isDirectory()) return { ok: false, status: 404, error: 'not_found' };

  // V7 - CANONICALISE, THEN RE-CHECK THE DRIVE. V5 above is PURELY LEXICAL
  // (path.resolve + path.parse) and V6 lstats ONLY THE FINAL COMPONENT.
  // Windows resolves a reparse point in the MIDDLE of a path at the OS level,
  // so a junction planted at <allowed>\link makes lstatSync on
  // <allowed>\link\Child report a real directory and readdirSync list the LINK
  // TARGET's children - including on the BLOCKED system drive. Reproduced on
  // this host before this guard existed, twice, independently: a direct browse
  // of the blocked drive returned 400 blocked_drive and a browse of the link
  // itself returned 404, while a browse THROUGH the link returned 200 with
  // fifteen real folder names off the blocked drive.
  // This is the same bug class resolveProjectPath's S6n-pre guard exists for -
  // its comment records the same reasoning - reintroduced on a route with
  // UNBOUNDED depth, where a per-parent lstat would not be enough and one
  // canonicalisation is.
  // realpathSync.native, NEVER realpathSync: the native form asks the OS and
  // resolves junctions; the JS form walks symlinks and does not resolve
  // Windows junctions reliably.
  // Compare ROOTS, NEVER `real !== resolved`: an 8.3 short name, NTFS case
  // canonicalisation and every legitimate same-drive junction make the strings
  // differ while the drive - the actual boundary - is unchanged.
  // DO NOT remove this because "V5 already checks the drive". Without it the
  // checks above are confinement on paper only.
  // Goes AFTER V6, not instead of it: V7 alone would ACCEPT a final-component
  // junction whose target is on the same allowed drive, which this route's
  // contract (a link is never browsable) forbids.
  let real;
  try {
    real = fs.realpathSync.native(resolved);
  } catch (err) {
    return mapFsError(err);
  }
  const verdict = realPathVerdict(real, drives);
  if (verdict) return verdict;

  return { ok: true, resolved, real };
}

// Same comparator listProjects (agent/projects.js) uses. Redefined locally
// rather than exported from projects.js - that file is on the do-not-touch
// list - but the ordering deliberately matches it.
const byName = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' });

/**
 * DESIGN CALL 1 - the drive list is memoised on `ctx`, not a module-level
 * variable (a module-level cache would be shared across every server a test
 * file starts), with a 60s TTL and successful results only.
 * ponytail: 60s of staleness. A drive attached mid-session appears within a
 * minute. A drive removed mid-session stays in the allowed set for up to a
 * minute, and a browse of it then fails at lstat with ENOENT -> 404, so the
 * stale entry grants nothing. The one real window is drive-letter reuse: if
 * a fixed drive is removed and a removable one takes its letter inside 60s,
 * folder NAMES on the removable drive can be listed. That discloses names
 * only - nothing is shared by browsing, and PUT /api/shared (T94) re-checks
 * the drive independently - so the ceiling is accepted. Upgrade path if it
 * ever matters: drop the TTL to 5s, or invalidate on a lstat ENOENT of a
 * cached root.
 */
async function cachedDrives(ctx) {
  const now = (ctx.now || Date.now)();
  const cached = ctx.driveCache;
  if (cached && now - cached.at < DRIVE_CACHE_TTL_MS) return cached.drives;
  const result = await listDrives(ctx);
  if (result.error) return null; // never cache a failure
  ctx.driveCache = { at: now, drives: result.drives };
  return result.drives;
}

/**
 * The route body. NEVER throws, NEVER rejects. Reads exactly `driveExec`,
 * `systemDrive` (both only by passing ctx through to listDrives), `dirProbe`
 * and `now` off ctx, and writes ctx.driveCache. It reads no request object,
 * no headers and no body - nothing from the request reaches listDrives, and
 * therefore nothing from the request can reach execFile.
 */
export async function listFolders(ctx, rawPath) {
  try {
    const { dirProbe = defaultDirProbe } = ctx;

    // Cheap shape check BEFORE the drive cache: a request that is rejectable
    // on shape alone (missing ?path=, UNC, %, ...) must not trigger a
    // cold-cache PowerShell spawn and must not come back 503 for a request
    // that was never valid. Re-run inside validateFolderPath below via
    // resolveRealFolderPath - see checkShape's own comment for why the
    // duplication is kept.
    const shapeRejection = checkShape(rawPath);
    if (shapeRejection) return shapeRejection;

    // DESIGN CALL 1's failure branch. A failed drive read fails CLOSED - it
    // lists nothing - and says so honestly rather than returning
    // 404 not_found, which would be a lie about the folder. No filesystem
    // call is made in this branch.
    const drives = await cachedDrives(ctx);
    if (drives === null) {
      return { ok: false, status: 503, error: 'drives_unavailable' };
    }

    // V1-V7, THE BOUNDARY. `resolved` is the lexical path this response
    // echoes; `real` is the canonical path V7 actually cleared and is what
    // every filesystem call below uses - passing `resolved` here instead
    // would re-resolve the junction at readdir time and hand back exactly the
    // escape V7 exists to stop.
    // ponytail: NARROWED, not closed. realpath and the readdir below are
    // separate syscalls, so a junction swapped between them is still resolved
    // late. Not exploitable by the client this route serves: winning that race
    // needs local write access inside a directory being browsed, and anyone
    // holding that already reads those names directly - the PWA cannot create
    // a directory at all. Closing it fully needs handle-relative reads
    // (opendir + dirfd), which node does not expose on Windows. Same residual
    // resolveProjectPath already accepts.
    const validated = resolveRealFolderPath(rawPath, drives);
    if (!validated.ok) return validated;
    const { resolved, real } = validated;

    // 6.1 - do NOT reuse readEntries from projects.js: it swallows every
    // error and returns [], which would report an EACCES folder as an EMPTY
    // folder. On this route the difference is the whole point - 403
    // not_readable is required for the unreadable case. This copies
    // readEntries' shape (try, map the error, never let it escape), not the
    // function itself.
    let entries;
    try {
      entries = fs.readdirSync(real, { withFileTypes: true });
    } catch (err) {
      return mapFsError(err);
    }

    // 6.2 - directories only, dot-prefixed skipped. dirent.isDirectory() is
    // false for a junction or symlink on Windows - the same free link
    // exclusion listProjects documents, so a link is neither listed as a
    // folder nor probed. FILES ARE NEVER COUNTED, NEVER RETURNED, NEVER
    // NAMED - the accept screen's promise covers folder names only.
    const names = [];
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue;
      if (dirent.name.startsWith('.')) continue;
      names.push(dirent.name);
    }

    // 6.3 - total is the real directory count BEFORE the 500 slice, so
    // T100's banner can state a true number.
    const total = names.length;
    // 6.4 - sort BEFORE the slice, so "the first 500" is deterministic and
    // alphabetical instead of readdir order.
    names.sort(byName);
    // 6.5 - the cap.
    const truncated = total > MAX_FOLDERS;
    const sliced = names.slice(0, MAX_FOLDERS);

    // 6.6 - readable, computed AFTER the slice: at most MAX_FOLDERS probes,
    // not `total`.
    const folders = sliced.map((name) => ({
      name,
      readable: dirProbe(path.join(real, name)),
    }));

    return {
      ok: true,
      body: {
        path: resolved,
        parent: parentOf(resolved),
        folders,
        total,
        truncated,
      },
    };
  } catch (err) {
    // Backstop only - every filesystem call and the whole cachedDrives call
    // above already sit inside their own try. Reaching this is a bug in this
    // module, not a designed path.
    console.warn(`claude-remote agent: /api/folders failed unexpectedly: ${err.code || err.message}`);
    return { ok: false, status: 500, error: 'list_failed' };
  }
}
