import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// THE FIRST TEST THAT EXECUTES agent/public/app.js (T104).
//
// Every other assertion about that file in this suite is
// read('app.js').includes(...) over SOURCE TEXT. That is why three tests were
// found pinning bugs rather than catching them, and why most review findings in
// it are read-traced rather than mutation-proved: nothing ran it.
//
// This runs it. import() evaluates all 4184 lines - every declaration, every
// module-level initialiser - and resolves all six sibling modules it imports
// from. Nothing else in the suite would notice if folders-ui.js stopped
// exporting a name app.js imports, or if a bad edit left the file unparseable;
// the app would simply be dead in the browser with a green suite behind it.
//
// It is deliberately NOT a fake DOM and NOT a suite. It is the enabler: the
// module is importable now, so the executable tests T104 actually wants -
// ensureAccepted, openRootEditor, the onPopState machine - have somewhere to
// stand. Do not grow this file into that; give them their own.
const APP = new URL('../public/app.js', import.meta.url).href; // a file:// URL - a bare Windows path is not importable

test('app.js executes under node, and its sibling imports all resolve', async () => {
  const app = await import('../public/app.js');
  assert.equal(typeof app.SHELL_VERSION, 'string');
  assert.match(app.SHELL_VERSION, /^\d+\.\d+\.\d+$/);
});

// THE GUARD THE TEST ABOVE STANDS ON. app.js ends in boot().finally(hideSplash)
// and registers two window listeners at module scope; IN_BROWSER guards all
// three. Without it, importing the module STARTS THE APP - boot() reaches
// showScreen('gate'), document is undefined, and hideSplash throws in the
// .finally.
//
// A CHILD PROCESS, and that is the whole point. Measured: inside `node --test`
// that throw lands AFTER the importing test has resolved, so the runner reports
// it as an unhandledRejection diagnostic and the import test above still passes.
// A separate process has nothing to swallow it and exits 1. Mutation-proved -
// delete any of the three IN_BROWSER guards and this goes red, which is the only
// thing holding the door open for every future executable test of app.js.
test('importing app.js does not start the app', () => {
  const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(APP)})`], { encoding: 'utf8' });
  assert.equal(r.status, 0, `importing app.js exited ${r.status}:
${String(r.stderr).trim().slice(0, 400)}`);
});
