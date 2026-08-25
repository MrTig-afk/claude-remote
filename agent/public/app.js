import { getProjects, getSessions, launchSession, createProject } from './api.js';

// Single module-level state. 15 rows today - full rebuild on every render(),
// no diffing, no framework, no template engine.
const state = {
  projects: [], // from /api/projects
  sessions: null, // array, or null = unknown (fetch failed / 404)
  launching: new Set(), // project names with a POST in flight
  results: new Map(), // name -> { kind:'started'|'reused'|'error', session?, code? }
  reachable: null, // null = not tried yet, true, false
};

const ERROR_COPY = {
  network: 'Cannot reach the agent. Check the PC is awake and Tailscale is connected, then tap REFRESH.',
  timeout: "The agent didn't answer in time. Check it is still running on the PC, then tap REFRESH.",
  project_not_found: "That project folder isn't there any more. Tap REFRESH to reload the list.",
  invalid_project: "The agent won't accept that project name. Tap REFRESH; if it keeps happening, rename the folder on the PC.",
  invalid_request: 'The agent rejected the request. This is a bug in the app - note what you tapped.',
  payload_too_large: 'The request was too big to send. This is a bug in the app - note what you tapped.',
  internal_error: 'The agent hit an internal error. Check its terminal window on the PC.',
  bad_response: "The agent replied with something this app doesn't understand. It may be a different version.",
};

function errorCopy(code, status) {
  return ERROR_COPY[code] || `The agent refused the request (status ${status}). Check its terminal window on the PC.`;
}

// Copy for POST /api/projects only (design/tokens.md + spec-t31.md section 6)
// - distinct from ERROR_COPY above, which is written for launch failures and
// uses codes (project_not_found, invalid_project) that don't apply here.
const NEW_PROJECT_ERROR_COPY = {
  invalid_request: 'Something went wrong sending that name.',
  name_empty: 'Enter a project name.',
  name_too_long: 'Too long – 64 characters max.',
  name_illegal_char: 'Windows folder names can’t contain < > : " | ? *.',
  name_edge_whitespace: 'Remove the space at the start or end.',
  name_percent_encoded: '% isn’t allowed in a project name.',
  name_has_separator: 'No \\ or / – projects are created directly in Repos.',
  name_absolute: 'Enter a name, not a path.',
  name_has_traversal: "That isn't a name.",
  name_dot_prefixed: "Names can't start with a dot (it would be hidden).",
  name_trailing_dot: "Names can't end with a dot.",
  name_reserved: "That's a reserved Windows device name.",
  name_not_launchable: "That name can't be used as a session name.",
  name_collision: 'Another project already maps to the same session name.',
  project_exists: 'A project with that name already exists.',
  base_unavailable: "The agent can't reach its projects folder.",
  create_failed: "Couldn't create the folder.",
  payload_too_large: 'That name is too long to send.',
  network: 'Cannot reach the agent. Check the PC is awake and Tailscale is connected.',
  timeout: "The agent didn't answer in time.",
  bad_response: "The agent replied with something this app doesn't understand.",
};

function newProjectErrorCopy(code) {
  return NEW_PROJECT_ERROR_COPY[code] || 'Could not create the project.';
}

// Mirrors agent/projects.js validateProjectName (V1-V14 minus V1, which is
// unreachable from a text input) in the same order, for instant feedback
// only - the server holds the same rules and is the trust boundary. Always
// called on a trimmed value, matching what onCreateProject actually sends
// (V5 is therefore unreachable here by construction, same as server-side
// intent: the client trims so the common phone-keyboard trailing space never
// reaches the server).
// ponytail: duplicated because the browser and the agent share no module
// boundary; keep this in sync by hand if projects.js's rules change.
function clientValidateName(name) {
  if (name === '') return 'name_empty';
  if (name.length > 64) return 'name_too_long';
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'name_illegal_char';
  if (/^\s|\s$/.test(name)) return 'name_edge_whitespace';
  if (name.includes('%')) return 'name_percent_encoded';
  if (/[\\/]/.test(name)) return 'name_has_separator';
  if (/^[A-Za-z]:/.test(name)) return 'name_absolute';
  if (/[<>:"|?*]/.test(name)) return 'name_illegal_char';
  if (/^\.+$/.test(name)) return 'name_has_traversal';
  if (name.startsWith('.')) return 'name_dot_prefixed';
  if (name.endsWith('.')) return 'name_trailing_dot';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name.split('.')[0].trim())) return 'name_reserved';
  const s = name.replace(/[\s.]+/g, '-').toLowerCase();
  if (s === '' || s.startsWith('-')) return 'name_not_launchable';
  return null;
}

