import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getPasscodeFilePath, getAttemptsFilePath } from './config.js';

export const TOKEN_HEADER = 'x-claude-remote-token'; // node lowercases req.headers
export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h absolute, no sliding renewal
export const FREE_ATTEMPTS = 3;
export const MAX_BACKOFF_MS = 300_000; // 5 min ceiling
export const MAX_TOKENS = 32;

const PASSCODE_VERSION = 1;
const ATTEMPTS_VERSION = 1;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;

// ASCII only, NOT \d with the u flag: \d is ASCII-only in JS today, but
// [0-9] makes the intent unmissable and survives someone adding the u/v flag
// later. Arabic-Indic digits and similar non-ASCII digit forms must fail.
const SIX_DIGITS = /^[0-9]{6}$/;

// The rate limiter gives an attacker three free guesses per backoff window,
// and these are the first ones anyone tries - without this list, three free
// guesses is a meaningful chance of instant entry. Unlock never consults
// this list, only setting does: revert by deleting this set and its branch.
const WEAK = new Set([
  '000000', '111111', '222222', '333333', '444444', '555555',
  '666666', '777777', '888888', '999999', '123456', '654321',
]);

function isSixDigits(v) {
  return typeof v === 'string' && SIX_DIGITS.test(v);
}

function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Same atomic tmp+renameSync shape as registry.js:writeRegistry, copied
// rather than imported - two small single-purpose files, not worth a shared
// module. Failure is logged by error code only, never the path, the stack,
// or the value being written: the caller may be writing a credential.
function writeJsonAtomic(filePath, data, label) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const json = JSON.stringify(data, null, 2);
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, filePath);
    return true;
  } catch (err) {
    console.warn(`claude-remote agent: could not write ${label}: ${err.code || 'unknown'}`);
    return false;
  }
}

/**
 * Reads and validates the passcode file, or null if it is absent, corrupt,
 * truncated, or a version this code does not understand. A corrupt file is
 * treated as NOT CONFIGURED rather than a hard failure: an attacker who can
 * corrupt this file could equally write their own hash into it, so
 * fail-closed buys nothing, while fail-open is the only behaviour that
 * cannot permanently lock the owner out of the one way in.
 */
function readPasscodeFile(ctx) {
  const passcodePath = ctx.passcodePath || getPasscodeFilePath();
  let raw;
  try {
    raw = fs.readFileSync(passcodePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`claude-remote agent: could not read passcode file: ${err.code || 'unknown'}`);
    }
    return null;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.warn('claude-remote agent: passcode file is corrupt; treating as not configured');
    return null;
  }

  if (
    data === null || typeof data !== 'object' || Array.isArray(data) ||
    data.version !== PASSCODE_VERSION ||
    typeof data.salt !== 'string' || typeof data.hash !== 'string' ||
    typeof data.N !== 'number' || typeof data.r !== 'number' ||
    typeof data.p !== 'number' || typeof data.keylen !== 'number'
  ) {
    console.warn('claude-remote agent: passcode file is malformed; treating as not configured');
    return null;
  }

  return data;
}

export function isConfigured(ctx) {
  return readPasscodeFile(ctx) !== null;
}

/**
 * consecutive failures -> ms to wait before the next attempt is accepted.
 * Three free tries, then the wait doubles from 1s up to a 300s ceiling.
 * Sustained throughput past the cap is one guess per 300s = 288/day; 10^6
 * combinations / 288 is about 3472 days (~9.5 years) to exhaust the space,
 * ~4.75 years to a 50% chance. Length is not what makes six digits safe -
 * this curve is.
 */
export function backoffMs(failures) {
  if (failures <= FREE_ATTEMPTS) return 0;
  return Math.min(1000 * 2 ** (failures - FREE_ATTEMPTS - 1), MAX_BACKOFF_MS);
}

/**
 * Effective counter = max(this process's own count, whatever is on disk).
 *
 * The file is DURABILITY, not authority. If it cannot be written (disk full,
 * an ACL change, a transient Windows EPERM on renameSync) the on-disk count
 * stays at 0 forever, and a limiter that reads only the file stops counting
 * at exactly the moment it matters. ctx.attemptFloor is the same counter held
 * in memory for the life of the agent process, so a wrong guess always costs
 * the attacker something. max() also means a reset whose write failed still
 * errs HIGH, which is the direction ruled correct for resets.
 *
 * Missing, corrupt, or wrong-version file reads back as a fresh counter (same
 * fail-open reasoning as readPasscodeFile), never a throw.
 */
