import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

// THE FIRST TESTS THAT RUN app.js's ACTUAL LOGIC (T104 step 3).
//
// agent/test/app-import.test.js proved the file can be EXECUTED. This proves
// three of its functions BEHAVE - the three T104 names, chosen because each has
// already produced a HIGH finding and each was only ever read-traced.
//
// ponytail: SIXTH hand-rolled new-Function slice loader. There are 58 of these
// spread across five test files and this one duplicates the pattern rather than
// sharing it - deliberate, owner-directed 2026-09-06: "The loader is CLEANUP.
// The three tests are SAFETY. Bundling them blocks the safety work behind a
// five-file refactor, in a repo that just spent 11 rounds demonstrating that
// large diffs attract findings." UPGRADE PATH: T104 step 2 collapses all 59 into
// one shared loader (agent/test/settings.test.js's loadOpenPickerFromShared is
// the model to copy). Do that as its own task, never bundled with a behaviour
// change. Until then this file is ugly on purpose and must not grow a helper.
//
// WHY SLICES AND NOT AN IMPORT: app.js exports only SHELL_VERSION. Exporting its
// internals to make them reachable would be a refactor of the file under test,
// which is exactly the diff-inflating move the note above rejects.
const APP = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

/** The source of one top-level function, from its declaration to the next. */
function slice(fromDecl, toDecl) {
  const a = APP.indexOf(fromDecl);
  const b = APP.indexOf(toDecl);
  assert.ok(a !== -1, `slice start not found: ${fromDecl}`);
  assert.ok(b > a, `slice end not found after start: ${toDecl}`);
  return APP.slice(a, b);
}

// --------------------------------------------------------------- onPopState

function loadOnPopState({ sheetPushed = false, subs = [], screen = 'list',
                          drill = false, openFolder = null, confirmName = null } = {}) {
  const calls = [];
  const state = { screen, openFolder, confirmName };
  const SETTINGS_SUBS = new Set(['shared', 'passcode', 'see', 'agent', 'reset', 'about', 'update', 'root']);
  // currentSub() must read the SAME array the slice mutates, not a copy, or the
  // parent it reports is one pop stale. Bound through this holder after
  // construction, because the array is declared inside the Function body.
  const live = {};
  const fn = new Function(
    'closeSheetHard', 'SETTINGS_SUBS', 'state', 'currentSub', 'showScreen',
    'renderSettings', 'renderSettingsSub', 'render', 'history', 'calls',
    `let sheetPushed = ${sheetPushed};
     const settingsSubs = ${JSON.stringify(subs)};
     let closingSub = true, settingsPushed = true, confirmPushed = true, folderPushed = true;
     ${slice('function onPopState()', 'function endTargetFor(')}
     return { onPopState, settingsSubs,
              flags: () => ({ sheetPushed, closingSub, settingsPushed, confirmPushed, folderPushed }) };`,
  );
  const mod = fn(
    () => calls.push('closeSheetHard'),
    SETTINGS_SUBS, state,
    () => (live.subs.length ? live.subs[live.subs.length - 1] : null),
    (name, dir) => calls.push(`showScreen:${name}:${dir}`),
    () => calls.push('renderSettings'),
    (k) => calls.push(`renderSettingsSub:${k}`),
    () => calls.push('render'),
    { state: drill ? { drill: true } : null },
    calls,
  );
  live.subs = mod.settingsSubs;
  return { ...mod, calls, state };
}

test('onPopState: the sheet is checked BEFORE the settings branch, and a sub-pop lifts exactly one entry', () => {
  // RED WHEN: the sheetPushed branch is moved below the settings branch. Then a
  // sheet opened on top of About has its own pop read by the settings branch,
  // which pops About out from under the owner - the bug the comment on that
  // branch describes. Checked with BOTH conditions true at once, which is the
  // only arrangement that can tell the two orderings apart.
  const sheet = loadOnPopState({ sheetPushed: true, subs: ['about'], screen: 'about' });
  sheet.onPopState();
  assert.deepEqual(sheet.calls, ['closeSheetHard'], 'the sheet closes and nothing else runs');
  assert.deepEqual(sheet.settingsSubs, ['about'], 'the settings stack must be untouched');

  // ONE ENTRY PER POP: About -> Update lands back on About, not on the settings
  // root, which is what the crumb promises.
  // RED WHEN: the branch clears the whole stack instead of popping one.
  const deep = loadOnPopState({ subs: ['about', 'update'], screen: 'update' });
  deep.onPopState();
  assert.deepEqual(deep.settingsSubs, ['about'], 'exactly one entry comes off');
  assert.deepEqual(deep.calls, ['showScreen:about:back', 'renderSettingsSub:about'],
    'it lands back on About and repaints it as a sub-screen, not as the settings root');
});

// ------------------------------------------------------------ openRootEditor

