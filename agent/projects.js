import fs from 'node:fs';
import path from 'node:path';

import { deriveSessionName, rootSlug } from './sessions.js';
import { isInsideOrEqual } from './shared.js';

const CONTAINER_MARKER = '.claude-remote-container';

const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

function readEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`claude-remote agent: could not list '${dir}': ${err.code || err.message}`);
    return [];
  }
}

/**
 * Returns the sorted { name, path } children of folderPath if folderPath is
 * a CONTAINER, or null if it is an ordinary project. A folder is a container
 * if it holds an entry NAMED `.claude-remote-container` (regardless of what
 * else it holds). That is a name match with no type check, deliberately: a
 * marker that is a directory counts exactly as a marker that is a file, and
 * `agent/test/projects.test.js` pins both. Do not "tighten" this with an
 * isFile() check to match a narrower reading - it would break a green test.
 * Absent the marker, a folder is a container if its own direct children are
 * ALL directories and it holds no file of its own (an empty folder is never
 * an empty container). One level only: a returned child is never itself
 * classified or recursed into.
 */
export function containerChildrenOf(folderPath) {
  const entries = readEntries(folderPath);
  let marker = false;
  let hasNonDir = false;
  const children = [];
  for (const dirent of entries) {
    if (dirent.name === CONTAINER_MARKER) {
      marker = true;
      continue;
    }
    // Same isDirectory() posture as the top-level walk below: lstat-based,
    // so symlinks/junctions are neither followed nor reported as children.
    if (!dirent.isDirectory()) {
      hasNonDir = true;
      continue;
    }
    // ponytail: a hidden DIRECTORY is skipped here but is NOT a file, so it
    // never sets hasNonDir - a repo holding .git plus subfolders and zero
    // top-level files guesses as a container. Narrower in practice than it
    // sounds: a hidden FILE takes the !isDirectory() branch above and DOES
    // set hasNonDir, so a repo with a README, a package.json or even just a
    // .gitignore stays an ordinary project. Only a file-free repo trips it.
    // The marker cannot rescue one that does - it forces container status
    // ON, never off. Upgrade path if it ever bites is a real rule (treat a
    // folder containing .git as a project), which is wider than the rule the
    // owner picked on 2026-08-28 and so was not added unilaterally.
    if (dirent.name.startsWith('.')) continue;
    children.push({ name: dirent.name, path: path.join(folderPath, dirent.name) });
  }
  children.sort(byName);

  if (marker) return children;
  if (hasNonDir) return null;
  if (children.length === 0) return null;
  return children;
}

/**
 * Every consumer of the shared set calls THIS - nobody reads ctx.baseDir or
 * ctx.sharedFolders directly. Precedence is by PRESENCE, not truthiness,
 * exactly the rule resolveSharedFolders (config.js) already uses for
 * shared_folders vs default_base_folder: an explicit `sharedFolders: []`
 * beside a `baseDir` yields [], not the baseDir - share less, never more.
 * ctx.baseDir (when sharedFolders is absent) is sugar for one container root,
 * which is what keeps every existing `{ baseDir }` ctx and every
 * `listProjects(base)` call resolving the same folders with no edit.
 */
export function rootsFrom(ctx) {
  const source = Object.prototype.hasOwnProperty.call(ctx, 'sharedFolders') && Array.isArray(ctx.sharedFolders)
    ? ctx.sharedFolders
    : typeof ctx.baseDir === 'string' && ctx.baseDir !== ''
      ? [{ path: ctx.baseDir, mode: 'container', excludes: [], new_folders: 'show' }]
      : [];
  return usableRoots(source);
}

/**
 * Two defensive filters over a candidate root list - every "hand-edited
 * config" answer lives here, since resolveSharedFolders' own normalisation
 * only guarantees shape, not usability as a SESSION-NAME PREFIX or as a
 * DISJOINT set.
 *
 * D1 - unusable root slug. Drop any root whose rootSlug is '' or starts with
 * '-'. resolveSharedFolders only requires path.isAbsolute, and
 * path.isAbsolute('\\\\server\\share') is TRUE on win32 - a hand-edited UNC
 * root would slug to '-server-share', and that leading '-' flows into
 * launch-session.ps1's -SessionName argument. T94's write route already
 * rejects UNC; this is the backstop for the file it does not own. rootSlug
 * now always ends in a hash digest, but the digest is a fixed-width SUFFIX
 * appended after slugSegment, so an empty readable half or a UNC path still
 * yields a leading '-' (e.g. '-9c3f1a', '-server-share-9c3f1a') and this
 * check still catches both.
 *
 * D2 - lexically nested roots. Drop the LATER of any overlapping pair
 * (ancestor or descendant, either direction), keeping the first-listed root -
 * the same "keep the earlier index" rule T94's own 409 overlapping_root uses
 * at write time. isInsideOrEqual is IMPORTED from shared.js, never
 * re-implemented - it is already case-folded and segment-aware, and it is
 * the same comparison T94 uses, so the two agree by construction.
 *
 * ponytail: this comparison is LEXICAL, not canonical - it drops the inner
 * one of a lexically-nested pair even when the two are canonically distinct
 * (a folder, plus a path descending through a junction inside it to an
 * unrelated target - T94 legally accepts that pair). Deliberate: listing
 * less than was ticked is safe, listing more is not. The alternative is
 * fs.realpathSync.native per root on the 5s poll, categorically refused on a
 * 7.74GB host. Upgrade path if it ever bites: canonicalise once per call and
 * compare canonically instead of lexically.
 */
