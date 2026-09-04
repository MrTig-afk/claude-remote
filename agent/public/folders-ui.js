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
  reachable, openFolderEmpty, projectCount, shared, offline = false,
}) {
  // R4: the phone being offline outranks everything, including 'waiting'.
  // Both produce the same silence from the agent, but only one of them is
  // the PC's fault - and telling someone their PC has not answered when the
  // phone has no network sends them to the wrong machine. Checked first for
  // the same reason 'waiting' is checked before the shared-set states.
  if (offline) return { kind: 'offline', roots: [] };
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

/**
 * The Shared Folders row's own state, so the list answers before you tap it.
 * -> { text, enterable }
 *
 * enterable === false for an UNKNOWN set, and that is the whole point:
 * sharedToTicks(null) returns [] silently, so a door that opened the picker
 * without consulting this would open it BLANK and a SAVE from there would
 * write { shared_folders: [] } - wiping every shared folder with no error.
 * null and undefined mean the same thing here, exactly as in listZoneState.
 *
 * ponytail: this is the one settings row today. A second non-folder row in
 * T79-T85 is the trigger to split a settings-ui.js out of this module -
 * folders-ui.js already owns "the shared-folder STATE selection", so this one
 * belongs here rather than starting a new file for a single function.
 */
export function sharedRowState(shared) {
  if (shared === null || shared === undefined) return { text: 'not known yet', enterable: false };
  if (shared.length === 0) return { text: 'nothing shared yet', enterable: true };
  const gone = shared.filter((r) => r.missing === true).length;
  const base = shared.length === 1 ? '1 folder shared' : `${shared.length} folders shared`;
  return { text: gone > 0 ? `${base} - ${gone} not on the PC` : base, enterable: true };
}

/**
 * The Shared folders screen's rows (Lane 3), one per shared root, in the
 * order the config holds them. -> [{ path, name, state, missing }]
 *
 * The artifact's sub-line reads "F:\Dev\Projects · 3 of 14" - the count
 * shared out of the count on disk. Only the first half is knowable in the
 * app: GET /api/projects reports the projects a root actually yielded (each
 * carries `root`), and NO payload says how many folders the root holds in
 * total. So this renders "<parent> · N projects" rather than inventing the
 * denominator. Add a total to agent/shared.js:describeSharedRoots if the
 * "of 14" is wanted; it is not guessable here.
 *
 * A missing root says so and nothing else. Reporting "0 projects" for a
 * folder that is not there would read as an empty folder rather than an
 * absent one, which is the distinction Lane 4 exists to draw.
 */
export function sharedFolderRows(shared, projects) {
  const counts = new Map();
  for (const p of projects || []) {
    const key = pathKey(p.root || '');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return (shared || []).map((r) => {
    const segs = crumbSegments(r.path);
    const name = segs.at(-1).label;
    // The parent is the crumb one step up; segs[0] is the synthetic DRIVES
    // entry, so a root directly on a drive has no parent segment to show.
    const parentSeg = segs.length >= 3 ? segs.at(-2) : null;
    const parent = parentSeg && parentSeg.path ? parentSeg.path.replace(/\\+$/, '') : '';
    const missing = r.missing === true;
    const single = r.mode === 'single';
    const projectCount = single ? null : (counts.get(pathKey(r.path)) || 0);
    let coverage;
    if (missing) coverage = 'not found';
    else if (single) coverage = 'this folder only';
    else coverage = projectCount === 1 ? '1 project' : `${projectCount} projects`;
    return {
      path: r.path,
      name,
      coverage,
      projectCount,
      missing,
      state: parent ? `${parent} · ${coverage}` : coverage,
    };
  });
}

/**
 * Lane 9, option C: the project list grouped into one section per shared
 * root, "expanded when there is only one so a single-folder install looks
 * exactly as it does today".
 *
 * Each header carries its OWN running count, and a folder with none shows
 * just its total - the artifact's wording. Section headers are named after
 * the folder even when there is only one, because "All projects" told you
 * nothing (Decided).
 *
 * Projects whose root matches no shared folder still appear, under a section
 * named for the root they claim. Dropping them would make a project vanish
 * from the app because its config entry was hand-edited - the list must show
 * what the agent actually returned.
 *
 * `open` is which sections are expanded. A single section is always open
 * regardless: that is the whole point of the rule.
 *
 * -> [{ name, path, projects, running, total, open }]
 */
export function projectSections(projects, shared, openNames, isRunning) {
  const order = [];
  const byRoot = new Map();
  const push = (key, name, path, project) => {
    if (!byRoot.has(key)) {
      byRoot.set(key, { name, path, projects: [] });
      order.push(key);
    }
    if (project) byRoot.get(key).projects.push(project);
  };

  // Shared roots first and in config order, so the sections do not reshuffle
  // as projects come and go.
  for (const r of shared || []) {
    if (r.missing === true) continue;
    push(pathKey(r.path), crumbSegments(r.path).at(-1).label, r.path, null);
  }
  for (const p of projects || []) {
    // A row with NO root is a synthetic one, built for a desk session whose
    // folder is not a listed project (see app.js). It belongs to no shared
    // folder, and grouping it would open a section with no name on it. It is
    // already drawn as a tile in the running zone above, which is the only
    // place it has ever appeared - so it is skipped here, not lost.
    const name = p.rootName || (p.root ? crumbSegments(p.root).at(-1).label : '');
    if (!p.root || !name) continue;
    push(pathKey(p.root), name, p.root, p);
  }

  const open = new Set(openNames || []);
  const sections = order.map((key) => {
    const s = byRoot.get(key);
    const running = s.projects.filter((p) => (isRunning ? isRunning(p) : false)).length;
    return {
      name: s.name,
      path: s.path,
      projects: s.projects,
      running,
      total: s.projects.length,
      open: open.has(s.name),
    };
  });
  // One section is always expanded: a single-folder install must look exactly
  // as it did before folders existed, not hide its whole list behind a tap.
  if (sections.length === 1) sections[0].open = true;
  return sections;
}

/**
 * Lane 3's "Editing one": the children of ONE shared root, each ticked or
 * not, with the ones holding a live session marked.
 *
 * The child list comes from GET /api/folders, never from /api/projects - an
 * EXCLUDED child is filtered out server-side and would simply be missing from
 * the projects list, so a screen built from that could never show you what
 * you had already switched off, let alone switch it back on.
 *
 * `excludes` is stored as folder NAMES (agent/shared.js), compared without
 * case - the same rule the agent applies when it walks the root.
 *
 * -> [{ name, path, ticked, running, readable }]
 */
export function rootEditRows(folders, excludes, runningNames) {
  const off = new Set((excludes || []).map((n) => String(n).toLowerCase()));
  const live = new Set((runningNames || []).map((n) => String(n).toLowerCase()));
  return (folders || []).map((f) => ({
    name: f.name,
    path: f.path,
    ticked: !off.has(String(f.name).toLowerCase()),
    running: live.has(String(f.name).toLowerCase()),
    readable: f.readable !== false,
  }));
}

/** The names to store as `excludes` for a root, from the rows on screen. */
export function excludesFrom(rows) {
  return (rows || []).filter((r) => !r.ticked).map((r) => r.name);
}

/**
 * A PUT body with ONE root's excludes replaced and every other root
 * byte-preserved - the same guarantee withoutRoot gives, for the same reason:
 * saving one folder's selection must not rewrite a sibling's mode or lose its
 * own excludes. A root this app does not hold is returned unchanged.
 */
export function withRootExcludes(shared, path, excludes) {
  const target = pathKey(path);
  return {
    shared_folders: (shared || []).map((r) => ({
      path: r.path,
      mode: r.mode === 'single' ? 'single' : 'container',
      excludes: pathKey(r.path) === target
        ? [...excludes]
        : (Array.isArray(r.excludes) ? r.excludes : []),
      new_folders: r.new_folders === 'hide' ? 'hide' : 'show',
    })),
  };
}

/**
 * The warning above the list when unticking would orphan a live session.
 * The artifact is explicit that this WARNS rather than blocks - "silently
 * orphaning a live session is a bug in a costume" - so this returns words,
 * never a veto. null when there is nothing to say.
 */
export function orphanWarning(rows) {
  const hit = (rows || []).filter((r) => r.running && !r.ticked).map((r) => r.name);
  if (hit.length === 0) return null;
  if (hit.length === 1) return `${hit[0]} has a session running. Unsharing it will not stop it.`;
  return `${hit.length} of these have sessions running. Unsharing them will not stop them.`;
}

/**
 * The words on the remove confirmation (Lane 8's X-as-remove), from the
 * artifact: "Stop sharing Repos? Its 3 projects disappear from the app.
 * Nothing on disk is touched."
 *
 * Pure, so the copy is testable without a DOM. The middle sentence is built
 * from the row's own fields rather than re-read out of its display string -
 * a container names its count, a single-folder root has none to name, and a
 * missing one has already gone.
 */
export function stopSharingPrompt(row) {
  let effect;
  if (row.missing) effect = 'It is already gone from the PC.';
  else if (row.projectCount === null) effect = 'It disappears from the app.';
  else if (row.projectCount === 1) effect = 'Its 1 project disappears from the app.';
  else effect = `Its ${row.projectCount} projects disappear from the app.`;
  return `Stop sharing ${row.name}? ${effect} Nothing on disk is touched.`;
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
