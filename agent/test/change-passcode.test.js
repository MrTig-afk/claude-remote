// T79 - Change passcode (Lane 7). Three halves: auth.js's own logic, the
// gated route in front of it, and the screen that drives it. Built-in
// node:test + node:assert/strict, no new dependency.
//
// The screen tests use the same idiom as settings.test.js: app.js is a
// browser module with no DOM in this runtime, so the block under test is
// sliced out of the source and run under a small stub DOM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

import { changePasscode, attemptUnlock, readAttempts, isConfigured, FREE_ATTEMPTS } from '../auth.js';
import { setPinRevealed } from '../public/lock.js';
import { makeAuthCtx, cleanupAuthCtx, seedPasscode, issueTestToken, makeAuthedFetch, fixtureServer } from './helper-auth.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

function read(relPath) {
  return fs.readFileSync(path.join(PUBLIC_DIR, relPath), 'utf8');
}

const OLD = '481902';
const NEW = '730518';

/**
 * A ctx with a passcode already set and NO live token, cleaned up on exit.
 * setPasscode issues a token to whoever set the passcode, which is correct in
 * the product and noise here - it would make every token count in this file
 * one higher than the test put there. Cleared so a count means what it says.
 */
function seeded(t, { now } = {}) {
  const ctx = makeAuthCtx({ now });
  t.after(() => cleanupAuthCtx(ctx));
  const set = seedPasscode(ctx, OLD);
  assert.equal(set.ok, true, 'fixture: seeding the passcode must succeed');
  ctx.tokens.clear();
  return ctx;
}

// --- auth.js ---------------------------------------------------------------

test('P1 - a correct current passcode swaps the credential: the old one stops working, the new one starts', (t) => {
  // RED WHEN: the new hash is never written, or is written from the wrong
  // field - a change screen that reports success and changes nothing is the
  // worst outcome this route has.
  const ctx = seeded(t);

  const res = changePasscode(ctx, OLD, NEW, NEW);
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);

  assert.equal(attemptUnlock(ctx, OLD).ok, false, 'the old passcode must no longer unlock');
  assert.equal(attemptUnlock(ctx, NEW).ok, true, 'the new passcode must unlock');
});

test('P2 - success signs EVERY device out, including the one that asked', (t) => {
  // RED WHEN: the tokens map is left alone, or a replacement token is issued
  // to the caller. Either makes the screen's own warning - "Every device is
  // signed out, including this one." - a lie the app cannot back up.
  const ctx = seeded(t);
  issueTestToken(ctx);
  issueTestToken(ctx);
  assert.equal(ctx.tokens.size, 2, 'fixture: two live tokens before the change');

  const res = changePasscode(ctx, OLD, NEW, NEW);
  assert.equal(res.ok, true);
  assert.equal(ctx.tokens.size, 0, 'every token must be dropped');
  assert.equal(res.token, undefined, 'no replacement token may be issued');
});

test('P3 - a wrong current passcode changes nothing, drops no token, and costs one attempt', (t) => {
  // RED WHEN: the failure path falls through to the write, or forgets to
  // count - the second turns this route into an unlimited guessing oracle
  // for the credential the gate rate-limits.
  const ctx = seeded(t);
  issueTestToken(ctx);

  const res = changePasscode(ctx, '111213', NEW, NEW);
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.equal(res.error, 'passcode_incorrect');
  assert.equal(res.failures, 1);

  assert.equal(ctx.tokens.size, 1, 'a failed change must not sign anyone out');
  assert.equal(readAttempts(ctx).failures, 1);
  assert.equal(attemptUnlock(ctx, OLD).ok, true, 'the passcode must be untouched');
});

