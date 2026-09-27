// hooks/check-update.mjs: the SessionStart hook that installs and updates the
// agent by itself (Lane 23 / R21.1-R21.2). Real temp folders; every outside
// effect - tailscale, the background job, PowerShell, the browser - is a fake
// handed in, so no test installs anything or opens anything.
//
// The WINDOWLESS claim is not testable here; it was measured by hand and the
// numbers are in the hook's header.

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  installedHash, sessionStart, runJob, firstReason, nodeVersionOk, tailscaleReady, stateFiles, LOCK_STALE_MS,
  SETTING_UP, NEEDS_TAILSCALE, NOT_WINDOWS, NEEDS_NODE, UPDATED, setupFailed, updateFailed,
  takeLock, releaseLock, removeLockIfStill, LONGEST_JOB_MS, INSTALL_TIMEOUT_MS, taskVerdict, realTaskQuery,
  realStartJob, realTailscale, phoneAddress, phoneReady, terminalQr, qrBlocks, TASK_NAME,
  ownPluginRoot, ALREADY_RUNNING, UP_TO_DATE, RUNS_ELSEWHERE, UPDATING,
} from '../../hooks/check-update.mjs';

const SCRIPT = fileURLToPath(new URL('../../hooks/check-update.mjs', import.meta.url));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-update-check-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
let n = 0;

// A plugin root shaped like the real one, and a copy of it the way setup makes it.
function makeRoot(dir, { serverBody = 'server v1', withTests = true } = {}) {
  fs.mkdirSync(path.join(dir, 'agent', 'public'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent', 'server.js'), serverBody);
  fs.writeFileSync(path.join(dir, 'agent', 'public', 'app.js'), 'app');
  fs.writeFileSync(path.join(dir, 'release-notes.json'), '[]');
  if (withTests) {
    fs.mkdirSync(path.join(dir, 'agent', 'test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent', 'test', 'x.test.js'), 'test');
  }
  return dir;
}

const RUNNING = JSON.stringify({ BackendState: 'Running' });
const URL_OK = 'https://desktop-abc1234.tail1a2b3c.ts.net:8790';

// `schtasks /query /xml` for a task register-task.ps1 made, in its real shape
// (this PC's, 2026-09-27), running node.exe on `serverPath`.
function taskXml(serverPath) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const data = 'C:\\Users\\u\\.claude\\plugins\\data\\claude-remote-claude-remote';
  return `<?xml version="1.0" encoding="UTF-16"?>\r\n<Task version="1.4">\r\n  <Actions Context="Author">\r\n    <Exec>\r\n`
    + `      <Command>${data}\\hidelaunch-af4db7d7385b.exe</Command>\r\n`
    + `      <Arguments>${esc(`"C:\\WINDOWS\\System32\\cmd.exe" /s /c "md "${data}" 2>nul & node.exe "${serverPath}" 1>>"${data}\\agent.log" 2>&1"`)}</Arguments>\r\n`
    + `      <WorkingDirectory>${path.dirname(serverPath)}</WorkingDirectory>\r\n    </Exec>\r\n  </Actions>\r\n</Task>`;
}
const NO_TASK = { ok: false, missing: true };

/** A throwaway world: plugin root, LOCALAPPDATA, data dir, a PATH holding claude.cmd. */
function world({ installed = null, plugin = 'server v1' } = {}) {
  const dir = path.join(base, `w${n += 1}`);
  const pluginRoot = makeRoot(path.join(dir, 'plugin'), { serverBody: plugin });
  const localAppData = path.join(dir, 'local');
  fs.mkdirSync(localAppData, { recursive: true });
  if (installed !== null) makeRoot(path.join(localAppData, 'claude-remote'), { serverBody: installed, withTests: false });
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off');
  const jobs = [];
  const tailscaleCalls = [];
  const ours = path.join(localAppData, 'claude-remote', 'agent', 'server.js');
  const deps = {
    platform: 'win32', pluginRoot, localAppData, dataDir: path.join(dir, 'data'), pathValue: bin,
    nodeVersion: 'v24.2.0', now: 1_000_000_000,
    tailscaleStatus: async () => { tailscaleCalls.push(1); return RUNNING; },
    // An installed copy's task runs it; with no copy there is no task yet.
    taskQuery: async () => (installed === null ? NO_TASK : { ok: true, stdout: taskXml(ours) }),
    phoneAddress: async () => null,
    startJob: (job) => jobs.push(job),
  };
  return { dir, deps, jobs, tailscaleCalls, ours, files: stateFiles(deps.dataDir) };
}
const readState = (w) => JSON.parse(fs.readFileSync(w.files.state, 'utf8'));
const writeState = (w, s) => { fs.mkdirSync(w.deps.dataDir, { recursive: true }); fs.writeFileSync(w.files.state, JSON.stringify(s)); };

test('installedHash: same files match even without the tests; an agent file or the release notes differ', () => {
  const a = makeRoot(path.join(base, 'h1'));
  assert.equal(installedHash(a), installedHash(makeRoot(path.join(base, 'h2'), { withTests: false })));
  assert.notEqual(installedHash(a), installedHash(makeRoot(path.join(base, 'h3'), { serverBody: 'server v2' })));
  const b = makeRoot(path.join(base, 'h4'));
  fs.writeFileSync(path.join(b, 'release-notes.json'), '[{"v":2}]');
  assert.notEqual(installedHash(a), installedHash(b));
});

test('nothing installed: starts the install in the background, says the setup line, holds the lock', async () => {
  const w = world();
  assert.equal(await sessionStart(w.deps), SETTING_UP);
  assert.equal(w.jobs.length, 1);
  const { lockToken, ...job } = w.jobs[0];
  assert.deepEqual(job, {
    kind: 'install', pluginRoot: w.deps.pluginRoot, target: path.join(w.deps.localAppData, 'claude-remote'),
    dataDir: w.deps.dataDir, hash: installedHash(w.deps.pluginRoot),
  });
  assert.equal(JSON.parse(fs.readFileSync(w.files.lock, 'utf8')).token, lockToken, 'the job carries the lock\'s token');
});

// RED WHEN (SS-C1-C01): the task check goes. THIS PC runs its agent from the
// F: checkout through the logon task; the first plugin load would have stopped
// it and re-pointed the task at a fresh copy.
test('a logon task running an agent from elsewhere: no install, no update, no line, no lock', async () => {
  const elsewhere = { ok: true, stdout: taskXml('F:\\Dev\\Projects\\Lala\\claude-remote\\agent\\server.js') };
  for (const installed of [null, 'server v0']) {
    const w = world({ installed });
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await sessionStart({ ...w.deps, taskQuery: async () => elsewhere }), null);
    assert.deepEqual(w.jobs, [], `installed: ${installed}`);
    assert.equal(fs.existsSync(w.files.lock), false);
    // A query that failed for any other reason than "no such task" is the same: hands off.
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await sessionStart({ ...w.deps, taskQuery: async () => ({ ok: false, missing: false }) }), null);
    assert.deepEqual(w.jobs, []);
  }
  const w = world({ installed: 'server v0' });
  assert.equal(await sessionStart(w.deps), null, 'the task runs the copy here: the update goes ahead');
  assert.equal(w.jobs.length, 1);
});

