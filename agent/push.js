import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';

import { getPushFilePath, writeConfig } from './config.js';

export const VAPID_SUBJECT = 'https://github.com/MrTig-afk/claude-remote';
export const JWT_TTL_S = 12 * 60 * 60;
export const EVENT_TTL_S = 86_400;
export const TEST_TTL_S = 300;
export const RECORD_SIZE = 4096;
export const MAX_DEVICES = 32;
export const MAX_NAME_CHARS = 64;

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const PUSH_FETCH_TIMEOUT_MS = 10_000;

function b64uDecode(s) {
  return Buffer.from(s, 'base64url');
}

function validVapidShape(v) {
  if (v === null || typeof v !== 'object') return false;
  const { publicKey, privateKey } = v;
  if (typeof publicKey !== 'string' || typeof privateKey !== 'string') return false;
  if (!B64URL_RE.test(publicKey) || !B64URL_RE.test(privateKey)) return false;
  const pubBuf = b64uDecode(publicKey);
  const privBuf = b64uDecode(privateKey);
  if (pubBuf.length !== 65 || pubBuf[0] !== 0x04 || privBuf.length !== 32) return false;
  // createPrivateKey accepts a d that does not belong to x/y (measured), so the
  // pair is proven here: a mismatched pair would sign every push invalidly.
  try {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(privBuf);
    return ecdh.getPublicKey().equals(pubBuf);
  } catch {
    return false;
  }
}

function validSubscriptionRow(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return false;
  if (typeof row.endpoint !== 'string' || row.endpoint === '') return false;
  if (row.keys === null || typeof row.keys !== 'object') return false;
  if (typeof row.keys.p256dh !== 'string' || typeof row.keys.auth !== 'string') return false;
  if (typeof row.createdAt !== 'string' || row.createdAt === '') return false;
  if (row.name !== undefined && typeof row.name !== 'string') return false;
  return true;
}

/**
 * push.json, or the empty shape on any missing/corrupt/malformed read. Never
 * throws - the same fail-open posture as auth.js's readPasscodeFile, for the
 * same reason: this is read on nearly every request that touches push state.
 */
export function readPushState(ctx) {
  let raw;
  try {
    raw = (ctx.readFileSync || fs.readFileSync)(ctx.pushPath || getPushFilePath(), 'utf8');
  } catch (err) {
    // Only ENOENT means "no state yet". Anything else (EBUSY/EPERM while a
    // scanner holds the file) is unknown state, and nothing may be written
    // over it - see ensureVapid and dropEndpoints.
    return err.code === 'ENOENT' ? { vapid: null, subscriptions: [] } : { vapid: null, subscriptions: [], unreadable: true };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { vapid: null, subscriptions: [] };
  }
  return {
    vapid: validVapidShape(data.vapid) ? data.vapid : null,
    subscriptions: Array.isArray(data.subscriptions) ? data.subscriptions.filter(validSubscriptionRow) : [],
  };
}

export function writePushState(ctx, state) {
  return writeConfig(ctx.pushPath || getPushFilePath(), state);
}

/** { publicKey, privateKey } - b64url, public 65B (0x04||X||Y), private 32B (d). */
export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([0x04]), b64uDecode(pubJwk.x), b64uDecode(pubJwk.y)]);
  return { publicKey: raw.toString('base64url'), privateKey: privJwk.d };
}

/**
 * Generates+writes VAPID keys only when no valid pair exists; a repeat call is
 * a no-op read. Fresh keys drop every subscription: each one is bound to the
 * key it was created under, so none could receive a push signed by the new one.
 */
export function ensureVapid(ctx) {
  const state = readPushState(ctx);
  if (state.vapid) return { ok: true, state };
  if (state.unreadable) return { ok: false };
  const next = { vapid: generateVapidKeys(), subscriptions: [] };
  if (!writePushState(ctx, next)) return { ok: false };
  return { ok: true, state: next };
}

function vapidPrivateKeyObject(vapid) {
  const pub = b64uDecode(vapid.publicKey);
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url'), d: vapid.privateKey },
    format: 'jwk',
  });
}

/** A VAPID (RFC 8292) bearer JWT for one push, ES256, exp = nowMs + JWT_TTL_S. */
export function vapidJwt(endpoint, vapid, nowMs) {
  const now = nowMs ?? Date.now();
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + JWT_TTL_S, sub: VAPID_SUBJECT };
  const signingInput = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: vapidPrivateKeyObject(vapid),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}

/** RFC 8291 section 3.4 key derivation. Every argument a Buffer. */
export function deriveContentKeys({ ecdhSecret, authSecret, uaPublic, asPublic, salt }) {
  const info = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, info, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));
  return { ikm, cek, nonce };
}

/**
 * RFC 8291/8188 aes128gcm push body. plaintext is a Buffer; p256dh/auth are
 * the subscription's b64url strings. salt/senderPrivateKey (Buffers) are test
 * seams - production always omits both.
 */
export function encryptPayload(plaintext, { p256dh, auth }, { salt, senderPrivateKey } = {}) {
  const plaintextBuf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  if (plaintextBuf.length > RECORD_SIZE - 17) throw new Error('claude-remote agent: push payload exceeds one record');

  const saltBuf = salt || crypto.randomBytes(16);
  const uaPublic = b64uDecode(p256dh);
  const authSecret = b64uDecode(auth);

  const ecdh = crypto.createECDH('prime256v1');
  if (senderPrivateKey) ecdh.setPrivateKey(senderPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  const { cek, nonce } = deriveContentKeys({ ecdhSecret, authSecret, uaPublic, asPublic, salt: saltBuf });

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([plaintextBuf, Buffer.from([0x02])])), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = Buffer.alloc(21);
  saltBuf.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(65, 20);
  return Buffer.concat([header, asPublic, ciphertext, tag]);
}

