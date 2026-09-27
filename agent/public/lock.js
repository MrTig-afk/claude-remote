// The lock and first-run set-passcode screens. DOM only, plus calls into
// api.js - api.js is the only module that talks to the network, and never
// any project data. showGate() resolves only once a valid token is held.
import { getAuthStatus, setPasscode, unlock, setToken } from './api.js';
// Same copy and command builder as the project-list variant (app.js) - one source, not two.
import { SERVE_MISSING, serveCommand } from './copy.js';

const MESSAGES = {
  // The count stays: it is the only warning that the backoff is coming
  // before it lands.
  passcode_incorrect: (data) => `! Wrong passcode. ${data.failures} ${data.failures === 1 ? 'try' : 'tries'} so far.`,
  too_many_attempts: (data) => `! Too many wrong tries. Try again in ${formatWait(data.retry_after_ms)}.`,
  passcode_mismatch: () => "! Those didn't match. Enter both again.",
  malformed_passcode: () => '! A passcode is exactly 6 digits.',
  passcode_too_weak: () => '! Too easy to guess. Pick something less obvious.',
  already_configured: () => '! A passcode is already set on this agent. Reload the app.',
  not_configured: () => '! No passcode is set yet. Reload the app to set one.',
  internal_error: () => '! The agent could not save it. Restart it on the PC, and check agent.log if it happens again.',
  network: () => '! Cannot reach the agent. Check the PC is awake and Tailscale is connected.',
  timeout: () => '! Cannot reach the agent. Check the PC is awake and Tailscale is connected.',
};

/**
 * A message line and its colour, set together so a colour never outlives its
 * words: 'error' red, 'warn' amber, '' plain (owner 2026-09-27, "Make errors
 * red"; Artifact Lanes 11, 12 and 20). The lockout is amber, as drawn.
 */
export function setMsg(el, text, tone = '') {
  el.textContent = text;
  el.dataset.tone = tone;
}
export const toneFor = (code) => (code === 'too_many_attempts' ? 'warn' : 'error');