test('P4 - wrong currents here spend the SAME budget the lock screen does', (t) => {
  // RED WHEN: this route gets its own counter. Two counters on one secret is
  // three free guesses per screen, and the backoff curve is the only thing
  // making a six-digit passcode safe (see auth.js:backoffMs).
  const ctx = seeded(t);

  for (let i = 0; i <= FREE_ATTEMPTS; i += 1) changePasscode(ctx, '111213', NEW, NEW);

  const gate = attemptUnlock(ctx, OLD);
  assert.equal(gate.ok, false, 'the gate must be in backoff, on a CORRECT passcode');
  assert.equal(gate.status, 429);
  assert.equal(gate.error, 'too_many_attempts');
});

test('P5 - inside the backoff window even a correct current passcode is refused, and the window is not extended', (t) => {
  // RED WHEN: the lockout check moves below the verify, which would let
  // anyone who can reach this route hold the owner out for as long as they
  // like by hammering it - strictly worse than the attack it prevents.
  let clock = 1_000_000;
  const ctx = seeded(t, { now: () => clock });

  for (let i = 0; i <= FREE_ATTEMPTS; i += 1) changePasscode(ctx, '111213', NEW, NEW);
  const lockedAt = readAttempts(ctx).lockedUntil;
  assert.ok(lockedAt > clock, 'fixture: the backoff window must be open');

  const refused = changePasscode(ctx, OLD, NEW, NEW);
  assert.equal(refused.status, 429);
  assert.equal(refused.error, 'too_many_attempts');
  assert.ok(refused.retryAfterMs > 0);
  assert.equal(readAttempts(ctx).lockedUntil, lockedAt, 'a refused request must not push the window out');
  assert.equal(attemptUnlock(ctx, OLD).status, 429, 'and it must not have burned a real attempt either');

  // Past the window, the same call goes through - the lockout is never
  // permanent.
  clock = lockedAt + 1;
  assert.equal(changePasscode(ctx, OLD, NEW, NEW).ok, true);
});

test('P6 - mismatch and a weak new passcode are refused, and are only judged after the current one is proven', (t) => {
  // RED WHEN: the new passcode's rules are checked BEFORE the current one is
  // verified, which hands a caller who cannot supply the current passcode a
  // free oracle for the format rules.
  const ctx = seeded(t);

  const mismatch = changePasscode(ctx, OLD, NEW, '730519');
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.error, 'passcode_mismatch');

  const weak = changePasscode(ctx, OLD, '123456', '123456');
  assert.equal(weak.status, 400);
  assert.equal(weak.error, 'passcode_too_weak');

  // Wrong current AND a mismatched new one: the answer must be about the
  // current one, because that is the check that ran first.
  const both = changePasscode(ctx, '111213', NEW, '730519');
  assert.equal(both.error, 'passcode_incorrect');

  assert.equal(attemptUnlock(ctx, OLD).ok, true, 'none of the refusals may have changed anything');
});

test('P7 - a malformed field is refused without costing an attempt', (t) => {
  // RED WHEN: malformed input starts burning the owner's budget. Only
  // six-digit strings can ever be right, so sending others is pure loss for
  // an attacker and must stay free for a fat-fingered owner.
  const ctx = seeded(t);

  for (const call of [['12345', NEW, NEW], [OLD, 'abcdef', NEW], [OLD, NEW, undefined], ['٤٨١٩٠٢', NEW, NEW]]) {
    const res = changePasscode(ctx, ...call);
    assert.equal(res.status, 400, JSON.stringify(call));
    assert.equal(res.error, 'malformed_passcode', JSON.stringify(call));
  }
  assert.equal(readAttempts(ctx).failures, 0, 'malformed input must not count as a guess');
});

test('P8 - with no passcode set at all, there is nothing to change', (t) => {
  const ctx = makeAuthCtx();
  t.after(() => cleanupAuthCtx(ctx));
  assert.equal(isConfigured(ctx), false);

  const res = changePasscode(ctx, OLD, NEW, NEW);
  assert.equal(res.status, 403);
  assert.equal(res.error, 'not_configured');
});

// --- POST /api/passcode ----------------------------------------------------

