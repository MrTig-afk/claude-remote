import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, after } from 'node:test';

import { listProjects, rootsFrom, usableRoots } from '../projects.js';
import { rootSlug, deriveSessionName } from '../sessions.js';
import { deriveDeskSessionName } from '../registry.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-'));
fs.mkdirSync(path.join(base, 'Pull Requests'));
fs.mkdirSync(path.join(base, 'Pull Requests', 'some-repo'));
fs.mkdirSync(path.join(base, 'Video Editing'));
fs.mkdirSync(path.join(base, 'email-lint'));
fs.mkdirSync(path.join(base, '.hidden'));
fs.writeFileSync(path.join(base, 'notes.txt'), 'hello');

const cbase = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-containers-'));
fs.mkdirSync(path.join(cbase, 'Pull Requests'));
fs.mkdirSync(path.join(cbase, 'Pull Requests', 'Vercel'));
fs.mkdirSync(path.join(cbase, 'Pull Requests', 'Davies'));
fs.mkdirSync(path.join(cbase, 'Pull Requests', 'y combinator-qm'));
fs.mkdirSync(path.join(cbase, 'Video Editing'));
fs.mkdirSync(path.join(cbase, 'Video Editing', 'clips'));
fs.writeFileSync(path.join(cbase, 'Video Editing', 'CLAUDE.md'), 'hi');
fs.mkdirSync(path.join(cbase, 'Marked'));
fs.mkdirSync(path.join(cbase, 'Marked', 'repo-a'));
fs.writeFileSync(path.join(cbase, 'Marked', 'notes.txt'), 'hi');
fs.writeFileSync(path.join(cbase, 'Marked', '.claude-remote-container'), '');
fs.mkdirSync(path.join(cbase, 'Marked Empty'));
fs.writeFileSync(path.join(cbase, 'Marked Empty', '.claude-remote-container'), '');
fs.mkdirSync(path.join(cbase, 'Repo'));
fs.mkdirSync(path.join(cbase, 'Repo', '.git'));
fs.mkdirSync(path.join(cbase, 'Repo', 'src'));
fs.mkdirSync(path.join(cbase, 'Repo', 'docs'));
fs.mkdirSync(path.join(cbase, 'Deep'));
fs.mkdirSync(path.join(cbase, 'Deep', 'child'));
fs.mkdirSync(path.join(cbase, 'Deep', 'child', 'grandchild'));
fs.mkdirSync(path.join(cbase, 'Empty'));
fs.mkdirSync(path.join(cbase, 'Files Only'));
fs.writeFileSync(path.join(cbase, 'Files Only', 'a.txt'), 'hi');
fs.mkdirSync(path.join(cbase, 'Hidden Child'));
fs.mkdirSync(path.join(cbase, 'Hidden Child', '.hidden'));
fs.mkdirSync(path.join(cbase, 'Hidden Child', 'visible'));
fs.mkdirSync(path.join(cbase, 'Marker Dir'));
fs.mkdirSync(path.join(cbase, 'Marker Dir', '.claude-remote-container'));
fs.mkdirSync(path.join(cbase, 'Marker Dir', 'repo-b'));
fs.writeFileSync(path.join(cbase, 'Marker Dir', 'loose.txt'), 'hi');

const find = (n) => listProjects(cbase).find((p) => p.name === n);

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(cbase, { recursive: true, force: true });
});

test('returns only the direct child directories of the base folder', () => {
  const result = listProjects(base);
  assert.equal(result.length, 3);
});

test('does not recurse into nested directories', () => {
  const result = listProjects(base);
  assert.equal(result.some((p) => p.name === 'some-repo'), false);
});

test('keeps a folder name containing a space intact', () => {
  const result = listProjects(base);
  assert.ok(result.some((p) => p.name === 'Pull Requests'));
});

test('keeps a hyphenated folder name intact', () => {
  const result = listProjects(base);
  assert.ok(result.some((p) => p.name === 'email-lint'));
});

test('excludes dot-prefixed folders', () => {
  const result = listProjects(base);
  assert.equal(result.some((p) => p.name === '.hidden'), false);
});