export function pushServiceOf(endpoint) {
  let host;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  if (host.endsWith('.push.apple.com')) return 'apple';
  if (host.endsWith('.googleapis.com')) return 'google';
  if (host.endsWith('.mozilla.com')) return 'mozilla';
  return 'other';
}

export function validateName(value) {
  if (value === undefined || value === null) return { ok: true, name: null };
  if (typeof value !== 'string') return { ok: false };
  const trimmed = value.trim();
  if (trimmed === '') return { ok: true, name: null };
  if (trimmed.length > MAX_NAME_CHARS) return { ok: false };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(trimmed)) return { ok: false };
  return { ok: true, name: trimmed };
}

/**
 * SSRF bound on a push endpoint: https only, no userinfo, no explicit
 * port, a dotted non-IP non-localhost hostname, length capped.
 * Known limit: a DNS name resolving to a private address is not caught here -
 * the agent only ever POSTs opaque ciphertext with fixed headers to it.
 * Upgrade path if that ever matters: resolve and re-check before sending.
 */
function validEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 1024) return false;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  if (url.port !== '') return false;
  const rawHost = url.hostname;
  // Trailing dots stripped first: `localhost.` is still loopback (measured).
  const host = (rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost)
    .replace(/\.+$/, '').toLowerCase();
  if (!host.includes('.')) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (net.isIP(host)) return false;
  return true;
}

function validP256dh(value) {
  if (typeof value !== 'string' || !B64URL_RE.test(value)) return false;
  const buf = b64uDecode(value);
  if (buf.length !== 65 || buf[0] !== 0x04) return false;
  try {
    // On-curve check: computeSecret throws for a point not on prime256v1 -
    // but only once THIS side has its own key pair; without generateKeys()
    // it throws for every point, valid or not (measured).
    const probe = crypto.createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(buf);
  } catch {
    return false;
  }
  return true;
}

function validAuth(value) {
  if (typeof value !== 'string' || !B64URL_RE.test(value)) return false;
  return b64uDecode(value).length === 16;
}

export function validateSubscription(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid_subscription' };
  const { endpoint, keys } = body;
  if (!validEndpoint(endpoint)) return { ok: false, error: 'invalid_subscription' };
  if (keys === null || typeof keys !== 'object') return { ok: false, error: 'invalid_subscription' };
  if (!validP256dh(keys.p256dh)) return { ok: false, error: 'invalid_subscription' };
  if (!validAuth(keys.auth)) return { ok: false, error: 'invalid_subscription' };
  const nameResult = validateName(body.name);
  if (!nameResult.ok) return { ok: false, error: 'invalid_name' };
  return { ok: true, sub: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, name: nameResult.name } };
}

/** Devices for the client: endpoint, name, created_at - NEVER keys or the private key. */
export function publicDevices(state) {
  return [...state.subscriptions]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((s) => ({ endpoint: s.endpoint, name: s.name ?? null, created_at: s.createdAt }));
}

/**
 * POSTs one encrypted push. Never throws - a network error, timeout or
 * encrypt failure is reported the same as any other non-2xx outcome.
 */
export async function sendPush(ctx, sub, vapid, type, ttl) {
  const fetchImpl = ctx.fetch || fetch;
  const service = pushServiceOf(sub.endpoint);

  let body;
  let jwt;
  try {
    body = encryptPayload(Buffer.from(JSON.stringify({ type })), sub.keys);
    jwt = vapidJwt(sub.endpoint, vapid, (ctx.now || Date.now)());
  } catch {
    console.warn(`claude-remote agent: push to ${service} -> could not build the request`);
    return { ok: false, gone: false, status: null };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(sub.endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttl),
        Urgency: 'high',
      },
      body,
    });
  } catch {
    console.warn(`claude-remote agent: push to ${service} -> network error`);
    return { ok: false, gone: false, status: null };
  } finally {
    clearTimeout(timer);
  }

  console.log(`claude-remote agent: push to ${service} -> ${res.status}`);
  return {
    ok: res.status >= 200 && res.status < 300,
    gone: res.status === 404 || res.status === 410,
    status: res.status,
  };
}

/** Sends type to every subscribed device, dropping any that answered gone in one re-read+write. */
export async function notifyAll(ctx, type) {
  const ensured = ensureVapid(ctx);
  if (!ensured.ok) return { sent: 0, gone: 0 };
  const { vapid, subscriptions } = ensured.state;
  const ttl = type === 'test' ? TEST_TTL_S : EVENT_TTL_S;

  let sent = 0;
  const goneEndpoints = new Set();
  for (const sub of subscriptions) {
    // eslint-disable-next-line no-await-in-loop
    const result = await sendPush(ctx, sub, vapid, type, ttl);
    if (result.ok) sent += 1;
    if (result.gone) goneEndpoints.add(sub.endpoint);
  }

  if (goneEndpoints.size > 0) dropEndpoints(ctx, goneEndpoints);
  return { sent, gone: goneEndpoints.size };
}

/** Removes the given endpoints from a FRESH read, so rows added during a slow send survive. */
export function dropEndpoints(ctx, endpoints) {
  const fresh = readPushState(ctx);
  if (fresh.unreadable) return false;
  return writePushState(ctx, { vapid: fresh.vapid, subscriptions: fresh.subscriptions.filter((s) => !endpoints.has(s.endpoint)) });
}
