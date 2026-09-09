import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

// The REAL withoutRoot, never a stub. removeRoot's refusal is a contract
// BETWEEN the two functions - "withoutRoot answers null, so removeRoot must not
// write" - and a stub would let the pair drift apart with both sides green.
import { withoutRoot } from '../public/folders-ui.js';

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

// ============================================================================
// FIVE MORE, ADDED 2026-09-09 FROM A MUTATION AUDIT
//
// The M13 sequence remediated 28 findings across two merges and then stopped as
// diverging, leaving "which of those fixes is actually covered" unanswered. It
// was answered mechanically: revert one fix, run the suite, see whether anything
// goes red. Nine of the twenty-one behavioural fixes could be reverted with all
// 1027 tests still green. These are the five of those nine that live in app.js.
//
// Same sixth-slice pattern and the same ponytail note as the three above: ugly
// on purpose, and it must not grow a helper. T104 step 2 collapses every slice
// in the repo into one shared loader, as its own task, never bundled with a
// behaviour change.
// ============================================================================

// ------------------------------------------------------------------- goHome

function loadGoHome({ subs = [], settingsPushed = false, confirmPushed = false,
                      folderPushed = false, sheetPushed = false, screen = 'list',
                      openFolder = null, confirmName = null } = {}) {
  const calls = [];
  const state = { screen, openFolder, confirmName };
  const fn = new Function(
    'state', 'finishFolders', 'closeSettings', 'closeSheetHard', 'showScreen',
    'render', 'history',
    `let settingsPushed = ${settingsPushed}, closingSub = true;
     let confirmPushed = ${confirmPushed}, folderPushed = ${folderPushed};
     let sheetPushed = ${sheetPushed};
     const settingsSubs = ${JSON.stringify(subs)};
     ${slice('function goHome()', 'function onPopState()')}
     return { goHome, settingsSubs };`,
  );
  const mod = fn(
    state,
    () => calls.push('finishFolders'),
    () => calls.push('closeSettings'),
    () => calls.push('closeSheetHard'),
    (name) => calls.push(`showScreen:${name}`),
    () => calls.push('render'),
    { go: (n) => calls.push(`history.go:${n}`) },
  );
  return { ...mod, calls, state };
}

test('goHome: leaving a settings sub-screen with a sheet open CLOSES the sheet, not just its flag', () => {
  // RED WHEN: `if (sheetPushed) closeSheetHard()` reverts to `sheetPushed = false`.
  // Clearing the flag alone leaves the sheet ON SCREEN with .hdr still inert and
  // its history entry disowned - a bricked header whose only route out is a
  // reload. Reachable because the how-to sheet opens on top of About, so a
  // settings sub-screen and a pushed sheet are live at the same time.
  const g = loadGoHome({ subs: ['about'], settingsPushed: true, sheetPushed: true, screen: 'about' });
  g.goHome();
  assert.ok(
    g.calls.includes('closeSheetHard'),
    `the sheet must be torn down, not merely unflagged - got ${g.calls.join(', ')}`,
  );
});

test('goHome: the settings branch counts EVERY pushed entry, so none is orphaned', () => {
  // RED WHEN: depth drops the confirm/folder/sheet terms. Every uncounted flag
  // leaves a history entry with no owner, and the next back press is a dead one.
  // Also pins the state clearing: #settings-open is visible on the drilled-in
  // folder view, so Settings is reachable from INSIDE a folder, and clearing
  // only the settings flags left state.openFolder set - the mark then landed
  // back inside the folder instead of at the top of the project list.
  const g = loadGoHome({
    subs: ['about'], settingsPushed: true, confirmPushed: true, folderPushed: true,
    sheetPushed: true, screen: 'about', openFolder: 'Pull Requests', confirmName: 'email-lint',
  });
  g.goHome();
  assert.ok(
    g.calls.includes('history.go:-5'),
    `one traversal covering all five entries, got ${g.calls.join(', ')}`,
  );
  assert.equal(g.state.openFolder, null, 'the drilled-in folder must be cleared');
  assert.equal(g.state.confirmName, null, 'and so must an open confirm');
});

