import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { getPidDirPath, getRegistryFilePath, resolveClaudeConfigDir } from './config.js';
import {
  findLiveSession, clearPidFile, recordLaunch, markSessionState, dropSession,
  isPidAlive, claimDeskSession,
  pidFileNameFor,
} from './registry.js';
import { containerChildrenOf, rootsFrom, listProjects } from './projects.js';

const LAUNCH_SCRIPT = fileURLToPath(new URL('./launch-session.ps1', import.meta.url));

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
 * Was a port of ConvertTo-SessionName (ClaudeRemote.psm1) in its
 * ONE-ARGUMENT form. IT NO LONGER IS, and that divergence is deliberate:
 * slugSegment below is an allowlist, while ConvertTo-SessionName is still
 * the original denylist. They are not the same rule any more and must not be
 * "resynced" by loosening this side.
 * The two delivery paths do not share a sink - this one feeds
 * launch-session.ps1 and cmd.exe, the PowerShell one feeds a tmux session
 * name through wsl.exe - so the fix landed only where the sink is. Whether
 * the SSH path needs its own is an open question for that path, not a reason
 * to weaken this one. The old note about .NET \s vs JS \s is moot here: no
 * whitespace class is used any more.
 *
 * The TWO-ARGUMENT form has NO PowerShell counterpart - ConvertTo-SessionName
 * has no concept of a root or a container folder, and the Pester suite does
 * not cover this branch. Called with a root, ANY depth below it derives
 * '<root-slug>/<seg>/<seg>/...' (sessionNameFor, below) - owner decision 1,
 * 2026-08-29: the root prefix is ALWAYS present, and every segment between
 * root and target is carried, not just the first two. 'Pull Requests\Vercel'
 * can never share a registry key with a top-level 'Vercel'. The '/' is a
 * private separator: no single segment can contain one, because path.basename
 * never yields a separator and the slug rule (slugSegment) only ever
 * introduces '-'.
 *
 * This MUST return the same string as deriveDeskSessionName (registry.js)
 * for the same path, or listSessions emits two views for one live session -
 * both now delegate to sessionNameFor so they cannot drift.
 *
 * ponytail: the caller must opt in by passing a root. Call sites that do so
 * always pass a root drawn from rootsFrom(ctx)/resolveProjectPath's return,
 * never ctx.baseDir directly; every other caller - projects.js, the tests -
 * passes a bare name or a flat path and is unaffected.
 */
// SECURITY - an ALLOWLIST, and it must stay one. Everything that is not a
// letter or a digit collapses to a single '-', so no shell metacharacter can
// reach a session name whatever a folder is called.
// It was a denylist (whitespace and dots only) until this was found: a
// session name flows into launch-session.ps1, which hands it to
// Start-Process for `claude.cmd` - a .cmd, so Windows runs it through
// cmd.exe. A project named `x&calc` therefore executed calc. Anyone with a
// valid token could create one over the API, and so could a folder name on
// disk. Widening the name validators instead would have been a denylist
// guarding a denylist; this is the one choke point every caller goes
// through - resolveProjectPath, the launchability check, createProject's
// collision guard, the pid-file name and the registry key.
// Do not "relax" this to allow a character back in. Any new character here
// is a new character reaching cmd.exe.
export const slugSegment = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/**
 * How many hex characters of the path digest ride on the end of a root slug.
 * Six is a readability/uniqueness trade, not a security parameter - see the
 * ponytail note on rootSlug.
 */
const ROOT_SLUG_HASH_CHARS = 6;