test('taskVerdict: ours only when the task runs <target>\\agent\\server.js', () => {
  const target = 'C:\\Users\\u\\AppData\\Local\\claude-remote';
  const q = (p) => ({ ok: true, stdout: taskXml(p) });
  assert.equal(taskVerdict(q(`${target}\\agent\\server.js`), target), 'ours');
  assert.equal(taskVerdict(q(`${target.toUpperCase()}\\AGENT\\SERVER.JS`), target), 'ours', 'Windows paths ignore case');
  assert.equal(taskVerdict(q('F:\\checkout\\agent\\server.js'), target), 'other');
  assert.equal(taskVerdict(q(`${target}\\agent\\server.js.bak`), target), 'other');
  assert.equal(taskVerdict(q(`${target}2\\agent\\server.js`), target), 'other');
  const amp = 'C:\\Users\\A&B\\AppData\\Local\\claude-remote';
  assert.equal(taskVerdict(q(`${amp}\\agent\\server.js`), amp), 'ours', 'XML escapes are read back');
  assert.equal(taskVerdict({ ok: true, stdout: '<Task><Exec><Command>x.exe</Command></Exec></Task>' }, target), 'other');
  assert.equal(taskVerdict({ ok: true, stdout: '' }, target), 'other');
  assert.equal(taskVerdict(NO_TASK, target), 'none');
  assert.equal(taskVerdict({ ok: false, missing: false }, target), 'other');
  assert.equal(taskVerdict(null, target), 'other');
});

test('realTaskQuery: full-path schtasks, no window, short timeout; "missing" only on exit 1 with no task file', async () => {
  const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const calls = [];
  const fake = (answer) => (file, args, opts, cb) => { calls.push({ file, args, opts }); cb(...answer); };
  assert.deepEqual(await realTaskQuery(fake([null, '<Task/>'])), { ok: true, stdout: '<Task/>' });
  assert.equal(calls[0].file, path.join(sys32, 'schtasks.exe'));
  assert.deepEqual(calls[0].args, ['/query', '/tn', TASK_NAME, '/xml']);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.ok(calls[0].opts.timeout <= 2000);
  const taskFile = path.join(sys32, 'Tasks', TASK_NAME);
  const exists = fs.existsSync(taskFile);
  assert.deepEqual(await realTaskQuery(fake([Object.assign(new Error('x'), { code: 1 })])), { ok: false, missing: !exists });
  assert.deepEqual(await realTaskQuery(fake([Object.assign(new Error('x'), { code: 'ETIMEDOUT', killed: true })])), { ok: false, missing: false });
});

// RED WHEN: the agentRunning check goes - a PC whose agent runs from a git
// checkout (no copy in LOCALAPPDATA) would have it stopped and its logon task
// re-pointed at a fresh copy the first time the plugin loaded.
test('no copy here but an agent already answers: left alone, no job, no line', async () => {
  const w = world();
  assert.equal(await sessionStart({ ...w.deps, agentRunning: async () => true }), null);
  assert.deepEqual(w.jobs, []);
  assert.equal(fs.existsSync(w.files.lock), false, 'and no lock taken');
  assert.equal(await sessionStart({ ...w.deps, agentRunning: async () => false }), SETTING_UP, 'nothing answering: the install goes ahead');
});