export function usableRoots(roots) {
  if (!Array.isArray(roots)) return [];

  const withSlugs = [];
  for (const root of roots) {
    const slug = rootSlug(root.path);
    if (slug === '' || slug.startsWith('-')) {
      console.warn(`claude-remote agent: shared root '${root.path}' has an unusable slug; skipping it`);
      continue;
    }
    withSlugs.push(root);
  }

  const kept = [];
  for (const root of withSlugs) {
    const resolved = path.resolve(root.path);
    const overlapsKept = kept.some((k) => {
      const keptResolved = path.resolve(k.path);
      return isInsideOrEqual(resolved, keptResolved) || isInsideOrEqual(keptResolved, resolved);
    });
    if (overlapsKept) {
      console.warn(`claude-remote agent: shared root '${root.path}' overlaps an earlier shared root; skipping it`);
      continue;
    }
    kept.push(root);
  }

  return kept;
}

/**
 * Lists projects across every usable root in `rootsOrBaseDir`. A string is
 * sugar for one container root (keeps createProject's C2 guard, and every
 * existing listProjects(base) call in the tests, working unchanged). An
 * array is the roots, passed through usableRoots. Anything else -> [].
 *
 * Per root: a `container` root walks its direct child DIRECTORIES exactly as
 * before (dot-prefixed skipped, dirent.isDirectory() so junctions are
 * excluded for free, containerChildrenOf for grandchildren), minus
 * `excludes` (case-insensitive match on direct children). A `single` root is
 * NEVER walked and contributes exactly one entry: the root itself.
 * `new_folders` does not filter here: `listProjects` filters on `excludes`
 * alone. There is no record of which folders existed at share time to filter
 * a "new since share" set against, and this reader must never write one -
 * nothing may claim to hide what it does not hide.
 *
 * Every top-level entry gains `root` (the root's absolute path) and
 * `rootName` (its basename); container CHILDREN do not - T99 groups on
 * top-level entries, and a child is already inside a grouped parent.
 *
 * The combined list is sorted ONCE with the existing byName comparator, so a
 * single root's output is byte-identical to today's and two roots interleave
 * alphabetically. Never throws: a root whose directory is gone is skipped
 * with a warn and the other roots still list in full.
 */
export function listProjects(rootsOrBaseDir) {
  let roots;
  if (typeof rootsOrBaseDir === 'string') {
    roots = [{ path: rootsOrBaseDir, mode: 'container', excludes: [], new_folders: 'show' }];
  } else if (Array.isArray(rootsOrBaseDir)) {
    roots = rootsOrBaseDir;
  } else {
    roots = [];
  }

  const projects = [];

  for (const root of usableRoots(roots)) {
    const rootPath = path.resolve(root.path);
    const rootName = path.basename(rootPath);

    if (root.mode === 'single') {
      // lstatSync, NEVER statSync, so a root that has become a junction is
      // skipped rather than followed - same posture as every other reparse-
      // point guard in this codebase.
      let st;
      try {
        st = fs.lstatSync(rootPath);
      } catch (err) {
        console.warn(`claude-remote agent: could not list '${rootPath}': ${err.code || err.message}`);
        continue;
      }
      if (!st.isDirectory()) {
        console.warn(`claude-remote agent: could not list '${rootPath}': not a directory`);
        continue;
      }
      projects.push({ name: rootName, path: rootPath, root: rootPath, rootName });
      continue;
    }

    // container - never walked when mode is 'single', see above.
    const excludeSet = new Set(
      (Array.isArray(root.excludes) ? root.excludes : []).map((name) => name.toLowerCase()),
    );

    for (const dirent of readEntries(rootPath)) {
      // Known ceiling: dirent.isDirectory() is false for symlinks/junctions, so
      // links are excluded for free - upgrade path if the owner ever
      // junctions a project in is to follow links deliberately here. The same
      // behaviour governs the child walk in containerChildrenOf.
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) {
        continue;
      }
      if (excludeSet.has(dirent.name.toLowerCase())) {
        continue;
      }
      const entry = {
        name: dirent.name,
        path: path.join(rootPath, dirent.name),
        root: rootPath,
        rootName,
      };
      // ponytail: one extra readdirSync per top-level folder per call, and
      // listProjects runs on the 5s session poll (listSessions, registry.js).
      // Metadata-only reads of ~15 folders; measure before caching.
      const children = containerChildrenOf(entry.path);
      if (children) {
        entry.container = true;
        entry.children = children;
      }
      projects.push(entry);
    }
  }

  projects.sort(byName);
  return projects;
}