/**
 * The root's own segment of every session name under it: slugSegment applied
 * to the root's WHOLE resolved path, plus a short digest OF that path.
 * 'F:\Dev\Projects\Repos' -> 'f-dev-projects-repos-9c3f1a'.
 *
 * Owner decision 1, 2026-08-29: ALWAYS prefixed, from one root onward - never
 * "only when there are two". A name that depends on HOW MANY roots exist is
 * not stable, and listSessions drops any entry whose derived name no longer
 * matches, so a conditional prefix would rename every running session at the
 * instant the owner adds his second folder.
 *
 * THE DIGEST IS WHY DECISION 1 ACTUALLY WORKS. slugSegment collapses every run
 * of non-alphanumerics to one '-', so a path SEPARATOR and a literal HYPHEN are
 * indistinguishable after slugging: 'F:\Dev\Projects\Repos' and
 * 'F:\Dev\Projects-Repos' are two different, non-overlapping folders that both
 * slugged to 'f-dev-projects-repos'. The overlap check accepts that pair (they
 * do not overlap) and usableRoots keeps both, so the two roots would share one
 * session-name namespace: STOP would end the other root's session and the
 * handoff would write HANDOFF.md into the wrong project. Reproduced, not
 * theorised. The readable half stays for humans; the digest is what makes the
 * identity true.
 *
 * Hashed on the UPPERCASED resolved path, deliberately: Windows paths are
 * case-insensitive, so 'F:\Dev' and 'f:\dev' are ONE folder and must be ONE
 * identity. Uppercase is the closer match to NTFS's own upcase-then-compare.
 * Hashing the raw or resolved-but-not-case-folded string would give a running
 * session a brand-new name the moment config.json was rewritten with different
 * casing, and the prune drops any entry whose name no longer derives - i.e. it
 * would silently kill live sessions on a rewrite.
 *
 * Pure function of the path: no counter, no stored id, no randomness, so it is
 * identical across agent restarts and reboots. Hex only, so it introduces no
 * character slugSegment's allowlist does not already emit.
 *
 * ponytail: 6 hex = 24 bits. Two roots collide only if their readable slugs
 * ALSO collide (the digest is a fixed-width suffix, so equal full strings force
 * equal readable halves) AND the digests collide - roughly 3e-5 across a
 * 32-root ceiling, and the owner will have two. Upgrade path if that is ever
 * not good enough: raise ROOT_SLUG_HASH_CHARS. It costs one more one-time
 * registry drop (owner decision 3's, already accepted) and nothing else.
 *
 * INTERNAL KEY ONLY - the tile still shows the real folder name with the dim
 * parent eyebrow. The digest never reaches the phone's UI.
 */
export function rootSlug(rootPath) {
  const resolved = path.resolve(rootPath);
  const digest = createHash('sha256')
    .update(resolved.toUpperCase(), 'utf8')
    .digest('hex')
    .slice(0, ROOT_SLUG_HASH_CHARS);
  return `${slugSegment(resolved)}-${digest}`;
}

/**
 * The session name for targetPath under rootPath: the root slug, then every
 * path segment between them, each slugged, joined with '/'. Returns null when
 * targetPath is not inside rootPath - a path outside the root must NEVER be
 * slugged into a name that looks confined.
 * targetPath === rootPath yields the root slug alone: that is a `single`-mode
 * root's session name.
 * THE ONE IMPLEMENTATION. deriveSessionName and deriveDeskSessionName both
 * delegate here, so they cannot drift; a second copy of this rule is exactly
 * how one live session renders as two tiles, and since T72 that would end the
 * WRONG session.
 */
export function sessionNameFor(rootPath, targetPath) {
  const rel = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return [rootSlug(rootPath), ...rel.split(path.sep).filter(Boolean).map(slugSegment)].join('/');
}

/**
 * Two latent behaviours this removed, deliberately:
 * 1. The old `segs.length === 2` branch fell back to the bare basename at
 *    depth 3+, while deriveDeskSessionName (registry.js) joined every
 *    segment - they diverged BY DESIGN at depth 3. They now agree at every
 *    depth via sessionNameFor.
 * 2. A cwd outside root used to still get its '..' segments slugged. It now
 *    returns null (deriveSessionName falls back to the bare basename, same
 *    as the no-baseDir form always has), which fails the prune's equality
 *    check and drops the entry. Safer, and the callers already gate on
 *    containment before calling this.
 */
