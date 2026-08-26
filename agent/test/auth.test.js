import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test, after } from 'node:test';

import {
  isConfigured, setPasscode, attemptUnlock, authStatus, authorize,
  backoffMs, readAttempts, MAX_BACKOFF_MS,
} from '../auth.js';
import { makeAuthCtx, cleanupAuthCtx, issueTestToken, seedPasscode } from './helper-auth.js';

const ctxs = [];
function ctx(opts) {
  const c = makeAuthCtx(opts);
  ctxs.push(c);
  return c;
}
after(() => { for (const c of ctxs) cleanupAuthCtx(c); });

// --- 1-2: storage shape ---

test('setPasscode writes the file, and the plaintext code appears in none of its bytes', () => {
  const c = ctx();
  const res = setPasscode(c, '481902', '481902');
  assert.equal(res.ok, true);
  const raw = fs.readFileSync(c.passcodePath, 'utf8');
  assert.ok(!raw.includes('481902'));
});

test('the written passcode.json has exactly the documented keys', () => {
  const c = ctx();
  setPasscode(c, '481902', '481902');
  const data = JSON.parse(fs.readFileSync(c.passcodePath, 'utf8'));
  assert.deepEqual(
    Object.keys(data).sort(),
    ['N', 'algo', 'created_at', 'hash', 'keylen', 'p', 'r', 'salt', 'version'].sort(),
  );
});

// --- 3 ---

test('attemptUnlock: right code -> 200 + token, wrong code -> 401', () => {
  const c = ctx();
  setPasscode(c, '481902', '481902');
  const ok = attemptUnlock(c, '481902');
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.token, 'string');

  const c2 = ctx();
  setPasscode(c2, '481902', '481902');
  const bad = attemptUnlock(c2, '111222');
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
});

// --- 4 ---

test('two fresh installs, same passcode -> different salt and different hash', () => {
  const a = ctx();
  const b = ctx();
  setPasscode(a, '481902', '481902');
  setPasscode(b, '481902', '481902');
  const da = JSON.parse(fs.readFileSync(a.passcodePath, 'utf8'));
  const db = JSON.parse(fs.readFileSync(b.passcodePath, 'utf8'));
  assert.notEqual(da.salt, db.salt);
  assert.notEqual(da.hash, db.hash);
});

// --- 5 ---

test('isConfigured: false on a fresh temp dir, true after setPasscode', () => {
  const c = ctx();
  assert.equal(isConfigured(c), false);
  setPasscode(c, '481902', '481902');
  assert.equal(isConfigured(c), true);
});

// --- 6 ---

test('setPasscode a second time -> 409 already_configured, stored hash unchanged', () => {
  const c = ctx();
  setPasscode(c, '481902', '481902');
  const before = fs.readFileSync(c.passcodePath, 'utf8');
  const second = setPasscode(c, '111222', '111222');
  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
  assert.equal(second.error, 'already_configured');
  const after1 = fs.readFileSync(c.passcodePath, 'utf8');
  assert.equal(before, after1);
});

// --- 7 ---

test('format rejection table, on both setPasscode and attemptUnlock', () => {
  const bad = ['12345', '1234567', '12a456', ' 12345', '12345 ', '', null, undefined, 123456, '١٢٣٤٥٦'];
  for (const v of bad) {
    const c = ctx();
    const res = setPasscode(c, v, v);
    assert.equal(res.ok, false, `setPasscode: ${v}`);
    assert.equal(res.error, 'malformed_passcode', `setPasscode: ${v}`);

    const c2 = ctx();
    setPasscode(c2, '481902', '481902');
    const res2 = attemptUnlock(c2, v);
    assert.equal(res2.ok, false, `attemptUnlock: ${v}`);
    assert.equal(res2.error, 'malformed_passcode', `attemptUnlock: ${v}`);
  }
});

// --- 8 ---

test('weak codes rejected on set; the same digits are a plain wrong guess on unlock', () => {
  const c = ctx();
  const r1 = setPasscode(c, '123456', '123456');
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'passcode_too_weak');

  const c2 = ctx();
  const r2 = setPasscode(c2, '000000', '000000');
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'passcode_too_weak');

  const c3 = ctx();
  setPasscode(c3, '481902', '481902');
  const r3 = attemptUnlock(c3, '123456');
  assert.equal(r3.ok, false);
  assert.equal(r3.error, 'passcode_incorrect');
});

