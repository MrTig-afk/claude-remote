import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// T28's whole claim is that a session launched with
// { detached: true, stdio: 'ignore', windowsHide: true } outlives the
// process that spawned it. The suite is (correctly) forbidden from ever
// starting a real `claude` session, so this proves the MECHANISM instead:
// spawn a harmless long-lived process with the exact same options object
// launchSession uses, kill the process that spawned it, and confirm the
// child is still alive. If this ever fails, launchSession's detachment
// claim is false regardless of anything sessions.test.js says.

// R12.1 - AND THIS ONE ACTUALLY RUNS THE LAUNCHER.
//
// Every other assertion about launch-session.ps1 in this file reads its SOURCE
// and checks a token is present. That is how five UI designs shipped green
// this week against code that could not work, and T104 is the standing task
// about it. This one executes the script and looks at what it DID.
//
// What it proves: a pre_launch_command that throws stops the launcher dead.
// The reason is written to the .err, no pid file appears, and execution never
// reaches Start-Process. Before R12.1 the catch fell straight through and
// started the session anyway - which is the state Artifact sequence 7 deleted
// after five refuted attempts at drawing it.
test('R12.1 - a failed pre-launch command STOPS the launcher before Start-Process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-r121-'));
  const pidFile = path.join(dir, 'session.pid');
  const ps1 = fileURLToPath(new URL('../launch-session.ps1', import.meta.url));

  // PATH IS NEUTERED DELIBERATELY. This suite is forbidden from ever starting
  // a real `claude` session (see the note at the top of this file), and the
  // whole claim under test is that the launcher stops BEFORE Start-Process -
  // so if the guard is ever removed, the script would run on and try to start
  // one. With claude.cmd unreachable it cannot, whatever the script does, and
  // the regression surfaces as the last assertion rather than as a stray
  // session on somebody's machine.
  // ABSOLUTE PATH to the shell, because PATH below is neutered and
  // powershell.exe lives in a SUBDIRECTORY of System32 - resolving it by name
  // fails with status null, which is a spawn error and not a script result.
  const shell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  const r = spawnSync(shell, [
    '-NoProfile', '-NonInteractive', '-File', ps1,
    '-ProjectPath', dir,
    '-SessionName', 'r121',
    '-PidFile', pidFile,
    // No quotes in the value, so nothing depends on how Node quotes argv on
    // Windows - and the message this produces is the real-world shape:
    // "The term '...' is not recognized", capitalised, with no trailing stop.
    '-PreLaunch', 'definitely-not-a-real-command-xyz',
  ], { encoding: 'utf8', env: { ...process.env, PATH: 'C:\\Windows\\System32' } });

  assert.equal(r.status, 1, 'the launcher must exit non-zero, not carry on');

  const errFile = `${pidFile}.err`;
  assert.equal(fs.existsSync(errFile), true, 'the reason is the only thing the phone will ever get');
  const reason = fs.readFileSync(errFile, 'utf8');
  assert.match(reason, /definitely-not-a-real-command-xyz/, 'the .err must name what failed');
  assert.match(reason, /not recognized/i);

  assert.equal(fs.existsSync(pidFile), false, 'no pid file - nothing was started');

  // THE DISCRIMINATOR. Remove the `exit 1` and the script runs on to
  // Start-Process, which then fails to resolve claude.cmd and says so on
  // stderr. Matching `claude.cmd` rather than `claude` on purpose: this
  // script's own path contains "claude-remote" and turns up in PowerShell
  // error output.
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.doesNotMatch(out, /claude\.cmd/i, 'the launcher reached Start-Process - the R12.1 guard is gone');

  fs.rmSync(dir, { recursive: true, force: true });
});