// Windows' 260-char MAX_PATH still binds for tools that live inside a project
// (git, node, python), so this cap must leave room for the TREE INSIDE it, not
// just the name - node_modules paths routinely eat 150+.
// The real budget is 260 - len(root) - 1 - len(name), and the root is whatever
// the user shared, so 64 is a DELIBERATE FIXED CAP, not a computed one. Under a
// long root the tree runs out first, which no name cap can repair.
// Tighter than resolveProjectPath's 255 (sessions.js) on purpose: that guards a
// READ of something that exists, this guards what the user is stuck with.
export const MAX_PROJECT_NAME_LENGTH = 64;

// Equivalent to /[\u0000-\u001f\u007f]/ (control chars incl. \t \n ESC DEL) -
// built from char codes so this source carries no raw control bytes.
const CONTROL_CHAR_RE = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);

// Windows reserved device names - exact match on the stem before the FIRST
// dot, case-insensitive, stem trimmed (Win32 strips a component's trailing
// spaces before the device-name check). So 'CON', 'con', 'CON.txt' and
// 'CON .txt' are all reserved; 'CONSOLE' and 'COM10' are NOT (this is an
// exact match, never a substring scan).
// Known ceiling: CLOCK$, CONIN$, CONOUT$ and superscript COM/LPT forms are
// not covered - mkdirSync fails on them anyway and that maps to
// create_failed (C5) with no partial state.
const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Validates a client-supplied new-project name. Trust boundary: reject,
 * never sanitize-and-continue (same posture as resolveProjectPath,
 * sessions.js). Pure - touches no filesystem. Rules are ordered,
 * first match wins: edge whitespace (V5) is rejected rather than silently
 * trimmed, and a literal '%' (V6) is rejected outright even though nothing
 * on this path URL-decodes - both are deliberate rejections, not
 * sanitization, per the trust-boundary rule above.
 */
