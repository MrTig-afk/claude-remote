import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { FALLBACK_BASE_DIR, getConfigFilePath, resolveBaseDir } from '../config.js';

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
