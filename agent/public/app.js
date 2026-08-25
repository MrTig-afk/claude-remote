import { getProjects, getSessions, launchSession } from './api.js';

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
    return { zone: 'tile', dot: 'accent', status: 'starting...', idle: '—', active: true };
  }

  const session = sessionFor(p);
  if (session) {
    if (session.status === 'running') {
      return { zone: 'tile', dot: 'filled', status: 'active session', idle: elapsed(session.started_at), active: true };
    }
    return { zone: 'tile', dot: 'accent', status: 'starting - not confirmed', idle: elapsed(session.started_at), active: true };
  }

  const result = state.results.get(p.name);
  if (result) {
    if (result.kind === 'started') {
      return { zone: 'tile', dot: 'accent', status: 'start requested - not confirmed', idle: elapsed(result.session.started_at), active: true };
    }
    if (result.kind === 'reused') {
      return { zone: 'tile', dot: 'filled', status: 'already running', idle: elapsed(result.session.started_at), active: true };
    }
    // result.kind === 'error': no registry entry exists, so this falls
    // back to being a list row.
    return { zone: 'list', dot: 'dim', status: 'could not start', idle: '—', active: false };
  }

  if (state.sessions === null) {
    return { zone: 'list', dot: 'dim', status: 'session state unknown', idle: '—', active: false };
  }
  return { zone: 'list', dot: 'dim', status: 'no session', idle: '—', active: false };
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
}

function onNewProject() {
  setBanner('info', [{ text: "Creating projects from here isn't built yet. Make the folder on the PC, then tap REFRESH." }]);
}

function wireEvents() {
  document.getElementById('projects').addEventListener('click', onProjectTap);
  document.getElementById('newproj').addEventListener('click', onNewProject);
  document.getElementById('refresh').addEventListener('click', () => load());
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
