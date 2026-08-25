import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { createProject } from '../projects.js';
import { resolveProjectPath } from '../sessions.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-create-'));

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function snapshot() {
  return fs.readdirSync(base).sort();
}

function assertAccepted(name) {
  const result = createProject(base, name);
  assert.equal(result.ok, true, `expected '${name}' to be accepted, got ${JSON.stringify(result)}`);
  assert.deepEqual(result.project, { name });
  const target = path.join(base, name);
  assert.equal(fs.statSync(target).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(target), []);
  return result;
}

function assertRejected(name, expectedError, expectedStatus = 400) {
  const before = snapshot();
  const result = createProject(base, name);
  assert.equal(result.ok, false, `expected '${JSON.stringify(name)}' to be rejected, got ${JSON.stringify(result)}`);
  assert.equal(result.error, expectedError);
  assert.equal(result.status, expectedStatus);
  assert.deepEqual(snapshot(), before, 'a rejected create must not touch the filesystem');
  return result;
}

// --- ACCEPT ---------------------------------------------------------------

test('accepts a hyphenated name', () => { assertAccepted('email-lint'); });
test('accepts a space in the middle', () => { assertAccepted('Pull Requests'); });
test('accepts another space-containing name', () => { assertAccepted('Video Editing'); });
test('accepts a multi-word name', () => { assertAccepted('Backend Engineering'); });
test('accepts underscore + digits', () => { assertAccepted('Project_2026'); });
test('accepts mixed case', () => { assertAccepted('MyApp'); });
test('accepts a single character', () => { assertAccepted('a'); });
test('accepts an interior dot', () => { assertAccepted('my.project'); });

test('accepts a 64-char name (boundary)', () => {
  assertAccepted('x'.repeat(64));
});

test('CONSOLE is not reserved (V13 is not a substring match)', () => { assertAccepted('CONSOLE'); });
test('COM10 is not reserved (only COM1-9 are)', () => { assertAccepted('COM10'); });
test('console.log is not reserved (stem is "console")', () => { assertAccepted('console.log'); });

test('success returns exactly { ok: true, project: { name } }, no path key', () => {
  const result = createProject(base, 'shape-check');
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'project']);
  assert.deepEqual(Object.keys(result.project), ['name']);
});

test('created directory is empty - no .git, no README, no anything', () => {
  const result = createProject(base, 'empty-check');
  assert.equal(result.ok, true);
  assert.deepEqual(fs.readdirSync(path.join(base, 'empty-check')), []);
});

// --- REJECT: name only, no filesystem effect --------------------------------

test('".." -> name_has_traversal', () => { assertRejected('..', 'name_has_traversal'); });
test('"." -> name_has_traversal', () => { assertRejected('.', 'name_has_traversal'); });
test('"..." -> name_has_traversal', () => { assertRejected('...', 'name_has_traversal'); });
test('"../foo" -> name_has_separator', () => { assertRejected('../foo', 'name_has_separator'); });
test('"..\\\\foo" -> name_has_separator', () => { assertRejected('..\\foo', 'name_has_separator'); });
test('"./foo" -> name_has_separator', () => { assertRejected('./foo', 'name_has_separator'); });
test('"foo/bar" -> name_has_separator', () => { assertRejected('foo/bar', 'name_has_separator'); });
test('"foo\\\\bar" -> name_has_separator', () => { assertRejected('foo\\bar', 'name_has_separator'); });
test('"/etc/passwd" -> name_has_separator', () => { assertRejected('/etc/passwd', 'name_has_separator'); });
test('"\\\\\\\\server\\\\share" -> name_has_separator', () => { assertRejected('\\\\server\\share', 'name_has_separator'); });
test('"C:\\\\Windows" -> name_has_separator', () => { assertRejected('C:\\Windows', 'name_has_separator'); });
test('"C:" -> name_absolute', () => { assertRejected('C:', 'name_absolute'); });
test('"C:foo" (drive-relative) -> name_absolute', () => { assertRejected('C:foo', 'name_absolute'); });

test('"%2e%2e%2f" -> name_percent_encoded', () => { assertRejected('%2e%2e%2f', 'name_percent_encoded'); });
test('"..%2f..%2fWindows" -> name_percent_encoded, nothing escapes base', () => {
  assertRejected('..%2f..%2fWindows', 'name_percent_encoded');
  const parentOfBase = path.dirname(base);
  assert.equal(fs.existsSync(path.join(parentOfBase, 'Windows')), false);
});
test('"100%-done" -> name_percent_encoded (deliberate false positive)', () => {
  assertRejected('100%-done', 'name_percent_encoded');
});

for (const reserved of ['CON', 'con', 'CoN', 'CON.txt', 'NUL', 'PRN', 'AUX', 'COM1', 'COM9', 'LPT1', 'LPT9', 'com3.log', 'CON .txt']) {
  test(`"${reserved}" -> name_reserved`, () => { assertRejected(reserved, 'name_reserved'); });
}

