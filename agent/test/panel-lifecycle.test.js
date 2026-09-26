// Discovery 1 remediation (ledger M22-C2, cycle 2) - C1, C2, C3. Real app.js
// source, sliced and run under a DOM stub that (unlike the registry-keyed
// stubs elsewhere in this suite) actually models CONNECTEDNESS: getElementById
// walks a real tree from a root, and innerHTML='' really detaches whatever was
// nested inside. That distinction is the whole point here - a registry-keyed
// stub's getElementById would keep "finding" a node after a real browser had
// already destroyed it, which is exactly the bug this file exists to catch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import * as folders from '../public/folders-ui.js';
import * as pushUi from '../public/push-ui.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
function read(rel) {
  return fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8').replace(/\r/g, '');
}

const flush = () => new Promise((r) => setImmediate(r));

// --- a small, tree-real DOM -------------------------------------------------

function makeEl(tag, id) {
  const listeners = new Map();
  const el = {
    tag,
    id: id || null,
    className: '',
    dataset: {},
    children: [],
    parent: null,
    hidden: false,
    disabled: false,
    attrs: {},
    value: '',
    type: 'password',
    _text: '',
    _use: null,
    appendChild(child) {
      const old = child.parent;
      if (old && old !== el) {
        const i = old.children.indexOf(child);
        if (i !== -1) old.children.splice(i, 1);
      }
      child.parent = el;
      if (!el.children.includes(child)) el.children.push(child);
      return child;
    },
    get parentElement() { return el.parent || null; },
    insertBefore(newNode, refNode) {
      const old = newNode.parent;
      if (old && old !== el) {
        const i = old.children.indexOf(newNode);
        if (i !== -1) old.children.splice(i, 1);
      }
      newNode.parent = el;
      const idx = el.children.indexOf(refNode);
      if (idx === -1) el.children.push(newNode);
      else el.children.splice(idx, 0, newNode);
      return newNode;
    },
    insertAdjacentElement(position, node) {
      if (position !== 'afterend') throw new Error(`insertAdjacentElement: unsupported position ${position}`);
      const parent = el.parent;
      if (!parent) throw new Error('insertAdjacentElement: element has no parent');
      const old = node.parent;
      if (old && old !== parent) {
        const i = old.children.indexOf(node);
        if (i !== -1) old.children.splice(i, 1);
      }
      node.parent = parent;
      const idx = parent.children.indexOf(el);
      parent.children.splice(idx + 1, 0, node);
      return node;
    },
    cloneNode() { return makeEl(el.tag); },
    querySelector() { return el._use || (el._use = makeEl('use')); },
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute(k) { return el.attrs[k]; },
    get textContent() { return el._text; },
    set textContent(v) { el._text = v; el.children = []; },
    get innerHTML() { return el._text; },
    // The real behaviour under test: clearing wipes every descendant,
    // including one that was moved in from somewhere else.
    set innerHTML(v) { el._text = v; el.children = []; },
    addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(fn); },
    removeEventListener(t, fn) { listeners.get(t)?.delete(fn); },
    listenerCount(t) { return listeners.get(t)?.size ?? 0; },
    fire(t, ev = {}) { for (const fn of [...(listeners.get(t) ?? [])]) fn(ev); },
  };
  return el;
}

function findById(root, id) {
  if (root.id === id) return root;
  for (const c of root.children) {
    const hit = findById(c, id);
    if (hit) return hit;
  }
  return null;
}