// Best-effort target-path preview only: derived from an existing project's
// absolute path already present in the loaded list (GET /api/projects
// returns one per entry; the create response deliberately omits it, see
// spec-t31.md Decision 1). If the base folder is currently empty nothing has
// a path to derive from - the preview falls back to a relative form rather
// than adding a new endpoint just to expose baseDir.
function baseDirGuess() {
  const withPath = state.projects.find((p) => p.path);
  if (!withPath) return null;
  const sep = withPath.path.includes('\\') ? '\\' : '/';
  const idx = withPath.path.lastIndexOf(sep);
  return idx === -1 ? null : { dir: withPath.path.slice(0, idx), sep };
}

// Time since session start, not time since last input (no API exposes
// that), so no "last active" label is ever put next to it.
function elapsed(startedAt) {
  const ms = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(ms)) return '—';
  const mins = Math.max(0, Math.floor(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days > 9) return '9d+';
  return `${days}d`;
}

// Two keys deliberately: path is the strong one (both sides resolve from
// the same baseDir), project covers an entry recorded by a different
// client. Matching on session_name is wrong - deriveSessionName can map two
// folders to the same name, which would attribute one row's session to
// another.
function sessionFor(p) {
  if (!state.sessions) return null;
  return state.sessions.find((s) => s.path === p.path || s.project === p.name) ?? null;
}

/**
 * The one honesty rule, stated once: a filled accent dot means and only
 * means the agent proved a live pid. Everything else is a hollow ring.
 * One rule places a row: a project with a registry entry (any status) or
 * an in-flight launch is a tile; everything else is a list row.
 */
function rowState(p) {
  if (state.launching.has(p.name)) {
    return { zone: 'tile', dot: 'accent', status: 'starting...', idle: '—' };
  }

  const session = sessionFor(p);
  if (session) {
    if (session.status === 'running') {
      return { zone: 'tile', dot: 'filled', status: 'active session', idle: elapsed(session.started_at) };
    }
    if (session.status === 'failed') {
      return { zone: 'list', dot: 'dim', status: 'launch unconfirmed', idle: elapsed(session.started_at) };
    }
    return { zone: 'tile', dot: 'accent', status: 'starting - not confirmed', idle: elapsed(session.started_at) };
  }

  const result = state.results.get(p.name);
  if (result) {
    if (result.kind === 'started') {
      return { zone: 'tile', dot: 'accent', status: 'start requested - not confirmed', idle: elapsed(result.session.started_at) };
    }
    if (result.kind === 'reused') {
      return { zone: 'tile', dot: 'filled', status: 'already running', idle: elapsed(result.session.started_at) };
    }
    // result.kind === 'error': no registry entry exists, so this falls
    // back to being a list row.
    return { zone: 'list', dot: 'dim', status: 'could not start', idle: '—' };
  }

  if (state.sessions === null) {
    return { zone: 'list', dot: 'dim', status: 'session state unknown', idle: '—' };
  }
  return { zone: 'list', dot: 'dim', status: 'no session', idle: '—' };
}

function setDot(svg, kind) {
  const circle = svg.querySelector('circle');
  if (kind === 'filled') {
    circle.setAttribute('fill', '#7ee787');
    circle.removeAttribute('stroke');
    circle.setAttribute('r', '4');
  } else {
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', kind === 'accent' ? '#5fae6f' : '#3d4a3d');
    circle.setAttribute('stroke-width', '1');
    circle.setAttribute('r', '3.5');
  }
}

function buildDot(kind) {
  const wrap = document.createElement('span');
  wrap.innerHTML = '<svg class="dot" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><circle cx="4" cy="4" r="3.5"/></svg>';
  const svg = wrap.firstElementChild;
  setDot(svg, kind);
  return svg;
}

function tileStatusLine(rs) {
  return rs.idle && rs.idle !== '—' ? `${rs.status} - ${rs.idle}` : rs.status;
}

function buildTile(p, rs) {
  const el = document.createElement('div');
  el.className = 'tile';
  if (state.launching.has(p.name)) el.setAttribute('aria-busy', 'true');
  el.appendChild(buildDot(rs.dot));
  const name = document.createElement('span');
  name.className = 'tile-name';
  name.textContent = p.name;
  el.appendChild(name);
  const status = document.createElement('span');
  status.className = 'tile-status';
  status.textContent = tileStatusLine(rs);
  el.appendChild(status);
  return el;
}

