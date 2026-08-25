import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';

import { getProjects } from '../public/api.js';

// api.js is the browser module under test; it calls the global fetch(),
// which Node provides. Stubbing globalThis.fetch is enough to drive
// request()'s branches without a real server.
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// --- Fix 5 (T30 fix pass, review issue 5): a body that parses to literal
// null must never throw on data.error / be indexed by callers - both the
// error path and the success path route through the same guard. ---

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
  assert.deepEqual(res, { ok: false, status: 404, code: 'not_found' });
});

test('request() still returns data for a normal object success body', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ projects: [] }) });
  const res = await getProjects();
  assert.deepEqual(res, { ok: true, status: 200, data: { projects: [] } });
});
