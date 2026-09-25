// Lane 19's words and pure state logic. No DOM access anywhere - app.js is
// the only place any of this touches the page, same rule as folders-ui.js
// and copy.js. Every string below is copied verbatim from the approved
// Artifact (design/userflow.artifact.html) - do not reword, do not invent.

// --- Settings root row (Lane 6) --------------------------------------------

export const ROW_OFF = 'off';
export const ROW_CANT = 'can’t turn on here';

// --- Notifications screen: state 1, off and available ----------------------

export const OFF_NAME = 'Off on this device';
export const NAME_FIELD_LABEL = 'Name this device · optional';
export const NAME_PLACEHOLDER = 'e.g. My iPhone';
export const TURN_ON = 'TURN ON';
export const HEAR_ABOUT_LABEL = 'You will hear about';
export const HEAR_LAUNCH_FAILED = 'A session that could not start';
export const HEAR_PC_CONNECTION = 'Your PC’s connection needing attention';
export const ENABLE_INFO = 'Only that. No project names, so nothing private shows on your lock screen.';

// --- state 2, can't turn on here --------------------------------------------

export const CANT_NAME = 'Can’t turn on here';
export const NOT_STANDALONE_SUB = 'not opened from your Home Screen';
export const NO_PUSH_SUB = 'needs iOS 16.4 or later';
export const DENIED_SUB = 'turned off in iOS Settings';
export const NOT_STANDALONE_BANNER = 'Notifications only work when claude-remote is opened from your Home Screen. In Safari, tap Share, then Add to Home Screen, then open it from there.';
export const NO_PUSH_BANNER = 'This iPhone’s iOS can’t get notifications from web apps. It needs iOS 16.4 or later.';
export const DENIED_BANNER = 'Notifications for claude-remote are off in iOS Settings. Turn them on in Settings › Notifications › claude-remote, then come back.';
// Off Apple devices there are no iOS Settings; the browser holds the permission.
export const DENIED_SUB_BROWSER = 'blocked in this browser';
export const DENIED_BANNER_BROWSER = 'Notifications for claude-remote are blocked in this browser. Allow them in this site’s settings, then come back.';

// --- state 3, enabling -------------------------------------------------------

export const ENABLING_NAME = 'Turning on…';
export const ENABLING_SUB = 'waiting for your answer';
export const TURNING_ON = 'TURNING ON…';

// --- state 4, enable failed --------------------------------------------------

export const ENABLE_FAILED_SUB = 'not saved';
export const ENABLE_FAILED_PC = 'Couldn’t turn notifications on. Your PC didn’t save this device. Try again.';
export const ENABLE_FAILED_PHONE = 'This phone couldn’t set up notifications. Try again.';
export const TRY_AGAIN = 'TRY AGAIN';

// --- state 5, on --------------------------------------------------------------

export const ON_NAME = 'On for this device';
export const ON_SUB = 'you will hear about the two things below';
export const DEVICES_HEADING = 'DEVICES';
export const NO_NAME_SUB = 'no name';
export const SEND_A_TEST = 'SEND A TEST';
export const TURN_OFF = 'TURN OFF ON THIS DEVICE';

// --- states 6/7, test result --------------------------------------------------

export const SENDING = 'SENDING…';
const SERVICE_NAMES = { apple: 'Apple', google: 'Google', mozilla: 'Mozilla' };

// --- state 8, rename ----------------------------------------------------------

export const CANCEL = 'CANCEL';
export const SAVE = 'SAVE';

// --- state 9, remove another device -------------------------------------------

export const REMOVE = 'REMOVE';
export const REMOVE_WARN = 'Lost it? Change your passcode too. Removing it here stops the pings; only a new passcode stops it opening the app.';

// --- state 10, stopped working -------------------------------------------------

export const STOPPED_WARN = 'Notifications stopped working on this device, so it was taken off the list. Turn them on again to get them back.';

/** 'Stop notifications on <name>?' */
export function removePrompt(name) {
  return `Stop notifications on ${name}?`;
}

/** 'Added <d Mon>. Leave empty to show the date.' */
export function renameHint(dateText) {
  return `Added ${dateText}. Leave empty to show the date.`;
}

/**
 * The Home Screen (standalone) requirement is Apple's, so it applies on
 * iPhone/iPad only. iPadOS may report a Macintosh UA, so an iPad is a
 * Macintosh UA carrying more than one touch point. Pure and injectable so it
 * is testable with no real navigator.
 */
