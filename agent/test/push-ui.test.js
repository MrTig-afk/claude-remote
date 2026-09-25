// T133 - push-ui.js (pure) and the app.js slices it feeds. Same idiom as
// settings.test.js: pure logic imported directly, app.js sliced out with
// new Function and run under a small stub DOM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { codeOnly } from './helper-source.js';

import {
  cantTurnOnReason, isIphoneOrIpad, notifyScreenState, notifyRowState, otherDevicesLine, addedDate, deviceRows,
  testAcceptedCopy, testFailedCopy, b64uToBytes, removePrompt, renameHint,
  ROW_OFF, ROW_CANT, OFF_NAME, ON_NAME, ON_SUB, CANT_NAME,
  NOT_STANDALONE_SUB, NO_PUSH_SUB, DENIED_SUB, DENIED_SUB_BROWSER, DENIED_BANNER_BROWSER,
  NOT_STANDALONE_BANNER, NO_PUSH_BANNER, DENIED_BANNER,
  ENABLING_NAME, ENABLING_SUB, TURNING_ON, TURN_ON, TRY_AGAIN,
  ENABLE_FAILED_SUB, ENABLE_FAILED_PC, ENABLE_FAILED_PHONE, ENABLE_INFO,
  DEVICES_HEADING, SEND_A_TEST, SENDING, TURN_OFF, NO_NAME_SUB, STOPPED_WARN,
  CANCEL, SAVE, REMOVE, REMOVE_WARN,
  NAME_FIELD_LABEL, NAME_PLACEHOLDER, HEAR_ABOUT_LABEL, HEAR_LAUNCH_FAILED, HEAR_PC_CONNECTION,
} from '../public/push-ui.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
function read(rel) {
  return fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8');
}

// --- capability order --------------------------------------------------

test('cantTurnOnReason: checked in order, first match wins', () => {
  assert.equal(cantTurnOnReason({ standalone: false, hasPush: false, permission: 'denied' }), 'not_standalone');
  assert.equal(cantTurnOnReason({ standalone: true, hasPush: false, permission: 'denied' }), 'no_push');
  assert.equal(cantTurnOnReason({ standalone: true, hasPush: true, permission: 'denied' }), 'denied');
  assert.equal(cantTurnOnReason({ standalone: true, hasPush: true, permission: 'default' }), null);
  assert.equal(cantTurnOnReason({ standalone: true, hasPush: true, permission: 'granted' }), null);
});

// --- D15 reversed: the platform detector --------------------------------

