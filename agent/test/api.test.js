import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';

import { getProjects, unlock } from '../public/api.js';

// api.js is the browser module under test; it calls the global fetch(),
// which Node provides. Stubbing globalThis.fetch is enough to drive
// request()'s branches without a real server.
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// request() is contracted never to throw. A body that parses to literal null
// would break that on data.error, and callers index into .data on the success
// path - so both routes go through the same non-object guard.

test('request() treats a literal null ERROR body as bad_response, not a throw', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => null });
  const res = await getProjects();
  assert.deepEqual(res, { ok: false, status: 500, code: 'bad_response' });
});

test('request() treats a literal null SUCCESS body as bad_response, not data:null handed to callers', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => null });
  const res = await getProjects();
  assert.deepEqual(res, { ok: false, status: 200, code: 'bad_response' });
});

// --- Regression: a normal object body on both paths is untouched. ---

test('request() still returns the error code from a normal object error body', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'not_found' }) });
  const res = await getProjects();
  // data is carried through alongside code so the passcode gate's lock
  // screen can read retry_after_ms off it; existing callers ignore the key.
  assert.deepEqual(res, { ok: false, status: 404, code: 'not_found', data: { error: 'not_found' } });
});

test('request() still returns data for a normal object success body', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ projects: [] }) });
  const res = await getProjects();
  assert.deepEqual(res, { ok: true, status: 200, data: { projects: [] } });
});

// --- The gate must not reject its own client ---
// The auth POSTs are rejected unless they carry Content-Type: application/json,
// which is what forces a cross-origin preflight. These assert the PWA actually
// sends that header, so the guard can never lock the real client out.

test('the auth POSTs send Content-Type: application/json, which the 415 guard requires', async () => {
  let captured = null;
  globalThis.fetch = async (path, init) => {
    captured = init;
    return { ok: true, status: 200, json: async () => ({ token: 't', expires_at: 'x' }) };
  };
  await unlock('481902');
  assert.equal(captured.headers['Content-Type'], 'application/json');
});

// --- A timeout during the BODY read is a timeout ---
// AbortSignal.timeout aborts the body stream too, so headers can arrive inside
// the window and the body stall past it. That lands in the json() catch, not the
// fetch() catch. Calling it bad_response there is not a cosmetic mislabel:
// load() routes only 'network' and 'timeout' into the waiting ladder, and
// everything else gets an error banner with waitTries reset and NO retry - so a
// PC that slept mid-response stranded the app on "the agent refused the
// request" instead of the retry state built for exactly that case.
//
// Written after a mutation audit found this fix had no executable coverage: the
// discrimination could be deleted and 1027 tests stayed green.

const throwingJson = (name) => async () => {
  const err = new Error('the operation was aborted');
  err.name = name;
  throw err;
};

test('request() reports a TimeoutError raised by the BODY read as timeout, not bad_response', async () => {
  // RED WHEN: the json() catch stops discriminating and returns bad_response
  // for every failure, which is what it did before this fix.
  globalThis.fetch = async () => ({ ok: true, status: 200, json: throwingJson('TimeoutError') });
  const res = await getProjects();
  assert.deepEqual(res, { ok: false, status: 0, code: 'timeout' });
});

test('request() reports an AbortError raised by the BODY read as timeout too', async () => {
  // Both names are checked because which one surfaces depends on the runtime:
  // AbortSignal.timeout gives TimeoutError, an explicit abort gives AbortError,
  // and the app must reach the retry ladder either way.
  globalThis.fetch = async () => ({ ok: true, status: 200, json: throwingJson('AbortError') });
  const res = await getProjects();
  assert.deepEqual(res, { ok: false, status: 0, code: 'timeout' });
});

test('a body that is genuinely unparseable is still bad_response, with its real status', async () => {
  // The other side of the discrimination, so a fix that returns 'timeout' for
  // EVERY body failure - which would also make the two tests above pass - is
  // caught here. Status is asserted as well: a real HTTP status survives, where
  // the timeout branch deliberately reports 0.
  globalThis.fetch = async () => ({ ok: true, status: 200, json: throwingJson('SyntaxError') });
  const res = await getProjects();
  assert.deepEqual(res, { ok: false, status: 200, code: 'bad_response' });
});
