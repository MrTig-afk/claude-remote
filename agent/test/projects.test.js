import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, after } from 'node:test';

import { listProjects } from '../projects.js';

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
  assert.deepEqual(find('Video Editing'), { name: 'Video Editing', path: path.join(cbase, 'Video Editing') });
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
  assert.deepEqual(find('Empty'), { name: 'Empty', path: path.join(cbase, 'Empty') });
});

test('a folder whose entries are all files is an ordinary project', () => {
  assert.deepEqual(find('Files Only'), { name: 'Files Only', path: path.join(cbase, 'Files Only') });
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
// never throws (projects.js:13-15): a candidate folder whose OWN entries
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
    assert.deepEqual(listProjects(lockedBase), [{ name: 'Locked', path: locked }]);
  } finally {
    execFileSync('icacls', [locked, '/reset']);
    fs.rmSync(lockedBase, { recursive: true, force: true });
  }
});