function buildRow(p, rs) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'row';
  btn.dataset.project = p.name;

  const dot = buildDot(rs.dot);
  btn.appendChild(dot);

  const main = document.createElement('span');
  main.className = 'row-main';
  const nameEl = document.createElement('span');
  nameEl.className = 'row-name';
  nameEl.textContent = p.name;
  const statusEl = document.createElement('span');
  statusEl.className = 'row-status';
  statusEl.textContent = rs.status;
  main.append(nameEl, statusEl);
  btn.appendChild(main);

  const idleEl = document.createElement('span');
  idleEl.className = 'row-idle';
  idleEl.textContent = rs.idle;
  btn.appendChild(idleEl);

  const chev = document.createElement('span');
  chev.className = 'row-chev';
  chev.textContent = '>';
  btn.appendChild(chev);

  return btn;
}

function setBanner(tone, parts) {
  const el = document.getElementById('banner');
  el.innerHTML = '';
  el.className = 'banner' + (tone === 'error' ? ' error' : '');
  el.hidden = false;
  for (const part of parts) {
    if (part.b) {
      const b = document.createElement('b');
      b.textContent = part.b;
      el.appendChild(b);
    } else {
      el.appendChild(document.createTextNode(part.text));
    }
  }
}

function hideBanner() {
  const el = document.getElementById('banner');
  el.hidden = true;
  el.innerHTML = '';
}

function setErrorBanner(code, status) {
  // The '!' glyph is the only visual weight an error gets - no red exists
  // in this palette (design/tokens.md has one accent and no error colour).
  setBanner('error', [{ text: '! ' + errorCopy(code, status) }]);
}

function failedSessions() {
  return (state.sessions || []).filter((s) => s.status === 'failed');
}

// Only ever SETS the banner. The stale case - banner says unconfirmed after
// the owner has relaunched - cannot survive, because a relaunch sets its own
// banner and load() hides first.
function maybeFailedBanner() {
  const f = failedSessions();
  if (f.length === 0) return;
  const names = f.slice(0, 2).map((s) => s.project).join(', ');
  const more = f.length > 2 ? ` and ${f.length - 2} more` : '';
  setBanner('error', [
    { text: '! ' },
    { b: names + more },
    { text: " - no session confirmed. It may have stalled on a prompt on the PC, or never started. Check the Claude app's Code tab, then tap the project to try again." },
  ]);
}

// Checks at roughly 3s, 8s and 33s after the trigger. The last is past
// STARTING_GRACE_MS (30s), which is the whole point: it is the first moment
// the agent can return a `failed` verdict, so without it the owner never
// sees one. Gaps, not absolute offsets - they are awaited in sequence.
const CONFIRM_GAPS_MS = [3000, 5000, 25000];
let confirming = false;
// Set when a launch happens while a confirm sequence is already running. The
// running sequence's gaps are anchored to the FIRST launch, so a project
// tapped a few seconds later would fall off the end of it still unconfirmed
// and sit as a frozen `starting` tile until a manual refresh - the exact
// invisible stall this status exists to remove.
let rearm = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function anyStarting() {
  return (state.sessions || []).some((s) => s.status === 'starting');
}

// Bounded and self-terminating: at most CONFIRM_GAPS_MS.length requests, and
// it stops as soon as nothing is `starting`. Not a poll - there is no timer
// unless a launch is actually in flight.
async function confirmStarting(force = false) {
  if (confirming) {
    if (force) rearm = true;
    return;
  }
  if (!force && !anyStarting()) return;
  confirming = true;
  try {
    for (const gap of CONFIRM_GAPS_MS) {
      await sleep(gap);
      if (document.visibilityState !== 'visible') return; // visibilitychange re-runs load()
      const s = await getSessions();
      if (!s.ok) return;
      state.sessions = s.data.sessions;
      render();
      maybeFailedBanner();
      if (!anyStarting()) return;
    }
  } finally {
    confirming = false;
    // Bounded at 3 x (1 + forced calls arriving mid-sequence). This call runs
    // with `confirming` already false, so it ENTERS the loop rather than
    // setting the flag again - a sequence can never re-arm itself, which is
    // what caps the chain. It does NOT rely on anyStarting() going false:
    // an entry that never resolves still stops after its three gaps. Do not
    // rewrite this into a loop keyed on anyStarting(); that reintroduces the
    // unbounded case this shape avoids.
    if (rearm) {
      rearm = false;
      confirmStarting(true);
    }
  }
}

