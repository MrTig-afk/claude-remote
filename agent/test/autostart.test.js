// agent/autostart: the logon task. This RENDERS the real template through the
// real register-task.ps1 (-RenderOnly: headless probe + schema validation,
// nothing registered) and checks the XML the scheduler would actually get.
//
// What is NOT here, on purpose: update-agent.ps1 stops and starts the owner's
// live agent and registers a real task, so the suite never runs it. Its
// end-to-end record (install, update, rollback, restart, crash recovery,
// measured 2026-09-23) is in docs/agent-autostart.md under "Verification".

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';

const AUTOSTART = fileURLToPath(new URL('../autostart/', import.meta.url));
const AGENT = path.dirname(path.dirname(AUTOSTART + 'x'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-autostart-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function render() {
  const out = path.join(dir, 'task.xml');
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(AUTOSTART, 'register-task.ps1'), '-RenderOnly', '-OutFile', out,
  ], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CLAUDE_REMOTE_AGENT_PORT: '' } });
  assert.equal(r.status, 0, `register-task.ps1 -RenderOnly failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /nothing was registered/);
  // Set-Content -Encoding Unicode: UTF-16LE with a BOM.
  return fs.readFileSync(out).toString('utf16le').replace(/^\uFEFF/, '');
}

const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
// Comments stripped: they name the settings they replaced, on purpose.
const xml = render().replace(/<!--[\s\S]*?-->/g, '');
const tag = (name) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m && unescape(m[1]);
};

test('the action is conhost --headless running THIS agent, logging to the data folder', () => {
  assert.match(tag('Command'), /\\System32\\conhost\.exe$/i);
  const args = tag('Arguments');
  assert.ok(args.startsWith('--headless cmd.exe /s /c "'), args);
  assert.ok(args.includes(`node.exe "${path.join(AGENT, 'server.js')}"`), args);
  assert.match(args, /1>>"[^"]*\\claude-remote-claude-remote\\agent\.log" 2>&1"$/);
  assert.equal(tag('WorkingDirectory'), AGENT);
});

test('no VBScript anywhere: the shim is gone and nothing refers to it', () => {
  assert.doesNotMatch(xml, /wscript|\.vbs/i);
  assert.equal(fs.existsSync(path.join(AUTOSTART, 'start-agent-hidden.vbs')), false);
});

test('crash recovery is an every-minute CLOCK trigger with IgnoreNew, not RestartOnFailure', () => {
  // RestartOnFailure never restarted a killed agent (measured); a repetition on
  // the logon trigger sat unarmed until the next logon (measured).
  assert.doesNotMatch(xml, /RestartOnFailure/);
  const time = xml.match(/<TimeTrigger>([\s\S]*?)<\/TimeTrigger>/);
  assert.ok(time, 'no TimeTrigger');
  assert.match(time[1], /<Interval>PT1M<\/Interval>/);
  assert.match(time[1], /<StartBoundary>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d<\/StartBoundary>/);
  assert.doesNotMatch(time[1], /<Duration>/, 'a Duration would end the recovery');
  assert.doesNotMatch(xml.match(/<LogonTrigger>[\s\S]*?<\/LogonTrigger>/)[0], /Repetition/);
  assert.equal(tag('MultipleInstancesPolicy'), 'IgnoreNew');
});

test('still as the owner, not elevated, never timed out', () => {
  assert.equal(tag('LogonType'), 'InteractiveToken');
  assert.equal(tag('RunLevel'), 'LeastPrivilege');
  assert.equal(tag('ExecutionTimeLimit'), 'PT0S');
});
