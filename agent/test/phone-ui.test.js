// agent/public/phone.js and its markup: Lane 23 steps 3-4, "Open it on your
// phone", and the Phone address row. A fake document and a fake fetch - the
// real module, driven the way app.js drives it.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const URL_OK = 'https://desktop-abc1234.tail1a2b3c.ts.net:8790';

function el() {
  return { hidden: true, innerHTML: '', textContent: '', onclick: null, disabled: false, classList: { add() {}, remove() {} } };
}
const els = {};
for (const id of ['phone-ready', 'phone-failed', 'phone-cmd', 'phone-qr', 'phone-url', 'phone-copy', 'phone-done',
  'phone-skip', 'phone-retry', 'agent-phone', 'agent-phone-qr', 'agent-phone-url', 'agent-phone-copy',
  'phone-ios-qr', 'phone-android-qr', 'agent-phone-ios-qr', 'agent-phone-android-qr']) els[id] = el();
globalThis.document = { getElementById: (id) => els[id] };
globalThis.location = { port: '8790', protocol: 'http:' };

// The agent's answers, in order, and every request the page made.
const answers = [];
const requests = [];
// An answer is a body (200), an Error (the network failed), or { status } (an HTTP error).
globalThis.fetch = async (url, opts = {}) => {
  requests.push(`${opts.method || 'GET'} ${url}`);
  const body = answers.shift() ?? { url: null, serve: 'unknown' };
  if (body instanceof Error) throw body;
  if (body.status) return { ok: false, status: body.status, json: async () => ({ error: 'unauthorized' }) };
  return { ok: true, status: 200, json: async () => body };
};
const settle = () => new Promise((r) => { setTimeout(r, 0); });
// With mock timers on, setTimeout does not fire by itself; setImmediate still does.
const drain = () => new Promise((r) => { setImmediate(() => setImmediate(r)); });

const { phoneView, openPhoneScreen, phoneScreenPending, refreshAgentPhone, RECHECK_MS, STORES, closePhoneScreen } = await import('../public/phone.js');
const { qrSvg } = await import('../public/qr.js');

test('phoneView: ready only for serve on AND a well-formed tailnet address; failed only for an ANSWER', () => {
  assert.equal(phoneView({ ok: true, data: { serve: 'on', url: URL_OK } }), 'ready');
  for (const res of [
    { ok: true, data: { serve: 'off', url: URL_OK } },
    { ok: true, data: { serve: 'unknown', url: URL_OK } },
    { ok: true, data: { serve: 'on', url: null } },
    { ok: true, data: { serve: 'on', url: 'https://x.ts.net:8790/"><script>' } },
    { ok: true, data: { serve: 'on', url: 'http://desktop.ts.net:8790' } },
  ]) assert.equal(phoneView(res), 'failed', JSON.stringify(res));
  // RED WHEN (SS-C1-C06): a request that never got an answer shows "couldn't
  // switch on sharing" - a claim about Tailscale nobody asked it.
  for (const res of [
    { ok: false, status: 0, code: 'network' },
    { ok: false, status: 0, code: 'timeout' },
    { ok: false, status: 401, code: 'unauthorized' },
    null,
  ]) assert.equal(phoneView(res), 'pending', JSON.stringify(res));
});

test('a failed request shows neither variant and asks again every RECHECK_MS until it gets an answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  requests.length = 0;
  answers.push(new Error('offline'), new Error('offline'), { url: URL_OK, serve: 'on' });
  const p = openPhoneScreen(() => {});
  await drain();
  assert.ok(els['phone-ready'].hidden && els['phone-failed'].hidden, 'nothing claimed');
  t.mock.timers.tick(RECHECK_MS - 1);
  await drain();
  assert.equal(requests.length, 1);
  t.mock.timers.tick(1);
  await drain();
  assert.equal(requests.length, 2);
  assert.ok(els['phone-ready'].hidden && els['phone-failed'].hidden);
  t.mock.timers.tick(RECHECK_MS);
  await drain();
  assert.equal(requests.length, 3);
  assert.equal(els['phone-ready'].hidden, false);
  t.mock.timers.tick(RECHECK_MS * 3);
  await drain();
  assert.equal(requests.length, 3, 'an answer ends the re-checks');
  els['phone-done'].onclick();
  await p;
});

