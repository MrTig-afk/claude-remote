import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { FALLBACK_BASE_DIR, getConfigFilePath, resolveBaseDir, readConfig, resolveSharedFolders } from '../config.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-config-'));

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeConfig(name, contents) {
  const configPath = path.join(dir, name);
  if (contents !== undefined) {
    fs.writeFileSync(configPath, contents);
  }
  return configPath;
}

test('falls back to F:\\Dev\\Projects\\Repos when the config file does not exist', () => {
  const configPath = writeConfig('missing.json');
  assert.equal(resolveBaseDir(configPath), FALLBACK_BASE_DIR);
});

test('falls back when the file is empty/whitespace', () => {
  const configPath = writeConfig('empty.json', '   \n  ');
  assert.equal(resolveBaseDir(configPath), FALLBACK_BASE_DIR);
});

test('falls back when default_base_folder is missing from the JSON', () => {
  const configPath = writeConfig('no-key.json', '{}');
  assert.equal(resolveBaseDir(configPath), FALLBACK_BASE_DIR);
});

test('falls back when default_base_folder is an empty or whitespace string', () => {
  const configPath = writeConfig('blank-value.json', JSON.stringify({ default_base_folder: '   ' }));
  assert.equal(resolveBaseDir(configPath), FALLBACK_BASE_DIR);
});

test('falls back when default_base_folder is a relative path', () => {
  const configPath = writeConfig('relative.json', JSON.stringify({ default_base_folder: 'Some\\Relative\\Path' }));
  assert.equal(resolveBaseDir(configPath), FALLBACK_BASE_DIR);
});

test('returns the configured absolute path when one is set', () => {
  const configPath = writeConfig('absolute.json', JSON.stringify({ default_base_folder: 'D:\\Some Where\\Projects' }));
  assert.equal(resolveBaseDir(configPath), path.resolve('D:\\Some Where\\Projects'));
});

test('throws, and the message names the config file path, when the file is not valid JSON', () => {
  const configPath = writeConfig('invalid.json', '{ not valid json');
  assert.throws(() => resolveBaseDir(configPath), (err) => err.message.includes(configPath));
});

test('getConfigFilePath ends with the shared claude-remote config path', () => {
  const configPath = getConfigFilePath();
  assert.ok(configPath.endsWith(path.join('.claude', 'plugins', 'data', 'claude-remote-claude-remote', 'config.json')));
});

// Same save/replace/restore-in-finally shape as agent/test/registry.test.js's
// console.warn capture, so a warn assertion never leaks into another test.
function captureWarnings(fn) {
  const warn = console.warn;
  const lines = [];
  console.warn = (msg) => lines.push(String(msg));
  try { return { result: fn(), lines }; } finally { console.warn = warn; }
}

test('resolveSharedFolders returns [] when the config file does not exist', () => {
  const configPath = writeConfig('shared-missing.json');
  assert.deepEqual(resolveSharedFolders(configPath), []);
});

test('resolveSharedFolders migrates a lone default_base_folder to one container root', () => {
  const configPath = writeConfig('shared-migrate.json', JSON.stringify({ default_base_folder: 'D:\\Some Where\\Projects\\' }));
  assert.deepEqual(resolveSharedFolders(configPath), [
    { path: path.resolve('D:\\Some Where\\Projects'), mode: 'container', excludes: [], new_folders: 'show' },
  ]);
});

test('resolveSharedFolders passes shared_folders through, normalised', () => {
  const configPath = writeConfig('shared-passthrough.json', JSON.stringify({
    shared_folders: [
      { path: 'F:\\Dev\\Projects\\Repos', mode: 'single', excludes: ['Archive', '', 7, 'old-stuff'], new_folders: 'hide', colour: 'red' },
    ],
  }));
  assert.deepEqual(resolveSharedFolders(configPath), [
    { path: path.resolve('F:\\Dev\\Projects\\Repos'), mode: 'single', excludes: ['Archive', 'old-stuff'], new_folders: 'hide' },
  ]);
});

test('resolveSharedFolders: shared_folders wins over default_base_folder when both are present', () => {
  const configPath = writeConfig('shared-wins.json', JSON.stringify({
    default_base_folder: 'D:\\Ignored\\Path',
    shared_folders: [{ path: 'F:\\Dev\\Projects\\Repos' }],
  }));
  const result = resolveSharedFolders(configPath);
  assert.equal(result.length, 1);
  assert.equal(result[0].path, path.resolve('F:\\Dev\\Projects\\Repos'));
  const ignoredPath = path.resolve('D:\\Ignored\\Path');
  assert.ok(!result.some((entry) => entry.path === ignoredPath));
});

test('resolveSharedFolders: an empty shared_folders wins over default_base_folder and yields []', () => {
  const configPath = writeConfig('shared-empty-wins.json', JSON.stringify({
    default_base_folder: 'D:\\Ignored\\Path',
    shared_folders: [],
  }));
  assert.deepEqual(resolveSharedFolders(configPath), []);
});

test('resolveSharedFolders: a non-array shared_folders yields [] with a warn, even beside a valid default_base_folder', () => {
  const configPath = writeConfig('shared-non-array.json', JSON.stringify({
    default_base_folder: 'D:\\Ignored\\Path',
    shared_folders: 'F:\\Whatever',
  }));
  const { result, lines } = captureWarnings(() => resolveSharedFolders(configPath));
  assert.deepEqual(result, []);
  assert.ok(lines.length >= 1);
});

test('resolveSharedFolders drops a garbage entry beside a good one, with a warn, and does not throw', () => {
  const configPath = writeConfig('shared-garbage.json', JSON.stringify({
    shared_folders: ['nope', { path: 'Some\\Relative\\Path' }, { path: 'F:\\Dev\\Projects\\Repos' }, null, 42, {}],
  }));
  const { result, lines } = captureWarnings(() => resolveSharedFolders(configPath));
  assert.equal(result.length, 1);
  assert.equal(result[0].path, path.resolve('F:\\Dev\\Projects\\Repos'));
  assert.equal(result[0].mode, 'container');
  assert.ok(lines.length >= 1);
});

test('resolveSharedFolders throws, and the message names the config file path, when the file is not valid JSON', () => {
  const configPath = writeConfig('shared-invalid.json', '{ not valid json');
  assert.throws(() => resolveSharedFolders(configPath), (err) => err.message.includes(configPath));
});

test('resolveSharedFolders preserves the path exactly as the owner wrote it, case included', () => {
  const configPath = writeConfig('shared-case.json', JSON.stringify({
    shared_folders: [{ path: 'F:\\Dev\\PROJECTS\\Repos' }],
  }));
  assert.deepEqual(resolveSharedFolders(configPath), [
    { path: 'F:\\Dev\\PROJECTS\\Repos', mode: 'container', excludes: [], new_folders: 'show' },
  ]);
});

test('readConfig returns {} for an absent file', () => {
  const configPath = writeConfig('read-missing.json');
  assert.deepEqual(readConfig(configPath), {});
});

test('readConfig hands back the whole parsed object, acknowledged_at included', () => {
  const configPath = writeConfig('read-whole.json', JSON.stringify({
    acknowledged_at: '2026-08-29T13:04:11.882Z',
    shared_folders: [],
  }));
  assert.deepEqual(readConfig(configPath), {
    acknowledged_at: '2026-08-29T13:04:11.882Z',
    shared_folders: [],
  });
});

test('readConfig returns {} for a top-level JSON array', () => {
  const configPath = writeConfig('read-array.json', '[]');
  assert.deepEqual(readConfig(configPath), {});
});
