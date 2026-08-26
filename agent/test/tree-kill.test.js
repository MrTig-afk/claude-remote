// The ONE test in this suite that touches a real process. Everything else
// uses a fake killSpawner/handoffSpawner; this one exercises the production
// endSession() path against a REAL cmd.exe /c ping tree, with the real
// taskkill and the real isPidAlive, to prove the whole tree - not just the
// pid the agent's own pid file names - actually dies. No Claude Code, no
// launch-session.ps1, no claude.cmd anywhere in this file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { test, after } from 'node:test';

import { deriveSessionName, endSession } from '../sessions.js';
import { recordLaunch, isPidAlive } from '../registry.js';
import { testSessionDirs } from './helper-auth.js';

const perTestDirs = [];
const capturedPids = [];
// Pids the test itself already confirmed dead via waitDead(). Windows
// reuses pids quickly, so a cleanup kill aimed at one of these could hit an
// unrelated process that grabbed the number since - the class of "kill a
// pid I did not spawn" the security review flagged. Only a pid never proven
// dead gets the belt-and-braces cleanup kill.
const provenDeadPids = new Set();

after(() => {
  // Best-effort: if the tree-kill inside the test itself already worked,
  // these are no-ops against pids that no longer exist.
  for (const pid of capturedPids) {
    if (provenDeadPids.has(pid)) continue;
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // already gone - the point of the test
    }
  }
  for (const d of perTestDirs) fs.rmSync(d, { recursive: true, force: true });
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bounded poll (40 x 100ms = 4s ceiling) for the child pid Windows assigns
// under a Win32_Process query - there is no synchronous way to learn it.
async function findChildPid(parentPid) {
  for (let i = 0; i < 40; i += 1) {
    let out;
    try {
      out = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}").ProcessId`,
      ], { encoding: 'utf8' });
    } catch {
      out = '';
    }
    const pid = Number(out.trim().split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0) return pid;
    await sleep(100);
  }
  return null;
}

// Bounded poll (up to 5s) for a pid to actually disappear - /T kills the
// tree, but teardown is not instantaneous. Records confirmed-dead pids so
// after() never aims a cleanup kill at a number Windows may have reused.
async function waitDead(pid) {
  for (let i = 0; i < 50; i += 1) {
    if (!isPidAlive(pid)) {
      provenDeadPids.add(pid);
      return true;
    }
    await sleep(100);
  }
  return false;
}

test(
  'endSession - real tree-kill: both the cmd.exe wrapper and its child die',
  { skip: process.platform !== 'win32' && 'windows only' },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-treekill-'));
    perTestDirs.push(dir);
    const base = path.join(dir, 'base');
    fs.mkdirSync(base, { recursive: true });
    const projectPath = path.join(base, 'ping-project');
    fs.mkdirSync(projectPath);

    const cmdChild = spawn('cmd.exe', ['/c', 'ping', '-n', '60', '127.0.0.1'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const cmdPid = cmdChild.pid;
    capturedPids.push(cmdPid);

    const childPid = await findChildPid(cmdPid);
    assert.ok(Number.isInteger(childPid), 'expected to find ping.exe as a child of the cmd.exe wrapper');
    capturedPids.push(childPid);

    assert.equal(isPidAlive(cmdPid), true, 'precondition: the cmd.exe wrapper must be alive');
    assert.equal(isPidAlive(childPid), true, 'precondition: the ping child must be alive');

    const sessionName = deriveSessionName(projectPath);
    const registryPath = path.join(dir, 'sessions.json');
    const pidDir = path.join(dir, 'session-pids');
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(path.join(pidDir, `${sessionName}.pid`), String(cmdPid), 'ascii');

    const ctx = {
      baseDir: base,
      registryPath,
      pidDir,
      sessionDirs: testSessionDirs(dir),
      now: Date.now,
      // killSpawner and isPidAlive are left at their REAL defaults on purpose
      // - this is the one test allowed to touch a real process. The handoff
      // outcome is irrelevant here, only the tree-kill is under test - the
      // fake runner exits on the next tick so the internal watch settles via
      // the exit path, never the timeout path, which would otherwise spawn a
      // real taskkill against a made-up pid.
      handoffSpawner: () => {
        const child = { pid: 999999, handlers: {}, on(event, fn) { this.handlers[event] = fn; return this; } };
        setImmediate(() => { if (child.handlers.exit) child.handlers.exit(); });
        return child;
      },
      handoffTimeoutMs: 50,
    };

    recordLaunch(ctx, { sessionName, project: 'ping-project', projectPath });

    const result = await endSession(ctx, 'ping-project');

    assert.equal(result.ok, true);
    assert.equal(result.body.result, 'handoff_started');

    assert.equal(await waitDead(cmdPid), true, 'the cmd.exe wrapper must be dead');
    assert.equal(await waitDead(childPid), true, 'the ping child must be dead too - not just the parent');
  },
);