export function deriveSessionName(projectPath, root) {
  if (root !== undefined) {
    const name = sessionNameFor(root, projectPath);
    if (name !== null) return name;
  }
  return slugSegment(path.basename(projectPath));
}

// Used by both the single- and two-segment branches of resolveProjectPath.
// Predicate set and order preserved verbatim from the pre-T68 whole-string
// check: '\' '/' ':' control-chars leading-'.' absolute.
const badSegment = (s) => /[\\/]/.test(s) || s.includes(':')
  || /[\u0000-\u001f]/.test(s) || s.startsWith('.') || path.isAbsolute(s);

// rootSlug + container + child. Exported so the number has one home.
export const MAX_PROJECT_SEGMENTS = 3;

/** root itself (a `single`-mode identifier with no child segment). */
function resolveRootItself(base) {
  let st;
  try {
    st = fs.lstatSync(base);
  } catch {
    return { ok: false, status: 404, error: 'project_not_found' };
  }
  if (!st.isDirectory()) {
    return { ok: false, status: 404, error: 'project_not_found' };
  }
  return { ok: true, path: base, root: base };
}

/** A direct child of base (the pre-T94 SINGLE branch, byte-identical). */
function resolveFlatChild(base, seg) {
  if (badSegment(seg)) {
    return { ok: false, status: 400, error: 'invalid_project' };
  }

  const resolved = path.resolve(base, seg);
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

  // Launchability check - ONE-ARGUMENT deliberately, to keep this narrowly
  // scoped: this checks the basename's own slug, not the rooted name, and
  // stays that way.
  const sessionName = deriveSessionName(resolved);
  if (sessionName === '' || sessionName.startsWith('-')) {
    return { ok: false, status: 400, error: 'invalid_project' };
  }

  return { ok: true, path: resolved, root: base };
}

/** '<container>/<child>' under base (the pre-T94 NESTED branch, byte-identical). */
function resolveNestedChild(base, seg1, seg2) {
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

  return { ok: true, path: resolved, root: base };
}

/**
 * Resolves segs (0, 1 or 2 already-split segments) against ONE root, mode-
 * gated. A `single` root has no children to resolve into - the only legal
 * identifiers are zero segments, or (legacy compat) exactly one segment equal
 * to the root's own basename - both resolve to the root itself. A `container`
 * root resolves zero segments as invalid (there is no "root itself" entry for
 * a container), one segment as a direct child, two as
 * '<container-child>/<child>'.
 */
function resolveWithinRoot(root, segs) {
  const base = path.resolve(root.path);

  if (root.mode === 'single') {
    if (segs.length === 0) return resolveRootItself(base);
    if (segs.length === 1 && segs[0].toLowerCase() === path.basename(base).toLowerCase()) {
      return resolveRootItself(base);
    }
    // A `single` root shares exactly one folder, never its children - any
    // other identifier shape is refused, not resolved against disk.
    return { ok: false, status: 404, error: 'project_not_found' };
  }

  // root.mode === 'container' from here.
  if (segs.length === 0) {
    return { ok: false, status: 400, error: 'invalid_project' };
  }
  if (segs.length === 1) {
    return resolveFlatChild(base, segs[0]);
  }
  return resolveNestedChild(base, segs[0], segs[1]);
}