test('installed and the same: silent, no job, and Tailscale is not even asked', async () => {
  const w = world({ installed: 'server v1' });
  assert.equal(await sessionStart(w.deps), null);
  assert.deepEqual(w.jobs, []);
  assert.deepEqual(w.tailscaleCalls, []);
});

test('installed but older than the plugin: an update job, and no line until it has finished', async () => {
  const w = world({ installed: 'server v0' });
  assert.equal(await sessionStart(w.deps), null);
  assert.equal(w.jobs[0].kind, 'update');
});

test('a second Claude during the install says nothing and starts nothing; a stale lock does not block', async () => {
  const w = world();
  assert.equal(await sessionStart(w.deps), SETTING_UP);
  assert.equal(await sessionStart({ ...w.deps, now: w.deps.now + LOCK_STALE_MS - 1 }), null);
  assert.equal(w.jobs.length, 1);
  assert.equal(w.tailscaleCalls.length, 1, 'the second start checks nothing, so it can print nothing either');
  assert.equal(await sessionStart({ ...w.deps, now: w.deps.now + LOCK_STALE_MS }), SETTING_UP);
  assert.equal(w.jobs.length, 2);
});

test('an unreadable lock is a dead job\'s, not a live one', async () => {
  const w = world();
  fs.mkdirSync(w.deps.dataDir, { recursive: true });
  fs.writeFileSync(w.files.lock, 'half-writ');
  assert.equal(await sessionStart(w.deps), SETTING_UP);
});

test('prerequisites: Tailscale, then Node, then claude.cmd - one line, nothing installed, no lock left', async () => {
  for (const [change, line] of [
    [{ tailscaleStatus: async () => JSON.stringify({ BackendState: 'NeedsLogin' }) }, NEEDS_TAILSCALE],
    [{ tailscaleStatus: async () => null }, NEEDS_TAILSCALE],
    [{ nodeVersion: 'v24.1.9' }, NEEDS_NODE],
    [{ pathValue: '' }, setupFailed('claude.cmd is not on PATH')],
  ]) {
    const w = world();
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await sessionStart({ ...w.deps, ...change }), line);
    assert.deepEqual(w.jobs, []);
    assert.ok(!fs.existsSync(w.files.lock));
  }
});

// RED WHEN: the agentRunning check is install-only again (SS-C1-D2-C01) - an
// old copy here, no logon task, and an agent run by hand from a checkout: the
// update would stop that agent and register the task at the old copy.
test('an update with no logon task and an agent already answering: left alone, no job, no line', async () => {
  const w = world({ installed: 'server v0' });
  const deps = { ...w.deps, taskQuery: async () => NO_TASK };
  assert.equal(await sessionStart({ ...deps, agentRunning: async () => true }), null);
  assert.deepEqual(w.jobs, []);
  assert.equal(fs.existsSync(w.files.lock), false);
  assert.equal(await sessionStart({ ...deps, agentRunning: async () => false }), null, 'nothing answering: the update goes ahead');
  assert.equal(w.jobs.length, 1);
  assert.equal(w.jobs[0].kind, 'update');
});

// RED WHEN: the three questions are asked one after another again
// (SS-C1-D2-C02) - their timeouts then add up to the hook's 10s limit.
test('the task, agent and Tailscale questions are asked at the same time', async () => {
  const w = world();
  const slow = (v) => () => new Promise((r) => { setTimeout(() => r(v), 150); });
  const t0 = Date.now();
  const line = await sessionStart({
    ...w.deps, taskQuery: slow(NO_TASK), agentRunning: slow(false),
    tailscaleStatus: slow(JSON.stringify({ BackendState: 'Running' })),
  });
  assert.equal(line, SETTING_UP);
  assert.ok(Date.now() - t0 < 400, `three 150ms questions took ${Date.now() - t0}ms - asked one by one`);
});

// RED WHEN: the claude.cmd line is returned without being recorded
// (SS-C1-D2-C03) - it then repeats at every start in every project.
test('claude.cmd missing: said once for this plugin version, then silent; a newer plugin tries again', async () => {
  const w = world();
  const deps = { ...w.deps, pathValue: '' };
  assert.equal(await sessionStart(deps), setupFailed('claude.cmd is not on PATH'));
  assert.equal(await sessionStart(deps), null, 'not again at the next start');
  assert.deepEqual(w.jobs, []);
  fs.writeFileSync(path.join(w.deps.pluginRoot, 'release-notes.json'), '[{"v":9}]');
  assert.equal(await sessionStart(deps), setupFailed('claude.cmd is not on PATH'), 'a newer plugin says it once more');
});

test('not Windows: the line once, then silent forever; nothing else is looked at', async () => {
  const w = world();
  const deps = { ...w.deps, platform: 'darwin', localAppData: undefined };
  assert.equal(await sessionStart(deps), NOT_WINDOWS);
  assert.equal(await sessionStart(deps), null);
  assert.deepEqual(w.jobs, []);
});