function renderConn() {
  const conn = document.getElementById('conn');
  const dot = conn.querySelector('.dot');
  const text = conn.querySelector('.conn-text');
  const host = conn.querySelector('.conn-host');
  host.textContent = location.host;

  if (state.reachable === null) {
    setDot(dot, 'dim');
    text.textContent = 'CONNECTING';
    text.classList.remove('reachable');
  } else if (state.reachable === true) {
    setDot(dot, 'filled');
    text.textContent = 'AGENT REACHABLE';
    text.classList.add('reachable');
  } else {
    setDot(dot, 'dim');
    text.textContent = 'CANNOT REACH AGENT';
    text.classList.remove('reachable');
  }
}

function renderProjects() {
  const tilesEl = document.getElementById('tiles');
  const listEl = document.getElementById('projects');
  const runCount = document.getElementById('run-count');
  const allCount = document.getElementById('all-count');

  tilesEl.innerHTML = '';
  listEl.innerHTML = '';

  const rows = state.projects.map((p) => ({ p, rs: rowState(p) }));
  const tiles = rows.filter((r) => r.rs.zone === 'tile');
  const list = rows.filter((r) => r.rs.zone === 'list');

  tilesEl.classList.toggle('single', tiles.length === 1);
  tilesEl.classList.toggle('empty', tiles.length === 0);
  if (tiles.length === 0) {
    const ph = document.createElement('div');
    ph.className = 'tiles-placeholder';
    const l1 = document.createElement('div');
    l1.textContent = 'nothing running';
    const l2 = document.createElement('div');
    l2.textContent = 'tap a project to start a session';
    ph.append(l1, l2);
    tilesEl.appendChild(ph);
  } else {
    for (const { p, rs } of tiles) tilesEl.appendChild(buildTile(p, rs));
  }
  runCount.textContent = String(tiles.length);

  if (state.reachable === false) {
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = 'Cannot reach the agent.';
    listEl.appendChild(msg);
  } else if (state.projects.length === 0) {
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = "No project folders found. Check the agent's base folder on the PC.";
    listEl.appendChild(msg);
  } else {
    for (const { p, rs } of list) listEl.appendChild(buildRow(p, rs));
  }
  allCount.textContent = String(state.projects.length);

  if (state.focusName) {
    const target = Array.from(listEl.children).find((c) => c.dataset && c.dataset.project === state.focusName);
    if (target) target.focus();
    state.focusName = null;
  }

  return rows;
}

function renderFooter(rows) {
  const footer = document.getElementById('footer');
  const total = state.projects.length;
  if (state.sessions === null && state.results.size === 0) {
    footer.textContent = `SESSION STATE UNKNOWN · ${total} TOTAL`;
    return;
  }
  const running = rows.filter((r) => r.rs.dot === 'filled').length;
  footer.textContent = `${running} ACTIVE · ${total} TOTAL`;
}

function render() {
  renderConn();
  const rows = renderProjects();
  renderFooter(rows);
}

async function load() {
  state.results = new Map();
  hideBanner();

  const [proj, sess] = await Promise.allSettled([getProjects(), getSessions()]);
  const p = proj.value; // api.js never throws - always fulfilled
  if (p.ok) {
    state.projects = p.data.projects;
    state.reachable = true;
  } else {
    state.projects = [];
    state.reachable = false;
    setErrorBanner(p.code, p.status);
  }

  // Any sessions failure, including 404, means "unknown" - it never blanks
  // the project list and never sets reachable = false on its own.
  const s = sess.value;
  state.sessions = s.ok ? s.data.sessions : null;

  render();
  if (state.reachable) maybeFailedBanner();
  confirmStarting();
}

async function onProjectTap(e) {
  const row = e.target.closest('[data-project]');
  if (!row) return;
  const name = row.dataset.project;
  if (state.launching.has(name)) return;

  state.launching.add(name);
  state.results.delete(name);
  render();

  const res = await launchSession(name);
  state.launching.delete(name);

  if (res.ok && res.status === 202) {
    state.results.set(name, { kind: 'started', session: res.data });
    setBanner('info', [{ b: name }, { text: " - start requested. Not confirmed yet: open the Claude app's Code tab to check it appeared." }]);
  } else if (res.ok && res.status === 200) {
    state.results.set(name, { kind: 'reused', session: res.data });
    setBanner('info', [{ b: name }, { text: " is already running. Open it in the Claude app's Code tab." }]);
  } else if (res.ok) {
    // Any other 2xx: never assume, treat as started but say we don't know.
    state.results.set(name, { kind: 'started', session: res.data });
    setBanner('info', [{ b: name }, { text: " - the agent accepted the request but reported a status this app doesn't know. Check the Claude app's Code tab." }]);
  } else {
    state.results.set(name, { kind: 'error', code: res.code });
    setErrorBanner(res.code, res.status);
  }

  state.focusName = name;
  render();
  // force: state.sessions does not yet contain the new entry, and the first
  // check at 3s is what brings it in.
  if (res.ok && res.status === 202) confirmStarting(true);
}