/**
 * Resolves and validates a client-supplied project identifier against roots
 * (rootsFrom(ctx)'s output, or - registry.js's prune - a single-element array
 * so form 2 stays unambiguous by construction). This is the trust boundary:
 * reject, never sanitize-and-continue.
 *
 * Two identifier forms:
 * FORM 1 - ROOT-QUALIFIED. First segment is a root slug, matched by EXACT
 * STRING EQUALITY against the computed set of rootSlug(root.path) for the
 * roots passed in - a lookup key against a closed server-side set, never used
 * to build a path. Tried FIRST.
 * FORM 2 - LEGACY (unchanged wire shape, no root prefix). Resolved against
 * EVERY root: one match resolves, zero is the first-tried root's own error,
 * two or more is 400 ambiguous_project - never a silent first-match-wins,
 * which would launch (or END) the wrong root's project.
 *
 * Returns { ok: true, path, root } (root is the matched root's absolute
 * path) or { ok: false, status, error }.
 */
export function resolveProjectPath(roots, project) {
  // S1 - whole raw string cap 518 = 262 (a root slug: a root path capped at 255
  // by folders.js's checkShape V1, plus '-' plus the 6-char digest) + 1 ('/')
  // + 255 (the root-relative remainder - see below). Runs before any split, so
  // a segment cannot be used to get past it. A pure DoS bound.
  if (typeof project !== 'string' || project.trim() === '' || project.length > 518) {
    return { ok: false, status: 400, error: 'invalid_request' };
  }

  const rootList = Array.isArray(roots) ? roots : [];

  // S2 - split on '/' ONLY, never on '\'. '\' stays a rejected character
  // inside every segment (badSegment) - a client sending 'Pull
  // Requests\Vercel' is REJECTED, not normalised.
  const segments = project.split('/');
  if (segments.length > MAX_PROJECT_SEGMENTS) {
    return { ok: false, status: 400, error: 'invalid_project' };
  }

  // FORM 1 - root-qualified. Order matters: tried first, so a container
  // literally named the same string as a root slug is unreachable by the
  // legacy form - noted, not coded around.
  const matchedRoot = rootList.find((r) => rootSlug(r.path) === segments[0]);
  if (matchedRoot) {
    const remainder = segments.slice(1);
    // The root-relative remainder is capped at exactly 255, measured AFTER
    // the root-slug segment is stripped and BEFORE the split - S1's original
    // property ("the 255 guard binds across BOTH real-name segments") is
    // preserved verbatim, one level down.
    if (remainder.join('/').length > 255) {
      return { ok: false, status: 400, error: 'invalid_project' };
    }
    return resolveWithinRoot(matchedRoot, remainder);
  }

  // FORM 2 - LEGACY. No root-slug match: resolve the 1-2 segments against
  // every root and collect the matches. A legacy identifier is still at most
  // 2 segments (invalid_project, matching S2's original code), and the
  // un-prefixed whole string keeps the original 255 cap - there is no
  // root-slug segment to strip first, so this is exactly S1's original
  // check and keeps S1's original error code, invalid_request.
  if (project.length > 255) {
    return { ok: false, status: 400, error: 'invalid_request' };
  }
  if (segments.length > 2) {
    return { ok: false, status: 400, error: 'invalid_project' };
  }

  const results = [];
  let firstError = null;
  for (const root of rootList) {
    const r = resolveWithinRoot(root, segments);
    if (r.ok) {
      results.push(r);
    } else if (firstError === null) {
      firstError = r;
    }
  }
  if (results.length === 1) return results[0];
  if (results.length === 0) {
    // Zero matches: the same error the single-root code returns today, from
    // the FIRST root tried, so single-root error codes are unchanged.
    return firstError || { ok: false, status: 404, error: 'project_not_found' };
  }
  // Two or more roots resolve the same legacy identifier: never silently
  // launch (or END) the first one - that is exactly the "wrong session"
  // landmine this form used to be.
  return { ok: false, status: 400, error: 'ambiguous_project' };
}

/**
 * The `project` field recorded and echoed for a launch/end - the client's
 * raw identifier, minus a form-1 root-slug prefix if one was present. The
 * registry's `project` field is a display label and every app.js path keys
 * off it; normalising it further than this single strip would change the
 * tile text. The legacy form (no root-slug match) is returned untouched.
 */