export function validateProjectName(name) {
  if (typeof name !== 'string') {
    return { ok: false, status: 400, error: 'invalid_request' };
  }
  if (name === '' || name.trim() === '') {
    return { ok: false, status: 400, error: 'name_empty' };
  }
  if (name.length > MAX_PROJECT_NAME_LENGTH) {
    return { ok: false, status: 400, error: 'name_too_long' };
  }
  if (CONTROL_CHAR_RE.test(name)) {
    return { ok: false, status: 400, error: 'name_illegal_char' };
  }
  if (/^\s|\s$/.test(name)) {
    return { ok: false, status: 400, error: 'name_edge_whitespace' };
  }
  if (name.includes('%')) {
    return { ok: false, status: 400, error: 'name_percent_encoded' };
  }
  if (/[\\/]/.test(name)) {
    return { ok: false, status: 400, error: 'name_has_separator' };
  }
  if (path.isAbsolute(name) || /^[A-Za-z]:/.test(name)) {
    return { ok: false, status: 400, error: 'name_absolute' };
  }
  if (/[<>:"|?*]/.test(name)) {
    return { ok: false, status: 400, error: 'name_illegal_char' };
  }
  if (/^\.+$/.test(name)) {
    return { ok: false, status: 400, error: 'name_has_traversal' };
  }
  if (name.startsWith('.')) {
    return { ok: false, status: 400, error: 'name_dot_prefixed' };
  }
  if (name.endsWith('.')) {
    return { ok: false, status: 400, error: 'name_trailing_dot' };
  }
  if (RESERVED_NAME_RE.test(name.split('.')[0].trim())) {
    return { ok: false, status: 400, error: 'name_reserved' };
  }
  const sessionName = deriveSessionName(name);
  if (sessionName === '' || sessionName.startsWith('-')) {
    return { ok: false, status: 400, error: 'name_not_launchable' };
  }
  if (!PLAIN_NAME_RE.test(name) || VARIATION_SELECTOR_RE.test(name)) {
    return { ok: false, status: 400, error: 'name_not_plain' };
  }
  return { ok: true };
}

// PRD R22 (Artifact Lane 11 step 3b): a name typed in the app is letters from
// any language, decimal digits, spaces and - _ . - nothing else. Not \p{M} or
// \p{N} whole: an enclosing mark (\p{Me}) and a digit make the keycap emoji
// 1️⃣, and \p{N} lets ① and ² in. Variation selectors are Mn but only ever
// turn a character into an emoji. Checked last, so the rules above keep
// their own, more specific lines.
const PLAIN_NAME_RE = /^[\p{L}\p{Mn}\p{Mc}\p{Nd} ._-]+$/u;
const VARIATION_SELECTOR_RE = /\p{Variation_Selector}/u;

/**
 * Validates, confines to baseDir, then creates one empty directory.
 * Never throws. Never returns a filesystem path or an OS error string.
 */
export function createProject(baseDir, name) {
  const v = validateProjectName(name);
  if (!v.ok) return v;

  // C1 - confinement. Byte-identical posture to resolveProjectPath's SINGLE
  // branch: createProject stays strictly one level and never creates INSIDE
  // a container - still out of scope as of T69, which closed without adding
  // it - while resolveProjectPath (T68) now also accepts exactly two
  // segments.
  // Unreachable after V7/V8; this is the structural backstop that makes
  // "direct child only" true rather than argued.
  const base = path.resolve(baseDir);
  const target = path.resolve(base, name);
  if (path.dirname(target) !== base || target === base) {
    return { ok: false, status: 400, error: 'invalid_project' };
  }

  // C2 - session-name collision. deriveSessionName maps 'Foo Bar' and
  // 'Foo.Bar' to the same 'foo-bar', and they would then share one registry
  // entry (see deriveSessionName, sessions.js) - launching the new project
  // would attach the owner to the OTHER project's session. Same "dropped
  // into unrelated work" failure the existing-folder check below exists to
  // prevent, one step later.
  // Entries that are the SAME physical target under NTFS's case-insensitive
  // matching (an exact or case-only-different repeat of `name`) are
  // excluded here on purpose: those hit mkdirSync's own EEXIST below and
  // report the more specific `project_exists`, not `name_collision`.
  //
  // T69 asked whether this must also see NESTED projects. It must not, and
  // it structurally cannot collide with one: a rooted session name is keyed
  // '<root-slug>/<...segments>' (sessions.js's sessionNameFor - the root slug
  // now carries a hash digest too, so it is nothing like a bare folder slug),
  // while anything creatable here is a single segment that can never contain
  // '/' - path.basename yields no separator, the slug rule introduces only
  // '-', and V7 rejects '/' and '\' outright. So a top-level 'Vercel'
  // alongside 'Pull Requests\Vercel' is legal, not a collision. If the
  // nested separator ever stops being '/', this paragraph dies with it -
  // create-project.test.js pins the behaviour.
  // Both `deriveSessionName(target)` above and `deriveSessionName(entry.path)`
  // below stay ONE-ARGUMENT deliberately, on BOTH sides: that compares
  // basename-slug to basename-slug within one base, which is the only
  // comparison that means anything here, since everything creatable is a
  // single segment one level under `base`. Adding `base` to only one side -
  // an easy "correction" now that the two-argument form prepends a root slug
  // - would compare a rooted name against a bare one, which can never match,
  // and would silently disable this guard.
  // Container entries are compared like any other, also deliberately: a
  // container's own folder name can collide ('Pull.Requests' vs a container
  // 'Pull Requests'), and a container stops being one the moment a loose
  // file lands in it, at which point it is launchable under that exact name.
  const sessionName = deriveSessionName(target);
  const lowerName = name.toLowerCase();
  for (const entry of listProjects(base)) {
    if (entry.name.toLowerCase() === lowerName) continue;
    if (deriveSessionName(entry.path) === sessionName) {
      return { ok: false, status: 409, error: 'name_collision' };
    }
  }

  // C3/C4 - create + atomicity. One non-recursive mkdirSync is a single
  // CreateDirectoryW call: it either creates the directory or fails, with no
  // partial state. NO `{ recursive: true }`, EVER: it (a) returns success
  // when the directory already exists - silently adopting existing work,
  // exactly the failure this task forbids - and (b) would create
  // intermediate folders, i.e. nesting. Do not "tidy" this back in.
  try {
    fs.mkdirSync(target);
  } catch (err) {
    // C5 - error mapping, by err.code only. Log server-side; the response
    // never carries the path or the OS error string.
    console.warn(`claude-remote agent: could not create project '${name}': ${err.code || err.message}`);
    if (err.code === 'EEXIST') {
      return { ok: false, status: 409, error: 'project_exists' };
    }
    if (err.code === 'ENOENT') {
      return { ok: false, status: 500, error: 'base_unavailable' };
    }
    return { ok: false, status: 500, error: 'create_failed' };
  }

  // C6 - success log. Safe to interpolate: V4 already rejected control
  // characters, so a crafted name cannot inject terminal escapes.
  console.log(`claude-remote agent: created project '${name}'`);
  return { ok: true, project: { name } };
}
