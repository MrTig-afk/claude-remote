// T132 - sw.js's push and notificationclick listeners. Harness shaped like
// pwa-assets.test.js's loadServiceWorker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

function read(relPath) {
  return fs.readFileSync(path.join(PUBLIC_DIR, relPath), 'utf8');
}

function loadServiceWorker({ clientsList = [] } = {}) {
  const source = read('sw.js');
  const listeners = {};
  const shown = [];
  const posted = [];
  const opened = [];
  let anyFocused = false;

  const fakeSelf = {
    addEventListener(type, handler) { listeners[type] = handler; },
    skipWaiting() {},
    clients: {
      claim: async () => {},
      matchAll: async () => clientsList.map(() => ({
        focus: () => { anyFocused = true; },
        postMessage: (msg) => posted.push(msg),
      })),
      openWindow: async (url) => { opened.push(url); },
    },
    registration: {
      showNotification: async (title, opts) => { shown.push({ title, opts }); },
    },
    location: { origin: 'http://127.0.0.1:8790' },
  };

  const fakeCaches = {
    async open() { return { async addAll() {}, async put() {}, async match() { return undefined; } }; },
    async keys() { return []; },
    async delete() { return true; },
    async match() { return undefined; },
  };

  const context = {
    self: fakeSelf,
    caches: fakeCaches,
    fetch: async () => ({ ok: true, status: 200, type: 'basic', clone: () => ({}) }),
    URL,
    Response,
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'sw.js' });

  return { listeners, shown, posted, opened, wasFocused: () => anyFocused };
}

async function firePush(sw, data) {
  let waited;
  sw.listeners.push({ data, waitUntil: (p) => { waited = p; } });
  await waited;
}

async function fireClick(sw, notification) {
  let waited;
  sw.listeners.notificationclick({ notification, waitUntil: (p) => { waited = p; } });
  await waited;
}

const TEXT = {
  launch_failed: 'A session couldn’t start. Open claude-remote to see why.',
  launch_unconfirmed: 'A session hasn’t confirmed it started. Open claude-remote to check.',
  serve_missing: 'This phone can’t reach your PC right now. It needs fixing at the PC.',
  test: 'Test from claude-remote. Notifications work on this device.',
};

test('push: each known type shows the fixed-text notification, extra payload fields never leak into it', async () => {
  for (const [type, body] of Object.entries(TEXT)) {
    const sw = loadServiceWorker();
    await firePush(sw, { json: () => ({ type, project: 'Beacon' }) });
    assert.equal(sw.shown.length, 1, type);
    assert.equal(sw.shown[0].title, 'claude-remote');
    assert.equal(sw.shown[0].opts.body, body);
    assert.equal(sw.shown[0].opts.icon, '/icons/icon-192.png');
    // sw.js runs in a separate vm realm, so its object literals carry that
    // realm's Object.prototype - deepEqual against a main-realm object then
    // fails as "not reference-equal" despite matching structure. Compare the
    // field, not the object identity of its wrapper.
    assert.equal(sw.shown[0].opts.data.type, type);
    assert.ok(!JSON.stringify(sw.shown[0]).includes('Beacon'));
  }
});

test('push: an unknown type, or a payload that throws parsing it, shows nothing', async () => {
  const unknown = loadServiceWorker();
  await firePush(unknown, { json: () => ({ type: 'something_else' }) });
  assert.equal(unknown.shown.length, 0);

  const malformed = loadServiceWorker();
  await firePush(malformed, { json: () => { throw new Error('bad payload'); } });
  assert.equal(malformed.shown.length, 0);
});

test('notificationclick: an existing window is focused; postMessage only for serve_missing; no openWindow', async () => {
  for (const type of Object.keys(TEXT)) {
    const sw = loadServiceWorker({ clientsList: [{}] });
    let closed = false;
    await fireClick(sw, { data: { type }, close: () => { closed = true; } });
    assert.equal(closed, true, type);
    assert.equal(sw.wasFocused(), true, type);
    assert.equal(sw.opened.length, 0, type);
    if (type === 'serve_missing') {
      assert.equal(sw.posted.length, 1);
      assert.equal(sw.posted[0].type, 'serve_missing');
    } else {
      assert.equal(sw.posted.length, 0);
    }
  }
});

test('notificationclick: no window open -> openWindow, fragment for serve_missing, root otherwise', async () => {
  const missing = loadServiceWorker({ clientsList: [] });
  await fireClick(missing, { data: { type: 'serve_missing' }, close: () => {} });
  assert.deepEqual(missing.opened, ['/#serve_missing']);
  assert.equal(missing.wasFocused(), false);

  const failed = loadServiceWorker({ clientsList: [] });
  await fireClick(failed, { data: { type: 'launch_failed' }, close: () => {} });
  assert.deepEqual(failed.opened, ['/']);

  const testType = loadServiceWorker({ clientsList: [] });
  await fireClick(testType, { data: { type: 'test' }, close: () => {} });
  assert.deepEqual(testType.opened, ['/']);
});

test('sw.js carries no claude:// deep link anywhere (mutation drill: a deep link here is a red condition)', () => {
  assert.ok(!read('sw.js').includes('claude://'));
});