test('isIphoneOrIpad: iPhone/iPad UA true; a Macintosh UA is an iPad only with multitouch', () => {
  assert.equal(isIphoneOrIpad({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' }), true);
  assert.equal(isIphoneOrIpad({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' }), true);
  // iPadOS 13+ reports a desktop Macintosh UA - only maxTouchPoints tells them apart.
  assert.equal(isIphoneOrIpad({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 }), true);
  assert.equal(isIphoneOrIpad({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 }), false);
  assert.equal(isIphoneOrIpad({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }), false, 'a real Mac has no maxTouchPoints at all');
  assert.equal(isIphoneOrIpad({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }), false);
  assert.equal(isIphoneOrIpad({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' }), false);
  assert.equal(isIphoneOrIpad(null), false);
  assert.equal(isIphoneOrIpad({}), false);
});

// --- notifyScreenState / notifyRowState ---------------------------------

test('notifyScreenState: loading, unavailable, off, on, stopped', () => {
  assert.equal(notifyScreenState(null), 'loading');
  assert.equal(notifyScreenState(undefined), 'loading');
  assert.equal(notifyScreenState({ reason: 'denied', mine: null, devices: null }), 'unavailable');
  assert.equal(notifyScreenState({ reason: null, mine: null, devices: null }), 'loading');
  assert.equal(notifyScreenState({ reason: null, mine: null, devices: [] }), 'off');
  assert.equal(notifyScreenState({ reason: null, mine: 'x', devices: [{ endpoint: 'x' }] }), 'on');
  assert.equal(notifyScreenState({ reason: null, mine: 'x', devices: [{ endpoint: 'y' }] }), 'stopped');
  assert.equal(notifyScreenState({ reason: null, mine: 'x', devices: [] }), 'stopped');
});

test('notifyRowState: unknown/unavailable/off/on, the settings root sub-line', () => {
  assert.deepEqual(notifyRowState(null), { text: '', enterable: false });
  assert.deepEqual(notifyRowState({ reason: 'no_push', mine: null, devices: null }), { text: ROW_CANT, enterable: true });
  assert.deepEqual(notifyRowState({ reason: null, mine: null, devices: null }), { text: '', enterable: false });
  assert.deepEqual(notifyRowState({ reason: null, mine: null, devices: [] }), { text: ROW_OFF, enterable: true });
  assert.deepEqual(
    notifyRowState({ reason: null, mine: 'x', devices: [{ endpoint: 'x' }] }),
    { text: 'on · 1 device', enterable: true },
  );
  assert.deepEqual(
    notifyRowState({ reason: null, mine: 'x', devices: [{ endpoint: 'x' }, { endpoint: 'y' }] }),
    { text: 'on · 2 devices', enterable: true },
  );
  // stopped reads as 'off' at the settings root - there is no fourth variant.
  assert.deepEqual(
    notifyRowState({ reason: null, mine: 'x', devices: [{ endpoint: 'y' }] }),
    { text: ROW_OFF, enterable: true },
  );
});

// --- otherDevicesLine (D13) ----------------------------------------------

test('otherDevicesLine(0/1/2)', () => {
  assert.equal(otherDevicesLine(0), 'no other devices yet');
  assert.equal(otherDevicesLine(1), '1 other device');
  assert.equal(otherDevicesLine(2), '2 other devices');
  assert.equal(otherDevicesLine(11), '11 other devices');
});

// --- addedDate ------------------------------------------------------------

test('addedDate: "d Mon", local time', () => {
  assert.equal(addedDate('2026-09-25T09:41:00.000Z'), `${new Date('2026-09-25T09:41:00.000Z').getDate()} Sep`);
  assert.equal(addedDate('2026-01-05T00:00:00.000Z'), `${new Date('2026-01-05T00:00:00.000Z').getDate()} Jan`);
});

// --- deviceRows -------------------------------------------------------------

test('deviceRows: this device first, then the rest by createdAt asc, with the right sub-lines', () => {
  const devices = [
    { endpoint: 'b', name: 'iPad', created_at: '2026-09-12T00:00:00.000Z' },
    { endpoint: 'c', created_at: '2026-09-01T00:00:00.000Z' }, // unnamed, oldest
    { endpoint: 'a', name: 'My iPhone', created_at: '2026-09-25T00:00:00.000Z' }, // this device, newest
  ];
  const rows = deviceRows(devices, 'a');
  assert.deepEqual(rows.map((r) => r.endpoint), ['a', 'c', 'b'], 'this device first, then createdAt asc');
  assert.equal(rows[0].current, true);
  assert.match(rows[0].sub, /^this device · added \d+ Sep$/);
  assert.equal(rows[1].current, false);
  assert.equal(rows[1].sub, NO_NAME_SUB);
  assert.match(rows[1].name, /^Added \d+ Sep$/);
  assert.equal(rows[2].current, false);
  assert.equal(rows[2].sub, null, 'a named OTHER device has no sub-line');
  assert.equal(rows[2].name, 'iPad');
});

test('deviceRows: no subscription on this device -> plain createdAt order, nothing marked current', () => {
  const devices = [
    { endpoint: 'b', created_at: '2026-09-12T00:00:00.000Z' },
    { endpoint: 'a', created_at: '2026-09-01T00:00:00.000Z' },
  ];
  const rows = deviceRows(devices, null);
  assert.deepEqual(rows.map((r) => r.endpoint), ['a', 'b']);
  assert.ok(rows.every((r) => r.current === false));
});

// --- test result copy, OPEN-5 ------------------------------------------------

test('testAcceptedCopy / testFailedCopy: Apple/Google/Mozilla named, other generic', () => {
  assert.equal(
    testAcceptedCopy('apple', true),
    'Apple accepted the test. It should arrive in a few seconds. If it doesn’t, check Focus and claude-remote’s notification settings in iOS.',
  );
  assert.equal(
    testAcceptedCopy('google', true),
    'Google accepted the test. It should arrive in a few seconds. If it doesn’t, check Focus and claude-remote’s notification settings in iOS.',
  );
  assert.equal(
    testAcceptedCopy('mozilla', true),
    'Mozilla accepted the test. It should arrive in a few seconds. If it doesn’t, check Focus and claude-remote’s notification settings in iOS.',
  );
  assert.equal(
    testAcceptedCopy('other', true),
    'The push service accepted the test. It should arrive in a few seconds. If it doesn’t, check Focus and claude-remote’s notification settings in iOS.',
  );
  // A browser off Apple devices (owner 2026-09-25): no iOS Settings to point at.
  assert.equal(
    testAcceptedCopy('google', false),
    'Google accepted the test. It should arrive in a few seconds. If it doesn’t, check this browser’s notification settings.',
  );
  assert.equal(
    testAcceptedCopy('apple', false),
    'Apple accepted the test. It should arrive in a few seconds. If it doesn’t, check this browser’s notification settings.',
  );
  assert.equal(
    testFailedCopy('apple'),
    'The test didn’t go out. Your PC couldn’t reach Apple’s push service. Check the PC’s internet connection, then try again.',
  );
  assert.equal(
    testFailedCopy('other'),
    'The test didn’t go out. Your PC couldn’t reach the push service. Check the PC’s internet connection, then try again.',
  );
});

// --- removePrompt / renameHint ------------------------------------------

test('removePrompt / renameHint', () => {
  assert.equal(removePrompt('iPad'), 'Stop notifications on iPad?');
  assert.equal(renameHint('25 Sep'), 'Added 25 Sep. Leave empty to show the date.');
});

// --- b64uToBytes --------------------------------------------------------

test('b64uToBytes: round-trips a b64url public key, tolerating no padding', () => {
  const raw = Buffer.from([0x04, 1, 2, 3, 253, 254, 255]);
  const b64u = raw.toString('base64url');
  assert.equal(b64u.includes('='), false, 'base64url carries no padding to begin with');
  const bytes = b64uToBytes(b64u);
  assert.deepEqual(Buffer.from(bytes), raw);
});

// --- every Lane 19 constant, pinned verbatim against the approved Artifact ---
// (design/userflow.artifact.html, Lane 19 - .claude/userflow.md carries an
// ASCII-apostrophe projection of the same words; D13 states the Artifact's
// own U+2019 is authoritative, so these literals use it throughout.)

test('every Lane 19 string constant matches the approved Artifact verbatim', () => {
  assert.equal(OFF_NAME, 'Off on this device');
  assert.equal(NAME_FIELD_LABEL, 'Name this device · optional');
  assert.equal(NAME_PLACEHOLDER, 'e.g. My iPhone');
  assert.equal(TURN_ON, 'TURN ON');
  assert.equal(HEAR_ABOUT_LABEL, 'You will hear about');
  assert.equal(HEAR_LAUNCH_FAILED, 'A session that could not start');
  assert.equal(HEAR_PC_CONNECTION, 'Your PC’s connection needing attention');
  assert.equal(ENABLE_INFO, 'Only that. No project names, so nothing private shows on your lock screen.');

  assert.equal(CANT_NAME, 'Can’t turn on here');
  assert.equal(NOT_STANDALONE_SUB, 'not opened from your Home Screen');
  assert.equal(NO_PUSH_SUB, 'needs iOS 16.4 or later');
  assert.equal(DENIED_SUB, 'turned off in iOS Settings');
  assert.equal(DENIED_SUB_BROWSER, 'blocked in this browser');
  assert.equal(DENIED_BANNER_BROWSER, 'Notifications for claude-remote are blocked in this browser. Allow them in this site’s settings, then come back.');
  assert.equal(
    NOT_STANDALONE_BANNER,
    'Notifications only work when claude-remote is opened from your Home Screen. In Safari, tap Share, then Add to Home Screen, then open it from there.',
  );
  assert.equal(NO_PUSH_BANNER, 'This iPhone’s iOS can’t get notifications from web apps. It needs iOS 16.4 or later.');
  assert.equal(
    DENIED_BANNER,
    'Notifications for claude-remote are off in iOS Settings. Turn them on in Settings › Notifications › claude-remote, then come back.',
  );

  assert.equal(ENABLING_NAME, 'Turning on…');
  assert.equal(ENABLING_SUB, 'waiting for your answer');
  assert.equal(TURNING_ON, 'TURNING ON…');

  assert.equal(ENABLE_FAILED_SUB, 'not saved');
  assert.equal(ENABLE_FAILED_PC, 'Couldn’t turn notifications on. Your PC didn’t save this device. Try again.');
  assert.equal(ENABLE_FAILED_PHONE, 'This phone couldn’t set up notifications. Try again.');
  assert.equal(TRY_AGAIN, 'TRY AGAIN');

  assert.equal(ON_NAME, 'On for this device');
  assert.equal(ON_SUB, 'you will hear about the two things below');
  assert.equal(DEVICES_HEADING, 'DEVICES');
  assert.equal(NO_NAME_SUB, 'no name');
  assert.equal(SEND_A_TEST, 'SEND A TEST');
  assert.equal(TURN_OFF, 'TURN OFF ON THIS DEVICE');

  assert.equal(SENDING, 'SENDING…');

  assert.equal(CANCEL, 'CANCEL');
  assert.equal(SAVE, 'SAVE');

  assert.equal(REMOVE, 'REMOVE');
  assert.equal(
    REMOVE_WARN,
    'Lost it? Change your passcode too. Removing it here stops the pings; only a new passcode stops it opening the app.',
  );

  assert.equal(
    STOPPED_WARN,
    'Notifications stopped working on this device, so it was taken off the list. Turn them on again to get them back.',
  );
});

test('no Lane 19 constant carries an ASCII apostrophe - D13 requires U+2019 throughout', () => {
  // codeOnly strips every comment first - this is about shipped STRING
  // literals, and the doc comments above them are ordinary ASCII prose.
  const code = codeOnly(read('push-ui.js'));
  const body = code.slice(code.indexOf('export const'));
  const bareApostrophes = [...body.matchAll(/[A-Za-z]'[A-Za-z]/g)];
  assert.deepEqual(bareApostrophes.map((m) => m[0]), [], 'a contraction spelled with U+0027 slipped into shipped copy');
});

// --- app.js slices --------------------------------------------------------

function readApp() {
  return fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8').replace(/\r/g, '');
}

test('onNotifyOn: Notification.requestPermission is awaited before any registration/api call', () => {
  const js = readApp();
  const src = js.slice(js.indexOf('async function onNotifyOn('), js.indexOf('async function onSendTest('));
  const permissionAt = src.indexOf('Notification.requestPermission()');
  const registrationAt = src.indexOf('getRegistration()');
  const addDeviceAt = src.indexOf('addPushDevice(');
  assert.ok(permissionAt !== -1, 'onNotifyOn must call Notification.requestPermission()');
  assert.ok(permissionAt < registrationAt, 'the permission prompt must be requested before the service worker registration is read');
  assert.ok(permissionAt < addDeviceAt, 'the permission prompt must be requested before any api.js call');
});

test('onNotifyOn: a PC refusal (not 401) unsubscribes the phone-side subscription before showing state 4', () => {
  const js = readApp();
  const src = js.slice(js.indexOf('async function onNotifyOn('), js.indexOf('async function onSendTest('));
  const failBranch = src.slice(src.indexOf('if (!res.ok) {'));
  assert.match(failBranch, /sub\.unsubscribe\(\)/, 'a device the PC refused must not stay subscribed on the phone - the next visit would misread it as state 10');
  assert.match(failBranch, /notifyTransient = \{ failed: 'pc' \}/);
});

test('onNotifyOn: the 401 branch runs the SAME unsubscribe cleanup as every other failure (C4)', () => {
  // RED WHEN: sub.unsubscribe() sits only after the 401 check (or only in the
  // 'pc' branch below it) - a 401 is still a device the PC never saved, and
  // skipping the cleanup there is exactly what misreads as state 10 ("it
  // stopped working") after the owner re-unlocks, for a device that never
  // worked at all.
  const js = readApp();
  const src = js.slice(js.indexOf('async function onNotifyOn('), js.indexOf('async function onSendTest('));
  const failBlock = src.slice(src.indexOf('if (!res.ok) {'), src.indexOf('notifyTransient = { failed: \'pc\' };'));
  const unsubscribeAt = failBlock.indexOf('sub.unsubscribe()');
  const status401At = failBlock.indexOf("res.status === 401");
  assert.ok(unsubscribeAt !== -1, 'the failure branch must unsubscribe the phone-side subscription');
  assert.ok(status401At !== -1, 'the failure branch must still special-case 401');
  assert.ok(
    unsubscribeAt < status401At,
    'unsubscribe must run before the 401 return, not only in the branch below it',
  );
});

// --- Lane 19 step 15: the gate variant's two entry points -------------------

test('boot(): the #serve_missing fragment also reveals the gate notice, not only the list flag', () => {
  const js = readApp();
  const start = js.indexOf("if (location.hash === '#serve_missing') {");
  const block = js.slice(start, js.indexOf('const badge =', start));
  assert.match(block, /state\.serveMissing = true;/);
  assert.match(block, /showServeMissingNotice\(\);/, 'the gate is almost always what the tap actually opens - see the RESOLVED block');
});

test('the service-worker message listener reveals the gate notice when the gate is the screen showing', () => {
  const js = readApp();
  const start = js.indexOf("addEventListener('message'");
  const block = js.slice(start, js.indexOf('});', start) + 3);
  assert.match(block, /state\.screen === 'list'/);
  assert.match(block, /state\.screen === 'gate'/);
  assert.match(block, /showServeMissingNotice\(\)/);
});

test('lock.js is imported for showServeMissingNotice alongside its existing exports', () => {
  const js = readApp();
  const importBlock = js.slice(0, js.indexOf('from \'./lock.js\';') + 20);
  assert.match(importBlock, /showServeMissingNotice/);
});

test('renderProjects picks buildServeMissingState only while state.serveMissing holds', () => {
  const js = readApp();
  const fn = js.slice(js.indexOf('function renderProjects('), js.indexOf('function renderRowZone('));
  assert.match(
    fn,
    /state\.serveMissing \? buildServeMissingState\(\) : buildEmptyState\(CANNOT_REACH, 'retry'\)/,
  );
});

test('serveCommand builds the exact tailscale command line for a given port', async () => {
  const { serveCommand } = await import('../public/copy.js');
  assert.equal(serveCommand('8790'), 'tailscale serve --bg --https=8790 8790');
});

test('load() clears state.serveMissing on a successful project fetch', () => {
  const js = readApp();
  const fn = js.slice(js.indexOf('async function load('), js.indexOf('async function onProjectTap('));
  const okBranch = fn.slice(fn.indexOf('if (p.ok) {'), fn.indexOf('} else if (state.offline)'));
  assert.match(okBranch, /state\.serveMissing = false;/);
});

test('SETTINGS_SUBS names notify, and settings-open refreshes push state outside openSettings', () => {
  const js = readApp();
  const declStart = js.indexOf('const SETTINGS_SUBS');
  const decl = js.slice(declStart, js.indexOf(';', declStart));
  assert.match(decl, /'notify'/);

  const openSettingsFn = js.slice(js.indexOf('function openSettings('), js.indexOf('function closeSettings('));
  assert.ok(!/refreshPush/.test(openSettingsFn), 'refreshPush must not run inside openSettings itself');

  const listener = js.slice(
    js.indexOf("document.getElementById('settings-open').addEventListener"),
    js.indexOf("document.getElementById('settings-close')"),
  );
  assert.match(listener, /openSettings\(\)/);
  assert.match(listener, /refreshPush\(\)/);
});

test('app.js picks the permission and test-result lines by DEVICE, not by push service', () => {
  // Owner 2026-09-25: off iPhone/iPad there are no iOS Settings to point at.
  const code = codeOnly(readApp());
  assert.match(code, /onApple = isIphoneOrIpad\(navigator\)/);
  assert.match(code, /onApple \? DENIED_SUB : DENIED_SUB_BROWSER/);
  assert.match(code, /onApple \? DENIED_BANNER : DENIED_BANNER_BROWSER/);
  assert.match(code, /testAcceptedCopy\(notifyTestResult\.service, isIphoneOrIpad\(navigator\)\)/);
});

// --- Discovery 1 remediation (C3) - leaving a screen closes what was open ---
// The behavioural two-opens-then-one-submit case lives in
// panel-lifecycle.test.js; this is the other half of C3's requirement -
// leaving the screen entirely (Back, the header mark, any navigation) must
// close the same way.

test('showScreen closes any open Lane 19/20 panel - leaving a screen must never leave one wired behind it (C3)', () => {
  const js = readApp();
  const fn = js.slice(js.indexOf('function showScreen('), js.indexOf('const ERROR_COPY = {'));
  assert.match(fn, /closeActiveReauth\(\);/);
  assert.match(fn, /closeNotifyRename\(\);/);
  assert.match(fn, /closeNotifyRemove\(\);/);
  // All three before the screen actually changes, not after.
  assert.ok(
    fn.indexOf('closeActiveReauth();') < fn.indexOf('state.screen = name;'),
    'the panel must close before the new screen is recorded as current',
  );
});