/** One tree carrying every element the sliced functions below can reach for. */
function buildDom() {
  const root = makeEl('root', 'root');
  const tiles = makeEl('div', 'tiles');
  const projects = makeEl('div', 'projects');
  const runCount = makeEl('span', 'run-count');
  const allCount = makeEl('span', 'all-count');

  const reauth = makeEl('div', 'reauth');
  const reauthLineEl = makeEl('div', 'reauth-line');
  const reauthPin = makeEl('input', 'reauth-pin');
  const reauthEye = makeEl('button', 'reauth-pin-eye');
  reauthEye.attrs['aria-pressed'] = 'false';
  const reauthMsg = makeEl('div', 'reauth-msg');
  const reauthAction = makeEl('button', 'reauth-action');
  const reauthCancel = makeEl('button', 'reauth-cancel');
  for (const c of [reauthLineEl, reauthPin, reauthEye, reauthMsg, reauthAction, reauthCancel]) reauth.appendChild(c);

  const notifyDevices = makeEl('div', 'notify-devices');
  const notifyDevicesCount = makeEl('span', 'notify-devices-count');

  const notifyRename = makeEl('div', 'notify-rename');
  const notifyRenameName = makeEl('input', 'notify-rename-name');
  const notifyRenameHint = makeEl('div', 'notify-rename-hint');
  for (const c of [notifyRenameName, notifyRenameHint]) notifyRename.appendChild(c);

  const notifyRemove = makeEl('div', 'notify-remove');
  const notifyRemovePrompt = makeEl('div', 'notify-remove-prompt');
  notifyRemove.appendChild(notifyRemovePrompt);

  const tplRowIco = makeEl('template', 'tpl-row-ico');
  tplRowIco.content = { firstElementChild: makeEl('svg') };

  const panelHome = makeEl('div', 'panel-home');

  for (const el of [
    tiles, projects, runCount, allCount, reauth, notifyDevices, notifyDevicesCount,
    notifyRename, notifyRemove, tplRowIco, panelHome,
  ]) root.appendChild(el);

  const doc = {
    getElementById: (id) => findById(root, id),
    createElement: (tag) => makeEl(tag),
  };

  return {
    doc, root, tiles, projects, reauth, reauthPin, reauthAction, reauthCancel,
    notifyDevices, notifyRename, notifyRemove, panelHome,
  };
}

/** A .gone-shaped notice with a REMOVE button, the way buildGoneNotice draws one. */
function appendGoneNotice(projects, rootPath) {
  const gone = makeEl('div');
  gone.className = 'gone';
  const btn = makeEl('button');
  btn.dataset.removeRoot = rootPath;
  gone.appendChild(btn);
  projects.appendChild(gone);
  return btn;
}

/** A notify device row, the way buildNotifyDeviceRow draws one. */
function appendDeviceRow(notifyDevices, endpoint) {
  const row = makeEl('div');
  row.className = 'row folder set-row notify-device';
  const nameBtn = makeEl('button');
  nameBtn.dataset.renameDevice = endpoint;
  const removeBtn = makeEl('button');
  removeBtn.dataset.removeDevice = endpoint;
  row.appendChild(nameBtn);
  row.appendChild(removeBtn);
  notifyDevices.appendChild(row);
  return row;
}

// --- the real source, combined so C1/C2/C3 share ONE activeReauth ----------

function loadPanelLifecycle() {
  const js = read('app.js');
  const rpStart = js.indexOf('function renderProjects() {');
  const rpEnd = js.indexOf('// The folder is held by NAME');
  assert.ok(rpStart !== -1 && rpEnd > rpStart, 'renderProjects() top not found - has app.js moved?');
  // Deliberately truncated: only the four lines this fix touches, closed with
  // one appended brace. Not the whole 400-line function - this is the exact
  // fragment C1 is about, kept small so a passing test proves that fragment
  // and nothing else.
  const renderProjectsTop = `${js.slice(rpStart, rpEnd)}}`;

  const libStart = js.indexOf('function shareAuthLost(');
  const libEnd = js.indexOf('function renderNotify() {');
  assert.ok(libStart !== -1 && libEnd > libStart, 'the Lane 20/19 panel block not found - has app.js moved?');
  const lib = js.slice(libStart, libEnd);

  // The real caller whose panel C1 is about - its anchor is the fix.
  const rrStart = js.indexOf('async function onRemoveRoot(');
  const rrEnd = js.indexOf('\n}\n', rrStart) + 3;
  assert.ok(rrStart !== -1 && rrEnd > rrStart, 'onRemoveRoot not found - has app.js moved?');
  const onRemoveRoot = js.slice(rrStart, rrEnd);

  return new Function(
    'document', 'state',
    'reauthLine', 'REAUTH_WRONG', 'reauthOutcome', 'setPinRevealed', 'messageFor', 'sleep',
    'deviceRows', 'addedDate', 'renameHint', 'removePrompt', 'NO_NAME_SUB',
    'crumbSegments', 'REMOVE', 'SAVE', 'removeRoot', 'load', 'setErrorBanner',
    'share', 'shareEls', 'putShared', 'sharedBody', 'applySaveResult', 'finishFolders', 'renderShare',
    'removePushDevice', 'navigator', 'cantTurnOnReason', 'isIphoneOrIpad', 'window', 'getPush', 'renderNotify', 'errorCopy',
    `${renderProjectsTop}
${onRemoveRoot}
${lib}
return {
  openReauth, closeActiveReauth, renderProjects, onRemoveRoot, openSaveReauth, onTurnOffThisDevice, settingsSubs,
  openNotifyRename, openNotifyRemove, closeNotifyRename, closeNotifyRemove, renderNotifyDevices,
};`,
  );
}