export function isIphoneOrIpad(nav) {
  if (!nav || typeof nav.userAgent !== 'string') return false;
  if (/iPhone|iPad/.test(nav.userAgent)) return true;
  return nav.userAgent.includes('Macintosh') && typeof nav.maxTouchPoints === 'number' && nav.maxTouchPoints > 1;
}

/**
 * Checked in this order, first match wins: not standalone, then no
 * PushManager, then permission denied. `standalone` already reflects whether
 * the Home Screen check applies on this platform (see isIphoneOrIpad) - the
 * caller passes `true` there to skip it entirely.
 * -> null | 'not_standalone' | 'no_push' | 'denied'
 */
export function cantTurnOnReason({ standalone, hasPush, permission }) {
  if (!standalone) return 'not_standalone';
  if (!hasPush) return 'no_push';
  if (permission === 'denied') return 'denied';
  return null;
}

/**
 * The Notifications screen's overall state, from `state.push` - see app.js's
 * refreshPush for the shape ({ reason, mine, devices, publicKey }).
 * -> 'loading' | 'unavailable' | 'off' | 'on' | 'stopped'
 */
export function notifyScreenState(push) {
  if (!push) return 'loading';
  if (push.reason) return 'unavailable';
  if (push.devices === null || push.devices === undefined) return 'loading';
  if (!push.mine) return 'off';
  return push.devices.some((d) => d.endpoint === push.mine) ? 'on' : 'stopped';
}

function deviceCountText(n) {
  return n === 1 ? '1 device' : `${n} devices`;
}

/** The Settings root row's own state - answers before the row is tapped. */
export function notifyRowState(push) {
  if (!push) return { text: '', enterable: false };
  if (push.reason) return { text: ROW_CANT, enterable: true };
  if (push.devices === null || push.devices === undefined) return { text: '', enterable: false };
  return notifyScreenState(push) === 'on'
    ? { text: `on · ${deviceCountText(push.devices.length)}`, enterable: true }
    : { text: ROW_OFF, enterable: true };
}

/** 'no other devices yet' | '1 other device' | 'N other devices' (D13). */
export function otherDevicesLine(n) {
  if (n === 0) return 'no other devices yet';
  return n === 1 ? '1 other device' : `${n} other devices`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'd Mon', local time. */
export function addedDate(iso) {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/**
 * Devices for the screen: this device first, then the rest by createdAt asc.
 * -> [{ endpoint, name, sub, current }]
 * `name` is the drawn name (the stored one, or 'Added <d Mon>'); `sub` is the
 * row's own sub-line, or null when the row draws none (a named other device).
 */
export function deviceRows(devices, mine) {
  const sorted = [...(devices || [])].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const mineRow = mine ? sorted.find((d) => d.endpoint === mine) : undefined;
  const others = sorted.filter((d) => d.endpoint !== mine);
  const ordered = mineRow ? [mineRow, ...others] : sorted;

  return ordered.map((d) => {
    const current = d.endpoint === mine;
    const dateText = addedDate(d.created_at);
    const name = d.name || `Added ${dateText}`;
    let sub = null;
    if (current) sub = `this device · added ${dateText}`;
    else if (!d.name) sub = NO_NAME_SUB;
    return {
      endpoint: d.endpoint, name, sub, current,
    };
  });
}

function serviceDisplay(service) {
  return SERVICE_NAMES[service] || null;
}

/**
 * The good test-result banner, naming the push service - never hard-coded.
 * The last sentence follows the DEVICE, not the service: a Mac on Safari uses
 * Apple's service but has no iOS Settings.
 */
export function testAcceptedCopy(service, onAppleDevice) {
  const who = serviceDisplay(service) || 'The push service';
  const check = onAppleDevice
    ? 'check Focus and claude-remote’s notification settings in iOS.'
    : 'check this browser’s notification settings.';
  return `${who} accepted the test. It should arrive in a few seconds. If it doesn’t, ${check}`;
}

/** The bad test-result banner, naming the push service - never hard-coded. */
export function testFailedCopy(service) {
  const name = serviceDisplay(service);
  const whose = name ? `${name}’s push service` : 'the push service';
  return `The test didn’t go out. Your PC couldn’t reach ${whose}. Check the PC’s internet connection, then try again.`;
}

/** Uint8Array for applicationServerKey, from a b64url public key string. */
export function b64uToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const base64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