function loadOpenRootEditor({ sharedAtOpen, nullDuringFetch = false, folders = ['a', 'b'] } = {}) {
  const calls = [];
  const msg = { textContent: '' };
  const state = { shared: sharedAtOpen, projects: [] };
  const fn = new Function(
    'sharedFolderRows', 'state', 'openSettingsSub', 'document', 'getFolders',
    'shareErrorMessage', 'rootEditRows', 'runningProjectNames', 'renderRootEditor', 'calls',
    `let rootEdit = null;
     ${slice('async function openRootEditor(', 'function renderRootEditor(')}
     return { openRootEditor, rootEdit: () => rootEdit };`,
  );
  const mod = fn(
    () => [{ path: 'F:/Dev/Projects/Repos', name: 'Repos' }],
    state,
    (k) => calls.push(`openSettingsSub:${k}`),
    { getElementById: () => msg },
    async () => {
      // THE BLIP, mid-flight: a visibilitychange whose failing acknowledge leg
      // nulls the set while the listing is still in the air.
      if (nullDuringFetch) state.shared = null;
      return { ok: true, status: 200, data: { folders } };
    },
    () => ({ text: 'err' }),
    (f) => f.map((n) => ({ name: n, ticked: true })),
    () => [],
    () => calls.push('renderRootEditor'),
    calls,
  );
  return { ...mod, calls, msg, state };
}

test('openRootEditor: a set that goes unknown mid-fetch leaves SAVE disabled instead of painting every child ticked', async () => {
  // THE DATA-CORRUPTION FAMILY, at this door: "a null or unknown value coerced
  // into a confident one". `(state.shared || [])` here meant "we do not know
  // what is shared" rendered as "nothing is excluded", so every child painted
  // TICKED - a selection that was never real - and saving it re-shared every
  // folder the owner had deliberately excluded.
  //
  // The set is KNOWN when the editor opens and goes null DURING the await. That
  // ordering is the whole point: the write-side guard is evaluated later against
  // the THEN-current set, so it does not cover this door.
  // RED WHEN: the Array.isArray guard is removed or weakened back to `|| []`.
  const blip = loadOpenRootEditor({
    sharedAtOpen: [{ path: 'F:/Dev/Projects/Repos', excludes: [] }],
    nullDuringFetch: true,
  });
  await blip.openRootEditor('F:/Dev/Projects/Repos');
  assert.equal(blip.rootEdit().rows, null, 'rows must stay null - renderRootEditor gates SAVE on it');
  assert.match(blip.msg.textContent, /^Lost track of your shared folders/);
  assert.ok(blip.calls.includes('renderRootEditor'),
    'the refusal must still repaint, or the screen keeps saying "Reading the folder..."');

  // POSITIVE CONTROL: with the set intact the same path DOES build rows, so the
  // assertion above is about the guard and not about a harness that never works.
  const ok = loadOpenRootEditor({ sharedAtOpen: [{ path: 'F:/Dev/Projects/Repos', excludes: [] }] });
  await ok.openRootEditor('F:/Dev/Projects/Repos');
  assert.equal(ok.rootEdit().rows.length, 2, 'a known set builds rows normally');
  assert.equal(ok.msg.textContent, '');
});

// ------------------------------------------------------------- ensureAccepted

function loadEnsureAccepted({ sharedFromAgent = [], nullDuringAccept = false } = {}) {
  const calls = [];
  const picker = { hidden: false };
  const state = { shared: undefined };
  const fn = new Function(
    'document', 'getAcknowledged', 'state', 'screenAfterUnlock', 'showAccept',
    'share', 'showFolders', 'sharedToTicks', 'showScreen', 'calls',
    `const pendingFolders = null;
     ${slice('async function ensureAccepted()', 'function showAccept()')}
     return { ensureAccepted };`,
  );
  const mod = fn(
    { getElementById: () => picker },
    async () => ({ ok: true, status: 200, data: { shared_folders: sharedFromAgent } }),
    state,
    () => 'accept',                       // a genuine first run
    async () => {
      // THE OWNER-PACED WINDOW. A visibilitychange here runs load(), whose
      // failing acknowledge leg nulls the set.
      if (nullDuringAccept) state.shared = null;
      calls.push('showAccept');
    },
    { ticks: [] },
    async (ticks) => calls.push(`picker:${JSON.stringify(ticks)}`),
    (s) => s.map((r) => ({ path: r.path })),
    (n) => calls.push(`showScreen:${n}`),
    calls,
  );
  return { ...mod, calls, picker, state };
}

test('ensureAccepted: a genuine first run still opens the picker when the set is nulled during the accept screen', async () => {
  // TWO READS OF A MUTABLE VALUE EITHER SIDE OF AN AWAIT was the bug; one read
  // is the fix. `await showAccept()` is unbounded and owner-paced, so a
  // visibilitychange inside it nulls state.shared - and re-reading it afterwards
  // made a GENUINE first run skip the picker and land on an empty list, with
  // CHOOSE FOLDERS also a no-op because it refuses a null set too. No way in
  // until a load() succeeded.
  // RED WHEN: the knownShared snapshot is dropped and state.shared is re-read.
  const blip = loadEnsureAccepted({ sharedFromAgent: [], nullDuringAccept: true });
  await blip.ensureAccepted();
  assert.ok(blip.calls.includes('showAccept'), 'the acknowledgement gate must still run');
  assert.ok(blip.calls.includes('picker:[]'),
    `the picker must open from the SNAPSHOT taken before the await, got ${JSON.stringify(blip.calls)}`);
  assert.equal(blip.picker.hidden, false, 'the list is revealed afterwards either way');

  // NEGATIVE CONTROL, and the reason the snapshot is not simply "always open":
  // when the set was NEVER known the picker must stay shut and fall through to
  // the list, where load() reports the agent unreachable - which is the truth.
  const unknown = loadEnsureAccepted({ sharedFromAgent: null });
  await unknown.ensureAccepted();
  assert.ok(!unknown.calls.some((c) => c.startsWith('picker:')),
    'an unknown set must never open the picker blind');
});
