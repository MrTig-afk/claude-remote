import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';

import { clearToken } from '../public/api.js';

// lock.js is the browser module under test. It touches `document` (stubbed
// below) and, via api.js, the global fetch() (also stubbed below), the way
// api.test.js stubs fetch against the same module.

function makeEl() {
  const listeners = new Map(); // type -> Set<fn>
  return {
    hidden: false,
    disabled: false,
    textContent: '',
    value: '',
    focus() {}, // lock.js calls e.pin.focus() on the RETRY re-probe path
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    // test-side drivers, not part of the DOM contract:
    listenerCount(type) { return listeners.get(type)?.size ?? 0; },
    fire(type, ev = { preventDefault() {} }) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(ev);
    },
  };
}

function makeDocument() {
  const ids = ['picker', 'gate', 'gate-form', 'gate-label', 'gate-title',
    'gate-sub', 'gate-go', 'gate-msg', 'pin', 'field-confirm', 'pin-confirm'];
  const map = new Map(ids.map((id) => [id, makeEl()]));
  return {
    getElementById(id) {
      const el = map.get(id);
      // Fail by NAME if lock.js starts reaching for a new node, instead of a
      // bare "cannot read .hidden of undefined" three frames deep.
      if (!el) throw new Error(`fake document has no element #${id}`);
      return el;
    },
    el(id) { return map.get(id); }, // test-side accessor
  };
}

function stubFetch(routes) { // routes: { [path]: (init) => Promise<res> }
  const calls = [];
  globalThis.fetch = async (path, init = {}) => {
    calls.push({ path });
    const handler = routes[path];
    if (!handler) throw new Error(`unrouted fetch: ${path}`);
    return handler(init); // may throw -> code 'network'
  };
  return calls;
}

const okStatus = (data) => async () => ({ ok: true, status: 200, json: async () => data });
const okToken = async () => ({ ok: true, status: 200, json: async () => ({ token: 't', expires_at: 'x' }) });
const flush = () => new Promise((r) => setImmediate(r)); // drains the microtask queue
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

let n = 0;
const freshLock = () => import(`../public/lock.js?t=${++n}`);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.document; // node has no document; delete, do not set undefined
  // T1's success path calls setToken('t') on the ONE api.js instance every
  // test in this file shares (the ?t= cache-buster only freshens lock.js) -
  // without this, later tests would silently carry an auth header.
  clearToken();
});

test('a second submit while one is in flight is ignored, and the first still completes', async () => {
  const d = deferred();
  const calls = stubFetch({
    '/api/auth/status': okStatus({ configured: true, retry_after_ms: 0 }),
    '/api/auth/unlock': () => d.promise,
  });
  const doc = makeDocument();
  globalThis.document = doc;

  const mod = await freshLock();
  const gate = mod.showGate();
  await flush();
  assert.equal(doc.el('gate-go').textContent, 'UNLOCK');

  doc.el('pin').value = '481902';
  const form = doc.el('gate-form');
  form.fire('submit');
  form.fire('submit');
  await flush();

  assert.equal(
    calls.filter((c) => c.path === '/api/auth/unlock').length,
    1,
    'a double tap must send exactly one unlock',
  );
  assert.equal(doc.el('gate-go').disabled, true);

  d.resolve(await okToken());
  await gate;

  assert.equal(calls.filter((c) => c.path === '/api/auth/unlock').length, 1);
  assert.equal(doc.el('gate').hidden, true);
  assert.equal(doc.el('picker').hidden, false);
});

test('a failed status probe relabels the button to RETRY and a tap re-probes instead of posting a passcode', async () => {
  let statusCall = 0;
  const calls = stubFetch({
    '/api/auth/status': () => {
      statusCall += 1;
      if (statusCall <= 2) throw new Error('offline');
      return okStatus({ configured: true, retry_after_ms: 0 })();
    },
    '/api/auth/unlock': () => { throw new Error('must not be called'); },
    '/api/auth/passcode': () => { throw new Error('must not be called'); },
  });
  const doc = makeDocument();
  globalThis.document = doc;

  const mod = await freshLock();
  mod.showGate();
  await flush();

  assert.equal(doc.el('gate-go').textContent, 'RETRY');
  assert.equal(
    doc.el('gate-msg').textContent,
    '! Cannot reach the agent. Check the PC is awake and Tailscale is connected.',
  );

  doc.el('pin').value = '481902';
  const form = doc.el('gate-form');
  form.fire('submit');
  // Synchronous, before the re-probe's await resolves: onSubmit disables the
  // button immediately (lock.js:145), proving the tap actually went through.
  assert.equal(doc.el('gate-go').disabled, true);
  await flush();
  // The re-probe (call 2) also failed. lock.js:125 must re-enable the button
  // or a RETRY tap that fails again strands the owner offline - #gate-go is
  // the form's default button, so a stuck-disabled state kills Enter too.
  assert.equal(doc.el('gate-go').disabled, false);

  form.fire('submit');
  await flush();

  assert.deepEqual(
    calls.map((c) => c.path),
    ['/api/auth/status', '/api/auth/status', '/api/auth/status'],
    'a RETRY tap must re-probe, never POST a passcode to a route we may not have',
  );
  assert.equal(doc.el('gate-go').textContent, 'UNLOCK');
  assert.equal(doc.el('gate-msg').textContent, '');
});

test('showGate() called twice while pending returns the same promise and wires the form once', async () => {
  const calls = stubFetch({
    '/api/auth/status': () => deferred().promise,
  });
  const doc = makeDocument();
  globalThis.document = doc;

  const mod = await freshLock();
  const p1 = mod.showGate();
  const p2 = mod.showGate();

  assert.equal(p1, p2, 'the second call must return the first promise, not start a second gate');
  assert.equal(calls.filter((c) => c.path === '/api/auth/status').length, 1);
  assert.equal(
    doc.el('gate-form').listenerCount('submit'),
    1,
    'a second runGate would stack a second submit listener with stale closed-over state',
  );
  assert.equal(doc.el('pin').listenerCount('input'), 1);
});

test('while the button is a RETRY, typing fewer than six digits does not disable it', async () => {
  let statusCall = 0;
  stubFetch({
    '/api/auth/status': () => {
      statusCall += 1;
      if (statusCall === 1) throw new Error('offline');
      return okStatus({ configured: true, retry_after_ms: 0 })();
    },
  });
  const doc = makeDocument();
  globalThis.document = doc;

  const mod = await freshLock();
  mod.showGate();
  await flush();

  doc.el('gate-go').disabled = true; // force the opposite state first
  doc.el('pin').value = '12';
  doc.el('pin').fire('input');

  assert.equal(
    doc.el('gate-go').disabled,
    false,
    "digit count is irrelevant while the button is a RETRY - disabling it strands the owner offline, and #gate-go is the form default button so it kills Enter too",
  );

  // A second, different under-six-digit value: without the statusUnknown
  // short-circuit (lock.js:102) this would also disable the button, so
  // forcing disabled=true again first keeps this assertion provable too.
  doc.el('gate-go').disabled = true;
  doc.el('pin').value = '5';
  doc.el('pin').fire('input');
  assert.equal(doc.el('gate-go').disabled, false);
});