test('DONE or SKIP stops the re-checks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  requests.length = 0;
  answers.push(new Error('offline'));
  const p = openPhoneScreen(() => {});
  await drain();
  els['phone-skip'].onclick();
  await p;
  t.mock.timers.tick(RECHECK_MS * 3);
  await drain();
  assert.deepEqual(requests, ['GET /api/phone']);
});

test('a 401 is not asked again on a timer; the re-entry after re-unlock checks afresh', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  requests.length = 0;
  answers.push({ status: 401 });
  const p = openPhoneScreen(() => {});
  await drain();
  assert.ok(els['phone-ready'].hidden && els['phone-failed'].hidden);
  t.mock.timers.tick(RECHECK_MS * 3);
  await drain();
  assert.equal(requests.length, 1, 'a timer would re-lock the app under the owner\'s typing');
  answers.push({ url: URL_OK, serve: 'on' });
  assert.equal(openPhoneScreen(() => {}), p, 're-entry: the same promise');
  await drain();
  assert.equal(requests.length, 2);
  assert.equal(els['phone-ready'].hidden, false);
  els['phone-done'].onclick();
  await p;
});

// RED WHEN: a re-entry reuses the render from before the 401 instead of asking.
test('a re-entry re-checks instead of keeping an old answer', async () => {
  answers.push({ url: URL_OK, serve: 'off' });
  const p = openPhoneScreen(() => {});
  await settle();
  assert.equal(els['phone-failed'].hidden, false);
  answers.push({ url: URL_OK, serve: 'on' });
  openPhoneScreen(() => {});
  await settle();
  assert.equal(els['phone-ready'].hidden, false);
  assert.equal(els['phone-failed'].hidden, true);
  els['phone-done'].onclick();
  await p;
});

test('the screen: ready variant with the code and address, DONE resolves it', async () => {
  answers.push({ url: URL_OK, serve: 'on' });
  let shown = 0;
  const p = openPhoneScreen(() => { shown += 1; });
  assert.equal(shown, 1);
  assert.ok(phoneScreenPending());
  assert.ok(els['phone-ready'].hidden && els['phone-failed'].hidden, 'nothing claimed before the agent answers');
  await settle();
  assert.equal(els['phone-ready'].hidden, false);
  assert.equal(els['phone-failed'].hidden, true);
  assert.equal(els['phone-url'].textContent, URL_OK);
  assert.match(els['phone-qr'].innerHTML, /^<svg class="qr-svg"/);
  assert.equal(typeof els['phone-copy'].onclick, 'function');
  // Re-entry (a re-unlock) re-shows it and hands back the same promise.
  answers.push({ url: URL_OK, serve: 'on' });
  assert.equal(openPhoneScreen(() => { shown += 1; }), p);
  assert.equal(shown, 2);
  els['phone-done'].onclick();
  await p;
  assert.equal(phoneScreenPending(), false);
});

test('serve failed: the command for THIS port, TRY AGAIN re-checks and shows the code once sharing is on', async () => {
  requests.length = 0;
  answers.push({ url: URL_OK, serve: 'off' }, { url: URL_OK, serve: 'on' });
  const p = openPhoneScreen(() => {});
  await settle();
  assert.equal(els['phone-failed'].hidden, false);
  assert.equal(els['phone-ready'].hidden, true);
  assert.equal(els['phone-cmd'].textContent, 'tailscale serve --bg --https=8790 8790');
  await els['phone-retry'].onclick();
  assert.deepEqual(requests, ['GET /api/phone', 'POST /api/phone/retry']);
  assert.equal(els['phone-ready'].hidden, false);
  assert.equal(els['phone-failed'].hidden, true);
  els['phone-done'].onclick();
  await p;
});

test('SKIP FOR NOW resolves too', async () => {
  answers.push({ url: null, serve: 'off' });
  const p = openPhoneScreen(() => {});
  await settle();
  els['phone-skip'].onclick();
  await p;
  assert.equal(phoneScreenPending(), false);
});