async function startServer(t) {
  const ctx = seeded(t);
  const server = fixtureServer(ctx);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { ctx, origin };
}

test('P9 - the route is behind the token gate: no token, no change', async (t) => {
  // RED WHEN: the route is moved under /api/auth/*, where handleAuthRoute
  // answers BEFORE the gate - which would make changing the passcode an
  // unauthenticated operation for anyone who can reach the agent.
  const { ctx, origin } = await startServer(t);

  const res = await fetch(`${origin}/api/passcode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: OLD, passcode: NEW, confirm: NEW }),
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'unauthorized');
  assert.equal(attemptUnlock(ctx, OLD).ok, true, 'the passcode must be untouched');
});

test('P10 - with a token and the right current passcode the route changes it and invalidates that very token', async (t) => {
  const { ctx, origin } = await startServer(t);
  const token = issueTestToken(ctx);
  const authed = makeAuthedFetch(origin, token);

  const res = await authed('/api/passcode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: OLD, passcode: NEW, confirm: NEW }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { changed: true });
  assert.equal(body.token, undefined, 'the reply must carry no replacement token');

  // The proof that "including this one" is real, end to end.
  const after = await authed('/api/projects');
  assert.equal(after.status, 401, 'the caller\'s own token must be dead');
});

test('P11 - the refusal bodies carry what the screen needs to explain itself', async (t) => {
  // RED WHEN: failures / retry_after_ms are dropped from the body, after
  // which the screen can only say "that did not work" - the lock screen's
  // own messages need both.
  const { ctx, origin } = await startServer(t);
  const authed = makeAuthedFetch(origin, issueTestToken(ctx));
  const send = (payload) => authed('/api/passcode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const wrong = await send({ current: '111213', passcode: NEW, confirm: NEW });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { error: 'passcode_incorrect', failures: 1, retry_after_ms: 0 });

  for (let i = 0; i < FREE_ATTEMPTS; i += 1) await send({ current: '111213', passcode: NEW, confirm: NEW });

  const locked = await send({ current: OLD, passcode: NEW, confirm: NEW });
  assert.equal(locked.status, 429);
  assert.ok(Number((await locked.json()).retry_after_ms) > 0);
  assert.ok(Number(locked.headers.get('Retry-After')) > 0, 'a 429 must carry Retry-After, as the unlock route does');
});

test('P12 - a body that is not a JSON object is refused before anything is read out of it', async (t) => {
  const { origin, ctx } = await startServer(t);
  const authed = makeAuthedFetch(origin, issueTestToken(ctx));
  const res = await authed('/api/passcode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '"not an object"',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_request');
});

// --- The screen ------------------------------------------------------------

// A stub DOM just big enough for the Change passcode block: fields with a
// value and a type, one eye button per field found by the `<input id>-eye`
// convention, and the two output nodes.
function pwDocument() {
  const nodes = new Map();
  const eyes = new Map();
  for (const id of ['pw-current', 'pw-new', 'pw-confirm']) {
    nodes.set(id, { value: '', type: 'password' });
    const eye = {
      attrs: { 'aria-pressed': 'false' },
      dataset: { pinName: `${id} field` },
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      querySelector() { return this._use || (this._use = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }); },
    };
    eyes.set(id, eye);
    nodes.set(`${id}-eye`, eye);
  }
  nodes.set('pw-go', { disabled: true });
  nodes.set('pw-msg', { textContent: '' });
  return { eyes, getElementById: (id) => nodes.get(id) };
}

// setPinRevealed reads the GLOBAL document (it is shared with the gate, which
// runs before any of app.js's wiring - see lock.js). Installing the stub
// globally is what lets these tests drive the real helper rather than a copy
// of it, which is the whole point: a copy could drift from the shipped one.
const realDocument = globalThis.document;
afterEach(() => { globalThis.document = realDocument; });

function loadPasscodeScreen({ api, lockNow } = {}) {
  const js = read('app.js');
  const src = js.slice(js.indexOf('const PW_FIELDS'), js.indexOf('function renderAbout('));
  const doc = pwDocument();
  globalThis.document = doc;
  const calls = { locked: 0 };
  const fn = new Function(
    'document', 'changePasscode', 'messageFor', 'lockNow', 'setPinRevealed',
    `${src}; return { PW_FIELDS, pwReady, updatePwEnabled, resetPasscodeForm, onChangePasscode };`,
  );
  const mod = fn(
    doc,
    api || (async () => ({ ok: true, status: 200, data: { changed: true } })),
    (code) => `! ${code}`,
    lockNow || (() => { calls.locked += 1; }),
    setPinRevealed,
  );
  return { ...mod, setPinRevealed, doc, calls };
}

test('U1 - the button is live only when all three fields hold six digits', () => {
  // RED WHEN: the guard drops a field, and a half-filled form can be
  // submitted - which spends one of the owner's three free attempts on a
  // request that could never have succeeded.
  const { pwReady } = loadPasscodeScreen();
  assert.equal(pwReady(['481902', '730518', '730518']), true);
  assert.equal(pwReady(['48190', '730518', '730518']), false);
  assert.equal(pwReady(['481902', '730518', '']), false);
  assert.equal(pwReady(['481902', '73051a', '730518']), false);
  assert.equal(pwReady(['481902', '730518']), false, 'a missing field is not a passing form');
});

test('U2 - each field reveals on its own, and the glyph, the pressed state and the label all move with it', () => {
  // RED WHEN: one toggle starts driving the whole form, or the icon swaps
  // while aria-pressed does not - a reveal a screen reader cannot hear.
  const { setPinRevealed, doc } = loadPasscodeScreen();

  setPinRevealed('pw-new', true);
  assert.equal(doc.getElementById('pw-new').type, 'text');
  assert.equal(doc.eyes.get('pw-new').attrs['aria-pressed'], 'true');
  assert.match(doc.eyes.get('pw-new').attrs['aria-label'], /^Hide /);
  assert.equal(doc.eyes.get('pw-new').querySelector().attrs.href, '#i-eye');

  assert.equal(doc.getElementById('pw-current').type, 'password', 'the other fields must not follow');
  assert.equal(doc.getElementById('pw-confirm').type, 'password', 'the other fields must not follow');

  setPinRevealed('pw-new', false);
  assert.equal(doc.getElementById('pw-new').type, 'password');
  assert.equal(doc.eyes.get('pw-new').attrs['aria-pressed'], 'false');
  assert.match(doc.eyes.get('pw-new').attrs['aria-label'], /^Show /);
  assert.equal(doc.eyes.get('pw-new').querySelector().attrs.href, '#i-eyeoff');
});

test('U3 - opening the screen leaves nothing from last time: every field empty AND re-masked', () => {
  // RED WHEN: the reset clears the values but not the reveal, so the next
  // person to open Settings gets a passcode field already set to show its
  // digits.
  const { resetPasscodeForm, setPinRevealed, doc } = loadPasscodeScreen();
  doc.getElementById('pw-current').value = '481902';
  setPinRevealed('pw-current', true);
  doc.getElementById('pw-msg').textContent = '! something';

  resetPasscodeForm();

  for (const id of ['pw-current', 'pw-new', 'pw-confirm']) {
    assert.equal(doc.getElementById(id).value, '');
    assert.equal(doc.getElementById(id).type, 'password', `${id} must be re-masked`);
  }
  assert.equal(doc.getElementById('pw-msg').textContent, '');
  assert.equal(doc.getElementById('pw-go').disabled, true);
});

test('U4 - a successful change re-locks this device instead of carrying on', async () => {
  // RED WHEN: the success path renders a "done" message and stays put. The
  // agent has already dropped this device's token by then, so every screen
  // behind it is dead - it just does not look it yet.
  const { onChangePasscode, doc, calls } = loadPasscodeScreen();
  doc.getElementById('pw-current').value = OLD;
  doc.getElementById('pw-new').value = NEW;
  doc.getElementById('pw-confirm').value = NEW;

  await onChangePasscode({ preventDefault() {} });
  assert.equal(calls.locked, 1, 'success must re-lock');
});

test('U5 - a refusal clears all three fields and says why, in the lock screen\'s own words', async () => {
  // RED WHEN: only the current field is cleared. Keeping the new pair and
  // re-asking for the current one is how a typo in the NEW passcode gets
  // saved - the same reasoning lock.js's clearInputs() carries.
  const api = async () => ({ ok: false, status: 401, code: 'passcode_incorrect', data: { failures: 1 } });
  const { onChangePasscode, doc, calls } = loadPasscodeScreen({ api });
  for (const id of ['pw-current', 'pw-new', 'pw-confirm']) doc.getElementById(id).value = '481902';

  await onChangePasscode({ preventDefault() {} });

  assert.equal(calls.locked, 0, 'a refusal must not lock the app');
  for (const id of ['pw-current', 'pw-new', 'pw-confirm']) {
    assert.equal(doc.getElementById(id).value, '', `${id} must be cleared`);
  }
  assert.equal(doc.getElementById('pw-msg').textContent, '! passcode_incorrect');
});

test('U6 - a double tap sends one change, not two', async () => {
  // RED WHEN: the in-flight guard goes. The second request carries the OLD
  // current passcode against the passcode the first one just changed, so it
  // comes back as a wrong-passcode failure the owner did nothing to earn.
  let sent = 0;
  const api = async () => { sent += 1; return { ok: true, status: 200, data: { changed: true } }; };
  const { onChangePasscode, doc } = loadPasscodeScreen({ api });
  doc.getElementById('pw-current').value = OLD;
  doc.getElementById('pw-new').value = NEW;
  doc.getElementById('pw-confirm').value = NEW;

  await Promise.all([
    onChangePasscode({ preventDefault() {} }),
    onChangePasscode({ preventDefault() {} }),
  ]);
  assert.equal(sent, 1);
});

test('U7 - the screen carries the artifact\'s warning, its three labelled fields, and an eye on each', () => {
  // RED WHEN: the consequence line is softened or dropped. It is the only
  // thing on the screen that says the tap ends the session on the phone
  // holding it.
  const html = read('index.html');
  const start = html.indexOf('<main id="set-passcode"');
  const screen = html.slice(start, html.indexOf('</main>', start));
  assert.ok(start !== -1, 'index.html must contain <main id="set-passcode">');

  assert.match(screen, /Every device is signed out, including this one\./);
  for (const label of ['CURRENT', 'NEW', 'CONFIRM']) {
    assert.match(screen, new RegExp(`>${label}</label>`), `the ${label} field must keep its label`);
  }
  const eyes = [...screen.matchAll(/<button class="pin-eye" id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(eyes, ['pw-current-eye', 'pw-new-eye', 'pw-confirm-eye'], 'one eye per field, in the artifact\'s order');
  // Lane 7 puts the crumb on every sub-screen, and it is wired by attribute.
  assert.match(screen, /data-set-back/);
});

test('U8 - the eye lives OUTSIDE the field label, or tapping it types into the field', () => {
  // RED WHEN: the gate's <label class="gate-field"> wrapper is copied over
  // wholesale. A click on a button inside a <label> is forwarded to the
  // labelled control, so the reveal would also move the caret.
  const html = read('index.html');
  const start = html.indexOf('<main id="set-passcode"');
  const screen = html.slice(start, html.indexOf('</main>', start));
  assert.ok(!/<label[^>]*class="gate-field"/.test(screen), 'the field group must not be a <label>');
  assert.match(screen, /<label class="gate-fieldlabel" for="pw-current"/, 'the label associates by `for` instead');
});
