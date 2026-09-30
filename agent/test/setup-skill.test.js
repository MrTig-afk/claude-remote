import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

// The setup skill's plugin-folder lookup is PowerShell a model runs word
// for word, so it is run here too - under Windows PowerShell 5.1, the one every
// Windows PC ships with, where it once matched nothing and stopped every new
// install with "plugin folder not found" (Dell install test, 2026-09-27).
const SKILL = path.resolve(import.meta.dirname, '..', '..', 'skills', 'setup', 'SKILL.md');

function lookupBlock() {
  const lines = fs.readFileSync(SKILL, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trimStart().startsWith('$paths = @('));
  const end = lines.findIndex((l, i) => i >= start && l.includes('Select-Object -Unique)'));
  assert.ok(start >= 0 && end >= start, 'the $paths lookup is no longer in skills/setup/SKILL.md');
  return lines.slice(start, end + 1).join('\n');
}

// A function named claude.cmd wins over the real executable in PowerShell's
// command lookup, so the block runs unchanged against a fake plugin list.
function runLookup(pluginListJson) {
  const script = [
    `function claude.cmd { '${pluginListJson.replace(/'/g, "''")}' }`,
    lookupBlock(),
    "'COUNT=' + $paths.Count",
    "'PATHS=' + ($paths -join '|')",
  ].join('\n');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
}

test('setup skill - the plugin lookup finds claude-remote among other plugins under Windows PowerShell 5.1', () => {
  const out = runLookup(JSON.stringify([
    { id: 'other@x', installPath: 'C:\\a' },
    { id: 'claude-remote@claude-remote', installPath: 'C:\\b\\claude-remote' },
    { id: 'more@y', installPath: 'C:\\c' },
  ]));
  assert.match(out, /COUNT=1\b/);
  assert.match(out, /PATHS=C:\\b\\claude-remote/);
});

test('setup skill - the plugin lookup finds it when it is the only plugin', () => {
  const out = runLookup(JSON.stringify([{ id: 'claude-remote@claude-remote', installPath: 'C:\\b' }]));
  assert.match(out, /COUNT=1\b/);
  assert.match(out, /PATHS=C:\\b\r?\n/);
});

test('setup skill - two scopes at two folders are both found, so the skill refuses to guess', () => {
  const out = runLookup(JSON.stringify([
    { id: 'claude-remote@claude-remote', installPath: 'C:\\user-scope' },
    { id: 'claude-remote@claude-remote', installPath: 'C:\\project-scope' },
  ]));
  assert.match(out, /COUNT=2\b/);
});
