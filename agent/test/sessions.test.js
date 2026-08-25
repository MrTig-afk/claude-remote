import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { deriveSessionName, resolveProjectPath, launchSession } from '../sessions.js';
import { createAgentServer } from '../server.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-sessions-'));
fs.mkdirSync(path.join(base, 'Pull Requests'));
fs.mkdirSync(path.join(base, 'Video Editing'));
fs.mkdirSync(path.join(base, 'email-lint'));
fs.mkdirSync(path.join(base, '-weird'));
fs.writeFileSync(path.join(base, 'notes.txt'), 'hello');

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function makeFakeSpawner() {
  const calls = [];
  function spawner(file, args, options) {
    const child = {
      pid: 4242,
      unrefCount: 0,
      handlers: {},
      unref() { this.unrefCount += 1; },
      on(event, fn) { this.handlers[event] = fn; return this; },
    };
    calls.push({ file, args, options, child });
    return child;
  }
  return { spawner, calls };
}

// --- 6.3 deriveSessionName - the naming contract ---------------------------

test('deriveSessionName - naming contract', () => {
  const rows = [
    ['Pull Requests', 'pull-requests'],
    ['Video Editing', 'video-editing'],
    ['email-lint', 'email-lint'],
    ['F:\\Dev\\Projects\\Repos\\Pull Requests', 'pull-requests'],
    ['F:\\Dev\\Projects\\Repos\\email-lint', 'email-lint'],
    ['Backend Engineering', 'backend-engineering'],
    ['My.Project', 'my-project'],
    ['A  B', 'a-b'],
    ['Foo. .Bar', 'foo-bar'],
    ['Reactive-Resume', 'reactive-resume'],
    ['F:\\Dev\\Projects\\Repos\\Video Editing\\', 'video-editing'],
  ];
  for (const [input, expected] of rows) {
    assert.equal(deriveSessionName(input), expected, `input: ${input}`);
  }
});

// --- 6.4 Launch mechanics (unit level, launchSession directly) -------------

test('launchSession - one call spawns exactly one process', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({ baseDir: base, spawner }, 'Pull Requests');
  assert.equal(calls.length, 1);
});

test('launchSession - spawns powershell.exe', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({ baseDir: base, spawner }, 'Pull Requests');
  assert.equal(calls[0].file, 'powershell.exe');
});

test('launchSession - exact args array', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({ baseDir: base, spawner }, 'Pull Requests');
  const LAUNCH_SCRIPT = path.join(path.resolve(import.meta.dirname, '..'), 'launch-session.ps1');
  assert.deepEqual(calls[0].args, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', LAUNCH_SCRIPT,
    '-ProjectPath', path.join(base, 'Pull Requests'),
    '-SessionName', 'pull-requests',
  ]);
});

test('launchSession - exact options (detachment contract)', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({ baseDir: base, spawner }, 'Pull Requests');
  assert.deepEqual(calls[0].options, {
    stdio: 'ignore',
    windowsHide: true,
    cwd: path.join(base, 'Pull Requests'),
  });
});

test('launchSession - child.unref() called exactly once', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({ baseDir: base, spawner }, 'Pull Requests');
  assert.equal(calls[0].child.unrefCount, 1);
});

test('launchSession - error handler wired', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({ baseDir: base, spawner }, 'Pull Requests');
  assert.equal(typeof calls[0].child.handlers.error, 'function');
});

test('launchSession - no shell string-building leaked into args', () => {
  const { spawner, calls } = makeFakeSpawner();
  launchSession({ baseDir: base, spawner }, 'Pull Requests');
  assert.ok(!calls[0].args.includes('-Command'));
  assert.ok(!calls[0].args.some((a) => a.includes('&')));
  assert.ok(!calls[0].args.some((a) => a.includes(';')));
});

// --- 6.5 Rejection cases - each asserts calls.length === 0 ------------------

test('resolveProjectPath - rejection table (invalid_project / invalid_request)', () => {
  const rows = [
    ['..', 'invalid_project'],
    ['../..', 'invalid_project'],
    ['..\\Windows', 'invalid_project'],
    ['C:\\Windows', 'invalid_project'],
    ['\\\\server\\share', 'invalid_project'],
    ['Pull Requests/../..', 'invalid_project'],
    ['sub/dir', 'invalid_project'],
    ['sub\\dir', 'invalid_project'],
    ['foo:bar', 'invalid_project'],
    ['.hidden', 'invalid_project'],
    ['', 'invalid_request'],
    ['   ', 'invalid_request'],
    ['x'.repeat(300), 'invalid_request'],
    [42, 'invalid_request'],
    [null, 'invalid_request'],
    [undefined, 'invalid_request'],
  ];
  for (const [project, expectedError] of rows) {
    const { spawner, calls } = makeFakeSpawner();
    const result = launchSession({ baseDir: base, spawner }, project);
    assert.equal(result.ok, false, `project: ${project}`);
    assert.equal(result.error, expectedError, `project: ${project}`);
    assert.equal(calls.length, 0, `project: ${project}`);
  }
});

test('resolveProjectPath - leading hyphen rejected as invalid_project', () => {
  const { spawner, calls } = makeFakeSpawner();
  const result = launchSession({ baseDir: base, spawner }, '-weird');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_project');
  assert.equal(calls.length, 0);
});

test('resolveProjectPath - nonexistent project rejected as project_not_found', () => {
  const { spawner, calls } = makeFakeSpawner();
  const result = launchSession({ baseDir: base, spawner }, 'no-such-project');
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.error, 'project_not_found');
  assert.equal(calls.length, 0);
});

