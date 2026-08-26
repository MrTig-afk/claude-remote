// The lock and first-run set-passcode screens. DOM only, plus calls into
// api.js - api.js is the only module that talks to the network, and never
// any project data. showGate() resolves only once a valid token is held.
import { getAuthStatus, setPasscode, unlock, setToken } from './api.js';

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
  internal_error: () => '! The agent could not save it. Check its terminal window on the PC.',
  network: () => '! Cannot reach the agent. Check the PC is awake and Tailscale is connected.',
  timeout: () => '! Cannot reach the agent. Check the PC is awake and Tailscale is connected.',
};

function formatWait(ms) {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

function messageFor(code, status, data) {
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
  };
}

function isSixDigits(v) {
  return /^[0-9]{6}$/.test(v);
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

  function clearInputs() {
    e.pin.value = '';
    e.confirmPin.value = '';
    updateGoEnabled();
  }

  return new Promise((resolve) => {
    async function checkStatus() {
      const res = await getAuthStatus();
      if (!res.ok) {
        // Cannot know yet whether this is a first run or a lock, so the same
        // button becomes RETRY and re-runs this probe instead of submitting
        // to a route we may not have (spec 7.4).
        statusUnknown = true;
        e.msg.textContent = messageFor(res.code, res.status);
        e.go.textContent = 'RETRY';
        e.go.disabled = false;
        return;
      }
      statusUnknown = false;
      e.msg.textContent = ''; // the probe worked; drop any stale "cannot reach" line
      mode = res.data.configured ? 'lock' : 'setup';
      rateLimited = mode === 'lock' && res.data.retry_after_ms > 0;
      retext();
      updateGoEnabled();
      if (rateLimited) {
        e.msg.textContent = `! Too many wrong tries. Try again in ${formatWait(res.data.retry_after_ms)}.`;
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
        resolve();
        return;
      }

      rateLimited = res.code === 'too_many_attempts';
      // Keeping the first entry and re-asking only the second is how a
      // typo gets saved - so passcode_mismatch clears BOTH inputs too.
      clearInputs();
      e.pin.focus();
      e.msg.textContent = messageFor(res.code, res.status, res.data);
      updateGoEnabled();
    }

    e.form.addEventListener('submit', onSubmit);
    e.pin.addEventListener('input', updateGoEnabled);
    e.confirmPin.addEventListener('input', updateGoEnabled);

    checkStatus();
  });
}