test('excludes files', () => {
  const result = listProjects(base);
  assert.equal(result.some((p) => p.name === 'notes.txt'), false);
});

test('returns entries sorted case-insensitively by name', () => {
  const result = listProjects(base);
  const names = result.map((p) => p.name);
  assert.deepEqual(names, ['email-lint', 'Pull Requests', 'Video Editing']);
});

test('gives each entry an absolute path equal to path.join(base, name)', () => {
  const result = listProjects(base);
  for (const entry of result) {
    assert.equal(entry.path, path.join(base, entry.name));
  }
});

test('returns [] for an empty directory', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-empty-'));
  try {
    assert.deepEqual(listProjects(empty), []);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('returns [] and does not throw when the base directory does not exist', () => {
  const missing = path.join(base, 'does-not-exist');
  assert.deepEqual(listProjects(missing), []);
});

test('returns [] and does not throw when the base path points at a file', () => {
  const filePath = path.join(base, 'notes.txt');
  assert.deepEqual(listProjects(filePath), []);
});

test('a folder whose entries are all directories and holds no file gets container: true', () => {
  assert.equal(find('Pull Requests').container, true);
});

test('a container\'s children are sorted case-insensitively', () => {
  const names = find('Pull Requests').children.map((c) => c.name);
  assert.deepEqual(names, ['Davies', 'Vercel', 'y combinator-qm']);
});

test('each child of a container has the expected absolute path', () => {
  for (const child of find('Pull Requests').children) {
    assert.equal(child.path, path.join(cbase, 'Pull Requests', child.name));
  }
});

test('a folder holding a loose file is not a container and keeps the ordinary shape', () => {
  assert.deepEqual(find('Video Editing'), {
    name: 'Video Editing',
    path: path.join(cbase, 'Video Editing'),
    root: cbase,
    rootName: path.basename(cbase),
  });
});

test('an ordinary entry has no container key at all', () => {
  assert.equal('container' in find('Video Editing'), false);
});

test('the marker overrides the guess: a folder with loose files and the marker is a container', () => {
  assert.equal(find('Marked').container, true);
});

test('the marker file is never reported as a child', () => {
  const names = find('Marked').children.map((c) => c.name);
  assert.deepEqual(names, ['repo-a']);
});

test('a marker-only folder is a container with an empty children array', () => {
  assert.equal(find('Marked Empty').container, true);
  assert.deepEqual(find('Marked Empty').children, []);
});

test('hidden child directories are not reported as children', () => {
  const names = find('Hidden Child').children.map((c) => c.name);
  assert.deepEqual(names, ['visible']);
});

test('a container\'s children are not themselves recursed into', () => {
  const deepChild = find('Deep').children.find((c) => c.name === 'child');
  assert.equal('container' in deepChild, false);
  assert.equal('children' in deepChild, false);
  assert.equal(JSON.stringify(listProjects(cbase)).includes('grandchild'), false);
});

test('an empty folder is an ordinary project, not an empty container', () => {
  assert.deepEqual(find('Empty'), {
    name: 'Empty',
    path: path.join(cbase, 'Empty'),
    root: cbase,
    rootName: path.basename(cbase),
  });
});

test('a folder whose entries are all files is an ordinary project', () => {
  assert.deepEqual(find('Files Only'), {
    name: 'Files Only',
    path: path.join(cbase, 'Files Only'),
    root: cbase,
    rootName: path.basename(cbase),
  });
});

test('every entry keeps the same name/path contract, container or not', () => {
  for (const entry of listProjects(cbase)) {
    assert.equal(entry.path, path.join(cbase, entry.name));
  }
});

// Known ceiling (documented in projects.js): a hidden directory like `.git`
// does not count as a file, so this repo guesses as a container too.
test('a repo folder with only a .git directory and subfolders guesses as a container', () => {
  assert.equal(find('Repo').container, true);
  assert.deepEqual(find('Repo').children.map((c) => c.name), ['docs', 'src']);
});

// The spec's marker rule is a NAME match only, no type check: a folder
// named '.claude-remote-container' overrides the guess whether it is a
// file or a directory, and either way it must never show up as a child.
test('a marker that is itself a directory still overrides the guess, and is never reported as a child', () => {
  const entry = find('Marker Dir');
  assert.equal(entry.container, true);
  assert.deepEqual(entry.children.map((c) => c.name), ['repo-b']);
});

// containerChildrenOf reuses readEntries for the per-folder read, which
// never throws (readEntries, projects.js): a candidate folder whose OWN entries
// cannot be listed must degrade to an ordinary project, not blow up
// listProjects. icacls denies read/execute on a folder this process itself
// owns - no elevation needed - to force that read to fail for real, rather
// than asserting behaviour nothing here actually exercises.
test('a container candidate that cannot be read degrades to an ordinary project, never throws', { skip: process.platform !== 'win32' && 'windows only' }, () => {
  const lockedBase = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-locked-'));
  const locked = path.join(lockedBase, 'Locked');
  fs.mkdirSync(locked);
  // Would otherwise guess as a container (one dir, no files) - the read
  // failure must be what stops that, not this fixture's shape.
  fs.mkdirSync(path.join(locked, 'child-dir'));
  const user = os.userInfo().username;
  execFileSync('icacls', [locked, '/deny', `${user}:(RX)`]);
  try {
    assert.deepEqual(listProjects(lockedBase), [{
      name: 'Locked', path: locked, root: lockedBase, rootName: path.basename(lockedBase),
    }]);
  } finally {
    execFileSync('icacls', [locked, '/reset']);
    fs.rmSync(lockedBase, { recursive: true, force: true });
  }
});

// --- Multi-root acceptance tests -----------------------------------------

// AT-1 - REGRESSION GUARD. One root: the string sugar and its equivalent
// one-container-root array must produce the SAME output, and that output
// must be a LITERAL - today's shape plus root/rootName on every top-level
// entry. RED WHEN: any change to the walk, the sort, the dot-prefix skip,
// the isDirectory() link exclusion, containerChildrenOf, or the sugar.
test('AT-1 - listProjects(base) string sugar equals the equivalent one-root array, both match a literal', () => {
  const rootEntry = { path: base, mode: 'container', excludes: [], new_folders: 'show' };
  const expected = [
    { name: 'email-lint', path: path.join(base, 'email-lint'), root: base, rootName: path.basename(base) },
    {
      name: 'Pull Requests',
      path: path.join(base, 'Pull Requests'),
      root: base,
      rootName: path.basename(base),
      container: true,
      children: [{ name: 'some-repo', path: path.join(base, 'Pull Requests', 'some-repo') }],
    },
    { name: 'Video Editing', path: path.join(base, 'Video Editing'), root: base, rootName: path.basename(base) },
  ];
  assert.deepEqual(listProjects(base), expected);
  assert.deepEqual(listProjects([rootEntry]), expected);
});

// AT-2 - two roots, distinct folder names: every project from both, one
// combined byName sort, each entry carrying its OWN root/rootName.
test('AT-2 - two roots combine into one byName-sorted list, each entry keeping its own root', () => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-at2-a-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-at2-b-'));
  fs.mkdirSync(path.join(rootA, 'Alpha'));
  fs.mkdirSync(path.join(rootB, 'Zulu'));
  try {
    const result = listProjects([
      { path: rootA, mode: 'container', excludes: [], new_folders: 'show' },
      { path: rootB, mode: 'container', excludes: [], new_folders: 'show' },
    ]);
    assert.deepEqual(result.map((p) => p.name), ['Alpha', 'Zulu']);
    assert.equal(result[0].root, rootA);
    assert.equal(result[1].root, rootB);
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

// AT-3 - B2's acceptance test: two roots sharing a child folder name produce
// TWO entries, both named the same, different path/rootName, and their
// derived session names differ.
test('AT-3 - two roots sharing a child name both list, and their session names differ', () => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-at3-a-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-at3-b-'));
  fs.mkdirSync(path.join(rootA, 'Vercel'));
  fs.mkdirSync(path.join(rootB, 'Vercel'));
  try {
    const result = listProjects([
      { path: rootA, mode: 'container', excludes: [], new_folders: 'show' },
      { path: rootB, mode: 'container', excludes: [], new_folders: 'show' },
    ]);
    assert.equal(result.length, 2);
    assert.ok(result.every((p) => p.name === 'Vercel'));
    assert.notEqual(result[0].path, result[1].path);
    assert.notEqual(result[0].rootName, result[1].rootName);
    assert.notEqual(
      deriveSessionName(result[0].path, result[0].root),
      deriveSessionName(result[1].path, result[1].root),
    );
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

// AT-4 - a `single`-mode root is never walked and never container-classified:
// exactly one entry, the root itself, no container/children key, and its
// children are absent from the result even though they exist on disk.
test('AT-4 - a single-mode root lists only itself, never its children', () => {
  const single = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-at4-'));
  fs.mkdirSync(path.join(single, 'Nested'));
  try {
    const result = listProjects([{ path: single, mode: 'single', excludes: [], new_folders: 'show' }]);
    assert.equal(result.length, 1);
    assert.equal(result[0].path, single);
    assert.equal(result[0].name, path.basename(single));
    assert.equal(result[0].rootName, path.basename(single));
    assert.equal('container' in result[0], false);
    assert.equal('children' in result[0], false);
    assert.equal(JSON.stringify(result).includes('Nested'), false);
  } finally {
    fs.rmSync(single, { recursive: true, force: true });
  }
});

// AT-5 - single-mode session name: no trailing child segment, and both
// naming functions agree.
test('AT-5 - single-mode session name is the bare root slug, and both derivations agree', () => {
  const single = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-at5-'));
  try {
    assert.equal(deriveSessionName(single, single), rootSlug(single));
    assert.equal(deriveDeskSessionName(single, single), deriveSessionName(single, single));
  } finally {
    fs.rmSync(single, { recursive: true, force: true });
  }
});

// AT-6 - excludes hide a child case-insensitively, and never touch disk.
test('AT-6 - excludes hides a child case-insensitively without unlinking it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-at6-'));
  const archivePath = path.join(root, 'Archive');
  fs.mkdirSync(archivePath);
  fs.mkdirSync(path.join(root, 'Kept'));
  try {
    const shown = listProjects([{ path: root, mode: 'container', excludes: ['Archive'], new_folders: 'show' }]);
    assert.equal(shown.some((p) => p.name === 'Archive'), false);
    assert.ok(shown.some((p) => p.name === 'Kept'));
    assert.equal(fs.existsSync(archivePath), true);

    const shownCaseDiff = listProjects([{ path: root, mode: 'container', excludes: ['archive'], new_folders: 'show' }]);
    assert.equal(shownCaseDiff.some((p) => p.name === 'Archive'), false);
    assert.equal(fs.existsSync(archivePath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// AT-7 - new_folders never filters the listing: `listProjects` filters on
// `excludes` alone. A child named in excludes is omitted under BOTH 'show'
// and 'hide'; the full list is otherwise identical either way.
test('AT-7 - new_folders does not filter the listing (the default)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-at7-'));
  fs.mkdirSync(path.join(root, 'Kept'));
  fs.mkdirSync(path.join(root, 'Excluded'));
  try {
    const show = listProjects([{ path: root, mode: 'container', excludes: ['Excluded'], new_folders: 'show' }]);
    const hide = listProjects([{ path: root, mode: 'container', excludes: ['Excluded'], new_folders: 'hide' }]);
    assert.deepEqual(show, hide);
    assert.deepEqual(show.map((p) => p.name), ['Kept']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// AT-8 - a root whose directory no longer exists is skipped with a warn; the
// other roots still list in full.
test('AT-8 - a removed root is skipped with a warn, the other root still lists in full', () => {
  const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-at8-gone-'));
  const alive = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-at8-alive-'));
  fs.mkdirSync(path.join(alive, 'Present'));
  fs.rmSync(gone, { recursive: true, force: true });
  const originalWarn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try {
    const result = listProjects([
      { path: gone, mode: 'container', excludes: [], new_folders: 'show' },
      { path: alive, mode: 'container', excludes: [], new_folders: 'show' },
    ]);
    assert.deepEqual(result.map((p) => p.name), ['Present']);
    assert.equal(warned, true);
  } finally {
    console.warn = originalWarn;
    fs.rmSync(alive, { recursive: true, force: true });
  }
});

// AT-9 - the empty set lists nothing, and nothing here ever throws. Presence
// beats truthiness: an explicit empty sharedFolders beside a baseDir yields
// [], never a fallback to baseDir.
test('AT-9 - zero roots and presence-over-truthiness never throw and always yield []', () => {
  assert.deepEqual(listProjects([]), []);
  assert.deepEqual(listProjects(undefined), []);
  assert.deepEqual(rootsFrom({}), []);
  assert.deepEqual(rootsFrom({ sharedFolders: [], baseDir: base }), []);
});

// AT-10 - a hand-edited nested pair: the descendant is dropped (with a
// warn), the ancestor's own listing is complete and not duplicated.
test('AT-10 - a hand-edited nested root pair drops the later, overlapping root', () => {
  const ancestor = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-at10-'));
  fs.mkdirSync(path.join(ancestor, 'Sub'));
  fs.mkdirSync(path.join(ancestor, 'Sub', 'Inner'));
  // A loose file keeps 'Sub' from guessing as a container in the ANCESTOR's
  // own one-level walk, so 'Inner' is invisible from there - the only way it
  // could leak into the result is via the DESCENDANT root's own top-level
  // walk, which D2 must prevent.
  fs.writeFileSync(path.join(ancestor, 'Sub', 'notes.txt'), 'x');
  fs.mkdirSync(path.join(ancestor, 'Top'));
  const descendant = path.join(ancestor, 'Sub');
  const originalWarn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try {
    const result = listProjects([
      { path: ancestor, mode: 'container', excludes: [], new_folders: 'show' },
      { path: descendant, mode: 'container', excludes: [], new_folders: 'show' },
    ]);
    // 'Sub' still appears ONCE, as the ancestor's own ordinary child; 'Inner'
    // must never appear at all - that is what proves the descendant ROOT was
    // dropped, not merely that 'Sub' itself vanished (it is a legitimate
    // child of the ancestor regardless of D2).
    assert.deepEqual(result.map((p) => p.name), ['Sub', 'Top']);
    assert.equal(warned, true);
  } finally {
    console.warn = originalWarn;
    fs.rmSync(ancestor, { recursive: true, force: true });
  }
});

// AT-11 - a hand-edited UNC root is dropped by D1 with a warn and never
// reaches deriveSessionName; no returned entry's derived name may start
// with '-' (the PowerShell-switch landmine D1 exists to prevent). R-4: D1
// still catches this AFTER the root-slug digest was added, because the
// digest is a fixed-width SUFFIX - it cannot turn a leading '-' into
// something else.
test('AT-11 - a hand-edited UNC root is dropped by D1, never reaching a launchable name', () => {
  assert.equal(rootSlug('\\\\server\\share').startsWith('-'), true);
  const alive = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-at11-'));
  fs.mkdirSync(path.join(alive, 'Fine'));
  const originalWarn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try {
    const roots = [
      { path: '\\\\server\\share', mode: 'container', excludes: [], new_folders: 'show' },
      { path: alive, mode: 'container', excludes: [], new_folders: 'show' },
    ];
    assert.equal(usableRoots(roots).length, 1);
    assert.deepEqual(usableRoots([{ path: '\\\\server\\share', mode: 'container', excludes: [], new_folders: 'show' }]), []);
    const result = listProjects(roots);
    assert.deepEqual(result.map((p) => p.name), ['Fine']);
    assert.equal(warned, true);
    for (const entry of result) {
      assert.equal(deriveSessionName(entry.path, entry.root).startsWith('-'), false);
    }
  } finally {
    console.warn = originalWarn;
    fs.rmSync(alive, { recursive: true, force: true });
  }
});
