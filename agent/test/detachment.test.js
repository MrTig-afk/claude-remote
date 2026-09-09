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