function loadLib(doc, state, over = {}) {
  const fn = loadPanelLifecycle();
  const o = {
    sleep: () => Promise.resolve(),
    removeRoot: async () => ({ ok: true, status: 200 }),
    shareEls: () => ({ skip: makeEl('button'), save: makeEl('button') }),
    putShared: async () => ({ ok: true, status: 200 }),
    applySaveResult: () => ({ done: true }),
    removePushDevice: async () => ({ ok: true, status: 200 }),
    ...over,
  };
  return fn(
    doc, state,
    folders.reauthLine, folders.REAUTH_WRONG, folders.reauthOutcome,
    () => {}, // setPinRevealed - not under test here
    () => '', // messageFor
    o.sleep,
    pushUi.deviceRows, pushUi.addedDate, pushUi.renameHint, pushUi.removePrompt, pushUi.NO_NAME_SUB,
    folders.crumbSegments, pushUi.REMOVE, pushUi.SAVE, o.removeRoot, async () => {}, () => {},
    { ticks: [] }, o.shareEls, o.putShared, () => ({}), o.applySaveResult, () => {}, () => {},
    o.removePushDevice, {}, () => null, () => false, {},
    async () => ({ ok: true, data: { devices: [], public_key: 'k' } }), // getPush
    () => {}, (code) => `error:${code}`,
  );
}

/** A promise plus its resolve, so a test decides when an await finishes. */
function gate() {
  let open;
  const p = new Promise((r) => { open = r; });
  return { p, open };
}

// ============================================================================
// C1 / D2-C1 - the gone-root REMOVE panel. Round 1 closed it on EVERY
// renderProjects(), and render() runs every 5s while a session runs, so it
// shut itself mid-typing. Now it is anchored outside #projects and nothing
// closes it on render.
// ============================================================================

test('D2-C1: a REMOVE panel stays open, typed digits intact, through the 5s renderProjects()', () => {
  const dom = buildDom();
  const btn = appendGoneNotice(dom.projects, 'F:\\Projects\\Example');
  const lib = loadLib(dom.doc, { openFolder: null, shared: [], projects: [], sessions: [], reachable: true });

  lib.onRemoveRoot('F:\\Projects\\Example', btn);
  assert.equal(dom.reauth.hidden, false, 'fixture: the panel is open');
  assert.equal(dom.reauth.parent, dom.root, 'anchored OUTSIDE #projects, the list every render rebuilds');
  dom.reauthPin.value = '4819';

  lib.renderProjects(); // watchSessions(), every 5s

  assert.equal(dom.doc.getElementById('reauth'), dom.reauth, 'still in the document');
  assert.equal(dom.reauth.hidden, false, 'still OPEN - the round-1 fix closed it on every render');
  assert.equal(dom.reauthPin.value, '4819', 'the half-typed passcode survives');
});

test('D2-C1: a REMOVE panel already closed by its submit survives the next renderProjects() too', async () => {
  const dom = buildDom();
  const btn = appendGoneNotice(dom.projects, 'F:\\Projects\\Example');
  const lib = loadLib(dom.doc, { openFolder: null, shared: [], projects: [], sessions: [], reachable: true });

  lib.onRemoveRoot('F:\\Projects\\Example', btn);
  dom.reauthPin.value = '481902';
  dom.reauthAction.fire('click');
  await flush();
  assert.equal(dom.reauth.hidden, true, 'fixture: the submit closed it');

  lib.renderProjects(); // onDone's load()

  assert.equal(dom.doc.getElementById('reauth'), dom.reauth, 'a closed panel must not be deleted by the next render either');
});

// ============================================================================
// C2 - #notify-rename/#notify-remove nested inside #notify-devices must
// survive a renderNotifyDevices() (SEND A TEST, refreshPush, a background
// visibilitychange load) the same way.
// ============================================================================

