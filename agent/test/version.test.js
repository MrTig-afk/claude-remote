// Three copies of one version string live in three files that no build step
// keeps in step: .claude-plugin/plugin.json (truth), agent/package.json (what
// the agent reads at boot), and agent/public/app.js's SHELL_VERSION (what the
// cached shell carries). This file is the thing that keeps them in step -
// adding a fourth copy anywhere means adding it here too.

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

function readJson(url) {
  return JSON.parse(fs.readFileSync(url, 'utf8'));
}

const pluginVersion = readJson(PLUGIN_MANIFEST_PATH).version;

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