export function readAttempts(ctx) {
  const onDisk = readAttemptsFile(ctx.attemptsPath || getAttemptsFilePath());
  const floor = ctx.attemptFloor;
  if (!floor) return onDisk;
  return {
    failures: Math.max(floor.failures, onDisk.failures),
    lockedUntil: Math.max(floor.lockedUntil, onDisk.lockedUntil),
  };
}

function readAttemptsFile(attemptsPath) {
  let raw;
  try {
    raw = fs.readFileSync(attemptsPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`claude-remote agent: could not read attempts file: ${err.code || 'unknown'}`);
    }
    return { failures: 0, lockedUntil: 0 };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.warn('claude-remote agent: attempts file is corrupt; resetting the counter');
    return { failures: 0, lockedUntil: 0 };
  }

  if (
    data === null || typeof data !== 'object' || Array.isArray(data) ||
    data.version !== ATTEMPTS_VERSION ||
    typeof data.failures !== 'number' || typeof data.locked_until !== 'number'
  ) {
    console.warn('claude-remote agent: attempts file is malformed; resetting the counter');
    return { failures: 0, lockedUntil: 0 };
  }

  return { failures: data.failures, lockedUntil: data.locked_until };
}

// Known ceiling: read-modify-write with no lock, same as
// registry.js:writeRegistry. Two simultaneous unlock attempts can lose one
// increment. Single-user agent; the worst case is one extra free guess.
//
// The in-memory floor is set BEFORE the disk write is attempted and is not
// conditional on it: that is what makes the limiter survive an unwritable
// data directory. It lives on ctx, which createAgentServer closes over for
// the process lifetime, so "a fresh ctx" means "a restarted agent" - the one
// place the disk file is the only memory left.
function writeAttempts(ctx, failures, lockedUntil) {
  const attemptsPath = ctx.attemptsPath || getAttemptsFilePath();
  ctx.attemptFloor = { failures, lockedUntil };
  return writeJsonAtomic(attemptsPath, { version: ATTEMPTS_VERSION, failures, locked_until: lockedUntil }, 'attempts file');
}

// Real agent process is exactly one Node process holding exactly one token
// store; tests must inject a fresh ctx.tokens Map instead of sharing this,
// since two createAgentServer calls in one test process would otherwise leak
// tokens between them.
const defaultTokens = new Map();

/**
 * Issues a token, storing only its SHA-256 digest server-side - a heap dump
 * never yields a usable credential, and there is no secret comparison on the
 * lookup path (a Map key match), so no timingSafeEqual is needed here.
 * Bearer, and that is accepted: the token is bound to no device or identity,
 * and lives only in one page's memory on one device for at most TOKEN_TTL_MS.
 */
function issueToken(ctx) {
  const tokens = ctx.tokens || defaultTokens;
  const now = (ctx.now || Date.now)();

  for (const [digest, entry] of tokens) {
    if (entry.expiresAt <= now) tokens.delete(digest);
  }
  // Map iterates in insertion order and TTL is a constant, so the first key
  // IS the oldest token. The loop still terminates on an empty Map because
  // MAX_TOKENS > 0.
  while (tokens.size >= MAX_TOKENS) tokens.delete(tokens.keys().next().value);

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = now + TOKEN_TTL_MS;
  tokens.set(sha256hex(token), { expiresAt });
  return { token, expiresAtIso: new Date(expiresAt).toISOString() };
}

