// Lane 10 (R1, R2) - the hand-off to the Claude app.
//
// handoff-ui.js is a pure module with no DOM, so it imports straight into
// node the same way update-ui.js and folders-ui.js do. The DOM wiring in
// app.js is covered by the browser pass, not here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLAUDE_APP_LINK, handoffReady, handoffCopy, SHEET_SEEN_KEY, SHEET,
} from '../public/handoff-ui.js';
import { codeOnly } from './helper-source.js';
import { listZoneState } from '../public/folders-ui.js';
import { PHONE_OFFLINE } from '../public/copy.js';

const PUBLIC = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');


// --- handoffReady: which statuses mean "go and type in it" ----------------

test('handoffReady is true only for a running session', () => {
  assert.equal(handoffReady({ status: 'running' }), true);
});

test("handoffReady does not read the activity field's values as statuses", () => {
  // busy / idle / waiting are `activity`, read from the desk-session file;
  // `status` is only ever starting | running | handoff | ended | failed. An
  // earlier cut tested status against the activity values, which can never
  // match - harmless, but it stated a contract this app does not have and
  // this test agreed with it.
  for (const activity of ['busy', 'idle', 'waiting']) {
    assert.equal(handoffReady({ status: activity }), false, activity);
  }
  assert.equal(handoffReady({ status: 'running', activity: 'busy' }), true);
});

test('handoffReady is false while the session is still starting', () => {
  // The "start requested" banner already covers this window, and it is the
  // honest message: there is nothing in the Claude app to open yet.
  assert.equal(handoffReady({ status: 'starting' }), false);
});

test('handoffReady is false for a session that is going away or gone', () => {
  // Sending someone to look for a session that failed or is tearing down is
  // worse than saying nothing - they go, find nothing, and stop trusting it.
  for (const status of ['handoff', 'ended', 'failed']) {
    assert.equal(handoffReady({ status }), false, status);
  }
});

test('handoffReady is false when the launch has not landed', () => {
  assert.equal(handoffReady(null), false);
  assert.equal(handoffReady(undefined), false);
});

test('handoffReady is false for a status this app does not know', () => {
  // Allow-list, not deny-list: a status added to the agent later must not
  // silently start promising that a session is ready to open.
  assert.equal(handoffReady({ status: 'quiesced' }), false);
  assert.equal(handoffReady({}), false);
});

// --- the copy -------------------------------------------------------------

test('the banner names the Claude app and the Code tab', () => {
  // Q2 chose naming it over staying generic: "your session is ready
  // elsewhere" is not an instruction to someone who does not know the flow.
  const copy = handoffCopy('claude-remote');
  assert.match(copy.body, /Claude/);
  assert.match(copy.body, /Code/);
});

test('no copy promises that the Code-tab row carries the project name', () => {
  // The row is named by `--remote-control <SessionName>`, and SessionName is
  // deriveSessionName's root slug + hash + slugged segments - so it reads
  // like `f-dev-projects-repos-a1b2c3/claude-remote`, never the display name.
  // "tap <project>" would be the one instruction this lane exists to give,
  // pointing at a label that is not on screen.
  assert.doesNotMatch(handoffCopy('claude-remote').body, /tap claude-remote/);
  assert.doesNotMatch(SHEET.steps[1], /named after the project/);
});

test('the banner names the project that was launched', () => {
  assert.match(handoffCopy('email-lint').body, /email-lint/);
  assert.match(handoffCopy('NutritionDE').body, /NutritionDE/);
});

test('the sheet leads with the line the whole screen exists for', () => {
  // "This app starts sessions. It does not show them." Everything else in
  // the sheet follows from it, so it is first by design.
  assert.match(SHEET.steps[0], /starts sessions/);
  assert.match(SHEET.steps[0], /does not show them/);
});

test('the sheet has exactly three steps and one control', () => {
  assert.equal(SHEET.steps.length, 3);
  assert.equal(typeof SHEET.button, 'string');
  assert.notEqual(SHEET.button, '');
});

// --- the deep link --------------------------------------------------------

test('nothing outside handoff-ui.js hardcodes a claude:// scheme', () => {
  // The scheme is UNVERIFIED on a device and a wrong one fails silently, the
  // same way a missing app does. One constant means one place to fix it; a
  // second copy in app.js would make that fix a hunt.
  const app = read('app.js');
  assert.ok(!app.includes('claude://'), 'app.js must use CLAUDE_APP_LINK, not a literal');
  assert.ok(app.includes('CLAUDE_APP_LINK'), 'app.js should import the constant');
});