// Runs the REAL launcher and reports what it did. Every test below drives
// this rather than reading the script's source.
//
// PATH IS NEUTERED, and USERPROFILE/LOCALAPPDATA are redirected at a scratch
// directory. Two separate reasons:
//   - PATH: this suite is forbidden from ever starting a real `claude`
//     session, and several of these tests assert the launcher stops BEFORE it
//     would. If a guard is ever removed the script must still be unable to
//     start one.
//   - USERPROFILE/LOCALAPPDATA: the conda search reads them, so redirecting
//     makes "conda is not installed" true for the test regardless of what is
//     on the machine running it. `C:\\ProgramData` is searched too and cannot
//     be redirected - absent on this host, checked 2026-09-12 - so a machine
//     with a ProgramData conda would take the activate path instead. The
//     assertions below are written to hold either way: what they claim is
//     that the launcher REFUSES, not which sentence it refuses with.
function runLauncher(dir, args) {
  const shell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  const ps1 = fileURLToPath(new URL('../launch-session.ps1', import.meta.url));
  const pidFile = path.join(dir, 'session.pid');
  const r = spawnSync(shell, [
    '-NoProfile', '-NonInteractive', '-File', ps1,
    '-ProjectPath', dir,
    '-SessionName', 'probe',
    '-PidFile', pidFile,
    ...args,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: 'C:\\Windows\\System32',
      USERPROFILE: path.join(dir, 'no-home'),
      LOCALAPPDATA: path.join(dir, 'no-appdata'),
    },
  });
  const errFile = `${pidFile}.err`;
  return {
    status: r.status,
    out: `${r.stdout || ''}${r.stderr || ''}`,
    pidFileExists: fs.existsSync(pidFile),
    errExists: fs.existsSync(errFile),
    // BOM STRIPPED. PowerShell 5.1's `Set-Content -Encoding utf8` writes a
    // byte-order mark, so the reason starts with U+FEFF on disk and any
    // assertion anchored with ^ fails for a reason that has nothing to do
    // with what is being tested. readErrFile (registry.js) strips it in
    // production for the same reason; this keeps the test seeing what the
    // phone sees.
    reason: fs.existsSync(errFile)
      ? fs.readFileSync(errFile, 'utf8').replace(/^﻿/, '')
      : null,
  };
}

function project() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cr-env-'));
}