test('goHome: with nothing else pushed, the settings branch traverses only what it owns', () => {
  // The negative control for the test above: a depth hardcoded to 5 would pass
  // that one. Only the settings entries are live here, so it must be 2.
  const g = loadGoHome({ subs: ['about'], settingsPushed: true, screen: 'about' });
  g.goHome();
  assert.ok(g.calls.includes('history.go:-2'), `expected -2, got ${g.calls.join(', ')}`);
  assert.ok(!g.calls.includes('closeSheetHard'), 'no sheet was open, so none is closed');
});

// --------------------------------------------------------------- removeRoot

function loadRemoveRoot({ shared = null,
                          result = { ok: true, status: 200, data: { shared_folders: [] } } } = {}) {
  const calls = [];
  const state = { shared };
  const fn = new Function(
    'state', 'withoutRoot', 'putShared',
    `let removingRoot = false;
     ${slice('async function removeRoot(rootPath)', 'async function onRemoveRoot(rootPath)')}
     return { removeRoot };`,
  );
  const mod = fn(
    state,
    withoutRoot,
    async () => { calls.push('putShared'); return result; },
  );
  return { ...mod, calls, state };
}

test('removeRoot: an unknown shared set is REFUSED, and no PUT is sent', async () => {
  // RED WHEN: the `body === null` guard is removed. withoutRoot answers null for
  // an unknown set, and writing that would turn "remove this one dead root" into
  // "remove ALL roots", because PUT /api/shared accepts an empty array as a
  // valid set. state.shared is nulled by load() whenever the acknowledge leg
  // fails, and load() runs on every visibilitychange - so a network blip while
  // the app sat backgrounded was the whole precondition.
  const r = loadRemoveRoot({ shared: null });
  assert.deepEqual(
    await r.removeRoot('F:\\Projects\\Example'),
    { ok: false, status: 0, code: 'shared_unknown' },
  );
  assert.deepEqual(r.calls, [], 'nothing may be written while the set is unknown');
});

test('removeRoot: a KNOWN set still writes, so the guard is not a blanket refusal', async () => {
  const r = loadRemoveRoot({ shared: [{ path: 'F:\\Projects\\Example', mode: 'single', excludes: [] }] });
  const res = await r.removeRoot('F:\\Projects\\Example');
  assert.equal(res.ok, true);
  assert.deepEqual(r.calls, ['putShared'], 'the removal itself must still happen');
});

// ------------------------------------------------------------ finishFolders

function loadFinishFolders({ nav = 0, pushed = 0 } = {}) {
  const calls = [];
  const share = { nav, pushed };
  const off = { removeEventListener() {} };
  const noop = () => {};
  const fn = new Function(
    'share', 'shareEls', 'onShareListChange', 'onShareListClick', 'onSharePickedClick',
    'onShareUpClick', 'onSave', 'onSkipClick', 'onFoldersPop', 'window', 'history',
    'hideFolders',
    `let resolveFolders = null, pendingFolders = null;
     ${slice('function finishFolders()', 'async function onSave()')}
     return { finishFolders };`,
  );
  const mod = fn(
    share,
    () => ({ list: off, picked: off, up: off, save: off, skip: off }),
    noop, noop, noop, noop, noop, noop, noop,
    { removeEventListener() {} },
    { go: (n) => calls.push(`history.go:${n}`) },
    () => calls.push('hideFolders'),
  );
  return { ...mod, calls, share };
}