test('C2: an open rename panel survives a renderNotifyDevices() that runs while it is still up', () => {
  const dom = buildDom();
  const row = appendDeviceRow(dom.notifyDevices, 'ep-a');
  const state = { push: { devices: [{ endpoint: 'ep-a', name: 'iPad', created_at: '2026-09-01T00:00:00.000Z' }], mine: 'ep-a' } };
  const lib = loadLib(dom.doc, state);

  lib.openNotifyRename('ep-a', row);
  assert.equal(dom.notifyRename.hidden, false, 'fixture: the rename panel is open');

  // SEND A TEST / refreshPush / a background load - any of them rebuild the
  // device list while the panel may still be open.
  lib.renderNotifyDevices();

  assert.notEqual(dom.doc.getElementById('notify-rename'), null, 'the rename panel must still be reachable');
  assert.notEqual(dom.doc.getElementById('notify-remove'), null, 'the remove panel must still be reachable too');

  // And still usable for a fresh row afterward.
  const newRows = dom.notifyDevices.children;
  assert.ok(newRows.length > 0, 'fixture: renderNotifyDevices rebuilt at least one row');
});

test('C2: an open remove-confirm panel survives a renderNotifyDevices() that runs while it is still up', () => {
  const dom = buildDom();
  const row = appendDeviceRow(dom.notifyDevices, 'ep-b');
  const state = { push: { devices: [{ endpoint: 'ep-b', name: 'iPad', created_at: '2026-09-01T00:00:00.000Z' }], mine: 'ep-a' } };
  const lib = loadLib(dom.doc, state);

  lib.openNotifyRemove('ep-b', row);
  assert.equal(dom.notifyRemove.hidden, false, 'fixture: the remove panel is open');

  lib.renderNotifyDevices();

  assert.notEqual(dom.doc.getElementById('notify-remove'), null, 'the remove panel must still be reachable');
});

// ============================================================================
// C3 - openReauth must never carry two live listener sets. Opening it again
// (a different target) must tear the first one down; a submit afterward must
// only ever reach the new target.
// ============================================================================

test('C3: two opens then one submit - only the SECOND target ever receives it', async () => {
  const dom = buildDom();
  const btnA = makeEl('button');
  const btnB = makeEl('button');
  dom.root.appendChild(btnA);
  dom.root.appendChild(btnB);
  const lib = loadLib(dom.doc, { push: null });

  let sendA = 0;
  let sendB = 0;
  lib.openReauth({
    buttons: [btnA], kind: 'stop', name: 'A', verb: 'REMOVE',
    send: async () => { sendA += 1; return { ok: true, status: 200 }; },
    onDone: () => {},
  });
  assert.equal(btnA.hidden, true, 'fixture: A is open');

  lib.openReauth({
    buttons: [btnB], kind: 'stop', name: 'B', verb: 'REMOVE',
    send: async () => { sendB += 1; return { ok: true, status: 200 }; },
    onDone: () => {},
  });
  assert.equal(btnA.hidden, false, 'opening a second target must restore the first one\'s own buttons');
  assert.equal(btnB.hidden, true);

  dom.reauthPin.value = '481902';
  dom.reauthAction.fire('click');
  await flush();

  assert.equal(sendA, 0, 'A must never receive a submit once it has been superseded');
  assert.equal(sendB, 1);
});

test('C3: closeActiveReauth tears down whatever is open without needing to know what it was', () => {
  const dom = buildDom();
  const btn = makeEl('button');
  dom.root.appendChild(btn);
  const lib = loadLib(dom.doc, { push: null });

  lib.openReauth({
    buttons: [btn], kind: 'stop', name: 'A', verb: 'REMOVE', send: async () => ({ ok: true, status: 200 }), onDone: () => {},
  });
  assert.equal(btn.hidden, true);

  lib.closeActiveReauth();

  assert.equal(btn.hidden, false, 'the button must come back');
  assert.equal(dom.reauth.hidden, true, 'the panel must close');

  // A second close (nothing open) must be a harmless no-op, not a throw.
  assert.doesNotThrow(() => lib.closeActiveReauth());
});

// ============================================================================
// Discovery 2 (cycle 2) - D2-C2, D2-S1, D2-C3, D2-C4.
// ============================================================================

function twoButtons(dom) {
  const a = makeEl('button');
  const b = makeEl('button');
  dom.root.appendChild(a);
  dom.root.appendChild(b);
  return [a, b];
}

