import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { trustFolder, claudeStatePath } from '../trust.js';

// Every test gets its own fake profile dir, passed as configDir, so the
// suite never reads or writes the developer's real Claude config.
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const STATE = '.claude.json';

function profile(state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-trust-'));
  dirs.push(dir);
  if (state !== undefined) {
    fs.writeFileSync(path.join(dir, STATE), typeof state === 'string' ? state : JSON.stringify(state, null, 2));
  }
  return dir;
}
const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, STATE), 'utf8'));

test('claudeStatePath - the configured profile, else the home directory', () => {
  assert.equal(claudeStatePath('C:\\p\\.claude-max'), path.join('C:\\p\\.claude-max', STATE));
  assert.equal(claudeStatePath(null), path.join(os.homedir(), STATE));
});

test('trustFolder - writes the dialog field under the forward-slash key', () => {
  const dir = profile({ userID: 'u1', projects: { 'D:/Other': { allowedTools: ['x'] } } });
  assert.equal(trustFolder('D:\\Assignments\\Sem 3\\DataVis_2', dir), true);
  const s = read(dir);
  assert.deepEqual(s.projects['D:/Assignments/Sem 3/DataVis_2'], { hasTrustDialogAccepted: true });
  // Everything else in Claude Code's file is left exactly as it was.
  assert.equal(s.userID, 'u1');
  assert.deepEqual(s.projects['D:/Other'], { allowedTools: ['x'] });
  assert.equal(fs.existsSync(path.join(dir, `${STATE}.claude-remote-tmp`)), false);
});

test('trustFolder - keeps the fields of an existing entry for the same key', () => {
  const dir = profile({ projects: { 'F:/Dev/WIL': { hasTrustDialogAccepted: false, history: [1] } } });
  assert.equal(trustFolder('F:\\Dev\\WIL', dir), true);
  assert.deepEqual(read(dir).projects['F:/Dev/WIL'], { hasTrustDialogAccepted: true, history: [1] });
});

test('trustFolder - writes the EXACT key; a differently-cased entry is left alone (RF-C02)', () => {
  const dir = profile({ projects: { 'd:/assignments/cml': { hasTrustDialogAccepted: false, history: [1] } } });
  assert.equal(trustFolder('D:\\Assignments\\CML', dir), true);
  const s = read(dir);
  assert.deepEqual(s.projects['D:/Assignments/CML'], { hasTrustDialogAccepted: true });
  assert.deepEqual(s.projects['d:/assignments/cml'], { hasTrustDialogAccepted: false, history: [1] });
});

test('trustFolder - adds a projects map when the file has none', () => {
  const dir = profile({ userID: 'u1' });
  assert.equal(trustFolder('F:\\Dev\\WIL', dir), true);
  assert.deepEqual(read(dir).projects, { 'F:/Dev/WIL': { hasTrustDialogAccepted: true } });
});

test('trustFolder - already trusted: true, and the file is not rewritten', () => {
  const raw = JSON.stringify({ projects: { 'F:/Dev/WIL': { hasTrustDialogAccepted: true } } });
  const dir = profile(raw);
  assert.equal(trustFolder('F:\\Dev\\WIL', dir), true);
  // Byte-identical: a rewrite would re-indent it.
  assert.equal(fs.readFileSync(path.join(dir, STATE), 'utf8'), raw);
});

test('trustFolder - never creates the file for a profile that has never run', () => {
  const dir = profile();
  assert.equal(trustFolder('F:\\Dev\\WIL', dir), false);
  assert.equal(fs.existsSync(path.join(dir, STATE)), false);
});

test('trustFolder - never rewrites a file it cannot parse or does not recognise', () => {
  for (const raw of ['{ "projects": ', '[]', 'null', '{"projects": []}', '{"projects": {"F:/Dev/WIL": "yes"}}']) {
    const dir = profile(raw);
    assert.equal(trustFolder('F:\\Dev\\WIL', dir), false, raw);
    assert.equal(fs.readFileSync(path.join(dir, STATE), 'utf8'), raw, raw);
  }
});

test('trustFolder - a session writing the file mid-merge is kept, not overwritten (RF-C03)', () => {
  const dir = profile({ projects: {} });
  const file = path.join(dir, STATE);
  const realWrite = fs.writeFileSync;
  let raced = false;
  fs.writeFileSync = function (target, ...rest) {
    // The first time trust.js writes its temp copy, another "session" rewrites
    // the real file - the exact window a stale rename would throw away.
    if (!raced && String(target).endsWith('.claude-remote-tmp')) {
      raced = true;
      realWrite(file, JSON.stringify({ projects: { 'F:/Other': { allowedTools: ['Bash'] } } }));
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(file, later, later);
    }
    return realWrite.call(this, target, ...rest);
  };
  try {
    assert.equal(trustFolder('F:\\Dev\\WIL', dir), true);
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.equal(raced, true);
  assert.deepEqual(read(dir).projects, {
    'F:/Other': { allowedTools: ['Bash'] },
    'F:/Dev/WIL': { hasTrustDialogAccepted: true },
  });
  assert.equal(fs.existsSync(`${file}.claude-remote-tmp`), false);
});

test('trustFolder - a rename refused for a moment (file busy) is retried, and gives up after the last attempt (RF2-C01)', () => {
  const realRename = fs.renameSync;
  let refusals = 1;
  fs.renameSync = function (...a) {
    if (refusals > 0) { refusals -= 1; throw Object.assign(new Error('busy'), { code: 'EPERM' }); }
    return realRename.apply(this, a);
  };
  try {
    const dir = profile({ projects: {} });
    assert.equal(trustFolder('F:\\Dev\\WIL', dir), true);
    assert.deepEqual(read(dir).projects, { 'F:/Dev/WIL': { hasTrustDialogAccepted: true } });

    refusals = Infinity;
    const stuck = profile({ projects: {} });
    assert.equal(trustFolder('F:\\Dev\\WIL', stuck), false);
    assert.deepEqual(read(stuck).projects, {});
    assert.equal(fs.existsSync(path.join(stuck, `${STATE}.claude-remote-tmp`)), false, 'no temp file left behind');
  } finally {
    fs.renameSync = realRename;
  }
});

test('trustFolder - writes through a symlinked state file instead of replacing the link (RF-C06)', (t) => {
  const dir = profile();
  const realDir = profile({ projects: {} });
  const link = path.join(dir, STATE);
  try {
    fs.symlinkSync(path.join(realDir, STATE), link, 'file');
  } catch (err) {
    t.skip(`cannot create a symlink here (${err.code}) - needs Developer Mode on Windows`);
    return;
  }
  assert.equal(trustFolder('F:\\Dev\\WIL', dir), true);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link must survive');
  assert.deepEqual(read(realDir).projects, { 'F:/Dev/WIL': { hasTrustDialogAccepted: true } });
});
