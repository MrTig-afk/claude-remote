// bin/install.mjs - `npx -y github:MrTig-afk/claude-remote`, the one-paste
// install. Its outside effects (claude, the hook) are measured on the Dell;
// this pins the one parse it does and the wiring npx depends on.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { pluginRoot, spawnOptions, linkLine, ID } from '../../bin/install.mjs';
import {
  ALREADY_RUNNING, UP_TO_DATE, UPDATING, RUNS_ELSEWHERE, NEEDS_TAILSCALE, NEEDS_NODE, NOT_WINDOWS, setupFailed, setUp,
  STILL_SETTING_UP, SETTING_UP,
} from '../../hooks/check-update.mjs';

// RED WHEN the paste stops ending with the address (owner 2026-09-28: on an
// update nothing opened and Claude had no link to give), or prints it after a
// setup that stopped, where there is nothing to open.
test('linkLine: the address after every outcome that leaves the app on this PC, never after one that stopped', () => {
  for (const ok of [ALREADY_RUNNING, UP_TO_DATE, UPDATING, RUNS_ELSEWHERE]) {
    assert.equal(linkLine(ok), 'Open http://127.0.0.1:8790 in your browser.', ok);
  }
  assert.equal(linkLine(UPDATING, 8791), 'Open http://127.0.0.1:8791 in your browser.');
  // setUp carries the link itself (sequence 37), so it is not said twice.
  // ...nor while it is still setting up, when the link does not answer yet.
  for (const stopped of [setUp(8790), STILL_SETTING_UP, SETTING_UP, NEEDS_TAILSCALE, NEEDS_NODE, NOT_WINDOWS, setupFailed('x'), '']) {
    assert.equal(linkLine(stopped), null, stopped);
  }
});

// RED WHEN the children run in the caller's folder again: the
// paste runs with Claude Code's cwd, the open project, and cmd.exe looks there
// before PATH. `claude --version` only - harmless whichever claude answers.
test('a claude.cmd planted in the current folder is never the one that runs', { skip: process.platform !== 'win32' }, () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-planted-'));
  // Claude Code sets this for its children (measured 2026-09-27), which turns
  // cmd's current-folder lookup off; a plain terminal window does not have it.
  const saved = process.env.NoDefaultCurrentDirectoryInExePath;
  delete process.env.NoDefaultCurrentDirectoryInExePath;
  try {
    fs.writeFileSync(path.join(project, 'claude.cmd'), '@echo PLANTED-CLAUDE\r\n');
    const here = spawnSync('claude --version', { shell: true, encoding: 'utf8', cwd: project });
    assert.match(here.stdout, /PLANTED-CLAUDE/, 'positive control: cmd does run a planted claude.cmd from the cwd');
    const prev = process.cwd();
    process.chdir(project);
    try {
      const ours = spawnSync('claude --version', spawnOptions(true));
      assert.doesNotMatch(`${ours.stdout}${ours.stderr}`, /PLANTED-CLAUDE/);
    } finally {
      process.chdir(prev);
    }
  } finally {
    if (saved !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = saved;
    fs.rmSync(project, { recursive: true, force: true });
  }
});

// `claude plugin list --json`, in its real shape (this PC, 2026-09-27).
const LIST = JSON.stringify([
  { id: 'chrome-devtools-mcp@claude-plugins-official', installPath: 'C:\\x\\chrome', enabled: true },
  { id: ID, version: 'e2c027e', scope: 'user', enabled: true, installPath: 'C:\\Users\\u\\.claude\\plugins\\cache\\claude-remote\\claude-remote\\e2c027e' },
]);

test('pluginRoot: the install path of claude-remote@claude-remote, from any profile\'s list', () => {
  assert.equal(pluginRoot(LIST), 'C:\\Users\\u\\.claude\\plugins\\cache\\claude-remote\\claude-remote\\e2c027e');
});

// RED WHEN the first match wins again: the list carries other
// projects' project-scope copies, and one listed first may be older.
test('pluginRoot: the user-scope copy, even when an older project-scope copy is listed first', () => {
  const list = JSON.stringify([
    { id: ID, scope: 'project:C:\\Users\\u\\old-repo', installPath: 'C:\\old\\copy' },
    { id: ID, scope: 'user', installPath: 'C:\\current\\copy' },
  ]);
  assert.equal(pluginRoot(list), 'C:\\current\\copy');
  // Positive control: with no user-scope copy, the other one is still found.
  assert.equal(pluginRoot(JSON.stringify([{ id: ID, scope: 'project:C:\\x', installPath: 'C:\\only' }])), 'C:\\only');
});

test('pluginRoot: null when it is not in the list, or the answer is not a list', () => {
  assert.equal(pluginRoot(JSON.stringify([{ id: 'other@x', installPath: 'C:\\y' }])), null);
  for (const bad of ['', 'not json', '{}', 'null', JSON.stringify([{ id: ID }])]) assert.equal(pluginRoot(bad), null, bad);
});

test('package.json points npx at the installer, and it is a node script', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.bin['claude-remote'], 'bin/install.mjs');
  assert.match(fs.readFileSync(new URL('../../bin/install.mjs', import.meta.url), 'utf8'), /^#!\/usr\/bin\/env node\r?\n/);
});