test('Settings > Agent status: the Phone address row shows only once the phone can reach the PC', async () => {
  answers.push({ url: URL_OK, serve: 'off' });
  await refreshAgentPhone();
  assert.equal(els['agent-phone'].hidden, true);
  answers.push({ url: URL_OK, serve: 'on' });
  await refreshAgentPhone();
  assert.equal(els['agent-phone'].hidden, false);
  assert.equal(els['agent-phone-url'].textContent, URL_OK);
  assert.match(els['agent-phone-qr'].innerHTML, /^<svg class="qr-svg"/);
});

test('"No Tailscale on your phone?": each address also gets the App Store and Google Play codes', async () => {
  // Tailscale Inc.'s own listings (verified 2026-09-27), and nothing else.
  assert.deepEqual(STORES, {
    ios: ['https://apps.apple.com/app/tailscale/id1470499037', 'QR code of Tailscale on the App Store'],
    android: ['https://play.google.com/store/apps/details?id=com.tailscale.ipn', 'QR code of Tailscale on Google Play'],
  });
  for (const id of ['phone-ios-qr', 'phone-android-qr', 'agent-phone-ios-qr', 'agent-phone-android-qr']) els[id].innerHTML = '';
  answers.push({ url: URL_OK, serve: 'on' });
  const p = openPhoneScreen(() => {});
  await settle();
  answers.push({ url: URL_OK, serve: 'on' });
  await refreshAgentPhone();
  for (const prefix of ['phone', 'agent-phone']) {
    assert.equal(els[`${prefix}-ios-qr`].innerHTML, qrSvg(...STORES.ios), prefix);
    assert.equal(els[`${prefix}-android-qr`].innerHTML, qrSvg(...STORES.android), prefix);
    // A screen reader must not announce a store code as the address (TS-C1-01).
    assert.match(els[`${prefix}-ios-qr`].innerHTML, /aria-label="QR code of Tailscale on the App Store"/);
    assert.match(els[`${prefix}-android-qr`].innerHTML, /aria-label="QR code of Tailscale on Google Play"/);
    assert.match(els[`${prefix}-qr`].innerHTML, /aria-label="QR code of the address"/);
  }
  els['phone-done'].onclick();
  await p;
});

test('the words are the Artifact\'s, verbatim, in index.html', () => {
  for (const words of [
    '<div class="phone-sec">Last step</div>',
    '<div class="phone-title">Open it on your phone</div>',
    'Your phone needs the Tailscale app too, from tailscale.com/download, signed in to the same Tailscale account as this PC. Then scan this with its camera, or type the address.',
    '<b>iPhone or iPad</b>Open it in Safari, tap Share, then Add to Home Screen.',
    '<b>Android</b>Open it in Chrome, tap ⋮, then Add to Home screen.',
    'Enter your passcode, tap a project, and the session shows up in the Claude app&rsquo;s Code tab.',
    '>DONE</button>',
    'This PC couldn&rsquo;t switch on Tailscale sharing, so your phone can&rsquo;t reach it yet.',
    'Open a terminal on this PC and run:',
    '>SKIP FOR NOW</button>',
    '>TRY AGAIN</button>',
    '<span class="row-name">Phone address</span>',
  ]) assert.ok(HTML.includes(words), words);
  assert.equal((HTML.match(/>COPY<\/button>/g) || []).length, 2, 'COPY on the screen and on the row');
  // Sequence 24: the same closed button on the screen and on the row.
  for (const words of [
    '<span>No Tailscale on your phone?</span>',
    '<b>iPhone or iPad</b>App Store</div>',
    '<b>Android</b>Google Play</div>',
    'Install it, sign in with the same Tailscale account as this PC, then scan the code above.',
  ]) assert.equal(HTML.split(words).length - 1, 2, words);
  assert.equal((HTML.match(/<details class="ts-more">/g) || []).length, 2, 'closed by default: no open attribute');
});

// Sequence 29: opened from Settings, the screen can be left by the browser's
// back button. RED WHEN closePhoneScreen stops settling it - a later unlock
// would then bring the screen back on its own (phoneScreenPending).
test('closePhoneScreen settles an open screen as DONE would, and is a no-op otherwise', async () => {
  closePhoneScreen();   // nothing open: must not throw
  answers.push({ url: URL_OK, serve: 'on' });
  const p = openPhoneScreen(() => {});
  assert.equal(phoneScreenPending(), true);
  closePhoneScreen();
  await p;
  assert.equal(phoneScreenPending(), false);
});
