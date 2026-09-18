// T83 - Contact me. The Artifact's screen below About: two rows (LinkedIn,
// Email), no sub-lines, a lead sentence and a note. Built 2026-09-15; the two
// repo rows on About (Source code, Report a problem) still wait for T66.
//
// Same idiom as settings.test.js: renderAbout is sliced out of app.js and RUN
// under stubs, so the About row is checked by executing the code that draws it,
// not by grepping for its name. The screen itself is static markup and is
// checked as markup. SCREEN_MAIN and the <main id> are pinned by settings S1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8').replace(/\r/g, '');

const LINKEDIN = 'https://www.linkedin.com/in/kaushikn2002';
const MAILTO = 'mailto:kaushiknaru2002@gmail.com';

// Runs renderAbout with every collaborator stubbed (nothing waiting, already
// installed) and returns the row specs it handed to buildSettingsRow, in order.
function aboutRows() {
  const js = read('app.js');
  // From the REPO_URL constant, which renderAbout reads, to the next function.
  const start = js.indexOf('const REPO_URL =');
  const end = js.indexOf('function renderUpdateDot(');
  assert.ok(start !== -1 && end > start, 'REPO_URL and renderAbout must sit before renderUpdateDot');
  const rows = [];
  const fn = new Function(
    'document', 'SHELL_VERSION', 'state', 'updateWaiting', 'aboutRowState',
    'isInstalled', 'installPromptUsed', 'installPrompt', 'buildSettingsRow',
    `${js.slice(start, end)}; return renderAbout;`,
  );
  const el = { textContent: '', innerHTML: '', appendChild() {} };
  fn(
    { getElementById: () => el }, '1.0.0', { status: null, shellStale: false },
    () => false, () => ({ text: 'x', update: false }),
    () => true, false, null, (spec) => { rows.push(spec); return {}; },
  )();
  return rows;
}

test('T83 - About draws a Contact me row, with no sub-line, directly above What this app can see', () => {
  // RED WHEN: the row is removed, given a description, or moved out of the
  // Artifact's order (update, [repo rows], Contact me, What this app can see).
  const rows = aboutRows();
  const ids = rows.map((r) => r.id);
  const at = ids.indexOf('contact');
  assert.ok(at !== -1, `About has no contact row: ${ids.join(', ')}`);
  assert.equal(ids[at + 1], 'see', 'Contact me sits immediately above What this app can see');
  const row = rows[at];
  assert.equal(row.state, '', 'no descriptions under the rows - the owner called them tacky');
  assert.equal(row.enterable, true);
  assert.equal(row.icon, 'i-mail');
});

test('T83 - the About row leads somewhere: contact is a settings sub-screen', () => {
  // RED WHEN: 'contact' is dropped from SETTINGS_SUBS - the click delegate
  // then ignores the row and the back gesture would close Settings outright.
  const js = read('app.js');
  const declStart = js.indexOf('const SETTINGS_SUBS');
  assert.match(js.slice(declStart, js.indexOf(';', declStart)), /'contact'/);
});

function contactMain() {
  const html = read('index.html');
  const start = html.indexOf('<main id="set-contact"');
  assert.ok(start !== -1);
  return html.slice(start, html.indexOf('</main>', start));
}