function formatWait(ms) {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

// Exported for the Change passcode screen (app.js): it refuses the same
// credential for the same reasons, so it must say the same words. One map,
// two screens - a second copy is how "Wrong passcode" and "Incorrect
// passcode" end up in the same app.
export function messageFor(code, status, data) {
  const fn = MESSAGES[code];
  if (fn) return fn(data || {});
  return `! The agent refused that (status ${status}).`;
}

function els() {
  return {
    picker: document.getElementById('picker'),
    gate: document.getElementById('gate'),
    form: document.getElementById('gate-form'),
    label: document.getElementById('gate-label'),
    title: document.getElementById('gate-title'),
    sub: document.getElementById('gate-sub'),
    go: document.getElementById('gate-go'),
    msg: document.getElementById('gate-msg'),
    pin: document.getElementById('pin'),
    confirmField: document.getElementById('field-confirm'),
    confirmPin: document.getElementById('pin-confirm'),
    pinEye: document.getElementById('pin-eye'),
    confirmEye: document.getElementById('pin-confirm-eye'),
  };
}

// The two fields on this screen. Both eyes are wired from this list, and both
// are re-masked from it, so a field added here cannot be half-wired.
const GATE_PINS = ['pin', 'pin-confirm'];

function isSixDigits(v) {
  return /^[0-9]{6}$/.test(v);
}

/**
 * The eye toggle, shared by every passcode field in the app - the two on this
 * gate and the three on Settings' Change passcode screen (app.js imports it).
 * It lives HERE rather than in app.js because the gate runs before
 * wireEvents() does, so app.js cannot own a control the lock screen needs.
 *
 * The button is found by convention: `<inputId>-eye`. A lookup by id rather
 * than a selector keeps this module's whole DOM surface to getElementById,
 * which is what makes it testable against a small stub.
 *
 * The glyph, the pressed state and the label all move together - swapping
 * only the icon would tell a screen reader nothing had changed.
 */
export function setPinRevealed(inputId, revealed) {
  document.getElementById(inputId).type = revealed ? 'text' : 'password';
  const btn = document.getElementById(`${inputId}-eye`);
  btn.setAttribute('aria-pressed', String(revealed));
  btn.setAttribute('aria-label', `${revealed ? 'Hide' : 'Show'} ${btn.dataset.pinName}`);
  btn.querySelector('use').setAttribute('href', revealed ? '#i-eye' : '#i-eyeoff');
}

/**
 * Reveals the same four elements the project-list variant draws, under the
 * gate's own "Waiting for the PC..." line - never instead of it.
 */
export function showServeMissingNotice() {
  const el = document.getElementById('gate-serve-missing');
  if (!el) return; // the gate markup is absent in a harness that does not model it
  document.getElementById('gate-serve-missing-banner').textContent = SERVE_MISSING.banner;
  document.getElementById('gate-serve-missing-lead').textContent = SERVE_MISSING.lead;
  const port = location.port || (location.protocol === 'https:' ? '443' : '80');
  document.getElementById('gate-serve-missing-cmd').textContent = serveCommand(port);
  document.getElementById('gate-serve-missing-after').textContent = SERVE_MISSING.after;
  el.hidden = false;
}

/** Once the PC answers, the gate is the ordinary unlock again - the notice goes with it. */
function hideServeMissingNotice() {
  const el = document.getElementById('gate-serve-missing');
  if (el) el.hidden = true;
}

// The same retry ladder app.js uses, and it has to live here as well as
// there. The passcode gate is not a screen the owner passes on the way to
// the waiting state - it is the screen a cold boot LANDS on, every single
// time: the token is memory-only by design (see api.js), so every open of
// the app runs showGate() before app.js ever calls load(). Until this
// existed, opening the PWA while the PC was still booting dead-ended on
// '! Cannot reach the agent' with a RETRY button and nothing retrying, and
// the whole waiting state behind it was unreachable.
const WAIT_GAPS_MS = [2000, 3000, 5000, 10000, 15000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// app.js:load() fires two requests in parallel, so one token expiry calls
// onAuthLost twice. Sharing the in-flight gate makes the second call a no-op
// instead of stranding the first promise (and stacking a second set of
// listeners with stale closed-over state on the same DOM nodes).
let pending = null;

export function showGate() {
  if (pending) return pending;
  pending = runGate().finally(() => { pending = null; });
  return pending;
}

async function runGate() {
  const e = els();

  e.picker.hidden = true;
  e.gate.hidden = false;

  let mode = 'lock'; // or 'setup'
  let rateLimited = false;
  let statusUnknown = false; // the status probe failed; the button is a RETRY
  let inFlight = false;

  function retext() {
    if (mode === 'setup') {
      e.label.textContent = 'FIRST RUN';
      e.title.textContent = 'Set a passcode';
      e.sub.textContent = "6 digits. You'll be asked for this every time the app opens.";
      e.go.textContent = 'SET PASSCODE';
      e.confirmField.hidden = false;
    } else {
      e.label.textContent = 'LOCKED';
      e.title.textContent = 'Enter passcode';
      e.sub.textContent = '6 digits. Asked every time the app opens.';
      e.go.textContent = 'UNLOCK';
      e.confirmField.hidden = true;
    }
  }

  // Stays enabled while rate-limited (regardless of digit count) so a tap
  // re-submits and picks up a fresh retry_after_ms - the server's lockout
  // check runs before its format check, so even a stale/blank field still
  // gets back a real answer, never a false malformed_passcode.
  function updateGoEnabled() {
    // While the button is a RETRY, digit count is irrelevant - and disabling
    // it would strand the owner on the offline screen, because #gate-go is
    // the form's default button so a disabled state kills Enter as well.
    if (statusUnknown) { e.go.disabled = false; return; }
    if (rateLimited) { e.go.disabled = false; return; }
    const pinOk = isSixDigits(e.pin.value);
    const confirmOk = mode !== 'setup' || isSixDigits(e.confirmPin.value);
    e.go.disabled = !(pinOk && confirmOk);
  }

  // Emptied AND re-masked. A wrong passcode clears the field; leaving it
  // revealed would mean the next person to pick the phone up gets a passcode
  // box already set to show its digits.
  function clearInputs() {
    e.pin.value = '';
    e.confirmPin.value = '';
    for (const id of GATE_PINS) setPinRevealed(id, false);
    updateGoEnabled();
  }

  return new Promise((resolve) => {
    let waitTries = 0;
    let waiting = false;

    // One toggle per FIELD, as the artifact specifies - never one switch for
    // the form. Held as a list so the same list can unwire them on the way
    // out: showGate() can run again after a token expiry, and a listener left
    // behind would hold the previous run's closure over the same nodes.
    const eyeHandlers = GATE_PINS.map((id) => [
      document.getElementById(`${id}-eye`),
      () => setPinRevealed(id, document.getElementById(`${id}-eye`).getAttribute('aria-pressed') !== 'true'),
    ]);

    // network/timeout only - the two codes that mean the agent said nothing
    // at all, which is what a PC that has not finished booting looks like
    // from a phone. Every other code is the agent ANSWERING, and retrying an
    // answer forever would be a spinner that never resolves. Stops on the
    // first success, and while the app is in the background.
    async function waitForAgent() {
      if (waiting) return;
      waiting = true;
      try {
        while (statusUnknown && document.visibilityState === 'visible') {
          await sleep(WAIT_GAPS_MS[Math.min(waitTries, WAIT_GAPS_MS.length - 1)]);
          if (!statusUnknown || document.visibilityState !== 'visible') return;
          waitTries += 1;
          setMsg(e.msg, `Waiting for the PC (${waitTries})...`);
          // Re-entrant by design: checkStatus() calls waitForAgent() again on
          // a failure, and `waiting` is still true, so that call is a no-op
          // and THIS loop keeps ownership of the retrying.
          await checkStatus();
        }
      } finally {
        waiting = false;
      }
    }

    // The loop above stops when the app goes to the background, so something
    // has to restart it on the way back - app.js's visibilitychange handler
    // is not wired until after the gate resolves, and without this the owner
    // returns to a frozen 'Waiting for the PC (3)' that never moves again.
    function onVisible() {
      if (document.visibilityState === 'visible' && statusUnknown) waitForAgent();
    }
    document.addEventListener('visibilitychange', onVisible);

    async function checkStatus() {
      const res = await getAuthStatus();
      if (!res.ok) {
        // Cannot know yet whether this is a first run or a lock, so the same
        // button becomes RETRY and re-runs this probe instead of submitting
        // to a route that may not be the right one for this unknown state.
        statusUnknown = true;
        e.go.textContent = 'RETRY';
        e.go.disabled = false;
        if (res.code === 'network' || res.code === 'timeout') {
          if (waitTries === 0) setMsg(e.msg, 'Waiting for the PC. This screen will unlock itself as soon as the agent answers.');
          waitForAgent();
          return;
        }
        // Not a silence - the agent refused. RETRY stays the only way on,
        // correctly: waiting cannot fix an answer.
        waitTries = 0;
        setMsg(e.msg, messageFor(res.code, res.status), toneFor(res.code));
        return;
      }
      statusUnknown = false;
      waitTries = 0;
      setMsg(e.msg, ''); // the probe worked; drop any stale "cannot reach" line
      hideServeMissingNotice(); // the PC answered - back to the ordinary unlock
      mode = res.data.configured ? 'lock' : 'setup';
      rateLimited = mode === 'lock' && res.data.retry_after_ms > 0;
      retext();
      updateGoEnabled();
      if (rateLimited) {
        setMsg(e.msg, `! Too many wrong tries. Try again in ${formatWait(res.data.retry_after_ms)}.`, 'warn');
      }
    }

    async function onSubmit(ev) {
      ev.preventDefault();
      // A double-tap on a phone is ordinary; without this guard it sends two
      // unlocks and one fat-finger burns two of the three free attempts.
      if (inFlight) return;
      inFlight = true;
      e.go.disabled = true;

      if (statusUnknown) {
        await checkStatus();
        inFlight = false;
        return;
      }

      const pin = e.pin.value;
      const confirmPin = e.confirmPin.value;
      const res = mode === 'setup' ? await setPasscode(pin, confirmPin) : await unlock(pin);
      inFlight = false;

      if (res.ok) {
        setToken(res.data.token);
        e.gate.hidden = true;
        e.picker.hidden = false;
        clearInputs();
        e.form.removeEventListener('submit', onSubmit);
        e.pin.removeEventListener('input', updateGoEnabled);
        e.confirmPin.removeEventListener('input', updateGoEnabled);
        for (const [btn, fn] of eyeHandlers) btn.removeEventListener('click', fn);
        // Removed with the rest: showGate can run again (onAuthLost), and a
        // listener left behind here would hold the previous run's closure
        // over the same DOM nodes - the exact stacking `pending` exists to
        // avoid a few lines above.
        document.removeEventListener('visibilitychange', onVisible);
        resolve();
        return;
      }

      rateLimited = res.code === 'too_many_attempts';
      // Keeping the first entry and re-asking only the second is how a
      // typo gets saved - so passcode_mismatch clears BOTH inputs too.
      clearInputs();
      e.pin.focus();
      setMsg(e.msg, messageFor(res.code, res.status, res.data), toneFor(res.code));
      updateGoEnabled();
    }

    e.form.addEventListener('submit', onSubmit);
    e.pin.addEventListener('input', updateGoEnabled);
    e.confirmPin.addEventListener('input', updateGoEnabled);
    for (const [btn, fn] of eyeHandlers) btn.addEventListener('click', fn);

    checkStatus();
  });
}