test('finishFolders: share.nav is bumped, so an in-flight level load cannot push onto a torn-down picker', () => {
  // RED WHEN: `share.nav += 1` is removed. share.nav's own comment used to claim
  // it "never needs a reset" - true only while the picker outlived every
  // request, which it does not. Drill into a folder, tap SKIP before
  // GET /api/folders returns, and the late response passes its
  // `nav !== share.nav` check, falls through, and runs history.pushState and
  // share.pushed += 1 against a screen already torn down. That entry has no
  // owner - onFoldersPop is unregistered by the time it lands and onPopState has
  // no branch for it - so the owner's next back press does nothing at all.
  const f = loadFinishFolders({ nav: 7 });
  f.finishFolders();
  assert.equal(f.share.nav, 8, 'the nav token must change, or a late response still reads as current');
});

test('finishFolders: the picker entries come off in ONE traversal, and the counter is spent first', () => {
  // The double-tap discipline this shares with cancelOpenConfirm: share.pushed
  // is zeroed BEFORE history.go, so a second call finds nothing left to pop.
  const f = loadFinishFolders({ pushed: 2 });
  f.finishFolders();
  assert.deepEqual(f.calls.filter((c) => c.startsWith('history.go')), ['history.go:-2']);
  assert.equal(f.share.pushed, 0);
  f.finishFolders();
  assert.deepEqual(f.calls.filter((c) => c.startsWith('history.go')), ['history.go:-2'],
    'the second call must not issue a second traversal');
});

// ---------------------------------------------------------- openSettingsSub

function loadOpenSettingsSub({ subs = [] } = {}) {
  const calls = [];
  const SETTINGS_SUBS = new Set(['shared', 'passcode', 'see', 'agent', 'reset', 'about', 'update', 'root']);
  // Same holder trick as loadOnPopState: currentSub() must read the SAME array
  // the slice mutates, and that array is declared inside the Function body.
  const live = {};
  const fn = new Function(
    'SETTINGS_SUBS', 'currentSub', 'showScreen', 'renderSettingsSub', 'history',
    `const settingsSubs = ${JSON.stringify(subs)};
     ${slice('function openSettingsSub(key)', 'function closeSettingsSub()')}
     return { openSettingsSub, settingsSubs };`,
  );
  const mod = fn(
    SETTINGS_SUBS,
    () => (live.subs.length === 0 ? null : live.subs[live.subs.length - 1]),
    (name, dir) => calls.push(`showScreen:${name}:${dir}`),
    (k) => calls.push(`renderSettingsSub:${k}`),
    { pushState: () => calls.push('pushState') },
  );
  live.subs = mod.settingsSubs;
  return { ...mod, calls };
}

test('openSettingsSub: a double tap on the same row is a no-op', () => {
  // RED WHEN: the `currentSub() === key` guard is removed - the double-tap guard
  // every other history-push site already has (openConfirm, openFolderScreen,
  // openSettings, showSheet). Without it two fast taps left settingsSubs as
  // ['shared','shared'] with two stacked history entries, so the first back
  // gesture popped one and re-rendered the SAME screen - a back press that reads
  // as dead - and via openRootEditor fired two GET /api/folders for one root.
  const s = loadOpenSettingsSub();
  s.openSettingsSub('shared');
  s.openSettingsSub('shared');
  assert.deepEqual(s.settingsSubs, ['shared'], 'the second tap must not stack a duplicate');
  assert.equal(s.calls.filter((c) => c === 'pushState').length, 1,
    'and must not push a second history entry');
});

test('openSettingsSub: a DIFFERENT key still opens, so the guard is not a blanket refusal', () => {
  // The negative control: returning on every second call would pass the test above.
  const s = loadOpenSettingsSub();
  s.openSettingsSub('shared');
  s.openSettingsSub('about');
  assert.deepEqual(s.settingsSubs, ['shared', 'about']);
  assert.equal(s.calls.filter((c) => c === 'pushState').length, 2);
});

test('openSettingsSub: an unknown key is refused before anything else happens', () => {
  const s = loadOpenSettingsSub();
  s.openSettingsSub('not-a-sub');
  assert.deepEqual(s.settingsSubs, []);
  assert.deepEqual(s.calls, []);
});