function displayProject(project, root) {
  const slug = rootSlug(root);
  // A form-1 identifier for a `single` root is the root slug ALONE, so the
  // strip below would leave ''. An empty label is not cosmetic: listSessions'
  // entry validator drops any entry whose project is '', and drop() unlinks
  // the pid file - so the very next 5s poll deletes a RUNNING session and its
  // only handle. Record the folder's own name instead, which round-trips: the
  // legacy basename form already resolves within a `single` root and derives
  // back to the same session name. The `|| slug` is for a hand-edited
  // drive-root entry ('F:\', basename ''), which the write route refuses
  // (`drive_root`) but resolveSharedFolders does not re-check; the slug itself
  // is a legal form-1 identifier, so that path round-trips too.
  if (project === slug) return path.basename(root) || slug;
  if (project.startsWith(`${slug}/`)) return project.slice(slug.length + 1);
  return project;
}

/**
 * Session names whose launch has been spawned but whose launcher has not
 * exited yet, mapped to the SessionView recordLaunch returned for it.
 *
 * THIS IS THE GUARD AGAINST LAUNCHING THE SAME PROJECT TWICE. The registry
 * alone could not do it. Between the spawn and the pid file appearing, the
 * registry entry has no pid, so listSessions dates it: `starting` inside
 * STARTING_GRACE_MS, `failed` after - and findLiveSession excludes `failed`,
 * so the next tap spawned a SECOND session for the same project.
 *
 * That is not theoretical. On 2026-08-28, two minutes after a cold boot, the
 * first powershell.exe of the session took 45 seconds to reach Start-Process
 * (measured: registry written 22:40:41, its cmd.exe created 22:40:56, and the
 * second launcher's arrived in the same second). The phone's 10s fetch
 * timeout had long since said "cannot reach the agent", the owner tapped
 * again past the grace window, and two live Claude sessions came up for one
 * project - two rows in the Code tab, and only the second one in the
 * registry, so the first could not even be stopped from the app.
 *
 * The launcher PROCESS is the honest liveness signal here, not a clock:
 * launch-session.ps1 exits only after Start-Process has returned and the pid
 * file is written, so this entry covers exactly the window the pid file does
 * not - however slow the machine is, with no second timeout to tune.
 *
 * Deliberately in-process, so it does not survive an agent restart. It does
 * not need to - an agent that restarts mid-launch has lost the child anyway,
 * and by then the pid file exists and findLiveSession covers it. Deleted on
 * both 'exit' and 'error' because node guarantees only that one of them
 * fires.
 */
const inFlightLaunches = new Map();

/**
 * Ceiling on how long an in-flight entry may block a relaunch, whatever the
 * child process does.
 *
 * Without it, a launcher that never exits blocks that project for the life of
 * the agent, and this repo has already met one that can: launch-session.ps1's
 * own header records Start-Process popping a modal "Pick an app" dialog on
 * this host. With windowsHide and no one at the desk, that dialog is never
 * dismissed, the launcher never exits, and every later tap would silently
 * come back "already starting" and spawn nothing - a worse failure than the
 * duplicate this guard exists to prevent, because it has no way out at all.
 *
 * Ten minutes: far past the ~45s a genuinely cold launcher needs (see
 * STARTING_GRACE_MS in registry.js), far short of a working day.
 */
const IN_FLIGHT_CEILING_MS = 10 * 60 * 1000;

/**
 * The key into inFlightLaunches. Scoped to the REGISTRY the launch was
 * recorded in, not to the session name alone: the map is module-level, so a
 * bare name would be shared by every ctx in the process. Production has one
 * registry and never notices; the test suite gives each test its own, and
 * without this scoping one test's un-exited fake launcher would answer the
 * next test's launch of the same project name.
 */
function inFlightKey(ctx, sessionName) {
  return `${ctx.registryPath || getRegistryFilePath()}\u0000${sessionName}`;
}