// --- 9 ---

test('mismatched confirm -> passcode_mismatch, and isConfigured stays false', () => {
  const c = ctx();
  const res = setPasscode(c, '481902', '481903');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'passcode_mismatch');
  assert.equal(isConfigured(c), false);
});

// --- 10 ---

test('corrupt/truncated passcode.json -> not configured, no throw, setPasscode succeeds again', () => {
  const c = ctx();
  fs.mkdirSync(path.dirname(c.passcodePath), { recursive: true });
  fs.writeFileSync(c.passcodePath, '{"version":1,"hash":"tru', 'utf8');
  assert.equal(isConfigured(c), false);
  const res = setPasscode(c, '481902', '481902');
  assert.equal(res.ok, true);
});

// --- 11 ---

test('a hash that decodes to 16 bytes -> attemptUnlock returns 401, does not throw', () => {
  const c = ctx();
  setPasscode(c, '481902', '481902');
  const data = JSON.parse(fs.readFileSync(c.passcodePath, 'utf8'));
  data.hash = Buffer.alloc(16, 1).toString('base64');
  fs.writeFileSync(c.passcodePath, JSON.stringify(data));
  assert.doesNotThrow(() => {
    const res = attemptUnlock(c, '481902');
    assert.equal(res.ok, false);
    assert.equal(res.status, 401);
  });
});

// --- 12 ---

test('agent/auth.js uses timingSafeEqual, never .equals( or Buffer.compare( - structural, not timing', () => {
  // A wall-clock timing benchmark is flaky under CI and would be theatre;
  // this structural check plus the length guard in verifyPasscode is the
  // real assurance that comparison stays constant-time.
  const source = fs.readFileSync(new URL('../auth.js', import.meta.url), 'utf8');
  assert.match(source, /timingSafeEqual/);
  assert.ok(!source.includes('.equals('));
  assert.ok(!source.includes('Buffer.compare('));
});

// --- 13 ---

test('two attemptUnlock successes yield different tokens, each >= 43 base64url chars', () => {
  const c = ctx();
  setPasscode(c, '481902', '481902');
  const r1 = attemptUnlock(c, '481902');
  const r2 = attemptUnlock(c, '481902');
  assert.notEqual(r1.token, r2.token);
  assert.ok(r1.token.length >= 43);
  assert.ok(r2.token.length >= 43);
});

// --- 14 ---

test('authorize: accepts a fresh token; rejects undefined, empty, random, and a token from another ctx', () => {
  const c = ctx();
  const other = ctx();
  seedPasscode(c, '481902');
  seedPasscode(other, '481902');
  const token = issueTestToken(c);
  issueTestToken(other);

  assert.equal(authorize({ headers: { 'x-claude-remote-token': token } }, c).ok, true);
  assert.equal(authorize({ headers: {} }, c).ok, false);
  assert.equal(authorize({ headers: { 'x-claude-remote-token': '' } }, c).ok, false);
  assert.equal(authorize({ headers: { 'x-claude-remote-token': 'not-a-real-token' } }, c).ok, false);

  const otherToken = issueTestToken(other);
  assert.equal(authorize({ headers: { 'x-claude-remote-token': otherToken } }, c).ok, false);
});

// --- 15 ---

test('authorize: an injected now past expires_at -> 401 token_expired, entry removed', () => {
  let now = 1_000_000;
  const c = ctx({ now: () => now });
  seedPasscode(c, '481902');
  c.tokens.clear(); // drop the token setPasscode itself issues on success
  const token = issueTestToken(c);
  now += 13 * 60 * 60 * 1000; // past the 12h TTL
  const res = authorize({ headers: { 'x-claude-remote-token': token } }, c);
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'token_expired');
  assert.equal(c.tokens.size, 0);
});

// --- 16 ---

test('issuing 40 tokens leaves ctx.tokens.size <= 32, the most recent still works', () => {
  const c = ctx();
  seedPasscode(c, '481902');
  let last;
  for (let i = 0; i < 40; i++) last = attemptUnlock(c, '481902').token;
  assert.ok(c.tokens.size <= 32);
  assert.equal(authorize({ headers: { 'x-claude-remote-token': last } }, c).ok, true);
});

// --- 17 ---