// --- wiring the browser pass cannot forget --------------------------------

test('the sheet key is namespaced so it cannot collide', () => {
  assert.match(SHEET_SEEN_KEY, /^cr\./);
});

test('handoff-ui.js touches no DOM, so node can import it', () => {
  // Same rule the other pure modules follow. A `document` reference here
  // would break this suite on import rather than at call time.
  const src = read('handoff-ui.js');
  for (const bad of ['document.', 'window.', 'localStorage']) {
    assert.ok(!src.includes(bad), `handoff-ui.js must not reference ${bad}`);
  }
});

test('handoff-ui.js is precached in both shell lists', () => {
  // A module missing from these does not load offline, and the cache key
  // stops changing when it is edited - the exact failure the last commit
  // before this one fixed for update-ui.js.
  assert.ok(read('sw.js').includes("'/handoff-ui.js'"), 'sw.js PRECACHE');
  const staticJs = fs.readFileSync(path.resolve(PUBLIC, '../static.js'), 'utf8');
  assert.ok(staticJs.includes("'handoff-ui.js'"), 'static.js SHELL_FILES');
});

test('the sheet markup and the hand-off button exist in the shell', () => {
  const html = read('index.html');
  for (const id of ['handoff-go', 'handoff-sheet', 'sheet-title', 'sheet-steps', 'sheet-go', 'sheet-note']) {
    assert.ok(html.includes(`id="${id}"`), `index.html is missing #${id}`);
  }
});

test('the hand-off button is an anchor, so navigation is the browser\'s job', () => {
  // Nothing in app.js navigates. If this became a <button> the deep link
  // would need a click handler, and the single-point-of-failure comment on
  // CLAUDE_APP_LINK would stop being true.
  assert.match(read('index.html'), /<a class="handoff-go ripples" id="handoff-go"/);
});