/**
 * Launches a detached Claude Code session for project, resolved against
 * rootsFrom(ctx) - the shared set, never ctx.baseDir directly (see rootsFrom,
 * projects.js).
 * ctx.spawner is the injectable seam for tests; defaults to child_process.spawn.
 * ctx also threads the registry seams (registryPath, pidDir, isPidAlive, now)
 * straight through to findLiveSession/clearPidFile/recordLaunch untouched.
 */
/**
 * The name the Claude app's Code tab shows for a session.
 *
 * The FOLDER LEAF, not the derived session name. The owner opened email-lint
 * on 2026-09-04 and found the row reading
 * `f-dev-projects-repos-02b052.email-lint` - so the hand-off banner, whose one
 * job is telling someone where their session is, was naming a label that does
 * not exist.
 *
 * Safe to change: NOTHING in the agent reads this value back. Launched
 * sessions are correlated by pid file and resolved path, and the registry key
 * keeps the root-qualified `sessionName` untouched (B2). `--name` has always
 * passed the raw leaf quoted - that is why the window title reads `MingleHub`
 * - so a leaf with spaces is already proven to survive the argument list.
 *
 * COLLISIONS. Two shared projects can share a leaf: `Work/email-lint` and
 * `Repos/email-lint`. The Code tab has no room for the dim parent eyebrow the
 * project list uses, so the name carries it: `email-lint (Work)`. BOTH sides
 * are qualified, never just the second one - otherwise a row's name would
 * depend on which was launched first, which is exactly the kind of thing that
 * is impossible to debug later. Everything else stays a bare leaf.
 *
 * `paths` is every project path the shared set can reach; comparison is
 * case-insensitive because Windows paths are.
 */
export function remoteControlName(targetPath, paths) {
  const leaf = path.basename(targetPath);
  const same = (paths || []).filter((p) => path.basename(p).toLowerCase() === leaf.toLowerCase());
  if (same.length <= 1) return leaf;
  return `${leaf} (${path.basename(path.dirname(targetPath))})`;
}

/** Every project path the shared set can reach, containers' children included. */
function allProjectPaths(roots) {
  const out = [];
  for (const p of listProjects(roots)) {
    // The container's OWN path as well as its children's: a container is
    // launchable through the API in its own right, so leaving it out meant a
    // top-level `Vercel` and a `Pull Requests/Vercel` saw no collision
    // between them and both produced a bare `Vercel` row - the duplicate this
    // function exists to prevent.
    out.push(p.path);
    for (const c of (p.children || [])) out.push(c.path);
  }
  return out;
}