function verifyPasscode(passcode, stored) {
  let saltBuf;
  let storedHash;
  try {
    saltBuf = Buffer.from(stored.salt, 'base64');
    storedHash = Buffer.from(stored.hash, 'base64');
  } catch {
    return false;
  }

  let derived;
  try {
    derived = crypto.scryptSync(passcode, saltBuf, stored.keylen, {
      N: stored.N,
      r: stored.r,
      p: stored.p,
    });
  } catch {
    return false;
  }

  // timingSafeEqual throws on unequal lengths, so a hand-corrupted or
  // downgraded hash must be caught here rather than crashing the request.
  if (derived.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(derived, storedHash);
}

export function setPasscode(ctx, passcode, confirm) {
  // Checked first so a second caller learns nothing about format rules from
  // a set attempt once a passcode already exists.
  if (isConfigured(ctx)) return { ok: false, status: 409, error: 'already_configured' };
  if (!isSixDigits(passcode)) return { ok: false, status: 400, error: 'malformed_passcode' };
  if (!isSixDigits(confirm)) return { ok: false, status: 400, error: 'malformed_passcode' };
  if (passcode !== confirm) return { ok: false, status: 400, error: 'passcode_mismatch' };
  if (WEAK.has(passcode)) return { ok: false, status: 400, error: 'passcode_too_weak' };

  const salt = crypto.randomBytes(16);
  // Global sync KDF, ~15-40ms of event loop per set/unlock call. Refused
  // (429) attempts never reach it, so the worst case per backoff window is
  // the 3 free attempts. Move to crypto.scrypt async if a second concurrent
  // user of this agent ever exists.
  const hash = crypto.scryptSync(passcode, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });

  const passcodePath = ctx.passcodePath || getPasscodeFilePath();
  const written = writeJsonAtomic(passcodePath, {
    version: PASSCODE_VERSION,
    algo: 'scrypt',
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    keylen: KEYLEN,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    created_at: new Date((ctx.now || Date.now)()).toISOString(),
  }, 'passcode file');

  if (!written) return { ok: false, status: 500, error: 'internal_error' };

  writeAttempts(ctx, 0, 0);

  const issued = issueToken(ctx);
  return { ok: true, status: 201, token: issued.token, expiresAt: issued.expiresAtIso };
}

export function attemptUnlock(ctx, passcode) {
  const stored = readPasscodeFile(ctx);
  if (!stored) return { ok: false, status: 403, error: 'not_configured' };

  const now = (ctx.now || Date.now)();
  const { failures, lockedUntil } = readAttempts(ctx);

  // Never-permanent-lockout guarantee: a request inside the backoff window
  // is refused without touching the counter and without reaching the KDF.
  // Extending the window on a hammered request would let anyone who can
  // reach this endpoint lock the owner out of the only way in for as long
  // as they liked - strictly worse than the attack this prevents.
  if (now < lockedUntil) {
    return { ok: false, status: 429, error: 'too_many_attempts', retryAfterMs: lockedUntil - now };
  }

  // A malformed body is not a guess and cannot eat the owner's budget: only
  // six-digit strings can ever be right, so sending malformed ones is pure
  // loss for an attacker.
  if (!isSixDigits(passcode)) {
    return { ok: false, status: 400, error: 'malformed_passcode' };
  }

  if (!verifyPasscode(passcode, stored)) {
    const newFailures = failures + 1;
    const wait = backoffMs(newFailures);
    // What actually caps the guess rate here is writeAttempts recording the
    // increment in ctx.attemptFloor, which it does unconditionally - so this
    // branch is NOT what keeps the limiter alive when the disk is unwritable,
    // and must not be read as if it were. It only reports the lost durability:
    // the count moved, but a restart will not remember it, so the answer is
    // 500 rather than a 401 the owner would take as normal. A CORRECT passcode
    // still returns 200 on the same broken disk, deliberately - refusing it
    // would hand anyone who can make the data directory unwritable a permanent
    // lockout of the owner's only way in.
    if (!writeAttempts(ctx, newFailures, wait > 0 ? now + wait : 0)) {
      return { ok: false, status: 500, error: 'internal_error' };
    }
    return { ok: false, status: 401, error: 'passcode_incorrect', failures: newFailures, retryAfterMs: wait };
  }

  writeAttempts(ctx, 0, 0);
  const issued = issueToken(ctx);
  return { ok: true, status: 200, token: issued.token, expiresAt: issued.expiresAtIso };
}

export function authStatus(ctx) {
  if (!isConfigured(ctx)) return { configured: false, retry_after_ms: 0 };
  const now = (ctx.now || Date.now)();
  const { lockedUntil } = readAttempts(ctx);
  return { configured: true, retry_after_ms: Math.max(0, lockedUntil - now) };
}

export function authorize(req, ctx) {
  if (!isConfigured(ctx)) return { ok: false, status: 403, body: { error: 'setup_required' } };

  const raw = req.headers[TOKEN_HEADER];
  if (typeof raw !== 'string' || raw === '') return { ok: false, status: 401, body: { error: 'unauthorized' } };

  const tokens = ctx.tokens || defaultTokens;
  const digest = sha256hex(raw);
  const entry = tokens.get(digest);
  if (!entry) return { ok: false, status: 401, body: { error: 'unauthorized' } };

  const now = (ctx.now || Date.now)();
  if (entry.expiresAt <= now) {
    tokens.delete(digest);
    return { ok: false, status: 401, body: { error: 'token_expired' } };
  }

  return { ok: true };
}