test('the hand-off button carries the external-link glyph the Artifact draws', () => {
  // It is the only thing on screen saying this control leaves the app. Static
  // in the markup, not built in JS: writing the label over the anchor wipes
  // the glyph (caught in the browser pass), and constructing SVG in JS needs
  // createElementNS, whose absolute namespace URL the no-egress test rejects.
  const html = read('index.html');
  const anchor = html.slice(html.indexOf('<a class="handoff-go'), html.indexOf('</a>', html.indexOf('<a class="handoff-go')));
  assert.match(anchor, /#i-ext/, 'the anchor must carry the external-link glyph');
  assert.match(anchor, /id="handoff-go-label"/, 'and a separate label span to write into');

  const app = read('app.js');
  const fn = app.slice(app.indexOf('function showHandoff('), app.indexOf('// ---- Lane 10 / R2'));
  assert.doesNotMatch(fn, /createElementNS/, 'no namespace URL may reach a shipped asset');
  assert.match(fn, /handoff-go-label/, 'showHandoff writes the label, never the anchor');
});

// ---------------------------------------------------------------------------
// R4 (Lane 13) - the phone being offline is a DIFFERENT screen from the PC
// not answering. The shipped app had one story for both.
// ---------------------------------------------------------------------------

test('offline outranks every other list state, including waiting', () => {
  // Both produce the same silence from the agent. Only one of them is the
  // PC's fault, and saying "no answer from the PC" when the phone has no
  // network sends someone to go and check a machine that is working.
  const base = { openFolderEmpty: false, projectCount: 0, shared: [] };
  assert.equal(listZoneState({ ...base, reachable: 'waiting', offline: true }).kind, 'offline');
  assert.equal(listZoneState({ ...base, reachable: false, offline: true }).kind, 'offline');
  assert.equal(listZoneState({ ...base, reachable: true, projectCount: 9, offline: true }).kind, 'offline');
});

test('offline defaults to false, so every existing caller is unchanged', () => {
  assert.equal(listZoneState({ reachable: 'waiting', openFolderEmpty: false, projectCount: 0, shared: [] }).kind, 'waiting');
});

test('the offline copy blames this device and names Tailscale', () => {
  // "Check your connection" alone leaves someone staring at a full signal
  // bar; on this setup the usual cause is that the tailnet is not up.
  assert.match(PHONE_OFFLINE.title + ' ' + PHONE_OFFLINE.body, /Tailscale/);
  assert.match(PHONE_OFFLINE.body, /Nothing is wrong with your PC/);
});

test('navigator.onLine is only ever read to explain a failure, never to predict one', () => {
  // It is optimistic - true on a captive portal, true on a tailnet that is
  // down - so it is trustworthy only when it answers false, and only about a
  // request that has ALREADY come back with nothing.
  const app = codeOnly(read('app.js'));
  const hits = app.match(/navigator\.onLine/g) || [];
  // Two: load(), and markUnreachable() for the failures the idle probe and
  // the session watch decide without going through load() at all.
  assert.equal(hits.length, 2, 'read only where a request has already come back with nothing');
  assert.match(app, /navigator\.onLine === false/, 'only the false answer is trusted');
});

test('the offline state retries on the online event, not on a ladder of its own', () => {
  // waitForAgent backs off against a PC that is almost certainly fine.
  const app = read('app.js');
  assert.match(app, /addEventListener\('online'/);
  // sliced, because `state.offline` branches exist in renderConn too
  const load = app.slice(app.indexOf('async function load()'), app.indexOf('async function onProjectTap('));
  const branch = codeOnly(load.slice(load.indexOf('} else if (state.offline) {'), load.indexOf("} else if (p.code === 'network'")));
  assert.ok(branch.length > 0, 'load() must carry an offline branch');
  // codeOnly, because the branch's own comment explains why waitForAgent is
  // the wrong thing here - and an ungutted grep reads that as calling it.
  assert.doesNotMatch(branch, /waitForAgent/, 'the offline branch must not start the PC retry ladder');
});

// ---------------------------------------------------------------------------
// R5 (Lane 15) - installing. A row in About, never a prompt.
// ---------------------------------------------------------------------------

test('nothing in the app raises an install prompt on its own', () => {
  // The owner rejected the one-time bar. Chromium's own mini-infobar is
  // suppressed too, or the app would interrupt exactly the way he said not to.
  const app = read('app.js');
  assert.match(app, /beforeinstallprompt/);
  assert.match(app, /e\.preventDefault\(\)/);
  const wire = app.slice(app.indexOf("addEventListener('beforeinstallprompt'"), app.indexOf("addEventListener('appinstalled'"));
  assert.doesNotMatch(wire, /\.prompt\(\)/, 'the captured event must not be raised at capture time');
});

test('the install row is absent once the app is already installed', () => {
  // The failure this placement is most likely to produce: a row that is
  // always there becomes a control that does nothing the moment it is used.
  const app = read('app.js');
  assert.match(app, /function isInstalled\(\)/);
  assert.match(app, /display-mode: standalone/);
  const about = app.slice(app.indexOf('function renderAbout('), app.indexOf('function renderUpdateDot('));
  assert.match(about, /if \(!isInstalled\(\) && !installPromptUsed\)/, 'renderAbout must gate the row on it');
});

test('the install row is only tappable when there is a dialog to raise', () => {
  // iOS Safari exposes no install API at all. A chevron there would be a tap
  // that does nothing, so that form of the row is informational instead and
  // states the gesture rather than pretending to perform it.
  const app = read('app.js');
  const about = app.slice(app.indexOf('function renderAbout('), app.indexOf('function renderUpdateDot('));
  assert.match(about, /enterable: !!installPrompt/, 'tappable only when a dialog exists');
  assert.match(about, /Add to Home Screen/, 'and it must name the platform gesture otherwise');
});

// ---------------------------------------------------------------------------
// R6 (Lane 16) - the desktop layout. One breakpoint, and below it nothing
// about the phone changes.
// ---------------------------------------------------------------------------

test('there is exactly one desktop breakpoint, at 900px', () => {
  // Two panes need ~264px of sidebar plus a readable main column. Picking a
  // single number keeps the "design it twice" cost at exactly twice.
  const css = read('app.css');
  const widths = (css.match(/@media \(min-width: (\d+)px\)/g) || []);
  assert.deepEqual([...new Set(widths)], ['@media (min-width: 900px)'],
    'a second width would mean a third layout to keep correct');
});

test('the phone layout is untouched below the breakpoint', () => {
  // The wrappers R6 added are layout-only: outside the media query they are
  // display:contents, so the picker's flex flow and DOM order are what they
  // always were.
  const css = read('app.css');
  assert.match(css, /#pane-top, #pane-bottom \{ display: contents; \}/);
  const desktop = css.slice(css.indexOf('@media (min-width: 900px)'));
  assert.match(desktop, /#picker \{[^}]*display: grid/, 'the split is inside the query, never outside it');
});

test('the sidebar is the project list itself, not a second copy of it', () => {
  // The rule that keeps this affordable: nothing is redesigned, so a new
  // screen inherits desktop by being in the main column. A separately
  // rendered sidebar would be a second app to keep in step.
  const html = read('index.html');
  assert.equal((html.match(/id="projects"/g) || []).length, 1,
    'one list container in the markup - a desktop-only copy would be a second app');
  assert.match(html, /<section class="zone" id="zone-list">/);
  assert.ok(html.indexOf('id="projects"') > html.indexOf('id="zone-list"'),
    'the list lives inside the section that becomes the sidebar');
});

test('the main column is placed explicitly, not left to auto-placement', () => {
  // RED WHEN: the sidebar spans both rows and the main column auto-places
  // into the sidebar's row - which is as tall as the project list, so the
  // banner stretched to 792px and pushed the rest below the fold. Caught in
  // the browser, not by a test.
  const css = read('app.css');
  const desktop = css.slice(css.indexOf('@media (min-width: 900px)'));
  assert.match(desktop, /#pane-top \{ grid-column: 2; grid-row: 2;/);
  assert.match(desktop, /#pane-bottom \{ grid-column: 2; grid-row: 3;/);
  // The drill-in back bar spans both columns in row 1. Without a cell of its
  // own it auto-placed below the sidebar, at the bottom-left of the page.
  assert.match(desktop, /#backbar \{ grid-column: 1 \/ -1; grid-row: 1;/);
});

test('the offline empty state can actually be reached in the harness', () => {
  // The harness's own rule: a copy.js constant renderProjects references must
  // be in BOTH the parameter list and the call arguments, or the first test to
  // reach that branch dies with a ReferenceError instead of an assertion.
  // R4's branch was the one that had been left out.
  const t = fs.readFileSync(path.resolve(PUBLIC, '../test/pwa-assets.test.js'), 'utf8');
  const harness = t.slice(t.indexOf('function makeRenderProjectsIntegration'), t.indexOf('function makeStubEl'));
  assert.match(harness, /'PHONE_OFFLINE',/, 'parameter list');
  assert.match(harness, /stubs\.PHONE_OFFLINE \|\| copy\.PHONE_OFFLINE/, 'call arguments');
});

// ---------------------------------------------------------------------------
// Settings chrome. Owner-reported 2026-09-04: "there is no go back arrow when
// you click settings, even the setting thingy is soo confusing that you need
// to squint to see that you're in the settings page." Both were deviations
// from Lane 6, which draws a title plus an X.
// ---------------------------------------------------------------------------

test('a screen title is a title, not the palette\'s disabled colour', () => {
  // It shipped at 9px in var(--dim) - the token reserved for dim/disabled
  // text - which put the only "where am I" signal in the app in its least
  // legible colour at its smallest size.
  const css = read('app.css');
  const rule = css.slice(css.indexOf('.set-label {'), css.indexOf('}', css.indexOf('.set-label {')));
  assert.doesNotMatch(rule, /var\(--dim\)/, 'a title must not be the disabled colour');
  assert.match(rule, /font-weight: 700/);
  const size = /font-size: (\d+)px/.exec(rule);
  assert.ok(size && Number(size[1]) >= 14, `a title at ${size && size[1]}px is not a title`);
});

test('the Settings root has its own way out', () => {
  // Sub-screens have the back crumb; the root had nothing but the header mark
  // and the Android gesture - and an installed PWA has no browser chrome, so
  // that reads as a screen with no exit.
  const html = read('index.html');
  const root = html.slice(html.indexOf('<main id="settings"'), html.indexOf('</main>', html.indexOf('<main id="settings"')));
  assert.match(root, /id="settings-close"/, 'the Settings root needs a close control');
  assert.match(root, /#i-x/, 'drawn as the X the Artifact draws');
  assert.match(read('app.js'), /getElementById\('settings-close'\)\.addEventListener\('click', closeSettings\)/,
    'and it leaves Settings the way its entry came on, not via goHome');
});

test('every screen title is sentence case, as the Artifact draws them', () => {
  // "AGENT STATUS" is a section label shouting; the Artifact draws "Agent
  // status". The two are different kinds of text and were being styled alike.
  const html = read('index.html');
  for (const m of html.matchAll(/class="set-label">([^<]+)</g)) {
    const t = m[1];
    assert.notEqual(t, t.toUpperCase(), `"${t}" is shouted, not a title`);
  }
});

test('an idle project list keeps checking the agent is still there', () => {
  // RED WHEN: nothing polls while the list is up with nothing running - which
  // is what shipped. watchSessions only runs when a session is watchable, and
  // load() only fires on boot, on a tap, and on becoming visible. Switching a
  // radio off therefore changed nothing on screen, for as long as the app
  // stayed open (owner, 2026-09-04).
  const app = read('app.js');
  assert.match(app, /async function watchHealth\(\)/);
  assert.match(app, /watchHealth\(\);/, 'load() must start it');

  const fn = app.slice(app.indexOf('async function watchHealth()'), app.indexOf('// What the two watch loops do'));
  // One cheap probe, not load()'s four requests, and on its own short
  // deadline: a radio switched off swallows the connection rather than
  // refusing it, so the timeout IS how long the screen stays wrong.
  assert.match(fn, /getStatus\(HEALTH_TIMEOUT_MS\)/);
  assert.match(app, /const HEALTH_TIMEOUT_MS = 3000;/);
  assert.match(app, /const HEALTH_GAP_MS = 5000;/);
  assert.doesNotMatch(codeOnly(fn), /load\(\)/, 'it decides from the probe - load() would spend four more timeouts first');
  // It must yield to everything that owns the connection more directly.
  assert.match(fn, /document\.visibilityState === 'visible'/);
  assert.match(fn, /state\.screen === 'list'/);
  assert.match(fn, /!anyWatchable\(\)/, 'a running session is watchSessions\' job, at 5s');
  assert.match(fn, /state\.reachable === true/, 'once it is lost, waitForAgent owns the retry');
  // Re-entry guard, same shape as watching/waiting.
  assert.match(fn, /if \(healthWatching\) return;/);
  // An agent ANSWERING with a refusal is not a reachability problem, and must
  // not blank the list behind "can't reach your PC".
  assert.match(fn, /st\.code !== 'network' && st\.code !== 'timeout'/);
  // Two strikes. A single lost request is a blip - a cell handover, a radio
  // waking - and blanking the list on one costs a full reload to undo.
  assert.match(app, /const STRIKES = 2;/);
  assert.match(fn, /if \(misses < STRIKES\) continue;/);
  assert.match(fn, /if \(st\.ok\) \{ misses = 0; continue; \}/, 'a good answer resets the count');
  // The flag must go DOWN before the escalation, or the waitForAgent ->
  // load() -> watchHealth() chain hits the re-entry guard and the loop
  // unwinds with nothing watching - one recovered blip and the list is idle
  // and unwatched for good.
  assert.ok(
    fn.indexOf('healthWatching = false;') < fn.indexOf('markUnreachable();'),
    'clear the guard before escalating, or the watcher never restarts',
  );
});

test('the session watch says so when the agent goes quiet, instead of returning silently', () => {
  // RED WHEN: watchSessions does `if (!s.ok) return;`. With a session running
  // and both radios off, the tile sat there looking live indefinitely - the
  // loop had simply stopped, and nothing else was watching.
  const app = read('app.js');
  const fn = app.slice(app.indexOf('async function watchSessions()'), app.indexOf('// One cheap probe'));
  assert.match(fn, /markUnreachable\(\);/);
  assert.match(fn, /if \(s\.code !== 'network' && s\.code !== 'timeout'\) return;/,
    'an agent ANSWERING with a refusal is not a reachability problem');
  assert.match(fn, /if \(misses < STRIKES\) continue;/, 'same two strikes as the idle probe');
  assert.match(fn, /misses = 0;/, 'a good answer resets the count');
});

test('markUnreachable leaves the screen where load() would have left it', () => {
  const app = read('app.js');
  const fn = app.slice(app.indexOf('function markUnreachable()'), app.indexOf('// Gaps between automatic retries'));
  assert.match(fn, /state\.offline = navigator\.onLine === false;/);
  assert.match(fn, /state\.projects = \[\];/);
  assert.match(fn, /state\.reachable = state\.offline \? false : 'waiting';/);
  // Offline is this device's fault; the `online` listener owns that recovery,
  // and waitForAgent would back off against a PC that is fine.
  assert.match(fn, /if \(!state\.offline\) waitForAgent\(\);/);
  assert.match(fn, /render\(\);/);
});

test('the Running section is gone while the agent cannot be reached', () => {
  // RED WHEN: renderProjects leaves #zone-run visible on an unreachable list.
  // It then reads "RUNNING 0 / nothing running / tap a project to start a
  // session" over the top of "Can't reach your PC" - two claims the app
  // cannot make (state.sessions is null, which the footer correctly calls
  // UNKNOWN) and an invitation to tap something that cannot work. Artifact
  // Lane 13 draws no Running section on either unreachable frame.
  const app = read('app.js');
  const fn = app.slice(app.indexOf('function renderProjects()'), app.indexOf('function renderFooter('));
  assert.match(fn, /document\.getElementById\('zone-run'\)\.hidden = state\.reachable !== true;/);
});

test('the wait ladder is capped short enough to notice the PC coming back', () => {
  // Each retry is a load(), which already spends its own 10s timeout against
  // a PC that is not answering. A 15s gap on top meant up to 25s of staring
  // at a machine that had already come back.
  const app = read('app.js');
  assert.match(app, /const WAIT_GAPS_MS = \[2000, 3000, 4000\];/);
});

test('TRY AGAIN restarts the ladder rather than resuming the backoff', () => {
  const app = read('app.js');
  const fn = app.slice(app.indexOf('async function onProjectTap('), app.indexOf('function openConfirm('));
  const branch = fn.slice(fn.indexOf("[data-retry]"), fn.indexOf('const choose ='));
  assert.match(branch, /state\.waitTries = 0;/, 'someone is watching: the next automatic retry must be the short one');
  assert.ok(branch.indexOf('state.waitTries = 0;') < branch.indexOf('load();'));
});

test('the last session ending hands the list back to the idle probe', () => {
  // watchHealth is only called from load(), and load() does not run when a
  // session simply ends at the desk - so the list went idle with nothing
  // watching it at all.
  const app = read('app.js');
  const fn = app.slice(app.indexOf('async function watchSessions()'), app.indexOf('// While the project list is on screen'));
  assert.match(fn, /finally \{[\s\S]*watchHealth\(\);[\s\S]*\}/);
});

test('closeSheet leaves the history flag for the pop it issues', () => {
  // RED WHEN: closeSheet clears sheetPushed before its own history.back().
  // The pop then misses the sheet branch in onPopState and is read by the
  // SETTINGS branch instead, popping About out from under the owner.
  //
  // This has now been reintroduced TWICE by tidying: once by gating the
  // popstate branch on the sheet being visible, once by folding closeSheet
  // into closeSheetHard (which owns the flag). Both times the suite was green
  // and the browser caught it. Hence this test.
  const app = read('app.js');
  // Bounded by the function's own closing brace: maybeShowSheet sits BEFORE
  // closeSheet in the file, so slicing to it gave an empty string that passed
  // the doesNotMatch assertions for free.
  const start = app.indexOf('function closeSheet()');
  const fn = codeOnly(app.slice(start, app.indexOf('\n}', start) + 2));
  assert.match(fn, /hideSheet\(\)/, 'it hides via hideSheet, which does not touch the flag');
  assert.doesNotMatch(fn, /closeSheetHard\(\)/, 'closeSheetHard disowns the entry - wrong for a path that pops one');
  assert.doesNotMatch(fn, /sheetPushed = false/, 'the popstate branch owns the flag on this path');
});

test('the two teardowns differ only in who owns the history entry', () => {
  // hideSheet is the shared half; closeSheetHard adds the disown. Written out
  // four times before this, which is how the invariant drifted.
  const app = read('app.js');
  const hard = app.slice(app.indexOf('function closeSheetHard()'), app.indexOf('// Count first, mutate after'));
  assert.match(hard, /hideSheet\(\);/);
  assert.match(hard, /sheetPushed = false;/);
  assert.equal((codeOnly(app).match(/\.hdr'\)\.inert = false/g) || []).length, 1,
    'one place lifts inert, or it drifts again');
});