test('a failed install is not retried by itself - but a newer plugin gets its own try', async () => {
  const w = world();
  const hash = installedHash(w.deps.pluginRoot);
  writeState(w, { last: { kind: 'install', ok: false, reason: 'x', hash, reported: true } });
  assert.equal(await sessionStart(w.deps), null);
  assert.deepEqual(w.jobs, []);
  writeState(w, { last: { kind: 'install', ok: false, reason: 'x', hash: 'an older plugin', reported: true } });
  assert.equal(await sessionStart(w.deps), SETTING_UP);
});

test('each outcome is printed exactly once, at the next start', async () => {
  const cases = [
    [{ kind: 'update', ok: true }, UPDATED],
    [{ kind: 'update', ok: false, reason: 'the agent did not come back' }, updateFailed('the agent did not come back')],
    [{ kind: 'install', ok: false, reason: 'copying failed' }, setupFailed('copying failed')],
    [{ kind: 'install', ok: true }, null],   // a first install says so by opening the browser
  ];
  for (const [last, line] of cases) {
    const w = world({ installed: 'server v1' });
    writeState(w, { last: { ...last, hash: 'h', reported: false } });
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await sessionStart(w.deps), line);
    assert.equal(readState(w).last.reported, true);
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await sessionStart(w.deps), null, 'and never again');
  }
});

test('the lines are the Artifact\'s, word for word', () => {
  assert.equal(SETTING_UP, 'Claude Remote is setting itself up on this PC. Your browser will open on its passcode screen in a moment.');
  assert.equal(NEEDS_TAILSCALE, 'Claude Remote needs Tailscale on this PC, running and signed in, before it can set itself up. Get it from tailscale.com/download, sign in, then restart Claude.');
  assert.equal(NOT_WINDOWS, 'Claude Remote runs on Windows 10 and 11 only, so it has not set itself up here.');
  assert.equal(NEEDS_NODE, 'Claude Remote needs Node.js 24.2 or newer. Install it from nodejs.org, then restart Claude.');
  assert.equal(setupFailed('R'), "Claude Remote couldn't set itself up: R. Run /claude-remote:setup to try again and see the details.");
  assert.equal(UPDATED, 'Claude Remote updated itself on this PC. The app on your phone picks it up the next time it opens.');
  assert.equal(updateFailed('R'), "Claude Remote couldn't update itself: R. Run /claude-remote:setup to try again and see the details.");
});

test('nodeVersionOk and tailscaleReady', () => {
  assert.ok(nodeVersionOk('v24.2.0') && nodeVersionOk('24.10.1') && nodeVersionOk('v25.0.0'));
  assert.ok(!nodeVersionOk('v24.1.99') && !nodeVersionOk('v23.9.0') && !nodeVersionOk('junk'));
  assert.ok(tailscaleReady(RUNNING));
  assert.ok(!tailscaleReady(JSON.stringify({ BackendState: 'Stopped' })) && !tailscaleReady('') && !tailscaleReady(null));
});

test('firstReason: the throw message, not the warnings above it or the PowerShell position lines', () => {
  const stderr = "update failed (no agent); the failed copy is at 'C:\\x'.\r\nAt C:\\x\\update-agent.ps1:4 char:1\r\n+ throw ...\r\n";
  assert.equal(firstReason(stderr, "agent running\r\nWARNING: rolling back\n", 1), "update failed (no agent); the failed copy is at 'C:\\x'");
  assert.equal(firstReason('', 'WARNING: w\n\nno agent at C:\\p\n', 1), 'no agent at C:\\p');
  assert.equal(firstReason('', '', 5), 'update-agent.ps1 exited with code 5');
});

// --- the background job ------------------------------------------------------

function jobWorld(kind) {
  const w = world(kind === 'update' ? { installed: 'server v0' } : {});
  const lockToken = takeLock(w.files.lock, Date.now());
  const job = { kind, pluginRoot: w.deps.pluginRoot, target: path.join(w.deps.localAppData, 'claude-remote'), dataDir: w.deps.dataDir, hash: 'H', lockToken };
  const calls = { install: [], opened: [], asked: 0 };
  const deps = (result, answers = [true]) => ({
    runInstall: async (args) => { calls.install.push(args); if (result instanceof Error) throw result; return result; },
    agentAnswers: async () => { calls.asked += 1; return answers.shift() ?? true; },
    openBrowser: (url) => calls.opened.push(url),
    port: 8790,
    waitMs: 0,
  });
  return { w, job, calls, deps };
}

