// The five /api/push* routes: agent/server.js's HTTP plumbing over
// agent/push.js's state and crypto.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateVapidKeys } from '../push.js';
import {
  makeAuthCtx, cleanupAuthCtx, seedPasscode, issueTestToken, makeAuthedFetch, fixtureServer,
} from './helper-auth.js';

async function startServer(t, { fetchImpl } = {}) {
  const ctx = makeAuthCtx();
  t.after(() => cleanupAuthCtx(ctx));
  seedPasscode(ctx, '481902');
  if (fetchImpl) ctx.fetch = fetchImpl;
  const server = fixtureServer(ctx);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = issueTestToken(ctx);
  return { ctx, origin, authed: makeAuthedFetch(origin, token), unauthed: (p, opts) => fetch(`${origin}${p}`, opts) };
}

function shapedKeys() {
  const keys = generateVapidKeys();
  return { p256dh: keys.publicKey, auth: Buffer.alloc(16, 3).toString('base64url') };
}

test('every push route -> 401 without a token', async (t) => {
  const { unauthed } = await startServer(t);
  const calls = [
    ['GET', '/api/push'],
    ['POST', '/api/push/devices'],
    ['POST', '/api/push/devices/rename'],
    ['POST', '/api/push/devices/remove'],
    ['POST', '/api/push/test'],
  ];
  for (const [method, p] of calls) {
    const res = await unauthed(p, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    assert.equal(res.status, 401, `${method} ${p}`);
  }
});

test('GET /api/push lazily creates push.json and returns a 65-byte key with an empty device list', async (t) => {
  const { authed } = await startServer(t);
  const res = await authed('/api/push');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(Buffer.from(body.public_key, 'base64url').length, 65);
  assert.deepEqual(body.devices, []);
});

test('re-subscribing without a name keeps the name set by rename', async (t) => {
  const { authed } = await startServer(t);
  const keys = shapedKeys();
  const endpoint = 'https://web.push.apple.com/dev-keep';
  const post = (body) => authed('/api/push/devices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  assert.equal((await post({ endpoint, keys })).status, 201);
  const renamed = await authed('/api/push/devices/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, name: 'Work iPhone' }),
  });
  assert.equal(renamed.status, 200);

  const resub = await post({ endpoint, keys });
  assert.equal(resub.status, 200);
  assert.equal((await resub.json()).device.name, 'Work iPhone');
});

test('POST /api/push/devices: add, same-endpoint update keeps createdAt, invalid, 33rd cap', async (t) => {
  const { authed } = await startServer(t);
  const keys = shapedKeys();
  const endpoint = 'https://web.push.apple.com/dev-a';

  const add = await authed('/api/push/devices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint, keys, name: 'My iPhone' }),
  });
  assert.equal(add.status, 201);
  const addedBody = await add.json();
  assert.equal(addedBody.device.name, 'My iPhone');
  const createdAt = addedBody.device.created_at;

  const update = await authed('/api/push/devices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint, keys, name: 'Renamed' }),
  });
  assert.equal(update.status, 200);
  const updatedBody = await update.json();
  assert.equal(updatedBody.device.name, 'Renamed');
  assert.equal(updatedBody.device.created_at, createdAt, 'createdAt must be kept on an update');

  const invalid = await authed('/api/push/devices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: 'not-a-url', keys }),
  });
  assert.equal(invalid.status, 400);

  for (let i = 0; i < 31; i += 1) {
    const res = await authed('/api/push/devices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: `https://web.push.apple.com/dev-${i}`, keys }),
    });
    assert.equal(res.status, 201, `filler device ${i}`);
  }
  // 32 devices now on file (dev-a plus 31 fillers); the 33rd distinct endpoint must be refused.
  const overflow = await authed('/api/push/devices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: 'https://web.push.apple.com/dev-overflow', keys }),
  });
  assert.equal(overflow.status, 409);
  assert.equal((await overflow.json()).error, 'too_many_devices');
});

test('POST /api/push/devices/rename: 200, blank clears the name, unknown 404', async (t) => {
  const { authed } = await startServer(t);
  const keys = shapedKeys();
  const endpoint = 'https://web.push.apple.com/dev-b';
  await authed('/api/push/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, keys, name: 'Old' }) });

  const renamed = await authed('/api/push/devices/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, name: 'New' }) });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).device.name, 'New');

  const cleared = await authed('/api/push/devices/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, name: '' }) });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).device.name, null);

  const unknown = await authed('/api/push/devices/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: 'https://web.push.apple.com/nope', name: 'X' }) });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'device_not_found');
});

test('POST /api/push/devices/remove: 204, then gone; unknown 404', async (t) => {
  const { authed } = await startServer(t);
  const keys = shapedKeys();
  const endpoint = 'https://web.push.apple.com/dev-c';
  await authed('/api/push/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, keys }) });

  const removed = await authed('/api/push/devices/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint }) });
  assert.equal(removed.status, 204);

  const list = await authed('/api/push');
  assert.deepEqual((await list.json()).devices, []);

  const unknown = await authed('/api/push/devices/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint }) });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'device_not_found');
});

test('POST /api/push/test: 201 -> accepted; 410 -> device_gone and the row is deleted; 500 -> 502; throw -> 502', async (t) => {
  let statusToReturn = 201;
  let shouldThrow = false;
  const { authed } = await startServer(t, {
    fetchImpl: async () => {
      if (shouldThrow) throw new Error('network down');
      return { status: statusToReturn };
    },
  });
  const keys = shapedKeys();
  const endpoint = 'https://web.push.apple.com/dev-d';
  await authed('/api/push/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, keys }) });

  const okRes = await authed('/api/push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint }) });
  assert.equal(okRes.status, 200);
  assert.deepEqual(await okRes.json(), { accepted: true, service: 'apple' });

  statusToReturn = 410;
  const goneRes = await authed('/api/push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint }) });
  assert.equal(goneRes.status, 410);
  assert.deepEqual(await goneRes.json(), { error: 'device_gone', service: 'apple' });
  const afterGone = await authed('/api/push');
  assert.deepEqual((await afterGone.json()).devices, []);

  await authed('/api/push/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, keys }) });
  statusToReturn = 500;
  const failRes = await authed('/api/push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint }) });
  assert.equal(failRes.status, 502);
  assert.deepEqual(await failRes.json(), { error: 'push_failed', service: 'apple' });

  shouldThrow = true;
  const throwRes = await authed('/api/push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint }) });
  assert.equal(throwRes.status, 502);
});

test('the VAPID private key string never appears in any push route response body', async (t) => {
  const { ctx, authed } = await startServer(t);
  const keys = shapedKeys();
  const endpoint = 'https://web.push.apple.com/dev-e';

  const bodies = [];
  bodies.push(await (await authed('/api/push')).text());
  bodies.push(await (await authed('/api/push/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, keys, name: 'X' }) })).text());
  bodies.push(await (await authed('/api/push/devices/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, name: 'Y' }) })).text());
  bodies.push(await (await authed('/api/push')).text());

  const state = (await import('../push.js')).readPushState(ctx);
  assert.ok(state.vapid && state.vapid.privateKey, 'fixture: vapid must have been generated');
  for (const body of bodies) {
    assert.ok(!body.includes(state.vapid.privateKey), 'a response leaked the VAPID private key');
    assert.ok(!body.includes('privateKey'), 'a response leaked the privateKey field name');
  }
});
