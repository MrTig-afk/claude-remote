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
    // The eye toggle's surface: it flips the input's type, and on the button
    // it moves aria-pressed, aria-label and the <use href>. dataset.pinName
    // is the noun the label is built from.
    type: 'password',
    dataset: { pinName: 'passcode' },
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    querySelector() { return this._use || (this._use = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }); },
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

function makeDocument({ visibilityState = 'visible' } = {}) {
  const ids = ['picker', 'gate', 'gate-form', 'gate-label', 'gate-title',
    'gate-sub', 'gate-go', 'gate-msg', 'pin', 'field-confirm', 'pin-confirm',
    // The two eye toggles, found by the `<input id>-eye` convention.
    'pin-eye', 'pin-confirm-eye'];
  const map = new Map(ids.map((id) => [id, makeEl()]));
  // document itself, not just its elements: the gate's own retry loop reads
  // visibilityState so it does not sit retrying in the background, and
  // listens for visibilitychange so it restarts on the way back.
  const docListeners = makeEl();
  return {
    visibilityState,
    addEventListener: (t, fn) => docListeners.addEventListener(t, fn),
    removeEventListener: (t, fn) => docListeners.removeEventListener(t, fn),
    getElementById(id) {
      const el = map.get(id);
      // Fail by NAME if lock.js starts reaching for a new node, instead of a
      // bare "cannot read .hidden of undefined" three frames deep.
      if (!el) throw new Error(`fake document has no element #${id}`);
      return el;
    },
    el(id) { return map.get(id); }, // test-side accessor
    docListenerCount(type) { return docListeners.listenerCount(type); },
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
  // Parked HIDDEN rather than deleted. The gate now runs its own retry loop
  // when the agent is silent, and a test can end with one of its gaps still
  // pending; a browser never takes `document` away underneath that, so a
  // deleted one would throw from a timer belonging to a finished test and
  // surface as an unhandledRejection in whichever test is running by then.
  // Hidden is the state that makes the loop exit on its own next tick. Every
  // test installs its own document first, so nothing reads this one.
  globalThis.document = {
    visibilityState: 'hidden',
    addEventListener() {},
    removeEventListener() {},
    getElementById() { return makeEl(); },
  };
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
  // Silence from the agent now reads as "waiting", not as a dead end: the
  // gate retries on its own (nothing here waits for one of those gaps), and
  // RETRY is the manual kick on top of it, not the only way forward.
  assert.equal(
    doc.el('gate-msg').textContent,
    'Waiting for the PC. This screen will unlock itself as soon as the agent answers.',
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

// The HIGH finding this loop exists for: the gate is the screen a cold-boot
// open LANDS on, every time (the token is memory-only, so showGate runs
// before app.js ever calls load()). Before this, it dead-ended on
// '! Cannot reach the agent' with a RETRY button and nothing retrying.
test('the gate re-probes on its own while the agent is silent, with no tap at all', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let statusCall = 0;
  const calls = stubFetch({
    '/api/auth/status': () => {
      statusCall += 1;
      if (statusCall <= 2) throw new Error('offline'); // PC still booting
      return okStatus({ configured: true, retry_after_ms: 0 })();
    },
  });
  const doc = makeDocument();
  globalThis.document = doc;

  const mod = await freshLock();
  mod.showGate();
  await flush();
  assert.equal(calls.length, 1, 'the first probe is the one showGate makes');

  // No submit, no tap: just the first gap elapsing.
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(calls.length, 2, 'the gate must re-probe by itself');
  assert.equal(doc.el('gate-msg').textContent, 'Waiting for the PC (1)...');

  t.mock.timers.tick(3000);
  await flush();
  assert.equal(calls.length, 3);
  // Third probe succeeded - the gate is a real lock screen again and the
  // waiting copy is gone.
  assert.equal(doc.el('gate-go').textContent, 'UNLOCK');
  assert.equal(doc.el('gate-msg').textContent, '');

  // And it stops: no further probe once the agent has answered.
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(calls.length, 3, 'the loop must stop on the first success');
});

test('the gate does not retry while the app is in the background', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const calls = stubFetch({
    '/api/auth/status': () => { throw new Error('offline'); },
  });
  const doc = makeDocument({ visibilityState: 'hidden' });
  globalThis.document = doc;

  const mod = await freshLock();
  mod.showGate();
  await flush();
  assert.equal(calls.length, 1);

  t.mock.timers.tick(60000);
  await flush();
  assert.equal(calls.length, 1, 'a backgrounded app must not sit probing the network');

  // Coming back to the foreground is what restarts it - app.js's own
  // visibilitychange handler is not wired until after the gate resolves.
  doc.visibilityState = 'visible';
  assert.equal(doc.docListenerCount('visibilitychange'), 1,
    'the gate must listen for the way back, or it freezes for good');
});

// --- The eye toggle on the gate (Lane 1 and Lane 2 both draw one) ----------

test('the eye reveals ONE field, and the other stays masked', async () => {
  // RED WHEN: one toggle starts driving both fields, or the icon swaps while
  // aria-pressed does not - a reveal a screen reader cannot hear.
  stubFetch({ '/api/auth/status': okStatus({ configured: false, retry_after_ms: 0 }) });
  const doc = makeDocument();
  globalThis.document = doc;

  const mod = await freshLock();
  mod.showGate();
  await flush();
  assert.equal(doc.el('field-confirm').hidden, false, 'first run shows the CONFIRM field');

  doc.el('pin-eye').fire('click');
  assert.equal(doc.el('pin').type, 'text');
  assert.equal(doc.el('pin-eye').getAttribute('aria-pressed'), 'true');
  assert.match(doc.el('pin-eye').getAttribute('aria-label'), /^Hide /);
  assert.equal(doc.el('pin-eye').querySelector().attrs.href, '#i-eye');
  assert.equal(doc.el('pin-confirm').type, 'password', 'the other field must not follow');

  doc.el('pin-eye').fire('click');
  assert.equal(doc.el('pin').type, 'password');
  assert.equal(doc.el('pin-eye').getAttribute('aria-pressed'), 'false');
  assert.equal(doc.el('pin-eye').querySelector().attrs.href, '#i-eyeoff');
});

test('a wrong passcode clears the field AND re-masks it', async () => {
  // RED WHEN: clearInputs empties the box but leaves it revealed, so the next
  // person to pick the phone up finds a passcode field set to show its digits.
  stubFetch({
    '/api/auth/status': okStatus({ configured: true, retry_after_ms: 0 }),
    '/api/auth/unlock': async () => ({
      ok: false, status: 401, json: async () => ({ error: 'passcode_incorrect', failures: 1, retry_after_ms: 0 }),
    }),
  });
  const doc = makeDocument();
  globalThis.document = doc;

  const mod = await freshLock();
  mod.showGate();
  await flush();

  doc.el('pin').value = '481902';
  doc.el('pin-eye').fire('click');
  assert.equal(doc.el('pin').type, 'text', 'fixture: the field is revealed before the failure');

  doc.el('gate-form').fire('submit');
  await flush();

  assert.equal(doc.el('pin').value, '');
  assert.equal(doc.el('pin').type, 'password', 'a cleared field must be re-masked');
  assert.equal(doc.el('pin-eye').getAttribute('aria-pressed'), 'false');
});

test('the eye is unwired on the way out, so a second showGate cannot stack a listener', async () => {
  // RED WHEN: the eye listeners outlive the run. showGate() runs again after
  // a token expiry, and a listener left behind holds the previous run's
  // closure over the same node - two toggles per tap, which cancel out and
  // look like a dead control.
  stubFetch({
    '/api/auth/status': okStatus({ configured: true, retry_after_ms: 0 }),
    '/api/auth/unlock': okToken,
  });
  const doc = makeDocument();
  globalThis.document = doc;

  const mod = await freshLock();
  const gate = mod.showGate();
  await flush();
  assert.equal(doc.el('pin-eye').listenerCount('click'), 1);

  doc.el('pin').value = '481902';
  doc.el('gate-form').fire('submit');
  await gate;

  assert.equal(doc.el('pin-eye').listenerCount('click'), 0, 'the eye must be unwired with the rest');
});
