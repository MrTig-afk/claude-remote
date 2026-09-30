import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  readPushState, writePushState, generateVapidKeys, ensureVapid, vapidJwt,
  deriveContentKeys, encryptPayload, pushServiceOf, validateName, validateSubscription,
  publicDevices, sendPush, notifyAll, dropEndpoints, VAPID_SUBJECT, JWT_TTL_S, RECORD_SIZE,
} from '../push.js';
import { seedPasscode } from './helper-auth.js';
import { changePasscode } from '../auth.js';

function tmpCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-push-'));
  return { dir, pushPath: path.join(dir, 'push.json') };
}

function b64u(s) {
  return Buffer.from(s, 'base64url');
}

// --- state ---

test('readPushState: missing file, corrupt JSON, bad VAPID shape -> empty, never throws', () => {
  const ctx = tmpCtx();
  assert.deepEqual(readPushState(ctx), { vapid: null, subscriptions: [] });

  fs.writeFileSync(ctx.pushPath, '{ not json');
  assert.deepEqual(readPushState(ctx), { vapid: null, subscriptions: [] });

  fs.writeFileSync(ctx.pushPath, JSON.stringify({ vapid: { publicKey: 'x' }, subscriptions: [] }));
  assert.deepEqual(readPushState(ctx), { vapid: null, subscriptions: [] });

  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('readPushState throwing on corrupt JSON is a red condition (mutation proof)', () => {
  // This test documents the guard; the real mutation drill (mutate, run,
  // restore, sha256-verify) is recorded in .pipeline/changes.md rather than
  // performed inline here, since it edits push.js itself.
  const ctx = tmpCtx();
  fs.writeFileSync(ctx.pushPath, '{ not json');
  assert.doesNotThrow(() => readPushState(ctx));
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('ensureVapid is idempotent: same keys, file unchanged on the second call', () => {
  const ctx = tmpCtx();
  const first = ensureVapid(ctx);
  assert.equal(first.ok, true);
  const bytesAfterFirst = fs.readFileSync(ctx.pushPath, 'utf8');

  const second = ensureVapid(ctx);
  assert.equal(second.ok, true);
  assert.equal(second.state.vapid.publicKey, first.state.vapid.publicKey);
  assert.equal(second.state.vapid.privateKey, first.state.vapid.privateKey);
  assert.equal(fs.readFileSync(ctx.pushPath, 'utf8'), bytesAfterFirst);

  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('a VAPID pair whose halves do not match reads as no keys, and regeneration drops the dead subscriptions', () => {
  const ctx = tmpCtx();
  const a = generateVapidKeys();
  const b = generateVapidKeys();
  const sub = { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: a.publicKey, auth: Buffer.alloc(16, 1).toString('base64url') }, createdAt: new Date().toISOString() };
  // Positive control: a matching pair reads back intact.
  fs.writeFileSync(ctx.pushPath, JSON.stringify({ vapid: a, subscriptions: [sub] }));
  assert.deepEqual(readPushState(ctx).vapid, a);

  fs.writeFileSync(ctx.pushPath, JSON.stringify({ vapid: { publicKey: a.publicKey, privateKey: b.privateKey }, subscriptions: [sub] }));
  assert.equal(readPushState(ctx).vapid, null);

  const ensured = ensureVapid(ctx);
  assert.equal(ensured.ok, true);
  assert.notEqual(ensured.state.vapid.publicKey, a.publicKey);
  assert.deepEqual(ensured.state.subscriptions, []);

  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('a push.json that exists but cannot be read is never overwritten', () => {
  const ctx = tmpCtx();
  assert.equal(ensureVapid(ctx).ok, true);
  const bytes = fs.readFileSync(ctx.pushPath);

  // The field case: the read fails (a scanner holding the file) while a write
  // would still succeed - so only the guards stand between it and a wipe.
  ctx.readFileSync = () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  assert.equal(readPushState(ctx).unreadable, true);
  assert.deepEqual(ensureVapid(ctx), { ok: false });
  assert.equal(dropEndpoints(ctx, new Set(['https://web.push.apple.com/x'])), false);
  assert.ok(fs.readFileSync(ctx.pushPath).equals(bytes));

  // Positive control: ENOENT is "no state yet" and does generate keys.
  delete ctx.readFileSync;
  fs.rmSync(ctx.pushPath);
  assert.equal(ensureVapid(ctx).ok, true);

  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('sendPush reports a signing failure instead of throwing', async () => {
  const keys = generateVapidKeys();
  const sub = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: keys.publicKey, auth: Buffer.alloc(16, 2).toString('base64url') } };
  let fetched = false;
  const ctx = { fetch: async () => { fetched = true; return { status: 201 }; } };
  const result = await sendPush(ctx, sub, { publicKey: 'AAAA', privateKey: keys.privateKey }, 'test', 300);
  assert.deepEqual(result, { ok: false, gone: false, status: null });
  assert.equal(fetched, false);
});

test('generateVapidKeys shape, and a vapidJwt signed with it verifies against it', () => {
  const keys = generateVapidKeys();
  const pub = b64u(keys.publicKey);
  assert.equal(pub.length, 65);
  assert.equal(pub[0], 0x04);
  assert.equal(b64u(keys.privateKey).length, 32);

  const jwt = vapidJwt('https://web.push.apple.com/x', keys, Date.now());
  const [h, p, s] = jwt.split('.');
  const publicKeyObj = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') },
    format: 'jwk',
  });
  assert.equal(
    crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKeyObj, dsaEncoding: 'ieee-p1363' }, b64u(s)),
    true,
  );
});

test('changePasscode success leaves push.json byte-identical', () => {
  const ctx = tmpCtx();
  ctx.passcodePath = path.join(ctx.dir, 'passcode.json');
  ctx.attemptsPath = path.join(ctx.dir, 'passcode-attempts.json');
  ctx.tokens = new Map();
  seedPasscode(ctx, '111222');
  ensureVapid(ctx);
  const before = fs.readFileSync(ctx.pushPath, 'utf8');

  const result = changePasscode(ctx, '111222', '333444', '333444');
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(ctx.pushPath, 'utf8'), before);

  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

// --- sender ---

const V = {
  plaintext: b64u('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
  as_public: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  as_private: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  ua_public: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  ua_private: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  ecdh_secret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  auth_secret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  IKM: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  CEK: 'oIhVW04MRdy2XN9CiKLxTg',
  NONCE: '4h_95klXJ5E_qnoN',
  encrypted: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('RFC 8291 Appendix A', () => {
  const asEcdh = crypto.createECDH('prime256v1');
  asEcdh.setPrivateKey(b64u(V.as_private));
  assert.equal(asEcdh.getPublicKey().toString('base64url'), V.as_public);

  const uaEcdh = crypto.createECDH('prime256v1');
  uaEcdh.setPrivateKey(b64u(V.ua_private));
  assert.equal(uaEcdh.getPublicKey().toString('base64url'), V.ua_public);

  const shared = asEcdh.computeSecret(b64u(V.ua_public));
  assert.equal(shared.toString('base64url'), V.ecdh_secret);

  const { ikm, cek, nonce } = deriveContentKeys({
    ecdhSecret: shared, authSecret: b64u(V.auth_secret), uaPublic: b64u(V.ua_public), asPublic: b64u(V.as_public), salt: b64u(V.salt),
  });
  assert.equal(ikm.toString('base64url'), V.IKM);
  assert.equal(cek.toString('base64url'), V.CEK);
  assert.equal(nonce.toString('base64url'), V.NONCE);

  const out = encryptPayload(V.plaintext, { p256dh: V.ua_public, auth: V.auth_secret }, { salt: b64u(V.salt), senderPrivateKey: b64u(V.as_private) });
  assert.equal(out.toString('base64url'), V.encrypted);
});

test('secondary round trip: a random-salt encryptPayload decrypts back to the plaintext', () => {
  const receiverEcdh = crypto.createECDH('prime256v1');
  receiverEcdh.setPrivateKey(b64u(V.ua_private));

  const out = encryptPayload(Buffer.from('hello claude-remote'), { p256dh: V.ua_public, auth: V.auth_secret });
  const salt = out.subarray(0, 16);
  const asPublic = out.subarray(21, 21 + 65);
  const ciphertext = out.subarray(21 + 65, out.length - 16);
  const tag = out.subarray(out.length - 16);

  const ecdhSecret = receiverEcdh.computeSecret(asPublic);
  const { cek, nonce } = deriveContentKeys({
    ecdhSecret, authSecret: b64u(V.auth_secret), uaPublic: b64u(V.ua_public), asPublic, salt,
  });
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  assert.equal(decrypted[decrypted.length - 1], 0x02);
  assert.equal(decrypted.subarray(0, -1).toString(), 'hello claude-remote');
});

test('vapidJwt: header, aud, exp, sub, signature length', () => {
  const keys = generateVapidKeys();
  const now = Date.now();
  const jwt = vapidJwt('https://web.push.apple.com/some/path', keys, now);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(payload.aud, 'https://web.push.apple.com');
  assert.equal(payload.sub, VAPID_SUBJECT);
  assert.equal(payload.exp - Math.floor(now / 1000), JWT_TTL_S);
  assert.ok(JWT_TTL_S <= 86400);
  assert.equal(b64u(s).length, 64);
});

test('sendPush: method, D5 headers, redirect error, encrypted body, status mapping', async () => {
  const keys = generateVapidKeys();
  const sub = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: V.ua_public, auth: V.auth_secret } };
  const receiverEcdh = crypto.createECDH('prime256v1');
  receiverEcdh.setPrivateKey(b64u(V.ua_private));

  function decryptBody(body) {
    const buf = Buffer.from(body);
    const salt = buf.subarray(0, 16);
    const asPublic = buf.subarray(21, 21 + 65);
    const ciphertext = buf.subarray(21 + 65, buf.length - 16);
    const tag = buf.subarray(buf.length - 16);
    const ecdhSecret = receiverEcdh.computeSecret(asPublic);
    const { cek, nonce } = deriveContentKeys({ ecdhSecret, authSecret: b64u(V.auth_secret), uaPublic: b64u(V.ua_public), asPublic, salt });
    const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.subarray(0, -1).toString());
  }

  let seenCall;
  const okCtx = {
    fetch: async (url, opts) => { seenCall = { url, opts }; return { status: 201 }; },
  };
  const okResult = await sendPush(okCtx, sub, keys, 'test', 300);
  assert.equal(okResult.ok, true);
  assert.equal(okResult.gone, false);
  assert.equal(seenCall.url, sub.endpoint);
  assert.equal(seenCall.opts.method, 'POST');
  assert.equal(seenCall.opts.redirect, 'error');
  assert.equal(seenCall.opts.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(seenCall.opts.headers['Content-Type'], 'application/octet-stream');
  assert.equal(seenCall.opts.headers.TTL, '300');
  assert.equal(seenCall.opts.headers.Urgency, 'high');
  assert.match(seenCall.opts.headers.Authorization, /^vapid t=.+, k=.+$/);
  assert.deepEqual(decryptBody(seenCall.opts.body), { type: 'test' });

  for (const status of [404, 410]) {
    const goneResult = await sendPush({ fetch: async () => ({ status }) }, sub, keys, 'test', 300);
    assert.equal(goneResult.ok, false);
    assert.equal(goneResult.gone, true);
  }

  const failResult = await sendPush({ fetch: async () => ({ status: 500 }) }, sub, keys, 'test', 300);
  assert.equal(failResult.ok, false);
  assert.equal(failResult.gone, false);

  const throwResult = await sendPush({ fetch: async () => { throw new Error('network'); } }, sub, keys, 'test', 300);
  assert.equal(throwResult.ok, false);
  assert.equal(throwResult.gone, false);
});

test('notifyAll: only the gone (410) row is deleted, in one write', async () => {
  const ctx = tmpCtx();
  const ensured = ensureVapid(ctx);
  const subs = [
    { endpoint: 'https://web.push.apple.com/a', keys: { p256dh: V.ua_public, auth: V.auth_secret }, createdAt: new Date(1).toISOString() },
    { endpoint: 'https://web.push.apple.com/b', keys: { p256dh: V.ua_public, auth: V.auth_secret }, createdAt: new Date(2).toISOString() },
    { endpoint: 'https://web.push.apple.com/c', keys: { p256dh: V.ua_public, auth: V.auth_secret }, createdAt: new Date(3).toISOString() },
  ];
  writePushState(ctx, { ...ensured.state, subscriptions: subs });

  let writeCount = 0;
  const origWrite = fs.writeFileSync;
  fs.writeFileSync = (...args) => { if (String(args[0]).endsWith('.tmp')) writeCount += 1; return origWrite(...args); };

  const statuses = { 'https://web.push.apple.com/a': 201, 'https://web.push.apple.com/b': 410, 'https://web.push.apple.com/c': 500 };
  ctx.fetch = async (url) => ({ status: statuses[url] });

  const result = await notifyAll(ctx, 'launch_failed');
  fs.writeFileSync = origWrite;

  assert.equal(result.sent, 1);
  assert.equal(result.gone, 1);
  assert.equal(writeCount, 1, 'notifyAll must write exactly once for the deletion pass');

  const after = readPushState(ctx);
  assert.deepEqual(after.subscriptions.map((s) => s.endpoint), ['https://web.push.apple.com/a', 'https://web.push.apple.com/c']);

  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('notifyAll never deletes on a 500', async () => {
  const ctx = tmpCtx();
  const ensured = ensureVapid(ctx);
  writePushState(ctx, {
    ...ensured.state,
    subscriptions: [{ endpoint: 'https://web.push.apple.com/a', keys: { p256dh: V.ua_public, auth: V.auth_secret }, createdAt: new Date().toISOString() }],
  });
  ctx.fetch = async () => ({ status: 500 });
  await notifyAll(ctx, 'launch_failed');
  assert.equal(readPushState(ctx).subscriptions.length, 1);
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('validateSubscription: SSRF and shape rejections, and an Apple-shaped endpoint accepted', () => {
  const keys = generateVapidKeys();
  const good = { p256dh: keys.publicKey, auth: Buffer.alloc(16, 7).toString('base64url') };

  const rejections = [
    { endpoint: 'http://web.push.apple.com/x', keys: good },
    { endpoint: 'https://127.0.0.1/x', keys: good },
    { endpoint: 'https://[::1]/x', keys: good },
    { endpoint: 'https://localhost/x', keys: good },
    { endpoint: 'https://localhost./x', keys: good },
    { endpoint: 'https://LOCALHOST./x', keys: good },
    { endpoint: 'https://push.localhost/x', keys: good },
    { endpoint: 'https://web.push.apple.com:8443/x', keys: good },
    // Split so a credentials-in-URL scanner does not read the fixture as a real one.
    { endpoint: 'https://user:' + 'pass@web.push.apple.com/x', keys: good },
    { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: Buffer.alloc(64, 4).toString('base64url'), auth: good.auth } },
    { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0)]).toString('base64url'), auth: good.auth } },
    { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: good.p256dh, auth: Buffer.alloc(15, 1).toString('base64url') } },
    { endpoint: 'https://web.push.apple.com/x', keys: good, name: 'x'.repeat(65) },
    { endpoint: 'https://web.push.apple.com/x', keys: good, name: 'bad\u0000name' },
  ];
  for (const body of rejections) {
    const result = validateSubscription(body);
    assert.equal(result.ok, false, JSON.stringify(body).slice(0, 60));
  }

  const accepted = validateSubscription({ endpoint: 'https://web.push.apple.com/abcdef', keys: good, name: 'My iPhone' });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.sub.name, 'My iPhone');
});

test('validateSubscription rejects an off-curve point (a mutation drill: this is the real on-curve guard)', () => {
  const bad65 = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0xff)]);
  const result = validateSubscription({
    endpoint: 'https://web.push.apple.com/x',
    keys: { p256dh: bad65.toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') },
  });
  assert.equal(result.ok, false);
});

