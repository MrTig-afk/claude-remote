// Four copies of one version string live in files that no build step keeps in
// step: .claude-plugin/plugin.json (truth), agent/package.json (what the
// agent reads at boot), agent/public/app.js's SHELL_VERSION (what the cached
// shell carries), and release-notes.json[0].version (what the newest entry
// claims to describe). This file is the thing that keeps them in step -
// adding a fifth copy anywhere means adding it here too.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { readAgentVersion, AGENT_VERSION } from '../server.js';

// Reaches outside agent/ on purpose: the test IS the drift detector, so it has
// to see the truth file. The no-'../'-out-of-agent rule is a runtime rule for
// the agent itself, not a rule for its tests - do not "fix" this away.
const PLUGIN_MANIFEST_PATH = new URL('../../.claude-plugin/plugin.json', import.meta.url);
const AGENT_PACKAGE_PATH = new URL('../package.json', import.meta.url);
const APP_JS_PATH = new URL('../public/app.js', import.meta.url);
const RELEASE_NOTES_PATH = new URL('../../release-notes.json', import.meta.url);

function readJson(url) {
  return JSON.parse(fs.readFileSync(url, 'utf8'));
}

const pluginVersion = readJson(PLUGIN_MANIFEST_PATH).version;
const releaseNotes = readJson(RELEASE_NOTES_PATH);

test('agent/package.json version equals plugin.json version', () => {
  assert.equal(readJson(AGENT_PACKAGE_PATH).version, pluginVersion);
});

test('app.js SHELL_VERSION equals plugin.json version', () => {
  const source = fs.readFileSync(APP_JS_PATH, 'utf8');
  const match = source.match(/export const SHELL_VERSION = '([^']+)'/);
  assert.ok(match, 'app.js must declare SHELL_VERSION');
  assert.equal(match[1], pluginVersion);
});

test('plugin.json version is valid semver', () => {
  assert.match(pluginVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
});

test('readAgentVersion() returns the version in plugin.json', () => {
  assert.equal(readAgentVersion(), pluginVersion);
  assert.equal(AGENT_VERSION, pluginVersion);
});

test('release-notes.json parses and is a non-empty array', () => {
  assert.ok(Array.isArray(releaseNotes));
  assert.ok(releaseNotes.length >= 1);
});

test('every release-notes entry has a version, an ISO date, and non-empty note strings', () => {
  releaseNotes.forEach((entry, i) => {
    assert.ok(entry !== null && typeof entry === 'object' && !Array.isArray(entry), `entry ${i} must be an object`);
    assert.equal(typeof entry.version, 'string', `entry ${i}.version must be a string`);
    assert.notEqual(entry.version.trim(), '', `entry ${i}.version must not be empty`);
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, `entry ${i}.date must be YYYY-MM-DD`);
    assert.ok(Array.isArray(entry.notes), `entry ${i}.notes must be an array`);
    assert.ok(entry.notes.length >= 1, `entry ${i}.notes must not be empty`);
    entry.notes.forEach((note, j) => {
      assert.equal(typeof note, 'string', `entry ${i}.notes[${j}] must be a string`);
      assert.notEqual(note.trim(), '', `entry ${i}.notes[${j}] must not be empty`);
    });
  });
});

test('release-notes.json newest entry version equals plugin.json version', () => {
  assert.equal(releaseNotes[0].version, pluginVersion);
});

// Applied to the real file by the test below, and proved capable of failing by
// the test after it - with a single entry the rule is trivially satisfied, so
// the control is what keeps this honest.
function assertNewestFirst(entries) {
  for (let i = 0; i + 1 < entries.length; i += 1) {
    assert.ok(entries[i + 1].date <= entries[i].date,
      `entry ${i + 1} (${entries[i + 1].date}) is newer than entry ${i} (${entries[i].date})`);
  }
}

test('release notes are newest first', () => {
  assertNewestFirst(releaseNotes);
});

test('the newest-first check rejects an out-of-order list', () => {
  assert.throws(() => assertNewestFirst([
    { date: '2026-01-01' }, { date: '2026-08-29' }, { date: '2025-12-31' },
  ]));
  assert.doesNotThrow(() => assertNewestFirst([
    { date: '2026-08-29' }, { date: '2026-08-29' }, { date: '2026-01-01' },
  ]));
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-version-'));

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readAgentVersion returns "unknown" when the file is missing, and does not throw', () => {
  const missingPath = path.join(dir, 'missing-package.json');
  assert.equal(readAgentVersion(missingPath), 'unknown');
});

test('readAgentVersion returns "unknown" when the file is not valid JSON', () => {
  const badPath = path.join(dir, 'bad-package.json');
  fs.writeFileSync(badPath, '{ not valid json');
  assert.equal(readAgentVersion(badPath), 'unknown');
});

// The header badge is NOT a fifth copy: index.html ships the node empty and
// boot() fills it from SHELL_VERSION. Three things are pinned - no literal in
// the markup, a fill that exists, and a fill that runs BEFORE the gate. The
// third is not pedantry: filling it in wireEvents(), after two awaits, left
// the badge blank behind the passcode screen on every single launch.
test('the header badge ships empty - no fifth copy of the version in markup', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const badge = html.match(/<div class="ver"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(badge, 'index.html must carry the header badge div');
  assert.equal(badge[1].trim(), '',
    'the header badge must ship empty - a literal here is a fifth copy of the version');
});

test('boot() fills the header badge from SHELL_VERSION between the cache reset and the gate', () => {
  // BOTH bounds are defects that happened, not tidiness:
  //  - after maybeResetCache, because `?reset-cache` is the documented escape
  //    hatch and a client can hold OLD index.html (no id on the badge) against
  //    NEW app.js; dereferencing first threw before the hatch could run.
  //  - before showScreen('gate'), because the header shows behind the gate and
  //    the passcode is asked on every open.
  const source = fs.readFileSync(APP_JS_PATH, 'utf8');
  const boot = source.slice(source.indexOf('async function boot()'));
  const fill = boot.search(/getElementById\('hdr-ver'\)[\s\S]{0,160}SHELL_VERSION/);
  const reset = boot.indexOf('maybeResetCache');
  const gate = boot.indexOf("showScreen('gate')");
  assert.ok(fill !== -1, 'boot() must fill #hdr-ver from SHELL_VERSION');
  assert.ok(reset !== -1 && gate !== -1, 'boot() must reach maybeResetCache and showScreen(gate)');
  assert.ok(reset < fill,
    'the badge fill must come AFTER maybeResetCache, or a stale-shell TypeError kills ?reset-cache');
  assert.ok(fill < gate,
    'the badge must be filled BEFORE the gate - the header is visible behind it on every launch');
});

test('the header badge fill is guarded, so a stale shell costs a badge and not the app', () => {
  // The `if (badge)` is the difference between a blank badge and a blank page
  // when old index.html meets new app.js. Optional chaining cannot be used on
  // an assignment target, so the guard is the only form available.
  const source = fs.readFileSync(APP_JS_PATH, 'utf8');
  assert.match(source, /const badge = document\.getElementById\('hdr-ver'\);\s*\r?\n\s*if \(badge\)/,
    'the #hdr-ver lookup must be null-guarded before assignment');
});
