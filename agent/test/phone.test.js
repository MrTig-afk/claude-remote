// agent/phone.js and its routes: tailscale serve runs only
// after the passcode is first set, only on the real server's opt-in, and the
// desk learns the address from Tailscale. Every tailscale call here is a fake
// handed in as ctx.tailscaleRun - no test runs the real binary.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { phoneUrl, startServe, phoneStatus } from '../phone.js';
import { makeAuthCtx, cleanupAuthCtx, seedPasscode, issueTestToken, authHeaders, fixtureServer } from './helper-auth.js';

const STATUS = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'Desktop-ABC1234.tail1a2b3c.ts.net.' } });
const SERVE_ON = JSON.stringify({ Web: { 'desktop-abc1234.tail1a2b3c.ts.net:8790': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8790' } } } } });
const URL_8790 = 'https://desktop-abc1234.tail1a2b3c.ts.net:8790';

/** A fake tailscale: records every call, answers from `answers` by joined args. */
function fakeTailscale(answers = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const a = answers[args.join(' ')];
    if (a instanceof Promise) return a;
    return a ?? { ok: true, stdout: '' };
  };
  return { calls, run };
}

const OK = { 'status --json': { ok: true, stdout: STATUS }, 'serve status --json': { ok: true, stdout: SERVE_ON } };

async function start(t, extra = {}) {
  const ctx = { ...makeAuthCtx(), ...extra };
  const server = fixtureServer(ctx);
  t.after(() => { server.close(); cleanupAuthCtx(ctx); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { ctx, origin: `http://127.0.0.1:${server.address().port}` };
}

const setPasscodeReq = (origin) => fetch(`${origin}/api/auth/passcode`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: '482913', confirm: '482913' }),
});

test('phoneUrl: the trailing dot goes, the name is lower-cased, junk and bad ports are refused', () => {
  assert.equal(phoneUrl(STATUS, 8790), URL_8790);
  assert.equal(phoneUrl(JSON.stringify({ Self: { DNSName: 'localhost.' } }), 8790), null, 'a single label is not a tailnet name');
  assert.equal(phoneUrl(JSON.stringify({ Self: { DNSName: 'evil.ts.net/x?' } }), 8790), null);
  assert.equal(phoneUrl(JSON.stringify({ Self: {} }), 8790), null);
  assert.equal(phoneUrl('not json', 8790), null);
  assert.equal(phoneUrl(STATUS, 0), null);
  assert.equal(phoneUrl(STATUS, 8790.5), null);
});

test('the first passcode set switches serve on, then asks the address once, without holding the reply', async (t) => {
  const { calls, run } = fakeTailscale({ ...OK, 'serve --bg --https=8790 8790': new Promise(() => {}) });
  const { ctx, origin } = await start(t, { phoneServe: true, tailscaleRun: run, port: 8790 });
  const res = await setPasscodeReq(origin);
  assert.equal(res.status, 201, 'a serve that never returns must not hold the passcode reply');
  assert.deepEqual(calls[0], ['serve', '--bg', '--https=8790', '8790']);
  assert.ok(ctx.phoneServing, 'the serve is in flight');
});

test('after serve, the tailnet address is requested once so the certificate is issued', async (t) => {
  const { calls, run } = fakeTailscale(OK);
  const warmed = [];
  const { ctx, origin } = await start(t, {
    phoneServe: true, tailscaleRun: run, port: 8790, warmFetch: async (url, opts) => { warmed.push({ url, opts }); return {}; },
  });
  assert.equal((await setPasscodeReq(origin)).status, 201);
  await ctx.phoneServing;
  assert.deepEqual(calls, [['serve', '--bg', '--https=8790', '8790'], ['status', '--json']]);
  assert.equal(warmed.length, 1);
  assert.equal(warmed[0].url, URL_8790);
  assert.ok(warmed[0].opts.signal instanceof AbortSignal, 'the request carries a timeout');
});

test('without the real server\'s opt-in, setting a passcode runs nothing', async (t) => {
  const { calls, run } = fakeTailscale(OK);
  const { ctx, origin } = await start(t, { tailscaleRun: run });
  assert.equal((await setPasscodeReq(origin)).status, 201);
  assert.equal(ctx.phoneServing, undefined);
  assert.deepEqual(calls, []);
});

test('serve never runs while no passcode is configured, whoever asks', async (t) => {
  const { calls, run } = fakeTailscale(OK);
  const ctx = { ...makeAuthCtx(), phoneServe: true, tailscaleRun: run };
  t.after(() => cleanupAuthCtx(ctx));
  assert.equal(await startServe(ctx, 8790), 'off');
  assert.deepEqual(calls, []);
});

test('neither a runner nor the opt-in: every answer is unknown', async (t) => {
  const ctx = makeAuthCtx();
  t.after(() => cleanupAuthCtx(ctx));
  seedPasscode(ctx, '482913');
  assert.equal(await startServe(ctx, 8790), 'unknown');
  assert.deepEqual(await phoneStatus(ctx, 8790), { url: null, serve: 'unknown' });
});

test('two callers share one serve run', async (t) => {
  let release;
  const { calls, run } = fakeTailscale({ ...OK, 'serve --bg --https=8790 8790': new Promise((r) => { release = r; }) });
  const ctx = { ...makeAuthCtx(), tailscaleRun: run, warmFetch: async () => ({}) };
  t.after(() => cleanupAuthCtx(ctx));
  seedPasscode(ctx, '482913');
  const a = startServe(ctx, 8790);
  const b = startServe(ctx, 8790);
  release({ ok: true, stdout: '' });
  assert.deepEqual(await Promise.all([a, b]), ['on', 'on']);
  assert.equal(calls.filter((c) => c[0] === 'serve' && c[1] === '--bg').length, 1);
});

test('GET /api/phone needs the token, then reports the address and serve state from Tailscale', async (t) => {
  const { run } = fakeTailscale(OK);
  const { ctx, origin } = await start(t, { tailscaleRun: run, port: 8790 });
  seedPasscode(ctx, '482913');
  assert.equal((await fetch(`${origin}/api/phone`)).status, 401);
  const token = issueTestToken(ctx);
  const res = await fetch(`${origin}/api/phone`, { headers: authHeaders(token) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { url: URL_8790, serve: 'on' });
});

test('GET /api/phone: no serve config is off; a tailscale that does not answer is unknown', async (t) => {
  const off = fakeTailscale({ ...OK, 'serve status --json': { ok: true, stdout: 'null' } });
  const ctx = { ...makeAuthCtx(), tailscaleRun: off.run };
  t.after(() => cleanupAuthCtx(ctx));
  assert.deepEqual(await phoneStatus(ctx, 8790), { url: URL_8790, serve: 'off' });
  ctx.tailscaleRun = fakeTailscale({ 'status --json': { ok: false, code: 'timeout' }, 'serve status --json': { ok: false, code: 'ENOENT' } }).run;
  assert.deepEqual(await phoneStatus(ctx, 8790), { url: null, serve: 'unknown' });
});

test('POST /api/phone/retry runs serve again and answers with the fresh state', async (t) => {
  const { calls, run } = fakeTailscale(OK);
  const { ctx, origin } = await start(t, { tailscaleRun: run, port: 8790, warmFetch: async () => ({}) });
  seedPasscode(ctx, '482913');
  const token = issueTestToken(ctx);
  assert.equal((await fetch(`${origin}/api/phone/retry`, { method: 'POST' })).status, 401);
  const res = await fetch(`${origin}/api/phone/retry`, { method: 'POST', headers: authHeaders(token) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { url: URL_8790, serve: 'on' });
  assert.deepEqual(calls[0], ['serve', '--bg', '--https=8790', '8790']);
});

test('a failed serve is logged by its code only, and reads as off', async (t) => {
  const { run } = fakeTailscale({ ...OK, 'serve --bg --https=8790 8790': { ok: false, code: '1' } });
  const ctx = { ...makeAuthCtx(), tailscaleRun: run };
  t.after(() => cleanupAuthCtx(ctx));
  seedPasscode(ctx, '482913');
  const warned = [];
  t.mock.method(console, 'warn', (line) => warned.push(line));
  assert.equal(await startServe(ctx, 8790), 'off');
  assert.deepEqual(warned, ['claude-remote agent: tailscale serve failed: 1']);
});