test('T83 - the screen is two plain links, LinkedIn then Email, with no descriptions and no underline', () => {
  // RED WHEN: a row is added or removed, a href changes, a row grows a
  // .row-status sub-line, a row acquires data-settings and starts being routed
  // as a screen by the settings delegate, or .row loses text-decoration: none
  // and the two links draw with the browser's default underline.
  const main = contactMain();
  const anchors = [...main.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(anchors.length, 2, `expected exactly two rows, found ${anchors.length}`);
  assert.ok(anchors[0].includes(`href="${LINKEDIN}"`), anchors[0]);
  assert.match(anchors[0], /target="_blank"/);
  assert.match(anchors[0], /rel="noopener noreferrer"/,
    'an external link must hand LinkedIn neither the opener nor the tailnet hostname as a referrer');
  assert.ok(anchors[1].includes(`href="${MAILTO}"`), anchors[1]);
  for (const a of anchors) {
    assert.match(a, /class="row folder set-row"/, 'the rows are the app\'s ordinary settings rows');
    assert.doesNotMatch(a, /data-settings/, 'a link row must not be routed as a screen');
  }
  assert.doesNotMatch(main, /row-status/, 'no descriptions under the rows');
  assert.match(main, /<span class="row-name">LinkedIn<\/span>/);
  assert.match(main, /<span class="row-name">Email<\/span>/);
  const css = read('app.css');
  const rowStart = css.indexOf('.row {');
  assert.match(css.slice(rowStart, css.indexOf('}', rowStart)), /text-decoration: none/);
});

test('T83 - the crumb says About, and the copy is the Artifact\'s', () => {
  // RED WHEN: the screen is re-parented or the two sentences drift from the
  // approved frame.
  const main = contactMain();
  assert.match(main, /data-set-back aria-label="Back to About"/);
  assert.match(main, /Bugs and feature requests are best raised as issues\. For anything else:/);
  assert.match(main, /These open your own apps\. Nothing is sent from here\./);
});

// --- T83, the other half: Source code and Report a problem on About --------

const REPO = 'https://github.com/MrTig-afk/claude-remote';

test('T83 - About draws Source code then Report a problem above Contact me, each a link to the repo', () => {
  // RED WHEN: either row is missing, out of the Artifact's order, given a
  // description, or points anywhere but the repo and its issues page.
  const rows = aboutRows();
  const ids = rows.map((r) => r.id);
  const at = ids.indexOf('source');
  assert.ok(at !== -1, `About has no source row: ${ids.join(', ')}`);
  assert.deepEqual(ids.slice(at, at + 3), ['source', 'issues', 'contact']);
  assert.equal(rows[at].href, REPO);
  assert.equal(rows[at + 1].href, `${REPO}/issues`);
  for (const row of rows.slice(at, at + 2)) {
    assert.equal(row.state, '', 'no descriptions under the rows');
    assert.equal(row.icon, 'i-ext', 'a row that leaves the app carries the external-link glyph');
  }
});

// A minimal element stub for buildSettingsRow: enough to see what it builds.
function stubDoc() {
  const el = (tag) => ({
    tag, dataset: {}, className: '', attrs: {}, children: [],
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = v; },
    querySelector() { return { setAttribute() {} }; },
    cloneNode() { return el('svg'); },
  });
  return {
    createElement: el,
    getElementById: () => ({ content: { firstElementChild: el('svg') } }),
  };
}

function loadBuildSettingsRow() {
  const js = read('app.js');
  const start = js.indexOf('function buildSettingsRow(');
  const end = js.indexOf('/**\n * Lane 6 of the userflow artifact', start);
  assert.ok(start !== -1 && end > start);
  return new Function('document', `${js.slice(start, end)}; return buildSettingsRow;`)(stubDoc());
}

test('T83 - buildSettingsRow: an href makes an <a> with noreferrer and NO data-settings; without one it is the routed button', () => {
  // RED WHEN: a link row becomes a button (the phone then taps into nothing),
  // loses noreferrer (the tailnet hostname leaks to GitHub), or a plain row
  // stops carrying data-settings (the settings delegate then ignores it).
  const build = loadBuildSettingsRow();
  const link = build({ id: 'source', icon: 'i-ext', name: 'Source code', state: '', enterable: true, href: REPO });
  assert.equal(link.tag, 'a');
  assert.equal(link.href, REPO);
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(link.dataset.settings, undefined);
  assert.ok(link.children.some((c) => c.className === 'folder-chev'), 'a link row still promises it goes somewhere');
  // F20-C01: a link cannot be made to look inert while still navigating.
  const inertLink = build({ id: 'source', icon: 'i-ext', name: 'Source code', state: '', enterable: false, href: REPO });
  assert.equal(inertLink.tag, 'a');
  assert.ok(inertLink.children.some((c) => c.className === 'folder-chev'), 'an href row always draws its chevron');
  assert.doesNotMatch(inertLink.className, /set-off/, 'an href row is never muted');
  const button = build({ id: 'see', icon: 'i-eye', name: 'What this app can see', state: '', enterable: true });
  assert.equal(button.tag, 'button');
  assert.equal(button.dataset.settings, 'see');
  assert.equal(button.href, undefined);
});