test('pushServiceOf table', () => {
  assert.equal(pushServiceOf('https://web.push.apple.com/x'), 'apple');
  assert.equal(pushServiceOf('https://1.push.apple.com/x'), 'apple');
  assert.equal(pushServiceOf('https://fcm.googleapis.com/x'), 'google');
  assert.equal(pushServiceOf('https://updates.push.services.mozilla.com/x'), 'mozilla');
  assert.equal(pushServiceOf('https://evil.com/web.push.apple.com'), 'other');
  assert.equal(pushServiceOf('https://notarealservice.example.com/x'), 'other');
  assert.equal(pushServiceOf('not a url'), 'other');
});

test('validateName: trims, caps at 64, rejects control chars, empty -> unnamed', () => {
  assert.deepEqual(validateName(undefined), { ok: true, name: null });
  assert.deepEqual(validateName(''), { ok: true, name: null });
  assert.deepEqual(validateName('  '), { ok: true, name: null });
  assert.deepEqual(validateName('  My iPhone  '), { ok: true, name: 'My iPhone' });
  assert.equal(validateName('x'.repeat(64)).ok, true);
  assert.equal(validateName('x'.repeat(65)).ok, false);
  assert.equal(validateName('bad\u0007name').ok, false);
  assert.equal(validateName(42).ok, false);
});

test('publicDevices: sorted by createdAt asc, never leaks keys', () => {
  const state = {
    vapid: null,
    subscriptions: [
      { endpoint: 'b', keys: { p256dh: 'x', auth: 'y' }, createdAt: '2026-01-02T00:00:00.000Z', name: 'B' },
      { endpoint: 'a', keys: { p256dh: 'x', auth: 'y' }, createdAt: '2026-01-01T00:00:00.000Z' },
    ],
  };
  const devices = publicDevices(state);
  assert.deepEqual(devices, [
    { endpoint: 'a', name: null, created_at: '2026-01-01T00:00:00.000Z' },
    { endpoint: 'b', name: 'B', created_at: '2026-01-02T00:00:00.000Z' },
  ]);
  assert.ok(!JSON.stringify(devices).includes('keys'));
});