test('resolveProjectPath - a file (not a directory) rejected as project_not_found', () => {
  const { spawner, calls } = makeFakeSpawner();
  const result = launchSession({ baseDir: base, spawner }, 'notes.txt');
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.error, 'project_not_found');
  assert.equal(calls.length, 0);
});

test('resolveProjectPath - junction escaping base dir rejected as project_not_found', (t) => {
  const linkPath = path.join(base, 'linked');
  try {
    fs.symlinkSync(os.tmpdir(), linkPath, 'junction');
  } catch {
    t.skip('junction creation not permitted');
    return;
  }
  const { spawner, calls } = makeFakeSpawner();
  const result = launchSession({ baseDir: base, spawner }, 'linked');
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.error, 'project_not_found');
  assert.equal(calls.length, 0);
});

// --- 6.6 HTTP level ----------------------------------------------------------

test('HTTP - POST /api/sessions launches and returns the flat session body', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const server = createAgentServer({ baseDir: base, spawner });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.deepEqual(body, { session_name: 'pull-requests', project: 'Pull Requests', status: 'starting' });
    assert.equal(calls.length, 1);
  } finally {
    server.close();
  }
});

test('HTTP - 202 has JSON content-type', async () => {
  const { spawner } = makeFakeSpawner();
  const server = createAgentServer({ baseDir: base, spawner });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  } finally {
    server.close();
  }
});

test('HTTP - 202 has Cache-Control: no-store', async () => {
  const { spawner } = makeFakeSpawner();
  const server = createAgentServer({ baseDir: base, spawner });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    server.close();
  }
});

test('HTTP - body not JSON at all -> 400 invalid_request, no spawn', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const server = createAgentServer({ baseDir: base, spawner });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.deepEqual(body, { error: 'invalid_request' });
    assert.equal(calls.length, 0);
  } finally {
    server.close();
  }
});

test('HTTP - body a valid-JSON string (not object) -> 400 invalid_request, no spawn', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const server = createAgentServer({ baseDir: base, spawner });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify('just a string'),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.deepEqual(body, { error: 'invalid_request' });
    assert.equal(calls.length, 0);
  } finally {
    server.close();
  }
});

test('HTTP - body [] -> 400 invalid_request, no spawn', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const server = createAgentServer({ baseDir: base, spawner });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([]),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.deepEqual(body, { error: 'invalid_request' });
    assert.equal(calls.length, 0);
  } finally {
    server.close();
  }
});

test('HTTP - body over 8 KB -> 413 payload_too_large, no spawn', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const server = createAgentServer({ baseDir: base, spawner });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const bigBody = JSON.stringify({ project: 'x'.repeat(9 * 1024) });
    const res = await fetch(`${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bigBody,
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.deepEqual(body, { error: 'payload_too_large' });
    assert.equal(calls.length, 0);
  } finally {
    server.close();
  }
});

test('HTTP - GET /api/sessions -> 404 not_found, no spawn', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const server = createAgentServer({ baseDir: base, spawner });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${origin}/api/sessions`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.deepEqual(body, { error: 'not_found' });
    assert.equal(calls.length, 0);
  } finally {
    server.close();
  }
});

test('HTTP - POST /api/sessions/ (trailing slash) -> 404 not_found, no spawn', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const server = createAgentServer({ baseDir: base, spawner });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${origin}/api/sessions/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Pull Requests' }),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.deepEqual(body, { error: 'not_found' });
    assert.equal(calls.length, 0);
  } finally {
    server.close();
  }
});

test('HTTP - POST /api/nope -> 404 not_found', async () => {
  const { spawner } = makeFakeSpawner();
  const server = createAgentServer({ baseDir: base, spawner });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${origin}/api/nope`, { method: 'POST' });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.deepEqual(body, { error: 'not_found' });
  } finally {
    server.close();
  }
});

test('HTTP - GET /api/projects still 200 with fixture names (survives async rewrite)', async () => {
  const { spawner } = makeFakeSpawner();
  const server = createAgentServer({ baseDir: base, spawner });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${origin}/api/projects`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const names = body.projects.map((p) => p.name);
    assert.ok(names.includes('Pull Requests'));
    assert.ok(names.includes('Video Editing'));
    assert.ok(names.includes('email-lint'));
  } finally {
    server.close();
  }
});

test('HTTP - two POSTs for the same project -> two spawns, both starting', async () => {
  const { spawner, calls } = makeFakeSpawner();
  const server = createAgentServer({ baseDir: base, spawner });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const req = () => fetch(`${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'email-lint' }),
    });
    const res1 = await req();
    const res2 = await req();
    assert.equal(res1.status, 202);
    assert.equal(res2.status, 202);
    const body1 = await res1.json();
    const body2 = await res2.json();
    assert.equal(body1.status, 'starting');
    assert.equal(body2.status, 'starting');
    assert.equal(calls.length, 2);
  } finally {
    server.close();
  }
});

// --- 6.7 Recipe-integrity test ----------------------------------------------

test('recipe-integrity - launch-session.ps1 preserves the proven launch recipe', () => {
  const script = fs.readFileSync(
    path.join(path.resolve(import.meta.dirname, '..'), 'launch-session.ps1'),
    'utf8',
  );
  assert.ok(script.includes('CLAUDE_CONFIG_DIR'));
  assert.ok(script.includes('.claude-max'));
  assert.ok(script.includes('--channels'));
  assert.ok(script.includes('plugin:whatsapp-claude-channel@whatsapp-claude-plugin'));
  assert.ok(script.includes('--remote-control'));
  assert.ok(script.includes('Activate.ps1'));
  assert.ok(script.includes('Start-Process'));
  assert.ok(script.includes('-LiteralPath'));
  assert.ok(!/--rc/.test(script));
});
