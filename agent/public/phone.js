// Lane 23 steps 3-4 - "Open it on your phone", the desk's last first-run
// screen, and the Phone address row in Settings > Agent status.
//
// The words live in index.html, verbatim from the approved Artifact; this
// module only chooses which variant shows and fills in the address. The
// address comes from the agent (GET /api/phone), which reads it from
// Tailscale - never typed, never guessed here.

import { getPhone, retryPhone } from './api.js';
import { qrSvg } from './qr.js';
import { serveCommand } from './copy.js';

// A tailnet address as agent/phone.js builds it, and nothing else - it is
// about to become a QR code the owner points a phone at.
const ADDRESS = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+:\d{1,5}$/;

/**
 * 'ready' only when the PC says sharing is on AND knows its address;
 * 'failed' only when the PC ANSWERED and said otherwise; 'pending' when the
 * request itself failed (401, network, timeout) - that says nothing about
 * sharing, so neither variant may claim anything (SS-C1-C06).
 */
export function phoneView(res) {
  if (!res || !res.ok || !res.data) return 'pending';
  const ok = res.data.serve === 'on' && typeof res.data.url === 'string' && ADDRESS.test(res.data.url);
  return ok ? 'ready' : 'failed';
}

export const RECHECK_MS = 3000;

function thisPort() {
  return location.port || (location.protocol === 'https:' ? '443' : '80');
}

// COPY: the clipboard where the browser allows it (127.0.0.1 and https are
// both secure contexts); otherwise the address is selected so Ctrl+C works.
async function copyAddress(url, button, text) {
  try {
    await navigator.clipboard.writeText(url);
    button.classList.add('copied');
    setTimeout(() => button.classList.remove('copied'), 1500);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(text);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function fillAddress(prefix, url) {
  document.getElementById(`${prefix}-qr`).innerHTML = qrSvg(url);   // numbers only - see qr.js
  const text = document.getElementById(`${prefix}-url`);
  text.textContent = url;
  const copy = document.getElementById(`${prefix}-copy`);
  copy.onclick = () => copyAddress(url, copy, text);
}

function renderPhone(view, res) {
  if (view === 'ready') fillAddress('phone', res.data.url);
  if (view === 'failed') document.getElementById('phone-cmd').textContent = serveCommand(thisPort());
  document.getElementById('phone-ready').hidden = view !== 'ready';
  document.getElementById('phone-failed').hidden = view !== 'failed';
}

let pending = null;
let checks = 0;        // only the newest check may render
let recheck = null;

/**
 * Asks the PC and shows the answer. A failed request is asked again every
 * RECHECK_MS while the screen is pending - except a 401: api.js has already
 * sent the app to the lock screen, and asking again would re-lock it under the
 * owner's typing. The re-unlock calls openPhoneScreen, which checks afresh.
 */
async function check(ask) {
  clearTimeout(recheck);
  recheck = null;
  const mine = ++checks;
  const res = await ask();
  if (!pending || mine !== checks) return;
  const view = phoneView(res);
  renderPhone(view, res);
  if (view === 'pending' && res?.status !== 401) recheck = setTimeout(() => check(getPhone), RECHECK_MS);
}

/** True while the screen is up and something is awaiting its DONE or SKIP. */
export function phoneScreenPending() {
  return pending !== null;
}

/**
 * Puts the screen up (via `show`, app.js's showScreen) and resolves on DONE
 * or SKIP FOR NOW. Re-entrant like the folder picker: a second call - a
 * re-unlock after a 401 - re-shows the screen, checks again (the first answer
 * may have been that 401), and hands back the same promise.
 */
export function openPhoneScreen(show) {
  show();
  if (pending) {
    check(getPhone);
    return pending;
  }
  const done = document.getElementById('phone-done');
  const skip = document.getElementById('phone-skip');
  const retry = document.getElementById('phone-retry');
  renderPhone('pending');
  pending = new Promise((resolve) => {
    const finish = () => {
      done.onclick = null; skip.onclick = null; retry.onclick = null;
      clearTimeout(recheck);
      recheck = null;
      pending = null;
      resolve();
    };
    done.onclick = finish;
    skip.onclick = finish;
    retry.onclick = async () => {
      retry.disabled = true;
      await check(retryPhone);
      retry.disabled = false;
    };
  });
  check(getPhone);
  return pending;
}

/** Settings > Agent status: the row shows only once the phone can reach the PC. */
export async function refreshAgentPhone() {
  const res = await getPhone();
  const ready = phoneView(res) === 'ready';
  if (ready) fillAddress('agent-phone', res.data.url);
  document.getElementById('agent-phone').hidden = !ready;
}