for (const bad of ['foo<bar', 'foo>bar', 'foo"bar', 'foo|bar', 'foo?bar', 'foo*bar', 'foo:bar']) {
  test(`"${bad}" -> name_illegal_char`, () => { assertRejected(bad, 'name_illegal_char'); });
}

test('embedded NUL -> name_illegal_char', () => { assertRejected('foo' + String.fromCharCode(0) + 'bar', 'name_illegal_char'); });
test('embedded tab -> name_illegal_char (control char, V4 fires before V5)', () => { assertRejected('foo\tbar', 'name_illegal_char'); });
test('embedded ANSI escape -> name_illegal_char', () => { assertRejected('foo' + String.fromCharCode(27) + '[31m', 'name_illegal_char'); });

test('"foo." -> name_trailing_dot', () => { assertRejected('foo.', 'name_trailing_dot'); });
test('"foo.." -> name_trailing_dot', () => { assertRejected('foo..', 'name_trailing_dot'); });

test('trailing space -> name_edge_whitespace', () => { assertRejected('foo ', 'name_edge_whitespace'); });
test('leading space -> name_edge_whitespace', () => { assertRejected(' foo', 'name_edge_whitespace'); });
test('trailing NBSP -> name_edge_whitespace', () => { assertRejected('foo\u00a0', 'name_edge_whitespace'); });

test('empty string -> name_empty', () => { assertRejected('', 'name_empty'); });
test('whitespace-only -> name_empty (precedes the whitespace rule)', () => { assertRejected('   ', 'name_empty'); });

test('".hidden" -> name_dot_prefixed', () => { assertRejected('.hidden', 'name_dot_prefixed'); });
test('65-char name -> name_too_long', () => { assertRejected('y'.repeat(65), 'name_too_long'); });

test('a number (not a string) -> invalid_request', () => { assertRejected(123, 'invalid_request'); });
test('null -> invalid_request', () => { assertRejected(null, 'invalid_request'); });
test('undefined -> invalid_request', () => { assertRejected(undefined, 'invalid_request'); });
test('{} -> invalid_request', () => { assertRejected({}, 'invalid_request'); });
test('[] -> invalid_request', () => { assertRejected([], 'invalid_request'); });

// --- EXISTENCE / FILESYSTEM -------------------------------------------------

test('creating "email-lint" twice -> second is 409 project_exists, folder not adopted or reset', () => {
  createProject(base, 'dup-check');
  const marker = path.join(base, 'dup-check', 'marker.txt');
  fs.writeFileSync(marker, 'do not touch');

  const before = snapshot();
  const result = createProject(base, 'dup-check');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'project_exists');
  assert.equal(result.status, 409);
  assert.deepEqual(snapshot(), before);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'do not touch');
});

test('an existing FILE of that name -> 409 project_exists, file contents unchanged', () => {
  fs.writeFileSync(path.join(base, 'notes.txt'), 'hello');
  const before = snapshot();
  const result = createProject(base, 'notes.txt');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'project_exists');
  assert.equal(result.status, 409);
  assert.deepEqual(snapshot(), before);
  assert.equal(fs.readFileSync(path.join(base, 'notes.txt'), 'utf8'), 'hello');
});

test('"EMAIL-LINT" when "email-lint" exists -> 409 project_exists (NTFS case-insensitive)', { skip: process.platform !== 'win32' }, () => {
  createProject(base, 'email-lint-case');
  const result = createProject(base, 'EMAIL-LINT-CASE');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'project_exists');
  assert.equal(result.status, 409);
});

test('"Foo.Bar" when "Foo Bar" exists -> 409 name_collision (both derive foo-bar), nothing created', () => {
  createProject(base, 'Foo Bar');
  const before = snapshot();
  const result = createProject(base, 'Foo.Bar');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'name_collision');
  assert.equal(result.status, 409);
  assert.deepEqual(snapshot(), before);
});

test('"Foo Bar" when "Foo Bar" exists -> 409 project_exists, not name_collision', () => {
  // 'Foo Bar' was created by the previous test. Same literal name repeated
  // is the "same physical folder" case: it hits mkdirSync's own EEXIST
  // rather than the collision check (projects.js C2 excludes a literal
  // repeat of the requested name for exactly this reason).
  const result = createProject(base, 'Foo Bar');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'project_exists');
  assert.equal(result.status, 409);
});

test('missing base directory -> 500 base_unavailable, no throw', () => {
  const missingBase = path.join(base, 'does-not-exist-base');
  assert.doesNotThrow(() => {
    const result = createProject(missingBase, 'anything');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'base_unavailable');
    assert.equal(result.status, 500);
  });
});

test('"sub/one" is rejected and no "sub" folder is created (nesting is impossible)', () => {
  const before = snapshot();
  const result = createProject(base, 'sub/one');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'name_has_separator');
  assert.deepEqual(snapshot(), before);
  assert.equal(fs.existsSync(path.join(base, 'sub')), false);
});

test('create/launch contract: anything created here is launchable by resolveProjectPath', () => {
  createProject(base, 'launch-contract');
  const result = resolveProjectPath(base, 'launch-contract');
  assert.equal(result.ok, true);
});
