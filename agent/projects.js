import fs from 'node:fs';
import path from 'node:path';

import { deriveSessionName } from './sessions.js';

/**
 * Lists the direct child directories of baseDir - flat, no recursion, no
 * container-folder expansion. Never throws: any failure is logged to
 * stderr and results in an empty list (or that one entry being skipped).
 */
export function listProjects(baseDir) {
  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch (err) {
    console.warn(`claude-remote agent: could not list '${baseDir}': ${err.code || err.message}`);
    return [];
  }

  const projects = [];
  for (const dirent of entries) {
    // Known ceiling: dirent.isDirectory() is false for symlinks/junctions, so
    // links are excluded for free - upgrade path if the owner ever
    // junctions a project in is to follow links deliberately here.
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) {
      continue;
    }
    projects.push({ name: dirent.name, path: path.join(baseDir, dirent.name) });
  }

  projects.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  return projects;
}

// Base dir 'F:\Dev\Projects\Repos\' is 21 chars; Windows' 260-char MAX_PATH
// still binds for tools that live inside a project (git, node, python).
// 21 + 64 = 85 leaves ~175 chars of headroom for the tree inside the project
// - node_modules paths routinely eat 150+. Deliberately tighter than
// resolveProjectPath's 255 (sessions.js:26): that guards a READ of something
// that already exists, this guards what the owner is about to be stuck with.
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
 * sessions.js:25-44). Pure - touches no filesystem. Rules are ordered,
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
  return { ok: true };
}

/**
 * Validates, confines to baseDir, then creates one empty directory.
 * Never throws. Never returns a filesystem path or an OS error string.
 */
export function createProject(baseDir, name) {
  const v = validateProjectName(name);
  if (!v.ok) return v;

  // C1 - confinement. Byte-identical posture to resolveProjectPath
  // (sessions.js:40-44). Unreachable after V7/V8; this is the structural
  // backstop that makes "direct child only" true rather than argued.
  const base = path.resolve(baseDir);
  const target = path.resolve(base, name);
  if (path.dirname(target) !== base || target === base) {
    return { ok: false, status: 400, error: 'invalid_project' };
  }

  // C2 - session-name collision. deriveSessionName maps 'Foo Bar' and
  // 'Foo.Bar' to the same 'foo-bar', and they would then share one registry
  // entry (sessions.js:77-83) - launching the new project would attach the
  // owner to the OTHER project's session. Same "dropped into unrelated
  // work" failure the existing-folder check below exists to prevent, one
  // step later.
  // Entries that are the SAME physical target under NTFS's case-insensitive
  // matching (an exact or case-only-different repeat of `name`) are
  // excluded here on purpose: those hit mkdirSync's own EEXIST below and
  // report the more specific `project_exists`, not `name_collision`.
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
