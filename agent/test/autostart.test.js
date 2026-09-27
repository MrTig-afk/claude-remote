// agent/autostart: the logon task. This RENDERS the real template through the
// real register-task.ps1 (-RenderOnly: builds hidelaunch.exe, proves it runs,
// schema-validates, registers nothing) and checks the XML the scheduler would
// actually get - then exercises the launcher it just built.
//
// -LauncherDir points at a temp folder: without it the render would build into
// the owner's real data folder, beside the live agent's log.
//
// What is NOT here, on purpose: update-agent.ps1 stops and starts the owner's
// live agent and registers a real task, so the suite never runs it. Its
// end-to-end record (install, update, rollback, restart, crash recovery,
// measured 2026-09-23) is in docs/agent-autostart.md under "Verification".

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';

const AUTOSTART = fileURLToPath(new URL('../autostart/', import.meta.url));
const AGENT = path.dirname(path.dirname(AUTOSTART + 'x'));
// Canonical from the start: PowerShell reports the long name, so a TEMP given
// as an 8.3 short path (CI's RUNNER~1) would never equal the paths built here.
const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-autostart-')));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const launcherDir = path.join(dir, 'launcher');

// Smart App Control is passed, never read from this machine, so both
// launchers are covered wherever the suite runs.
function render(sac = 'Off', into = launcherDir) {
  const out = path.join(dir, `task-${sac}.xml`);
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(AUTOSTART, 'register-task.ps1'), '-RenderOnly', '-OutFile', out,
    '-LauncherDir', into, '-SmartAppControl', sac,
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

test('the action is our own hidelaunch.exe running THIS agent, logging to the data folder', () => {
  const cmd = tag('Command');
  assert.match(cmd, /\\hidelaunch-[0-9a-f]{12}\.exe$/, cmd);
  assert.equal(path.dirname(cmd), launcherDir, 'built outside the folder update-agent.ps1 renames');
  assert.equal(fs.existsSync(cmd), true, 'the task would point at a launcher that does not exist');
  const args = tag('Arguments');
  // A FULL path to cmd.exe, never the bare name: hidelaunch passes a null
  // application name, so Windows searches the launcher's own folder and the
  // current directory before System32, and a planted cmd.exe would win.
  assert.match(args, /^"[A-Za-z]:\\[^"]*\\cmd\.exe" \/s \/c "/, args);
  assert.ok(args.includes(`node.exe "${path.join(AGENT, 'server.js')}"`), args);
  assert.match(args, /1>>"[^"]*\\claude-remote-claude-remote\\agent\.log" 2>&1"$/);
  assert.equal(tag('WorkingDirectory'), AGENT);
});

test('no VBScript, and no conhost --headless where Smart App Control is off', () => {
  assert.doesNotMatch(xml, /wscript|\.vbs/i);
  assert.equal(fs.existsSync(path.join(AUTOSTART, 'start-agent-hidden.vbs')), false);
  // --headless is undocumented, loses the child's exit code, and conhost
  // parenting cmd.exe is a catalogued attacker technique. Not in the action.
  assert.doesNotMatch(tag('Command'), /conhost/i);
  assert.doesNotMatch(tag('Arguments'), /--headless/);
});

// Owner 2026-09-27, "B plus A": where Smart App Control is On, Windows can
// re-rate the unsigned hidelaunch and block it at any restart (it did, by
// hash, after nine days). There the task uses Microsoft's own conhost.exe.
test('Smart App Control On: conhost.exe --headless by full path, same command line, nothing built', () => {
  const none = path.join(dir, 'launcher-sac-on');
  const on = render('On', none).replace(/<!--[\s\S]*?-->/g, '');
  const get = (name) => unescape(on.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))[1]);
  assert.equal(get('Command'), path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'conhost.exe'));
  assert.equal(get('Arguments'), `--headless ${tag('Arguments')}`, 'the rest of the line must match the Off render');
  assert.deepEqual(fs.readdirSync(none).filter((f) => f.startsWith('hidelaunch-')), [], 'no unsigned build left on a Smart App Control PC');
});

test('the launcher is built from source into the data folder, content-addressed', () => {
  const built = fs.readdirSync(launcherDir).filter((f) => f.startsWith('hidelaunch-'));
  assert.equal(built.length, 1, `expected exactly one build, got ${built.join(', ')}`);
  // The name must follow the source, so a changed hidelaunch.cs compiles to a
  // NEW path instead of failing to overwrite one a running agent holds open.
  const src = fs.readFileSync(path.join(AUTOSTART, 'hidelaunch.cs'));
  const sha = crypto.createHash('sha256').update(src).digest('hex').slice(0, 12);
  assert.equal(built[0], `hidelaunch-${sha}.exe`);
});

// The two things the task's crash recovery depends on, exercised against the
// real binary rather than asserted about the source. A launcher that did not
// wait would leave the task Ready and the every-minute trigger would start a
// second agent; one that lost the exit code would make Last Run Result a lie.
// A FULL path here too. Passing a bare cmd.exe would be the very pattern the
// production change removed: the launcher resolves it from its own folder and
// the CWD (here, the repo root) before System32.
const CMD = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');

test('the launcher waits for its child and returns the child exit code', () => {
  const exe = tag('Command');
  const r = spawnSync(exe, [`"${CMD}"`, '/c', 'exit 42'],
    { windowsHide: true, windowsVerbatimArguments: true });
  assert.equal(r.status, 42, 'exit code not propagated (conhost --headless reported 0 here)');
});

test('the launcher keeps quotes, so a path with spaces survives', () => {
  const exe = tag('Command');
  const spaced = path.join(dir, 'a folder with spaces');
  fs.mkdirSync(spaced, { recursive: true });
  const marker = path.join(spaced, 'ran.txt');
  // Rejoining parsed argv with spaces drops the quotes and cmd answers
  // 'C:\Program' is not recognized - measured 2026-09-23 on the first draft.
  // windowsVerbatimArguments: node would otherwise re-quote these and the
  // launcher would never see the command line the task actually hands it.
  const r = spawnSync(exe, [`"${CMD}"`, '/s', '/c', `"type nul > "${marker}""`],
    { windowsHide: true, windowsVerbatimArguments: true });
  assert.equal(r.status, 0, 'launcher reported a failure');
  assert.equal(fs.existsSync(marker), true, 'the quoted path did not survive to cmd');
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

// Runs last on purpose: it leaves a decoy behind that the single-build check
// above would count. -RenderOnly is documented as the diagnostic that changes
// nothing, and a sweep of old builds once sat ABOVE its early return - so it
// could delete the launcher the REGISTERED task still points at, leaving both
// triggers naming a missing file forever.
test('-RenderOnly deletes no existing launcher build', () => {
  const decoy = path.join(launcherDir, 'hidelaunch-000000000000.exe');
  fs.writeFileSync(decoy, 'an older build, still named by a registered task');
  render();
  assert.equal(fs.existsSync(decoy), true, '-RenderOnly removed a build it does not own');
});

test('still as the owner, not elevated, never timed out', () => {
  assert.equal(tag('LogonType'), 'InteractiveToken');
  assert.equal(tag('RunLevel'), 'LeastPrivilege');
  assert.equal(tag('ExecutionTimeLimit'), 'PT0S');
});