export function launchSession(ctx, project) {
  const { spawner = spawn } = ctx;
  const roots = rootsFrom(ctx);
  const r = resolveProjectPath(roots, project);
  if (!r.ok) return r;

  const sessionName = deriveSessionName(r.path, r.root);
  const recordedProject = displayProject(project, r.root);

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

  // A container is a folder OF projects, not a project. The PWA draws one as a
  // drill-in row, so a tap cannot reach here; this is the second lock on the
  // one route that starts a process with the owner's full account access, for
  // everything that is NOT a tap - a stale saved name, a client bug, a direct
  // API call.
  //
  // Asked of listProjects, NOT of containerChildrenOf directly, and that is the
  // whole correctness of it. The heuristic applies at every depth; listProjects
  // applies it at exactly ONE - top-level children of a `container` root - so
  // re-deriving here refuses folders the list draws as tappable, such as a
  // file-free child inside a container. Reading the same list the phone reads
  // means the two cannot disagree by construction. Regression-tested.
  //
  // BELOW findLiveSession on purpose: refusing to START one is the whole
  // change. A session that already exists must still be reported as `reused`
  // and must stay endable - endSession and registry.js's prune share
  // resolveProjectPath, which is deliberately untouched.
  const resolved = path.resolve(r.path);
  if (listProjects(roots).some((e) => e.container && path.resolve(e.path) === resolved)) {
    return { ok: false, status: 400, error: 'project_is_container' };
  }

  // Checked AFTER findLiveSession, not before: once the pid file exists the
  // registry holds the truer view (a real pid, a real status), and this map
  // only ever answers for the gap before that.
  //
  // NOT `reused`. The launcher has not reached Start-Process yet, so nothing
  // is running to reuse - saying so would put "already running" on the phone
  // for a session that does not exist. This is the same answer the FIRST tap
  // got: accepted, starting, ask again shortly. The client keys its polling
  // off that 202, so a tap here also restarts the confirm sequence instead of
  // leaving the tile frozen.
  const key = inFlightKey(ctx, sessionName);
  const pending = inFlightLaunches.get(key);
  if (pending) {
    if ((ctx.now || Date.now)() - pending.at < IN_FLIGHT_CEILING_MS) {
      return { ok: true, reused: false, session: pending.view };
    }
    // Past the ceiling: the launcher is wedged, not slow. Fall through and
    // let the owner's tap start a fresh one rather than answering forever.
    inFlightLaunches.delete(key);
  }

  // MUST happen before the spawn: a stale pid file from an earlier run must
  // not be adopted by a launch that silently writes nothing, which would
  // produce a phantom "running" entry that never expires.
  clearPidFile(ctx, sessionName);

  const pidDir = ctx.pidDir || getPidDirPath();

  // hasOwn, not `??`: a test passing an explicit null means "assert no
  // -ConfigDir is passed", and `??` would send that back to the real config and
  // read the developer's own machine instead.
  // ctx.configPath, NOT the bare default: without it this read the machine's
  // LIVE config even under test, so every launch test that did not pin
  // claudeConfigDir behaved differently here than on a fresh clone - and
  // because readConfig THROWS on invalid JSON, one stray comma in that
  // hand-editable file failed a batch of unrelated tests with a message
  // pointing nowhere near them. `undefined` falls through to the parameter
  // default, which is that same file. Same convention shared.js already uses.
  const claudeConfigDir = Object.hasOwn(ctx, 'claudeConfigDir')
    ? ctx.claudeConfigDir
    : resolveClaudeConfigDir(ctx.configPath);

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
    // THE CODE-TAB ROW NAME, and nothing else - see remoteControlName above.
    // The registry key keeps the root-qualified `sessionName`, because
    // recordLaunch below is still passed the untouched value.
    // launch-session.ps1 hands this value straight to
    // `claude.cmd --remote-control`. Whether that CLI accepts a '/' inside a
    // session name could not be established: node's spawn, PowerShell,
    // Start-Process and cmd.exe all pass '/' through untouched (it is not a
    // cmd metacharacter, and the token does not begin with one, so it is not
    // read as a switch), but the CLI's own handling is observable only by
    // running it, which this build was not permitted to do. The collapse is
    // therefore PRECAUTIONARY, and it is the same one pidFileNameFor
    // (registry.js) makes for the pid FILE name, for the same reason it is
    // collision-free: the slug rule maps every '.' and every whitespace run
    // to '-', so no single-segment session name can contain a '.' and
    // 'pull-requests.vercel' is unreachable by any flat project. If a launch
    // is ever seen working with a '/', this replace can simply go - nothing
    // else in the agent reads the --remote-control name back.
    '-SessionName', remoteControlName(r.path, allProjectPaths(roots)),
    '-PidFile', pidFilePath,
    // Only when configured. An absent claude_config_dir must pass NO -ConfigDir
    // at all, so launch-session.ps1 leaves CLAUDE_CONFIG_DIR unset and Claude
    // Code uses its own default profile (T56). Passing an empty string here
    // would defeat that - PowerShell would bind it and the `if ($ConfigDir)`
    // guard is what turns it back into "absent".
    ...(claudeConfigDir ? ['-ConfigDir', claudeConfigDir] : []),
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

  // Both events release the in-flight entry, because node promises only that
  // ONE of them fires: a spawn that fails outright emits 'error' and may
  // never emit 'exit', and an entry left behind by that would make the
  // project permanently unlaunchable until the agent restarts. Folded into
  // the existing error handler rather than registered as a second 'error'
  // listener - the test seam's fake child keys handlers by name, so a second
  // registration would silently replace the log line rather than add to it.
  child.on('error', (err) => {
    inFlightLaunches.delete(key);
    console.error(`claude-remote agent: launch of '${sessionName}' failed to spawn:`, err);
  });
  child.on('exit', () => inFlightLaunches.delete(key));
  child.unref();

  const view = recordLaunch(ctx, { sessionName, project: recordedProject, projectPath: r.path });

  // After the handlers, and safe there: node emits neither event on this
  // tick, so nothing can be released before it is recorded. `at` is read
  // from ctx.now for the same reason every other clock in this agent is -
  // it is the seam the tests advance.
  inFlightLaunches.set(key, { view, at: (ctx.now || Date.now)() });

  return { ok: true, reused: false, session: view };
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
/**
 * Force tree-kills the session's process. ctx.killSpawner is the injectable
 * seam, mirroring ctx.spawner; it defaults to child_process.spawn.
 *
 * It used to spawn a handoff run afterwards. It does not any more - see the
 * note where that spawn was.
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
  const roots = rootsFrom(ctx);
  const r = resolveProjectPath(roots, project);
  if (!r.ok) return r;

  const sessionName = deriveSessionName(r.path, r.root);
  const existing = findLiveSession(ctx, sessionName);
  const recordedProject = displayProject(project, r.root);
  return endResolvedSession(ctx, { sessionName, projectPath: r.path, project: recordedProject, existing });
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
        startedAt: existing.started_at, endingStartedAt: startedIso,
      })
    : markSessionState(ctx, sessionName, null, { status: 'ending', ending_started_at: startedIso });
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
    ? dropSession(ctx, sessionName, 'ending')
    : markSessionState(ctx, sessionName, 'ending', { status: undefined, ending_started_at: undefined }));

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
    dropSession(ctx, sessionName, 'ending');
    return { ok: true, status: 200, body: { result: 'already_ended', project, session_name: sessionName } };
  }

  // Not wrapped in try/catch: a missing seam (helper-auth's refusePidImageName)
  // must propagate and fail loudly, same as a missing killSpawner. A genuine
  // real-world lookup failure is handled INSIDE
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
    dropSession(ctx, sessionName, 'ending');
    return { ok: true, status: 200, body: { result: 'already_ended', project, session_name: sessionName } };
  }

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
  // Registry is already at `status: 'ending'` from the claim above - no
  // second write needed here.

  // THE HANDOFF USED TO BE SPAWNED HERE, and no longer is. It ran
  // `claude -p --resume <id> /handoff` against the conversation this function
  // had just killed, with nobody reading the result, and then reported
  // success. Owner, 2026-09-04: "the handoff thing is genuinely bad." A file
  // whose only real claim is that it exists, written at the exact moment
  // someone stops paying attention.
  //
  // The app writes nothing now. The stop confirm asks for one from Claude
  // first (Artifact Lane 2, approved sequence 3) and this ends the session and
  // stops.
  //
  // The claim status is the string 'ending' - the concurrency mutex that stops
  // two STOPs racing, never shown to anyone. It was called 'handoff' until
  // T101 (2026-09-05), left that way on purpose for one release because
  // renaming it reaches the whole of registry.js and two suites, and that is
  // not a change to bury in the same commit as a behaviour removal.
  markSessionState(ctx, sessionName, 'ending', {
    status: 'ended',
    ended_at: new Date((ctx.now || Date.now)()).toISOString(),
  });

  return {
    ok: true,
    status: 200,
    body: { result: 'ended', project, session_name: sessionName },
  };
}
