// Pure shell module for the folder picker (T97) and the shared-folder STATE
// selection (T100). No DOM access anywhere -
// not at module scope, not inside a function - so `node --test` imports this
// directly, the same way accept.test.js imports copy.js. app.js is the only
// place any of this touches the page.

/** Hard cap, mirroring agent/shared.js. The server holds the real one. */
export const MAX_SHARED_ROOTS = 32;

// Windows separators only, '/' tolerated on input - every path here comes
// from the agent's own responses, which are always '\'-formed. Uppercased
// and stripped of a trailing separator, exactly like pathKey in
// agent/shared.js, so two spellings of the same folder compare equal.
function normSep(p) {
  return p.replace(/\//g, '\\');
}

function pathKey(p) {
  return normSep(p).replace(/\\+$/, '').toUpperCase();
}

/**
 * Breadcrumb segments for `absPath`, always starting with the drive list.
 * -> [{ label, path }]  path === null only for the leading DRIVES entry.
 * crumbSegments(null) -> [{ label: 'DRIVES', path: null }], which is also
 * what makes crumbSegments(parent).at(-1) the UP target with no branch.
 */
export function crumbSegments(absPath) {
  const drives = { label: 'DRIVES', path: null };
  if (absPath === null || absPath === undefined) return [drives];

  const norm = normSep(absPath).replace(/\\+$/, '');
  const m = /^([A-Za-z]):(\\.*)?$/.exec(norm);
  if (!m) return [drives]; // not a shape this module produces; degrade rather than throw

  const letter = `${m[1].toUpperCase()}:`;
  const segs = [drives, { label: letter, path: `${letter}\\` }];

  const rest = m[2]; // starts with '\', or undefined for a bare drive root
  if (rest) {
    let cum = letter;
    for (const part of rest.split('\\').filter(Boolean)) {
      cum = `${cum}\\${part}`;
      segs.push({ label: part, path: cum });
    }
  }
  return segs;
}

/**
 * ticks -> the exact PUT body. Order preserved: a 400's `index` names a row.
 * Carries a tick's `mode`/`excludes` through when present, defaulting to
 * `container`/`[]` for a tick that has neither (one made by ticking a row in
 * the picker never carries them). Without this, re-entering the picker from
 * state 4 and tapping SAVE would silently rewrite a `single` root to
 * `container` and erase its excludes - a data-loss fix, not a feature.
 */
export function sharedBody(ticks) {
  return {
    shared_folders: ticks.map((t) => ({
      path: t.path,
      mode: t.mode === 'single' ? 'single' : 'container',
      excludes: Array.isArray(t.excludes) ? t.excludes : [],
      new_folders: t.newFolders,
    })),
  };
}

/**
 * 'ticked' | 'covered' | 'covers' | null. Affordance only - the server
 * re-checks this independently (PUT /api/shared -> 409 overlapping_root) and
 * is the actual boundary; this function only decides what the picker shows.
 * Segment-aware and case-folded, so 'F:\Dev' never covers 'F:\Development'.
 */
export function coverageOf(candidate, tickedPaths) {
  const c = pathKey(candidate);
  for (const t of tickedPaths) {
    if (c === pathKey(t)) return 'ticked';
  }
  for (const t of tickedPaths) {
    const tk = pathKey(t);
    if (c.startsWith(`${tk}\\`)) return 'covered'; // candidate sits inside a ticked root
  }
  for (const t of tickedPaths) {
    const tk = pathKey(t);
    if (tk.startsWith(`${c}\\`)) return 'covers'; // candidate contains a ticked root
  }
  return null;
}

/** { enabled, note }. A blocked drive is never enterable from the UI. */
export function driveRowState(drive) {
  if (drive.blocked) return { enabled: false, note: `${drive.letter} - blocked` };
  return { enabled: true, note: drive.letter };
}

/** The honest truncation line, or null. */
export function truncatedNote(total, shown) {
  if (total <= shown) return null;
  return `This folder holds ${total} folders. Showing the first ${shown}, in alphabetical order.`;
}

/**
 * Which thing owns the project list's list zone (T100). Pure, so the
 * precedence is unit-testable with no DOM and no server.
 *
 * `shared` is null/undefined when the agent has not told us the set (the
 * fetch failed, or it has not happened yet) - the two are treated
 * IDENTICALLY, which is also what keeps every existing test's state literal
 * working without an edit.
 *
 * -> { kind, roots }  roots is [] except where noted.
 *    'waiting' | 'unreachable' | 'folder-empty' | 'rows'
 *  | 'unknown-shared' | 'nothing-shared'
 *  | 'all-gone'      roots = every root, all missing
 *  | 'empty-day-one' roots = the roots that are NOT missing
 */
export function listZoneState({
  reachable, openFolderEmpty, projectCount, shared,
}) {
  // Unreachable (or still waking up) beats every state below, and it must
  // stay first: the phone cannot tell "nothing shared" from "the PC did not
  // answer" - both look like an empty list - and `shared` is stale or absent
  // on this path anyway. A later refactor that moves the shared-set checks
  // ahead of these two would tell an asleep PC's owner "nothing shared yet"
  // and send him into a picker that would wipe a set the PC never reported.
  if (reachable === 'waiting') return { kind: 'waiting', roots: [] };
  if (reachable === false) return { kind: 'unreachable', roots: [] };
  if (openFolderEmpty) return { kind: 'folder-empty', roots: [] };
  if (projectCount > 0) return { kind: 'rows', roots: [] };
  if (shared === null || shared === undefined) return { kind: 'unknown-shared', roots: [] };
  if (shared.length === 0) return { kind: 'nothing-shared', roots: [] };
  if (shared.every((r) => r.missing === true)) return { kind: 'all-gone', roots: shared };
  return { kind: 'empty-day-one', roots: shared.filter((r) => !r.missing) };
}

/** The roots the agent says are gone. [] when the set is unknown. */
export function missingRoots(shared) {
  return (shared || []).filter((r) => r.missing === true);
}

/**
 * A PUT body with one root removed and EVERY other root byte-preserved.
 * Comparison is the module's existing pathKey (case-folded, trailing
 * separator tolerated). `missing` is stripped - it is a report field, never
 * part of the schema. Removing the only root yields
 * { shared_folders: [] }, which PUT /api/shared accepts.
 */
export function withoutRoot(shared, path) {
  const target = pathKey(path);
  return {
    shared_folders: (shared || [])
      .filter((r) => pathKey(r.path) !== target)
      .map((r) => ({
        path: r.path,
        mode: r.mode === 'single' ? 'single' : 'container',
        excludes: Array.isArray(r.excludes) ? r.excludes : [],
        new_folders: r.new_folders === 'hide' ? 'hide' : 'show',
      })),
  };
}

/**
 * shared_folders -> the picker's tick objects, so re-entering the picker
 * with roots already shared opens with them ticked instead of empty.
 * `name` is the last path segment, taken from crumbSegments so this module
 * keeps exactly one path parser.
 *
 * Accepted ceiling: the picker still shows no per-root exclusion list, so a
 * root with excludes round-trips them but cannot be edited until T98.
 */
export function sharedToTicks(shared) {
  return (shared || []).map((r) => ({
    path: r.path,
    name: crumbSegments(r.path).at(-1).label,
    newFolders: r.new_folders === 'hide' ? 'hide' : 'show',
    mode: r.mode === 'single' ? 'single' : 'container',
    excludes: Array.isArray(r.excludes) ? r.excludes : [],
  }));
}

const SHARE_ERROR_COPY = {
  overlapping_root: (n) => `${n} overlaps a folder you already picked. Untick one of them.`,
  too_many_roots: () => `You can share at most ${MAX_SHARED_ROOTS} folders.`,
  system_directory: (n) => `${n} is a Windows system folder and cannot be shared.`,
  drive_root: (n) => `${n} is a whole drive. Pick a folder inside it instead.`,
  blocked_drive: (n) => `${n} is on the blocked drive.`,
  not_found: (n) => `${n} is not there any more.`,
  invalid_path: (n) => `${n} is not a folder the agent will accept.`,
  invalid_request: () => 'The agent rejected the request.',
  not_readable: (n) => `${n} cannot be opened - you do not have permission.`,
  drives_unavailable: () => 'Could not read your drives.',
  config_unreadable: () => 'The agent could not read its config file on the PC.',
  write_failed: () => 'The agent could not save that on the PC.',
  // api.js's own codes - never server codes, but this is the one place both
  // families of failure end up as a row/banner message.
  network: () => 'Cannot reach the agent. Check the PC is awake and Tailscale is connected.',
  timeout: () => "The agent didn't answer in time.",
  bad_response: () => "The agent replied with something this app doesn't understand.",
};

// Codes the server names a row for - shareErrorMessage echoes `index` back
// only for these, so a code with no row meaning never marks one.
const ROW_CODES = new Set([
  'overlapping_root', 'system_directory', 'drive_root', 'blocked_drive',
  'not_found', 'invalid_path', 'not_readable',
]);

/** -> { text, index }. `index` is the row to mark, or null. */
export function shareErrorMessage(code, status, index, ticks) {
  const name = (i) => (ticks && ticks[i] && ticks[i].name) || 'That folder';
  const build = SHARE_ERROR_COPY[code];
  const rowIndex = ROW_CODES.has(code) && typeof index === 'number' ? index : null;
  if (build) return { text: build(name(rowIndex)), index: rowIndex };
  return { text: `The agent refused the request (status ${status}).`, index: rowIndex };
}

/** Pure SAVE reducer: (share, apiResult) -> { done, ticks, message, errorIndex } */
export function applySaveResult(share, res) {
  if (res.ok) {
    return {
      done: true, ticks: share.ticks, message: null, errorIndex: null,
    };
  }
  const dataIndex = res.data && typeof res.data.index === 'number' ? res.data.index : null;
  const { text, index } = shareErrorMessage(res.code, res.status, dataIndex, share.ticks);
  return {
    done: false, ticks: share.ticks, message: text, errorIndex: index,
  };
}