test('D2-C2: a superseded session\'s late reply touches nothing - not the newer panel, not its own onDone', async () => {
  const dom = buildDom();
  const [btnA, btnB] = twoButtons(dom);
  const lib = loadLib(dom.doc, { push: null });

  const reply = gate();
  let doneA = 0;
  lib.openReauth({
    buttons: [btnA], kind: 'stop', name: 'A', verb: 'REMOVE', send: () => reply.p, onDone: () => { doneA += 1; },
  });
  dom.reauthPin.value = '481902';
  dom.reauthAction.fire('click'); // A's PUT is in flight

  lib.openReauth({
    buttons: [btnB], kind: 'stop', name: 'B', verb: 'REMOVE', send: async () => ({ ok: true, status: 200 }), onDone: () => {},
  });
  dom.reauthPin.value = '12';
  reply.open({ ok: true, status: 200 });
  await flush();

  assert.equal(doneA, 0, 'A\'s onDone must not run on a screen the owner has moved past');
  assert.equal(dom.reauth.hidden, false, 'B\'s panel stays open');
  assert.equal(btnB.hidden, true, 'B\'s buttons stay hidden, not stranded beside an open panel');
  assert.equal(dom.reauthPin.value, '12', 'B\'s typing is untouched');
});

test('D2-C2: a lockout wait that ends after a newer session opened does not reset that session', async () => {
  const dom = buildDom();
  const [btnA, btnB] = twoButtons(dom);
  const wait = gate();
  const lib = loadLib(dom.doc, { push: null }, { sleep: () => wait.p });

  lib.openReauth({
    buttons: [btnA], kind: 'stop', name: 'A', verb: 'REMOVE',
    send: async () => ({ ok: false, status: 429, code: 'too_many_attempts', data: { retry_after_ms: 1000 } }),
    onDone: () => {},
  });
  dom.reauthPin.value = '000000';
  dom.reauthAction.fire('click');
  await flush(); // A is sleeping out its lockout

  lib.openReauth({
    buttons: [btnB], kind: 'stop', name: 'B', verb: 'REMOVE', send: async () => ({ ok: true, status: 200 }), onDone: () => {},
  });
  dom.reauthPin.value = '4819';
  wait.open();
  await flush();

  assert.equal(dom.reauthPin.value, '4819', 'A\'s wake-up must not clear B\'s field');
});

test('D2-S1: digits typed then abandoned (CANCEL, or leaving the screen) are cleared from the hidden field', () => {
  const dom = buildDom();
  const [btn] = twoButtons(dom);
  const lib = loadLib(dom.doc, { push: null });
  const open = () => lib.openReauth({
    buttons: [btn], kind: 'stop', name: 'A', verb: 'REMOVE', send: async () => ({ ok: true, status: 200 }), onDone: () => {},
  });

  open();
  dom.reauthPin.value = '4819';
  dom.reauthCancel.fire('click');
  assert.equal(dom.reauthPin.value, '', 'CANCEL');

  open();
  dom.reauthPin.value = '4819';
  lib.closeActiveReauth(); // what showScreen() runs on Back / the header mark
  assert.equal(dom.reauthPin.value, '', 'navigation close');
});

test('D2-C3: a 401 on the picker\'s reauth SAVE writes nothing onto the picker onAuthLost tore down', async () => {
  const dom = buildDom();
  const [skip, save] = twoButtons(dom);
  let applied = 0;
  const lib = loadLib(dom.doc, { push: null }, {
    shareEls: () => ({ skip, save }),
    putShared: async () => ({ ok: false, status: 401, code: 'unauthorized' }),
    applySaveResult: () => { applied += 1; return { done: false, message: 'x' }; },
  });

  lib.openSaveReauth();
  dom.reauthPin.value = '481902';
  dom.reauthAction.fire('click');
  await flush();

  assert.equal(applied, 0, 'finishSave must not run on a 401 - no share.error to reappear after re-unlock');
});

test('D2-C4: a failed TURN OFF keeps its error on screen after refreshPush()', async () => {
  const dom = buildDom();
  const msg = makeEl('div', 'notify-msg');
  dom.root.appendChild(msg);
  const lib = loadLib(dom.doc, { push: { mine: 'ep-a', devices: [] } }, {
    removePushDevice: async () => ({ ok: false, status: 500, code: 'write_failed' }),
  });

  lib.settingsSubs.push('notify'); // the screen is showing, so refreshPush re-renders and clears #notify-msg

  await lib.onTurnOffThisDevice();

  assert.equal(msg.textContent, 'error:write_failed', 'refreshPush cleared it - TURN OFF looked like it did nothing');
});
