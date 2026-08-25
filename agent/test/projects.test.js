import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { listProjects } from '../projects.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-'));
fs.mkdirSync(path.join(base, 'Pull Requests'));
fs.mkdirSync(path.join(base, 'Pull Requests', 'some-repo'));
fs.mkdirSync(path.join(base, 'Video Editing'));
fs.mkdirSync(path.join(base, 'email-lint'));
fs.mkdirSync(path.join(base, '.hidden'));
fs.writeFileSync(path.join(base, 'notes.txt'), 'hello');

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
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
