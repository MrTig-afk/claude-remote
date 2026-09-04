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
