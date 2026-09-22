// hooks/check-update.mjs: the SessionStart notice that the copy setup made is
// older than the plugin. Real temp folders, the real script.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { updateMessage, MESSAGE } from '../../hooks/check-update.mjs';

const SCRIPT = fileURLToPath(new URL('../../hooks/check-update.mjs', import.meta.url));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-update-check-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

// A plugin root shaped like the real one, and a copy of it the way setup makes it.
function makeRoot(name, { serverBody = 'server v1', withTests = true } = {}) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, 'agent', 'public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agent', 'server.js'), serverBody);
  fs.writeFileSync(path.join(root, 'agent', 'public', 'app.js'), 'app');
  fs.writeFileSync(path.join(root, 'release-notes.json'), '[]');
  if (withTests) {
    fs.mkdirSync(path.join(root, 'agent', 'test'));
    fs.writeFileSync(path.join(root, 'agent', 'test', 'x.test.js'), 'test');
  }
  return root;
}

test('same files: no notice, even though the copy has no tests', () => {
  assert.equal(updateMessage(makeRoot('p1'), makeRoot('i1', { withTests: false })), null);
});

test('a changed agent file: the notice', () => {
  assert.equal(updateMessage(makeRoot('p2', { serverBody: 'server v2' }), makeRoot('i2')), MESSAGE);
});

test('changed release notes alone: the notice', () => {
  const plugin = makeRoot('p3');
  fs.writeFileSync(path.join(plugin, 'release-notes.json'), '[{"v":2}]');
  assert.equal(updateMessage(plugin, makeRoot('i3')), MESSAGE);
});

test('never set up: silent', () => {
  assert.equal(updateMessage(makeRoot('p4'), path.join(base, 'nowhere')), null);
});

test('an unreadable plugin root: silent, never a throw', () => {
  assert.equal(updateMessage(path.join(base, 'missing-plugin'), makeRoot('i5')), null);
});

test('run as the hook: prints systemMessage JSON when they differ, nothing when they match', () => {
  const local = path.join(base, 'localappdata');
  fs.mkdirSync(local);
  fs.cpSync(makeRoot('i6'), path.join(local, 'claude-remote'), { recursive: true });
  const run = (pluginRoot) => execFileSync(process.execPath, [SCRIPT], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, LOCALAPPDATA: local }, encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(run(makeRoot('p6', { serverBody: 'server v2' }))), { systemMessage: MESSAGE });
  assert.equal(run(makeRoot('p7')), '');
});