test('backoffMs curve', () => {
  // Doubling from 1000 * 2**(failures-FREE_ATTEMPTS-1), capped at
  // MAX_BACKOFF_MS, reaches the 300000ms cap at failures=13
  // (1000*2**9=512000, clamped) - failures=12 is still 1000*2**8=256000,
  // one step short of the cap.
  assert.equal(backoffMs(1), 0);
  assert.equal(backoffMs(2), 0);
  assert.equal(backoffMs(3), 0);
  assert.equal(backoffMs(4), 1000);
  assert.equal(backoffMs(5), 2000);
  assert.equal(backoffMs(6), 4000);
  assert.equal(backoffMs(7), 8000);
  assert.equal(backoffMs(8), 16000);
  assert.equal(backoffMs(9), 32000);
  assert.equal(backoffMs(10), 64000);
  assert.equal(backoffMs(11), 128000);
  assert.equal(backoffMs(12), 256000);
  assert.equal(backoffMs(13), 300000);
  assert.equal(backoffMs(20), 300000);
  assert.equal(backoffMs(1000), 300000);
});

// --- 18 ---

test('three wrong guesses in a row -> each 401 with retry_after_ms 0', () => {
  const c = ctx();
  setPasscode(c, '481902', '481902');
  for (let i = 0; i < 3; i++) {
    const r = attemptUnlock(c, '111222');
    assert.equal(r.status, 401);
    assert.equal(r.retryAfterMs, 0);
  }
});

// --- 19 ---

test('the 4th wrong guess -> 401 with retry_after_ms 1000; the immediate 5th -> 429', () => {
  const c = ctx();
  setPasscode(c, '481902', '481902');
  for (let i = 0; i < 3; i++) attemptUnlock(c, '111222');
  const fourth = attemptUnlock(c, '111222');
  assert.equal(fourth.status, 401);
  assert.equal(fourth.retryAfterMs, 1000);
  const fifth = attemptUnlock(c, '111222');
  assert.equal(fifth.status, 429);
  assert.equal(fifth.error, 'too_many_attempts');
});

// --- 20 ---

test('KDF is not reached during backoff', () => {
  const c = ctx();
  setPasscode(c, '481902', '481902');
  for (let i = 0; i < 3; i++) attemptUnlock(c, '111222'); // 3 free failures, not locked yet

  let kdfCalls = 0;
  const origScryptSync = crypto.scryptSync;
  crypto.scryptSync = (...args) => { kdfCalls++; return origScryptSync(...args); };
  try {
    // Prove the instrument works BEFORE asserting a zero: one UNLOCKED wrong
    // attempt must reach the KDF exactly once. Without this, kdfCalls === 0
    // below is vacuously satisfiable - if the monkey-patch ever stops
    // applying (a named crypto import in auth.js), it would still pass.
    assert.equal(attemptUnlock(c, '111222').status, 401); // 4th failure -> now locked
    assert.equal(kdfCalls, 1);

    kdfCalls = 0;
    for (let i = 0; i < 20; i++) {
      const r = attemptUnlock(c, '481902'); // even the RIGHT code, still refused
      assert.equal(r.status, 429);
    }
    assert.equal(kdfCalls, 0);
  } finally {
    crypto.scryptSync = origScryptSync;
  }
});

// --- 21 ---

test('hammering does not extend the lockout', () => {
  const c = ctx();
  setPasscode(c, '481902', '481902');
  for (let i = 0; i < 4; i++) attemptUnlock(c, '111222');
  const before = readAttempts(c);
  for (let i = 0; i < 20; i++) attemptUnlock(c, '111222');
  const afterAttempts = readAttempts(c);
  assert.equal(afterAttempts.lockedUntil, before.lockedUntil);
  assert.equal(afterAttempts.failures, before.failures);
});

// --- 22 ---

test('a correct passcode after 6 failures (now advanced past lockout) -> 200, attempts reset', () => {
  let now = 2_000_000;
  const c = ctx({ now: () => now });
  setPasscode(c, '481902', '481902');
  for (let i = 0; i < 6; i++) attemptUnlock(c, '111222');
  const { lockedUntil } = readAttempts(c);
  now = lockedUntil + 1;
  const res = attemptUnlock(c, '481902');
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.deepEqual(readAttempts(c), { failures: 0, lockedUntil: 0 });
});

// --- 23 ---