test('R12 - environment.yml with no `name:` refuses the launch and says which', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'environment.yml'), 'dependencies:\n  - python=3.12\n');

  const r = runLauncher(dir, []);
  assert.equal(r.status, 1);
  assert.equal(r.pidFileExists, false, 'nothing may be started');
  assert.match(r.reason, /name:/, 'the reason must say what is missing from the file');
  assert.doesNotMatch(r.out, /claude\.cmd/i, 'it must not have reached Start-Process');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('R12 - a conda project on a machine with no conda refuses, and says THAT', () => {
  // PRECONDITION, ASSERTED NOT ASSUMED. runLauncher redirects USERPROFILE and
  // LOCALAPPDATA into a scratch directory, so four of the six roots the
  // launcher searches are empty by construction. The two ProgramData roots are
  // absolute and cannot be redirected, so they are checked here. This FAILS
  // rather than skips if conda is installed there: a skipped guard is a green
  // run, and the exact message below is the thing under test.
  for (const root of ['C:\\ProgramData\\miniconda3', 'C:\\ProgramData\\anaconda3']) {
    assert.equal(
      fs.existsSync(path.join(root, 'shell', 'condabin', 'conda-hook.ps1')), false,
      `this test needs no conda at ${root}; with one installed there the launcher would take the activate path instead`,
    );
  }

  const dir = project();
  fs.writeFileSync(path.join(dir, 'environment.yml'), 'name: nutrition-de\ndependencies: []\n');

  const r = runLauncher(dir, []);
  assert.equal(r.status, 1);
  assert.equal(r.pidFileExists, false, 'nothing may be started');
  assert.equal(r.errExists, true, 'a refusal without a reason is the failure this feature exists to remove');
  assert.match(r.reason, /nutrition-de/, 'a phone shows nothing but this line, so it must name the environment');
  // THE EXACT DIAGNOSIS, not merely "it refused". Deleting the no-conda guard
  // still refuses - `. $null` throws and the catch below it turns that into
  // "could not activate" - so an assertion that only checked for a refusal
  // passed against the deleted guard. Measured: that mutation survived until
  // this line existed. What breaks is the OWNER'S ability to tell "conda is
  // not installed" from "your environment is broken", which are different
  // jobs to do in the morning.
  assert.match(r.reason, /no conda installation was found/i);
  assert.doesNotMatch(r.out, /claude\.cmd/i);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('R12 - an unset USERPROFILE refuses cleanly instead of dying silently', () => {
  // F13-C03. The conda roots were one @(...) literal, which PowerShell
  // evaluates ENTIRELY before the loop body runs - so a single unset
  // USERPROFILE made Join-Path raise a terminating
  // ParameterBindingValidationException and killed the launcher with no .err
  // at all. The agent runs as a scheduled task, where neither USERPROFILE nor
  // LOCALAPPDATA is guaranteed to be present.
  const dir = project();
  fs.writeFileSync(path.join(dir, 'environment.yml'), 'name: needs-conda\n');

  const shell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  const ps1 = fileURLToPath(new URL('../launch-session.ps1', import.meta.url));
  const pidFile = path.join(dir, 'session.pid');
  // EMPTIED, NOT DELETED, and the difference is the whole test. `delete
  // env.USERPROFILE` does NOT reach PowerShell - Windows repopulates it, and
  // this test passed for that reason alone while proving nothing (measured
  // 2026-09-12: the child reported `USERPROFILE STILL SET: C:\\Users\\...`).
  // An empty string does arrive empty, and `Join-Path '' x` throws exactly as
  // a null one does, which is the terminating error the fix exists to avoid.
  const env = {
    ...process.env,
    PATH: 'C:\\Windows\\System32',
    LOCALAPPDATA: path.join(dir, 'no-appdata'),
    USERPROFILE: '',
  };

  const r = spawnSync(shell, [
    '-NoProfile', '-NonInteractive', '-File', ps1,
    '-ProjectPath', dir, '-SessionName', 'probe', '-PidFile', pidFile,
  ], { encoding: 'utf8', env });

  assert.equal(r.status, 1);
  assert.equal(fs.existsSync(`${pidFile}.err`), true, 'it must refuse WITH a reason, not just die');
  assert.match(fs.readFileSync(`${pidFile}.err`, 'utf8'), /needs-conda/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('R12 - the name is parsed as YAML means it, not as the old regex did', () => {
  // F13-C04. The first version was `^\\s*name:\\s*([^\\s#]+)` with PowerShell's
  // case-INSENSITIVE -match. Measured against real files, it produced `"my`
  // for `name: "my env"` - truncated at the space, opening quote kept - and it
  // matched `NAME:`, which YAML does not, and a `name:` indented under another
  // key in preference to the real top-level one.
  const dir = project();
  fs.writeFileSync(path.join(dir, 'environment.yml'), 'name: "my env"  # the one to use\n');

  const r = runLauncher(dir, []);
  assert.equal(r.status, 1);
  // No conda here, so the refusal quotes the name it parsed - which is what
  // makes the parse observable at all.
  assert.match(r.reason, /^my env is a conda environment/,
    'quotes stripped, trailing comment dropped, and NOT truncated at the space');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('R12 - an UPPERCASE NAME: is not a YAML name key, and is not treated as one', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'environment.yml'), 'NAME: shouty\n');

  const r = runLauncher(dir, []);
  assert.equal(r.status, 1);
  assert.match(r.reason, /no top-level 'name:'/, 'YAML keys are case-sensitive; -match was not');
  assert.doesNotMatch(r.reason, /shouty/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('R12 - an UNREADABLE environment.yml says so, instead of blaming the file for having no name', () => {
  // F13-C05. -ErrorAction SilentlyContinue turned every read fault into
  // `$envName = $null`, so a locked or unreadable file told the owner it had
  // no `name:` - sending them to fix the wrong thing. A DIRECTORY by that name
  // is the cheapest reliable unreadable file on Windows.
  const dir = project();
  fs.mkdirSync(path.join(dir, 'environment.yml'));

  const r = runLauncher(dir, []);
  assert.equal(r.status, 1);
  assert.match(r.reason, /could not read this project's environment\.yml/);
  assert.doesNotMatch(r.reason, /no top-level/, 'that is a different fault with a different fix');

  fs.rmSync(dir, { recursive: true, force: true });
});

// STANDING CONDA IN, so the activation guard is reachable at all.
//
// runLauncher points USERPROFILE at `<dir>/no-home`, and that is the FIRST root
// the launcher searches - so a hook placed there wins over any real conda on
// the machine, and these two tests are deterministic everywhere.
//
// This is not a mock of the thing under test. conda's real conda-hook.ps1 is
// itself just a PowerShell script that defines a `conda` function; what is
// stood in here is conda, not the launcher, and the launcher runs untouched.
function fakeConda(dir, body) {
  const hookDir = path.join(dir, 'no-home', 'miniconda3', 'shell', 'condabin');
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, 'conda-hook.ps1'), body);
}

test('R12.1 - conda that does NOT enter the environment refuses the launch', () => {
  // F13-C01, THE CRITICAL ONE, and the reason a try/catch could never catch it:
  // a native command exiting non-zero raises no terminating error even under
  // $ErrorActionPreference = 'Stop' (measured on this host 2026-09-12), and
  // conda's own activate Invoke-Expressions an EMPTY string when the
  // environment does not exist - so nothing is thrown at all. This conda
  // "succeeds" loudly and enters nothing, which is exactly that shape.
  const dir = project();
  fs.writeFileSync(path.join(dir, 'environment.yml'), 'name: never-created\n');
  fakeConda(dir, 'function conda { }\n');

  const r = runLauncher(dir, []);
  assert.equal(r.status, 1, 'a session in the WRONG environment is the state Artifact sequence 7 deleted');
  assert.equal(r.errExists, true);
  assert.match(r.reason, /could not enter the conda environment 'never-created'/);
  assert.equal(r.pidFileExists, false);
  assert.doesNotMatch(r.out, /claude\.cmd/i, 'it must not have reached Start-Process');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('R12 - conda that DOES enter the environment lets the launch proceed', () => {
  // THE POSITIVE CONTROL. The two differ in one thing only: whether conda
  // actually set CONDA_DEFAULT_ENV. Without this, the assertion above would
  // also pass against a launcher that refused every conda project outright.
  const dir = project();
  fs.writeFileSync(path.join(dir, 'environment.yml'), 'name: really-there\n');
  fakeConda(dir, "function conda { if ($args[0] -eq 'activate') { $env:CONDA_DEFAULT_ENV = $args[1] } }\n");

  const r = runLauncher(dir, []);
  // No .err at all: Write-LaunchRefusal is the only thing that writes it, so
  // its absence proves the environment step completed and the script ran on -
  // then failed at Start-Process, because PATH makes claude.cmd unreachable.
  assert.equal(r.errExists, false, 'a working activation must not be refused');
  assert.equal(r.pidFileExists, false, 'and claude.cmd is deliberately unreachable, so nothing started');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('R12.1 - a conda hook that defines no `conda` refuses WITH a reason', () => {
  // F14-D2-C02. Round 1 replaced the try/catch with a post-condition; round 2
  // showed the post-condition is NECESSARY BUT NOT SUFFICIENT. A non-zero exit
  // is not terminating, but a command-RESOLUTION failure is - a hook that loads
  // cleanly and defines no `conda` (a partial install, or a conda whose
  // CONDA_EXE is unset) throws CommandNotFoundException. Unguarded that killed
  // the script with no .err at all, which is the reasonless failure R12.1
  // exists to abolish.
  const dir = project();
  fs.writeFileSync(path.join(dir, 'environment.yml'), 'name: half-installed\n');
  fakeConda(dir, '# a hook that loads fine and defines nothing\n');

  const r = runLauncher(dir, []);
  assert.equal(r.status, 1);
  assert.equal(r.errExists, true, 'a refusal with no reason is the whole failure mode');
  assert.match(r.reason, /could not run conda activate for 'half-installed'/);
  assert.equal(r.pidFileExists, false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('R12 - a `name:` with an empty or comment-only value is treated as absent', () => {
  // F14-D2-C03. `(.+?)` captures whitespace and a single space is TRUTHY in
  // PowerShell, so `name: ` sailed past the empty check and the owner was told
  // their machine had no conda - about an environment called "". A comment-only
  // value was worse: the comment became the name.
  for (const body of ['name: \n', 'name:\t\n', 'name: # todo pick one\n']) {
    const dir = project();
    fs.writeFileSync(path.join(dir, 'environment.yml'), body);

    const r = runLauncher(dir, []);
    assert.equal(r.status, 1);
    assert.match(r.reason, /no top-level 'name:'/, `should read as absent: ${JSON.stringify(body)}`);
    assert.doesNotMatch(r.reason, /no conda installation/, 'that accuses the machine of the wrong fault');

    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R12.1 - a BROKEN venv activate refuses the launch with a reason', () => {
  // F13-C02. `. $activate` sat outside any try/catch, so with
  // $ErrorActionPreference = 'Stop' a broken Activate.ps1 - a stale
  // pyvenv.cfg, a moved interpreter, a venv copied from another machine -
  // killed the script with NO .err at all. The registry then showed
  // `starting` for the full grace window and `failed` with nothing to show,
  // on the branch that runs for every project that is not configured.
  const dir = project();
  fs.mkdirSync(path.join(dir, 'venv', 'Scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'venv', 'Scripts', 'Activate.ps1'), "throw 'this venv is broken'\n");

  const r = runLauncher(dir, []);
  assert.equal(r.status, 1);
  assert.equal(r.errExists, true, 'a refusal with no reason is the failure R12.1 exists to abolish');
  assert.match(r.reason, /this venv is broken/, 'the underlying error has to reach the phone');
  assert.equal(r.pidFileExists, false);
  assert.doesNotMatch(r.out, /claude\.cmd/i);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('R12 - a venv WINS over environment.yml, and the launch gets past the environment step', () => {
  // SAME PRECONDITION AS THE CONDA TEST, and for the same reason. This proves
  // the venv branch won from the ABSENCE of a .err - but on a host with conda
  // at ProgramData the conda branch would run, fail to activate
  // `should-not-be-used`, and now write a .err, so the assertion would still
  // be meaningful. Asserted anyway so the discriminator is not silently
  // resting on which machine happens to run it.
  for (const root of ['C:\\ProgramData\\miniconda3', 'C:\\ProgramData\\anaconda3']) {
    assert.equal(
      fs.existsSync(path.join(root, 'shell', 'condabin', 'conda-hook.ps1')), false,
      `this test needs no conda at ${root}`,
    );
  }
  const dir = project();
  // An empty Activate.ps1 is dot-sourceable and does nothing, which is exactly
  // what this needs: the claim is about which branch runs, not about venv.
  fs.mkdirSync(path.join(dir, 'venv', 'Scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'venv', 'Scripts', 'Activate.ps1'), '');
  fs.writeFileSync(path.join(dir, 'environment.yml'), 'name: should-not-be-used\n');

  const r = runLauncher(dir, []);
  // THE DISCRIMINATOR: no .err at all. Write-LaunchRefusal is the only thing that
  // writes that file, so its absence proves the environment step completed and
  // the script ran on - it then fails at Start-Process, because PATH above
  // makes claude.cmd unreachable on purpose.
  assert.equal(r.errExists, false, 'the venv branch must have won - a .err means it tried conda');
  assert.equal(r.pidFileExists, false, 'and claude.cmd is deliberately unreachable, so nothing started');

  fs.rmSync(dir, { recursive: true, force: true });
});

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
    // GUARD: on Windows process.kill(0) terminates the CALLING process. On the
    // failure path grandchildPid is still 0, so an unguarded kill here killed
    // the test runner itself - erasing the assertion message, skipping the
    // rest of the file, and orphaning the sleeper. The suite went red with no
    // stated reason. Found in review 2026-08-26.
    if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
      try { process.kill(grandchildPid); } catch { /* already gone */ }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('recipe-integrity check has teeth - mutated copies fail the same assertions', () => {
  const real = fs.readFileSync(
    path.join(path.resolve(import.meta.dirname, '..'), 'launch-session.ps1'),
    'utf8',
  );

  // COMMENTS ARE STRIPPED BEFORE EVERY TOKEN CHECK BELOW, and the reason is
  // recorded two entries down: the `.claude-max` token once survived ONLY
  // inside the comment explaining its own removal, so a raw includes() passed
  // while the CODE had lost it - an assertion quietly requiring the opposite of
  // the truth. That is not hypothetical for the tokens added here: the
  // opening-report change ships a 13-line comment block on the same subject.
  // ONE definition, reused by the token checks, the --channels assertion AND
  // the proofs at the end. They used to each re-implement it, which made the
  // proofs worthless: review demonstrated it by replacing only the real check's
  // strip with one that can never fail, and the "proofs" still reported 2/2
  // pass. A proof that does not exercise the thing it proves is decoration.
  const stripPsComments = (src) => src.replace(/^\s*#.*$/gm, '');
  const carriesChannels = (src) => /--channels/.test(stripPsComments(src));

  const requiredTokens = [
    'CLAUDE_CONFIG_DIR',
    // NOT `.claude-max`. That entry lived here until T56 (2026-09-05) and had
    // become actively harmful: the recipe no longer hardcodes a personal
    // profile, so the token survived ONLY inside the comment explaining its own
    // removal. That made this assertion (a) require the opposite of what T56
    // established, and (b) a trap - rewording that comment turned the suite red
    // with "real recipe should contain .claude-max", sending the reader after a
    // regression that does not exist.
    // What is actually required now is the CONDITIONAL, which is the whole
    // behaviour: set the variable only when a profile was passed in.
    'if ($ConfigDir)',
    '$env:CLAUDE_CONFIG_DIR = $ConfigDir',
    // The ELSE half, and it needs pinning as much as the if: Start-Process
    // inherits this process's environment, and the owner's own shell exports
    // CLAUDE_CONFIG_DIR (the claudemax alias / PowerShell profile). Without the
    // clear, a launch with no configured profile silently inherits that one and
    // can land on a workspace-trust modal nobody can answer from a phone.
    // Review deleted this block and the whole suite stayed green - hence this.
    'Remove-Item Env:CLAUDE_CONFIG_DIR',
    // The pre-launch branch, BOTH halves, for the same reason the ConfigDir
    // conditional above is pinned rather than the bare variable: the behaviour
    // is the choice between them. Losing the `if` would run a configured
    // command AND the auto-detect; losing the `else` would silently drop venv
    // activation for every existing install, which is the regression that
    // matters because nothing about it is visible from a phone.
    'if ($PreLaunch)',
    // THE WHOLE try/catch, not the bare Invoke-Expression, and for the reason
    // the --remote-control entry below spells out. $ErrorActionPreference is
    // 'Stop', so without the catch a failing pre_launch_command aborts the
    // launcher BEFORE Start-Process: no session, no pid file, and nothing
    // visible from the phone. Pinning only the call would let the guard be
    // deleted with the suite green.
    // BOTH halves, because the comment above is not decoration. When the code
    // went multi-line this was weakened to the bare call, which unpinned the
    // catch - `catch` -> `finally`, or moving the .err write out, would have
    // left the suite green while $ErrorActionPreference = 'Stop' aborted the
    // launcher before Start-Process. Caught in review, restored here.
    'Invoke-Expression $PreLaunch',
    // THIS EXACT LINE, and it took three attempts to get a token that bites.
    // `'} catch {'` also matched the inner catch on the Set-Content line;
    // `'$preLaunchFailure = $_'` on its own line survived a catch->finally
    // mutation because the assignment lives on happily inside a finally. Both
    // were MUTATED and both stayed green. Only the catch keyword and the
    // capture together are unique to the outer guard.
    '} catch { $preLaunchFailure = $_',
    // The .err file is the ONLY observable a failed pre_launch_command has.
    // Write-Warning goes to a stream the agent spawns with stdio:'ignore' and
    // the script is -NonInteractive, so deleting this line makes every
    // failure - a typo, a missing conda hook, a wrong path - indistinguishable
    // from success everywhere. Pinned because nothing else would notice.
    'Set-Content -LiteralPath "$PidFile.err"',
    // The opening-report guard, WHOLE. The `-not` is the load-bearing half:
    // losing it inverts the switch, so every launch would suppress the report
    // instead of only the ones the owner switched off - and a silent session
    // started from a phone is the failure with nothing to diagnose.
    'if (-not $NoOpeningReport -and (Test-Path',
    // The auto-detect must survive INSIDE that else. Pinned as the loop header
    // rather than the whole block so reformatting does not turn the suite red
    // for no regression.
    "foreach ($dir in @('venv', '.venv'))",
    // WHOLE token, not the bare flag, for a bug that actually
    // happened: this entry was the bare flag `'--remote-control'` on
    // 2026-09-04, so changing the argument FORM stripped nothing this list
    // guards and the mutation test below stayed green. A name with a space
    // then splits in two, and the leftover word is typed into the session.
    '"--remote-control=`"$SessionName`""',
    // The opening report, and specifically its APPEND. A phone-launched session
    // has nobody to type the first message, and a SessionStart hook can only
    // add context - never a turn. Pinning the append rather than the variable:
    // building the array and not passing it is the silent-failure shape.
    'Read HANDOFF.md and give the opening report.',
    ') + $openingReport)',
    'Activate.ps1',
    'Start-Process',
    '-LiteralPath',
    '-PassThru',
    '$PidFile',
  ];

  // The real file passes every check - baseline sanity before mutating.
  // Against the CODE, never the raw file: see the note above requiredTokens.
  const realCode = stripPsComments(real);
  for (const token of requiredTokens) {
    assert.ok(realCode.includes(token), `real recipe should contain ${token} IN CODE, not only in a comment`);
  }
  assert.ok(!/--rc/.test(real), 'real recipe should not contain --rc');
  // The channels flag stops Remote Control connecting (measured 2026-09-05:
  // with it the session renders but sits on `/rc connecting...` forever and
  // never reaches the Code tab; without it, nothing else changed, it connects
  // quickly). requiredTokens above cannot express "must be ABSENT", which is
  // why this sits beside it. Comments stripped first - the script's own
  // comment explains this rule and has to name the flag to do so. The strip
  // itself is defined above requiredTokens, because every token check now uses
  // it too.
  assert.ok(
    !carriesChannels(real),
    'the PWA recipe must not pass --channels - it prevents the Code-tab row appearing',
  );

  // THE MUTATION THAT CAN ACTUALLY FAIL. The loop that stood here deleted the
  // token outright - `real.split(token).join('')` - and then asserted the token
  // was absent, which is true BY CONSTRUCTION for any implementation of the
  // check, including one that never strips anything. It called itself proof
  // that "the assertions are not tautologies" while being exactly that, and it
  // survived a remediation pass that touched the line and called it
  // strengthened. Found by review, 2026-09-09; the entry two blocks up records
  // review catching the same class of decoration in this very test once before.
  //
  // COMMENTING THE TOKEN OUT is a real mutation, because it changes only
  // whether the token is CODE. It proves both halves at once, for every token:
  // the token genuinely lives in code rather than prose, AND stripPsComments
  // actually removes commented lines. Replace the strip with `(s) => s` and
  // every iteration goes red, which is what the old loop could never do.
  for (const token of requiredTokens) {
    const commentedOut = real.split('\n')
      .map((line) => (line.includes(token) ? `# ${line}` : line))
      .join('\n');
    assert.equal(
      stripPsComments(commentedOut).includes(token),
      false,
      `commenting out every line holding '${token}' must fail its check - if this passes, either the token is not really required in code or the strip is a no-op`,
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

  // The SAME proof for the --channels absence check, which needs it more: it
  // asserts against a comment-STRIPPED copy, so a later change to that strip
  // (to handle trailing `#`, or PowerShell's `<# #>` blocks) could quietly eat
  // the ArgumentList line and leave the guard unable to fail. The regressed
  // copy adds the flag as real code - not inside a comment - so it must be
  // seen through the strip.
  const channelsBack = `${real}\n    '--channels=plugin:whatsapp-channel@whatsapp-claude-plugin',\n`;
  assert.equal(
    carriesChannels(channelsBack),
    true,
    'a copy that re-adds --channels as CODE must fail the absence check - if this passes, the strip has eaten the line it is meant to scan',
  );
  // ...and the strip must not be so eager that a commented mention trips it,
  // which is the failure that made this strip necessary in the first place.
  const onlyInComment = `${real}\n    # explains why --channels must not be here\n`;
  assert.equal(
    carriesChannels(onlyInComment),
    false,
    'a mention inside a comment must NOT fail the check - the script documents this rule and has to name the flag',
  );
});