test('the job runs update-agent.ps1 exactly as setup does, then opens the browser once on a FIRST install', async () => {
  const { w, job, calls, deps } = jobWorld('install');
  await runJob(job, deps({ code: 0, stdout: 'agent running', stderr: '' }, [false, false, true]));
  assert.deepEqual(calls.install, [['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(job.pluginRoot, 'agent', 'autostart', 'update-agent.ps1'), '-Source', job.pluginRoot, '-Target', job.target]]);
  assert.equal(calls.asked, 3, 'waited for the agent to answer');
  assert.deepEqual(calls.opened, ['http://127.0.0.1:8790']);
  const { last } = readState(w);
  assert.equal(last.ok, true);
  assert.equal(last.kind, 'install');
  assert.equal(last.reported, false);
  assert.ok(!fs.existsSync(w.files.lock), 'the lock is given back');
});

test('an update never opens the browser', async () => {
  const { job, calls, deps } = jobWorld('update');
  await runJob(job, deps({ code: 0, stdout: '', stderr: '' }));
  assert.deepEqual(calls.opened, []);
  assert.equal(calls.asked, 0);
});

test('a failed install records its reason, opens nothing, and gives the lock back', async () => {
  const { w, job, calls, deps } = jobWorld('install');
  await runJob(job, deps({ code: 1, stdout: '', stderr: 'copying the new version failed (robocopy 16) - nothing was stopped\r\nAt x\r\n' }));
  assert.deepEqual(calls.opened, []);
  const { last } = readState(w);
  assert.equal(last.ok, false);
  assert.equal(last.reason, 'copying the new version failed (robocopy 16) - nothing was stopped');
  assert.equal(last.hash, 'H');
  assert.ok(!fs.existsSync(w.files.lock));
});

test('a job that throws still gives the lock back', async () => {
  const { w, job, deps } = jobWorld('install');
  await assert.rejects(runJob(job, deps(new Error('boom'))));
  assert.ok(!fs.existsSync(w.files.lock));
});

test('run as the hook: silent when nothing changed, the pending line as systemMessage JSON otherwise', () => {
  const w = world({ installed: 'server v1' });
  const home = path.join(w.dir, 'home');
  const dataDir = path.join(home, '.claude', 'plugins', 'data', 'claude-remote-claude-remote');
  const run = () => execFileSync(process.execPath, [SCRIPT], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: w.deps.pluginRoot, LOCALAPPDATA: w.deps.localAppData, USERPROFILE: home, HOME: home },
    encoding: 'utf8',
  });
  assert.equal(run(), '');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'auto-setup.json'), JSON.stringify({ last: { kind: 'update', ok: true, hash: 'h', reported: false } }));
  assert.deepEqual(JSON.parse(run()), { systemMessage: UPDATED });
  assert.equal(run(), '');
});

// --- the lock (SS-C1-C02 / C03) ---------------------------------------------