test('survives restart: 5 failures persist across a fresh ctx over the same attemptsPath', () => {
  // now is advanced past MAX_BACKOFF_MS before each of the first 4 attempts
  // so none of them lands inside an earlier lockout window (which would
  // refuse it without incrementing failures) - but NOT after the 5th, so the
  // restarted ctx below is built while still inside that 5th failure's own
  // backoff window, which is what "still refused" after restart asserts.
  let now = 5_000_000;
  const c = ctx({ now: () => now });
  setPasscode(c, '481902', '481902');
  for (let i = 0; i < 5; i++) {
    attemptUnlock(c, '111222');
    if (i < 4) now += MAX_BACKOFF_MS + 1000;
  }

  const restarted = { passcodePath: c.passcodePath, attemptsPath: c.attemptsPath, tokens: new Map(), now: () => now };
  assert.equal(readAttempts(restarted).failures, 5);
  const res = attemptUnlock(restarted, '481902');
  assert.equal(res.status, 429);
});

// --- 24 ---

test('corrupt passcode-attempts.json -> readAttempts resets, no throw', () => {
  const c = ctx();
  fs.mkdirSync(path.dirname(c.attemptsPath), { recursive: true });
  fs.writeFileSync(c.attemptsPath, '{"failures": tr', 'utf8');
  assert.doesNotThrow(() => {
    assert.deepEqual(readAttempts(c), { failures: 0, lockedUntil: 0 });
  });
});

// --- 25 ---

test('a malformed_passcode attempt does not increment failures', () => {
  const c = ctx();
  setPasscode(c, '481902', '481902');
  const before = readAttempts(c).failures;
  attemptUnlock(c, '12345');
  const after1 = readAttempts(c).failures;
  assert.equal(after1, before);
});

// --- 26 ---

test('authStatus returns exactly configured + retry_after_ms, never salt/hash/token/paths', () => {
  const c = ctx();
  const unconfigured = authStatus(c);
  assert.deepEqual(Object.keys(unconfigured), ['configured', 'retry_after_ms']);
  setPasscode(c, '481902', '481902');
  const configured = authStatus(c);
  assert.deepEqual(Object.keys(configured), ['configured', 'retry_after_ms']);
});

// --- 27 (review fix) ---

test('a failed attempts-file write fails CLOSED: 500, never a 401 that was not counted', () => {
  const c = ctx();
  setPasscode(c, '481902', '481902');
  // An unwritable attempts path (its parent is the passcode FILE, so the
  // mkdirSync inside writeJsonAtomic throws ENOTDIR) stands in for the real
  // preconditions: disk full, an ACL change, a transient Windows EPERM on
  // renameSync. If the increment cannot be recorded, the guess must be
  // refused - answering 401 would leave failures at 0 forever and turn the
  // limiter into unlimited guessing.
  c.attemptsPath = path.join(c.passcodePath, 'passcode-attempts.json');
  const res = attemptUnlock(c, '111222');
  assert.equal(res.status, 500);
  assert.equal(res.error, 'internal_error');
});

// --- 28 (review fix, LOW-1) ---

test('an unwritable attempts file still rate-limits: the counter is in memory, not only on disk', () => {
  let now = 9_000_000;
  const c = ctx({ now: () => now });
  setPasscode(c, '481902', '481902');
  // Same unwritable-path trick as test 27: nothing this ctx writes from here
  // on can ever reach disk. Refusing the 401 (test 27) does NOT by itself cap
  // the guess rate - only a counter that keeps moving does.
  c.attemptsPath = path.join(c.passcodePath, 'passcode-attempts.json');

  for (let i = 0; i < 4; i++) {
    assert.equal(attemptUnlock(c, '111222').status, 500);
  }
  assert.equal(fs.existsSync(c.attemptsPath), false); // nothing was persisted
  assert.equal(readAttempts(c).failures, 4);          // ...and it counted anyway

  // The 4th failure opened a real backoff window, so the next guess is
  // REFUSED before the KDF, exactly as it would be with a writable disk.
  const fifth = attemptUnlock(c, '111222');
  assert.equal(fifth.status, 429);
  assert.equal(fifth.error, 'too_many_attempts');
  // The oracle is gone with it: inside the window the CORRECT passcode gets
  // the same answer as a wrong one, so 500-vs-200 no longer sorts guesses.
  assert.equal(attemptUnlock(c, '481902').status, 429);

  // Not a permanent lockout: past the window the correct passcode still wins.
  now += MAX_BACKOFF_MS + 1000;
  assert.equal(attemptUnlock(c, '481902').status, 200);
});