function newProjectNameEl() { return document.getElementById('newproj-name'); }

function currentNameTrimmed() {
  // Client-side trim only, matching the contract in design/tokens.md /
  // spec-t31.md section 11: the server is the boundary, this is UX so the
  // common phone-keyboard trailing space never becomes a round trip.
  return newProjectNameEl().value.trim();
}

function updateNewProjectTarget() {
  const targetEl = document.getElementById('newproj-target');
  const errorEl = document.getElementById('newproj-error');
  const createBtn = document.getElementById('newproj-create');
  const name = currentNameTrimmed();

  if (name === '') {
    errorEl.hidden = true;
    targetEl.textContent = '';
    createBtn.disabled = true;
    return;
  }

  const code = clientValidateName(name);
  if (code) {
    errorEl.textContent = newProjectErrorCopy(code);
    errorEl.hidden = false;
    targetEl.textContent = '';
    createBtn.disabled = true;
    return;
  }

  errorEl.hidden = true;
  errorEl.textContent = '';
  const base = baseDirGuess();
  targetEl.textContent = base
    ? `will create: ${base.dir}${base.sep}${name}`
    : `will create: ${name} (in the projects folder)`;
  createBtn.disabled = false;
}

function openNewProjectPanel() {
  document.getElementById('newproj-panel').hidden = false;
  const nameEl = newProjectNameEl();
  nameEl.value = '';
  updateNewProjectTarget();
  nameEl.focus();
}

function closeNewProjectPanel() {
  document.getElementById('newproj-panel').hidden = true;
}

async function onCreateProject() {
  const errorEl = document.getElementById('newproj-error');
  const createBtn = document.getElementById('newproj-create');
  const name = currentNameTrimmed();

  const code = clientValidateName(name);
  if (code) {
    errorEl.textContent = newProjectErrorCopy(code);
    errorEl.hidden = false;
    return;
  }

  createBtn.disabled = true;
  const res = await createProject(name);
  createBtn.disabled = false;

  if (res.ok) {
    closeNewProjectPanel();
    setBanner('info', [{ b: res.data.project.name }, { text: ' created.' }]);
    // Re-fetch, never optimistic insert (spec-t31.md section 11 / 8): the
    // list is the single source of truth once the agent has confirmed it.
    await load();
    return;
  }

  // Name stays in the field so it can be corrected (spec-t31.md section 11).
  errorEl.textContent = newProjectErrorCopy(res.code);
  errorEl.hidden = false;
  updateNewProjectTarget();
}

function onNewProject() {
  openNewProjectPanel();
}

function wireEvents() {
  document.getElementById('projects').addEventListener('click', onProjectTap);
  document.getElementById('newproj').addEventListener('click', onNewProject);
  document.getElementById('refresh').addEventListener('click', () => load());
  document.getElementById('newproj-cancel').addEventListener('click', closeNewProjectPanel);
  document.getElementById('newproj-create').addEventListener('click', onCreateProject);
  newProjectNameEl().addEventListener('input', updateNewProjectTarget);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') load();
  });
}

function registerServiceWorker() {
  // .catch(() => {}) is load-bearing: over plain HTTP on a Tailscale IP the
  // origin is not a secure context, registration throws, and the app must
  // carry on working with no cache at all.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  }
}

// Escape hatch with no devtools: browse to <host>:8790 with ?reset-cache=1
// in the address bar to clear every cache and service worker registration,
// then reload clean.
async function maybeResetCache() {
  if (!new URLSearchParams(location.search).has('reset-cache')) return false;
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  }
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  }
  location.replace('/');
  return true;
}

async function boot() {
  if (await maybeResetCache()) return;
  // T33: the passcode gate goes here - check lock state and return before
  // render() until unlocked. Nothing below needs to move.
  registerServiceWorker();
  wireEvents();
  render();
  await load();
}

boot();