function lockDir() {
  const dir = path.join(base, `lock${n += 1}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'auto-setup.lock');
}

// Real processes, released at the same instant, each trying to take the lock.
async function race(lockFile, count) {
  const taker = path.join(base, 'taker.mjs');
  fs.writeFileSync(taker, [
    `import { takeLock } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};`,
    'const [lock, at] = process.argv.slice(2);',
    'while (Date.now() < Number(at)) { /* the starting gun */ }',
    'process.stdout.write(String(takeLock(lock, Date.now())));',
  ].join('\n'));
  const at = Date.now() + 1500;
  const outs = await Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
    execFile(process.execPath, [taker, lockFile, String(at)], { encoding: 'utf8' }, (err, out) => (err ? reject(err) : resolve(out)));
  })));
  return outs.filter((o) => o !== 'null');
}

// RED WHEN: the lock is created empty and filled in afterwards (the old 'wx'
// write): a racer reads the empty file, takes it for a dead job's, deletes it
// and takes the lock too - two installs at once.
test('six Claude starts at the same instant: exactly one takes the lock, and the lock holds its token', async () => {
  const lockFile = lockDir();
  const winners = await race(lockFile, 6);
  assert.equal(winners.length, 1, `winners: ${winners}`);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, winners[0]);
  assert.deepEqual(fs.readdirSync(path.dirname(lockFile)), ['auto-setup.lock'], 'no temp files left behind');
});

// The same bug, deterministically: a second start that looks the instant the
// lock file appears must find it complete, and so held. Every write or link
// onto the lock path is followed, right there, by another take.
test('the lock never exists without its content: a start arriving mid-creation finds it held', () => {
  const lockFile = lockDir();
  const seen = [];
  const orig = { writeFileSync: fs.writeFileSync, linkSync: fs.linkSync };
  let nested = false;
  const spy = (name) => (...args) => {
    const r = orig[name].apply(fs, args);
    if (!nested && path.resolve(String(args[name === 'linkSync' ? 1 : 0])) === path.resolve(lockFile)) {
      nested = true;
      try { seen.push(takeLock(lockFile, Date.now())); } finally { nested = false; }
    }
    return r;
  };
  fs.writeFileSync = spy('writeFileSync');
  fs.linkSync = spy('linkSync');
  let token;
  try {
    token = takeLock(lockFile, Date.now());
  } finally {
    Object.assign(fs, orig);
  }
  assert.ok(seen.length > 0, 'the lock path was written');
  assert.deepEqual(seen, seen.map(() => null), 'the start arriving mid-creation took nothing');
  assert.ok(token);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, token);
});

test('two starts racing for a STALE lock: exactly one takes it over', async () => {
  const lockFile = lockDir();
  fs.writeFileSync(lockFile, JSON.stringify({ token: 'dead', started: 1 }));
  const winners = await race(lockFile, 2);
  assert.equal(winners.length, 1, `winners: ${winners}`);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, winners[0]);
});

test('the stale window outlasts the longest job, and is derived from it', () => {
  assert.ok(LONGEST_JOB_MS > INSTALL_TIMEOUT_MS, 'the browser wait counts too');
  assert.ok(LOCK_STALE_MS > LONGEST_JOB_MS, `${LOCK_STALE_MS} <= ${LONGEST_JOB_MS}`);
  assert.equal(INSTALL_TIMEOUT_MS, 10 * 60 * 1000);
});

test('a fresh lock is never taken; a stale one is; an unreadable-right-now one counts as held', () => {
  const lockFile = lockDir();
  const now = 5_000_000_000;
  const first = takeLock(lockFile, now);
  assert.ok(first);
  assert.equal(takeLock(lockFile, now + LOCK_STALE_MS - 1), null);
  const second = takeLock(lockFile, now + LOCK_STALE_MS);
  assert.ok(second && second !== first, 'stale: taken over');
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, second);
});

// RED WHEN: a job's finally removes the lock unconditionally. Its lock went
// stale (or was taken over) and a newer job now holds it.
test('a job gives back only its own lock', async () => {
  const lockFile = lockDir();
  const mine = takeLock(lockFile, Date.now());
  releaseLock(lockFile, 'someone-else');
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, mine, 'another token: untouched');
  releaseLock(lockFile, undefined);
  assert.ok(fs.existsSync(lockFile), 'no token: untouched');
  releaseLock(lockFile, mine);
  assert.ok(!fs.existsSync(lockFile));

  const { w, job, deps } = jobWorld('install');
  fs.rmSync(w.files.lock);
  const newer = takeLock(w.files.lock, Date.now());
  await runJob(job, deps({ code: 0, stdout: '', stderr: '' }));
  assert.equal(JSON.parse(fs.readFileSync(w.files.lock, 'utf8')).token, newer, 'the old job left the newer lock alone');
});

// RED WHEN: a stale takeover deletes whatever is at the lock path, when
// another start replaced the stale lock between the read and the delete.
test('removing a stale lock never removes a newer one that replaced it', () => {
  const lockFile = lockDir();
  const staleRaw = JSON.stringify({ token: 'dead', started: 1 });
  fs.writeFileSync(lockFile, JSON.stringify({ token: 'newer', started: Date.now() }));
  removeLockIfStill(lockFile, staleRaw);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, 'newer');
  assert.deepEqual(fs.readdirSync(path.dirname(lockFile)), ['auto-setup.lock']);
  removeLockIfStill(lockFile, fs.readFileSync(lockFile, 'utf8'));
  assert.ok(!fs.existsSync(lockFile), 'the one judged: removed');
});

// --- an update does not need Tailscale (SS-C1-C04) ---------------------------

// RED WHEN: the Tailscale check runs for an update too - a PC whose Tailscale
// is signed out would be told it "needs Tailscale before it can set itself up",
// about an agent that is already set up, and would never get the update.
test('an update neither asks Tailscale nor says NEEDS_TAILSCALE', async () => {
  const w = world({ installed: 'server v0' });
  const line = await sessionStart({ ...w.deps, tailscaleStatus: async () => { w.tailscaleCalls.push(1); return null; } });
  assert.equal(line, null);
  assert.deepEqual(w.tailscaleCalls, []);
  assert.equal(w.jobs.length, 1);
  assert.equal(w.jobs[0].kind, 'update');
});

// --- the job that never started (SS-C1-C05) ----------------------------------

// RED WHEN: realStartJob has no 'error' listener - the spawn failure is an
// uncaught exception in the hook, the lock stays for the whole stale window,
// and nothing ever says the install did not happen.
test('a job that cannot be spawned: lock given back, failure recorded, said at the next start', async () => {
  const w = world();
  assert.equal(await sessionStart({ ...w.deps, startJob: (job) => realStartJob(job, () => {
    const child = new EventEmitter();
    child.unref = () => {};
    process.nextTick(() => child.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' })));
    return child;
  }) }), SETTING_UP);
  await new Promise((r) => { setImmediate(r); });
  assert.ok(!fs.existsSync(w.files.lock), 'the lock is given back');
  const { last } = readState(w);
  assert.equal(last.ok, false);
  assert.equal(last.kind, 'install');
  assert.equal(last.reason, 'the background install could not start (ENOENT)');
  assert.equal(await sessionStart(w.deps), setupFailed('the background install could not start (ENOENT)'));
});

test('a spawn that throws outright is handled the same way', async () => {
  const w = world();
  await sessionStart({ ...w.deps, startJob: (job) => realStartJob(job, () => { throw Object.assign(new Error('bad'), { code: 'EINVAL' }); }) });
  assert.ok(!fs.existsSync(w.files.lock));
  assert.equal(readState(w).last.reason, 'the background install could not start (EINVAL)');
});

// --- tailscale's working folder (SS-C1-S01) ----------------------------------

// RED WHEN: cwd goes. With the bare-name fallback, libuv looks for tailscale in
// the child's cwd first - unset, the project folder Claude was opened in.
// (Measured 2026-09-27: a planted exe in cwd ran; with cwd System32 it did not.)
test('tailscale runs with its cwd in System32, no window, fixed args', async () => {
  const calls = [];
  const out = await realTailscale(['status', '--json'], (file, args, opts, cb) => { calls.push({ file, args, opts }); cb(null, '{}'); });
  assert.equal(out, '{}');
  assert.equal(calls[0].opts.cwd, path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'));
  assert.equal(calls[0].opts.windowsHide, true);
  assert.deepEqual(calls[0].args, ['status', '--json']);
  assert.equal(await realTailscale(['status'], (f, a, o, cb) => cb(new Error('x'))), null);
});

// --- the phone code in the terminal (Lane 23 step 8, R21.7) ------------------

const SERVE_ON = JSON.stringify({ TCP: { 8790: { HTTPS: true } }, Web: { 'desktop-abc1234.tail1a2b3c.ts.net:8790': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8790' } } } } });
const STATUS = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'desktop-abc1234.tail1a2b3c.ts.net.' } });

test('terminalQr: quiet zone, finder patterns, light modules drawn, every line bright white', () => {
  const lines = qrBlocks('https://claude.ai');   // 17 bytes: version 2, 25 modules + 2x2 quiet = 29
  assert.equal(lines.length, 15);
  assert.ok(lines.every((l) => [...l].length === 29));
  assert.equal(lines[0], '█'.repeat(29), 'rows 0-1: quiet zone, light');
  assert.equal(lines[14], '▀'.repeat(29), 'row 28: quiet zone, no row below it');
  // Rows 2-3: the top of both upper finder patterns - a dark row over a ring.
  assert.ok(lines[1].startsWith('██ ▄▄▄▄▄ █'), lines[1]);
  assert.ok(lines[1].endsWith('█ ▄▄▄▄▄ ██'), lines[1]);
  const wrapped = terminalQr('https://claude.ai').split('\n');
  assert.equal(wrapped.length, lines.length);
  wrapped.forEach((l, i) => assert.equal(l, `\x1b[97m${lines[i]}\x1b[0m`));
});

test('phoneReady: the approved line, the address written out, then the code', () => {
  const [first, ...qr] = phoneReady(URL_OK).split('\n');
  assert.equal(first, `Claude Remote is ready. Scan this with your phone's camera to open it, or go to ${URL_OK}`);
  assert.equal(qr.join('\n'), terminalQr(URL_OK));
});

test('phoneAddress: the address only when serve shares THIS port and the name is known', async () => {
  const run = (serve, status) => async (args) => (args[0] === 'serve' ? serve : status);
  assert.equal(await phoneAddress(8790, run(SERVE_ON, STATUS)), URL_OK);
  assert.equal(await phoneAddress(8791, run(SERVE_ON, STATUS)), null, 'another port');
  assert.equal(await phoneAddress(8790, run('null', STATUS)), null, 'serve off');
  assert.equal(await phoneAddress(8790, run(null, STATUS)), null, 'tailscale not answering');
  assert.equal(await phoneAddress(8790, run(SERVE_ON, null)), null, 'name unknown');
});

test('the phone code is shown once, only for this plugin\'s install, and records that it was', async () => {
  const w = world({ installed: 'server v1' });
  let asked = 0;
  const deps = { ...w.deps, phoneAddress: async () => { asked += 1; return URL_OK; } };
  assert.equal(await sessionStart(deps), phoneReady(URL_OK));
  assert.equal(readState(w).phoneShown, true);
  assert.equal(readState(w).phoneUrl, URL_OK);
  assert.equal(await sessionStart(deps), null, 'never again');
  assert.equal(asked, 1, 'and Tailscale is not asked again');
  assert.deepEqual(w.jobs, []);
});

test('no phone code while sharing is off, for an agent run from elsewhere, or with no copy here', async () => {
  const w = world({ installed: 'server v1' });
  assert.equal(await sessionStart(w.deps), null, 'sharing not on yet');
  assert.equal(fs.existsSync(w.files.state), false, 'nothing recorded, so it is asked again next start');
  const elsewhere = { ok: true, stdout: taskXml('F:\\checkout\\agent\\server.js') };
  let asked = 0;
  const phone = async () => { asked += 1; return URL_OK; };
  assert.equal(await sessionStart({ ...w.deps, taskQuery: async () => elsewhere, phoneAddress: phone }), null);
  assert.equal(await sessionStart({ ...w.deps, taskQuery: async () => NO_TASK, phoneAddress: phone }), null);
  assert.equal(asked, 0, 'Tailscale is not even asked for an install this plugin did not make');
  const bare = world();
  assert.equal(await sessionStart({ ...bare.deps, agentRunning: async () => true, phoneAddress: phone }), null, 'no copy: no code');
  assert.equal(asked, 0);
});

test('one line per start: an outcome line first, the phone code at the next start', async () => {
  const w = world({ installed: 'server v1' });
  writeState(w, { last: { kind: 'update', ok: true, hash: 'h', reported: false } });
  const deps = { ...w.deps, phoneAddress: async () => URL_OK };
  assert.equal(await sessionStart(deps), UPDATED);
  assert.equal(await sessionStart(deps), phoneReady(URL_OK));
  assert.equal(readState(w).last.reported, true, 'the outcome stays reported');
  // A first install that worked has no line of its own, so its next start shows the code.
  const w2 = world({ installed: 'server v1' });
  writeState(w2, { last: { kind: 'install', ok: true, hash: 'h', reported: false } });
  assert.equal(await sessionStart({ ...w2.deps, phoneAddress: async () => URL_OK }), phoneReady(URL_OK));
  assert.equal(readState(w2).last.reported, true);
});

test('run as the hook with --print-qr: the same drawing, plain, for setup\'s hand-over', () => {
  const out = execFileSync(process.execPath, [SCRIPT, '--print-qr', URL_OK], { encoding: 'utf8' });
  assert.equal(out, `${qrBlocks(URL_OK).join('\n')}\n`);
  assert.equal(execFileSync(process.execPath, [SCRIPT, '--print-qr'], { encoding: 'utf8' }), '');
});

// --now (AGENTS.md's third command) has no CLAUDE_PLUGIN_ROOT: it must find the
// plugin it sits in, or it hashes and installs from the wrong folder.
test('--now finds its own plugin root: the folder above hooks/', () => {
  const root = path.join(base, 'own-root');
  assert.equal(ownPluginRoot(pathToFileURL(path.join(root, 'hooks', 'check-update.mjs')).href), root);
  assert.equal(ownPluginRoot(), path.resolve(fileURLToPath(new URL('../..', import.meta.url))), 'the repo copy is its own root');
});

// RED WHEN: the README sentence, AGENTS.md's steps and the hook drift apart -
// the sentence must name AGENTS.md, AGENTS.md must give the reason BEFORE the
// commands and run the hook's real --now mode with the PS 5.1-safe lookup, and
// the README must carry no instructions addressed to Claude (sequence 21).
test('install docs: README names AGENTS.md; AGENTS.md reasons first, then the three commands', () => {
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
  const agents = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
  assert.match(readme, /Install Claude Remote by following github\.com\/MrTig-afk\/claude-remote\/blob\/main\/AGENTS\.md/);
  assert.doesNotMatch(readme, /claude plugin marketplace add|check-update\.mjs" --now/, 'no Claude steps in the README');
  const why = agents.indexOf('**Why these steps.**');
  const cmds = agents.indexOf('claude plugin marketplace add MrTig-afk/claude-remote');
  assert.ok(why !== -1 && cmds > why, 'the reason comes before the commands');
  assert.match(agents, /claude plugin install claude-remote@claude-remote/);
  assert.match(agents, /\(\(claude plugin list --json \| ConvertFrom-Json\) \| Where-Object id -eq 'claude-remote@claude-remote'/, 'brackets for PS 5.1');
  assert.match(agents, /hooks\\check-update\.mjs" --now/);
  assert.match(fs.readFileSync(SCRIPT, 'utf8'), /process\.argv\[2\] === '--now'/, 'the hook really has a --now mode');
});

// RED WHEN: --now maps a silent branch to one catch-all sentence again
// (SO-C1-C01) - it denied an update that was starting and hid a failed setup.
// Every branch a session start keeps quiet, --now names.
test('--now names every outcome, and never takes the phone code', async () => {
  const ex = (w, more = {}) => sessionStart({ ...w.deps, explain: true, ...more });
  const fresh = world();
  assert.equal(await ex(fresh), SETTING_UP, 'install started');
  assert.equal(await ex(fresh), ALREADY_RUNNING, 'the lock is held');

  const older = world({ installed: 'server v0' });
  assert.equal(await ex(older), UPDATING, 'an update really started');
  assert.equal(older.jobs.length, 1);

  const same = world({ installed: 'server v1' });
  let asked = 0;
  assert.equal(await ex(same, { phoneAddress: async () => { asked += 1; return URL_OK; } }), UP_TO_DATE);
  assert.equal(asked, 0, 'the phone code is never asked for, so it is not used up');

  const foreign = world();
  const elsewhere = { ok: true, stdout: taskXml('F:\\checkout\\agent\\server.js') };
  assert.equal(await ex(foreign, { taskQuery: async () => elsewhere }), RUNS_ELSEWHERE);
  assert.equal(await ex(world(), { taskQuery: async () => NO_TASK, agentRunning: async () => true }), RUNS_ELSEWHERE);

  const failed = world();
  writeState(failed, { last: { kind: 'install', ok: false, hash: installedHash(failed.deps.pluginRoot), reported: true, reason: 'boom' } });
  assert.equal(await ex(failed), setupFailed('boom'), 'a failed setup that will not retry says so');
  assert.equal(await sessionStart(failed.deps), null, 'while a session start stays quiet about it');

  const nonWin = world();
  assert.equal(await ex(nonWin, { platform: 'linux' }), NOT_WINDOWS);
  assert.equal(await ex(nonWin, { platform: 'linux' }), NOT_WINDOWS, 'every time, not just once');
  assert.equal(await ex(world(), { localAppData: '' }), setupFailed('this PC has no LOCALAPPDATA folder'));
});
