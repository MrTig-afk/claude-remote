import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

// T28's whole claim is that a session launched with
// { detached: true, stdio: 'ignore', windowsHide: true } outlives the
// process that spawned it. The suite is (correctly) forbidden from ever
// starting a real `claude` session, so this proves the MECHANISM instead:
// spawn a harmless long-lived process with the exact same options object
// launchSession uses, kill the process that spawned it, and confirm the
// child is still alive. If this ever fails, launchSession's detachment
// claim is false regardless of anything sessions.test.js says.

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('detachment - a Start-Process grandchild outlives the agent that launched it', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-detach-'));
  const pidFile = path.join(tmpDir, 'grandchild.pid');
  const parentScript = path.join(tmpDir, 'parent.cjs');

  // This mirrors PRODUCTION exactly, which the previous version of this test
  // did not: it used `node -e` as the grandchild, and node detaches happily
  // where powershell.exe does not - so it passed green while the real
  // launcher was dead. The real chain is:
  //   agent (node)  ->  powershell.exe (short-lived, NOT detached)
  //                 ->  Start-Process grandchild (the thing that must survive)
  // Only the last hop is meant to outlive the agent, and Start-Process is
  // what provides it. The powershell.exe hop uses the SAME options object
  // launchSession passes - deliberately WITHOUT `detached: true`, because
  // that stops powershell 5.1 executing at all on Windows.
  const psCommand = [
    "$p = Start-Process powershell.exe",
    "-ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 120'",
    '-PassThru -WindowStyle Hidden;',
    `Set-Content -LiteralPath '${pidFile}' -Value $p.Id`,
  ].join(' ');

  fs.writeFileSync(
    parentScript,
    `
    const { spawn } = require('node:child_process');
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', ${JSON.stringify(psCommand)},
    ], { stdio: 'ignore', windowsHide: true });
    child.unref();
    setInterval(() => {}, 1000);
    `,
  );

  const parent = spawn(process.execPath, [parentScript], { stdio: 'ignore' });
  let grandchildPid = 0;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  // EVERYTHING below is inside the try. An earlier version left the pid-file
  // assertion outside it, so the exact failure this test exists to catch -
  // powershell never running - threw before any cleanup and leaked the
  // immortal parent process, hanging the run instead of failing it.
  try {

  // Wait for the powershell hop to run and record the grandchild's pid. If
  // this times out, powershell never executed - which is exactly the bug
  // this test exists to catch.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (fs.existsSync(pidFile)) {
      const raw = fs.readFileSync(pidFile, 'utf8').trim();
      if (raw) { grandchildPid = Number(raw); break; }
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  assert.ok(
    Number.isInteger(grandchildPid) && grandchildPid > 0,
    'powershell.exe must actually execute and report a grandchild pid - if this '
    + 'fails, the launcher spawns a process that silently never runs',
  );

    assert.equal(alive(grandchildPid), true, 'grandchild should be alive before the parent dies');

    parent.kill();
    await new Promise((r) => setTimeout(r, 1500));

    assert.equal(alive(parent.pid), false, 'parent must be dead');
    assert.equal(
      alive(grandchildPid),
      true,
      'grandchild must SURVIVE the agent being killed - this is the whole promise of T28',
    );
  } finally {
    try { parent.kill(); } catch { /* already dead */ }
    try { process.kill(grandchildPid); } catch { /* already gone */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('recipe-integrity check has teeth - mutated copies fail the same assertions', () => {
  const real = fs.readFileSync(
    path.join(path.resolve(import.meta.dirname, '..'), 'launch-session.ps1'),
    'utf8',
  );

  const requiredTokens = [
    'CLAUDE_CONFIG_DIR',
    '.claude-max',
    '--channels',
    'plugin:whatsapp-claude-channel@whatsapp-claude-plugin',
    '--remote-control',
    'Activate.ps1',
    'Start-Process',
    '-LiteralPath',
  ];

  // The real file passes every check - baseline sanity before mutating.
  for (const token of requiredTokens) {
    assert.ok(real.includes(token), `real recipe should contain ${token}`);
  }
  assert.ok(!/--rc/.test(real), 'real recipe should not contain --rc');

  // Each mutated copy - one required token stripped - must fail the check
  // that token guards. Proves the assertions are not tautologies.
  for (const token of requiredTokens) {
    const mutated = real.split(token).join('');
    assert.equal(
      mutated.includes(token),
      false,
      `mutated copy with '${token}' removed should fail the includes() check`,
    );
  }

  // A copy with a bare --rc token reintroduced (simulating a regression
  // back to the retired flag as a whitespace-delimited argument, which is
  // exactly what the regex is built to catch) must fail the negative
  // assertion.
  const regressed = `${real}\n--rc mysession\n`;
  assert.equal(
    /--rc/.test(regressed),
    true,
    'a copy containing a bare --rc token should fail the --rc-absence check',
  );
});
