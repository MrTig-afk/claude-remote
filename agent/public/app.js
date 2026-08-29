import { getProjects, getSessions, launchSession, endSession, dismissEnded, createProject, getAcknowledged, acknowledge, getDrives, getFolders, putShared, onAuthLost } from './api.js';
import { showGate } from './lock.js';
import {
  TITLE, LEDE, CONSENT_LABEL, SETTINGS_NOTE, ACCEPT_BUTTON, SECTIONS_TOGGLE, renderSections,
  CHOOSE_FOLDERS_BUTTON, PICKER_SKIP, PICKER_CANCEL, REMOVE_BUTTON,
  NOTHING_SHARED, SHARED_UNKNOWN, ALL_ROOTS_GONE, ROOT_GONE_BODY, rootGoneTitle,
  emptyDayOneTitle, EMPTY_DAY_ONE_BODY,
} from './copy.js';
import {
  crumbSegments, sharedBody, coverageOf, driveRowState, truncatedNote, shareErrorMessage, applySaveResult, MAX_SHARED_ROOTS,
  listZoneState, missingRoots, withoutRoot, sharedToTicks, sharedRowState,
} from './folders-ui.js';

// The version baked into whatever copy of the shell the phone has cached.
// Keep it a plain single-quoted literal: the version test reads it out of
// this source file, because a browser module cannot be imported under node.
export const SHELL_VERSION = '0.1.0';

// Single module-level state. 15 rows today - full rebuild on every render(),
// no diffing, no framework, no template engine.
const state = {
  // showScreen is the ONLY writer of this field - see the router below. The
  // app always opens on the passcode gate, before boot() has asked the
  // agent anything.
  screen: 'gate',
  projects: [], // from /api/projects
  sessions: null, // array, or null = unknown (fetch failed / 404)
  launching: new Set(), // project names with a POST in flight
  results: new Map(), // name -> { kind:'started'|'reused'|'error', session?, code? }
  // null = not tried yet, true, false, or 'waiting' - the agent did not
  // answer AND the reason was network/timeout, which is the one failure that
  // ends by itself when the PC finishes waking up. waitForAgent() owns it.
  reachable: null,
  waitTries: 0, // retries made in the current 'waiting' run, for the status line
  stopping: new Set(), // project names with an end POST in flight - CLIENT ONLY
  confirmName: null, // the ONE project whose tile is currently the question
  openFolder: null, // the open container's NAME, or null = the top-level list.
  // Held by NAME, never as an object reference, so a state.projects reload
  // cannot leave a stale folder on screen. Set by openFolderScreen(name) only;
  // cleared by closeFolderScreen(), the popstate handler, and renderProjects
  // when the name no longer resolves to a container.
  // The agent's answer for the shared set: an array of
  // { path, mode, excludes, new_folders, missing }, or null = it has not told
  // us. null and absent mean the same thing everywhere - see listZoneState.
  shared: null,
};

// Ended records announced this open. Announcing also dismisses at the agent,
// so a record shows once; the 24h retention is the never-opened fallback.
const reported = new Set();

// The whole routing table. One <main> per screen, exactly one visible at a
// time. T79-T85 add a key and a <main> here and inherit showScreen, goHome
// and the back handling with no further wiring.
const SCREEN_MAIN = {
  gate: 'gate',
  accept: 'accept',
  list: 'picker',      // #picker IS the project list - it predates the folder picker
  folders: 'folders',  // the folder picker (T97)
  settings: 'settings',
};

// The one place a screen changes. Sets `hidden` on every <main> in
// SCREEN_MAIN so two of them can never render stacked (the failure the
// hideAccept() comment in boot() describes), records which screen the app is
// on, and keeps the two pieces of header chrome that depend on it honest.
function showScreen(name) {
  state.screen = name;
  for (const [screen, id] of Object.entries(SCREEN_MAIN)) {
    document.getElementById(id).hidden = screen !== name;
  }
  // The gate and the acknowledgement warning each have exactly ONE way out
  // and home is not it. Inert rather than hidden: design/tokens.md puts the
  // mark on EVERY screen, lock included, and never muted - so the control
  // stays fully drawn and stops being tappable.
  document.getElementById('home').disabled = name === 'gate' || name === 'accept';
  // Settings is reached from the project list and from nowhere else. On the
  // picker it would be a loop; on the gate it would be a way past it.
  document.getElementById('settings-open').hidden = name !== 'list';
  renderConn();   // the status line belongs to the project list; renderConn derives that
}

const ERROR_COPY = {
  network: 'Cannot reach the agent. Check the PC is awake and Tailscale is connected, then tap REFRESH.',
  timeout: "The agent didn't answer in time. Check it is still running on the PC, then tap REFRESH.",
  project_not_found: "That project folder isn't there any more. Tap REFRESH to reload the list.",
  invalid_project: "The agent won't accept that project name. Tap REFRESH; if it keeps happening, rename the folder on the PC.",
  invalid_request: 'The agent rejected the request. This is a bug in the app - note what you tapped.',
  payload_too_large: 'The request was too big to send. This is a bug in the app - note what you tapped.',
  internal_error: 'The agent hit an internal error. Check its terminal window on the PC.',
  bad_response: "The agent replied with something this app doesn't understand. It may be a different version.",
  session_not_running: "That session isn't running yet, or is already being ended. Tap REFRESH.",
  // A 403 the gate flow has not already caught: the agent lost its passcode
  // file while the app was open. api.js only re-locks on 401, so this one
  // reaches the banner and needs real copy.
  setup_required: 'This agent has no passcode yet. Reload the app to set one.',
  // The two failures POST /api/acknowledge can return - see agent/config.js's
  // acknowledge().
  config_unreadable: 'The agent could not read its config file on the PC. Check its terminal window.',
  write_failed: 'The agent could not save that on the PC. Check its terminal window.',
};

function errorCopy(code, status) {
  return ERROR_COPY[code] || `The agent refused the request (status ${status}). Check its terminal window on the PC.`;
}

// Copy for POST /api/projects only - distinct from ERROR_COPY above, which
// is written for launch failures and uses codes (project_not_found,
// invalid_project) that don't apply here.
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
// Duplicated because the browser and the agent share no module boundary;
// keep this in sync by hand if projects.js's rules change.
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
// returns one per entry; the create response deliberately omits it, matching
// createProject's contract of never returning a filesystem path). If the
// base folder is currently empty nothing has a path to derive from - the
// preview falls back to a relative form rather than adding a new endpoint
// just to expose baseDir.
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

// The name of the folder that CONTAINS this one, read off an absolute path -
// 'Pull Requests' for '...\Pull Requests\Vercel'. Both separators are handled,
// the same way baseDirGuess does it, because the agent's paths are whatever
// the OS it runs on produces. null when there is no containing segment to
// name. It answers about the PATH and knows nothing about the project list,
// which is why only renderProjects' synthetic-row loop may call it: a
// top-level project's row has a path too, and running this on it would put the
// base folder's name over every tile in the app.
function parentFolderName(p) {
  if (!p) return null;
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(sep).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

// Two keys deliberately: path is the strong one (both sides resolve from
// the same baseDir), project covers an entry recorded by a different
// client. Matching on session_name is wrong - deriveSessionName can map two
// folders to the same name, which would attribute one row's session to
// another.
function sessionFor(p) {
  if (!state.sessions) return null;
  // Path first. The name fallback is for registry entries only - a desk
  // session in a subfolder that happens to share a root project's name must
  // not attach itself to that project's row. Known ceiling: its STOP still
  // resolves by display name (endTargetFor), so in that collision the
  // subfolder session is not endable from the phone; key tiles on path if
  // it ever happens for real.
  return state.sessions.find((s) => (s.path === p.path || (s.project === p.name && s.source !== 'desk')) && s.status !== 'ended') ?? null;
}

/**
 * The one honesty rule, stated once: a filled accent dot means and only
 * means the agent proved a live pid. Everything else is a hollow ring.
 * One rule places a row: a project with a registry entry (any status) or
 * an in-flight launch is a tile; everything else is a list row - and a
 * container short-circuits ahead of all of it, never becoming a tile.
 */
function rowState(p) {
  // A container is a folder, not a project: it has no session state to
  // report, so it takes no dot and can never be a tile. First check in the
  // function deliberately - nothing below it (a launch in flight, a stale
  // result, a session that matched by name) may promote it to the RUNNING
  // zone. `implicit` is absent, so buildRow always draws its sub-line.
  // ACCEPTED CEILING: a desk session opened IN the container's own root
  // folder renders nowhere in the app. This returns before sessionFor, and
  // renderProjects' synthetic-row loop skips that path because the
  // container's own path IS a listed project. The drill-in screen carried a
  // dimmed row for it briefly; the owner had it removed - a container is not
  // a project path, so a row for it was noise. Such a session is visible and
  // endable at the desk, which is where it was started.
  if (p.container) {
    const n = (p.children || []).length;
    return { zone: 'list', folder: true, status: n === 1 ? '1 project' : n + ' projects', idle: '—' };
  }

  if (state.launching.has(p.name)) {
    return { zone: 'tile', dot: 'accent', status: 'starting...', idle: '—' };
  }

  if (state.stopping.has(p.name)) {
    return { zone: 'tile', dot: 'accent', status: 'ending...', idle: '—' };
  }

  const session = sessionFor(p);
  if (session) {
    if (session.status === 'running') {
      const desk = session.source === 'desk';
      return {
        // `busy` / `idle` / `waiting` is Claude Code's own word for what the session is
        // doing right now (agent/registry.js reads it from the desk-session
        // file). It REPLACES 'active session' rather than being appended as a
        // fourth segment: the filled dot already says active, and a fourth
        // segment wraps the 9px status line onto two lines on a 184px tile
        // (app.css:159 sets no nowrap). Line reads: "busy - 12m - desktop".
        zone: 'tile', dot: 'filled', status: session.activity || 'active session',
        idle: elapsed(session.started_at), stop: true,
        ...(desk ? { suffix: 'desktop', desk: true } : {}),
      };
    }
    if (session.status === 'failed') {
      return { zone: 'list', dot: 'dim', status: 'launch unconfirmed', idle: elapsed(session.started_at) };
    }
    if (session.status === 'handoff') {
      return { zone: 'tile', dot: 'accent', status: 'writing handoff...', idle: '—' };
    }
    return { zone: 'tile', dot: 'accent', status: 'starting...', idle: elapsed(session.started_at) };
  }

  const result = state.results.get(p.name);
  if (result) {
    if (result.kind === 'started') {
      return { zone: 'tile', dot: 'accent', status: 'starting...', idle: elapsed(result.session.started_at) };
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
  // implicit: this is the default state of every project that is not running,
  // and the hollow dot already says it. Drawing it on all fifteen rows cost a
  // second line of height each and told the owner nothing he could act on.
  // The string stays so a screen reader still gets it.
  return { zone: 'list', dot: 'dim', status: 'no session', idle: '—', implicit: true };
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

// Tiles and list rows both use this. The list has no separate idle column any
// more, so this is the only thing carrying a row's elapsed time - the one
// list state that has a real one (a launch that was never confirmed) would
// otherwise lose it silently.
function statusLine(rs) {
  return [rs.status, rs.idle && rs.idle !== '—' ? rs.idle : null, rs.suffix || null].filter(Boolean).join(' - ');
}

function buildTile(p, rs) {
  const el = document.createElement('div');
  el.className = 'tile';
  if (state.launching.has(p.name) || state.stopping.has(p.name)) el.setAttribute('aria-busy', 'true');
  el.appendChild(buildDot(rs.dot));
  // The eyebrow: the folder this session lives IN, above its name, so a nested
  // session can never be mistaken for a top-level project of the same name.
  // Two routes reach a tile with two different name shapes and both are
  // covered here. A nested LAUNCHED session, and any drill-in row, is keyed
  // '<container>/<child>' - the parent is the part before the last '/', and
  // splitting it out is also what stops a nested launched tile rendering that
  // whole raw string as its name. A nested DESK session is keyed by its bare
  // basename (the desk discovery in agent/registry.js reports
  // path.basename(cwd)), so its name can never carry a parent at all;
  // renderProjects hands that one over as p.parent, derived from the path.
  // p.parent wins where both exist - path is the strong key, same rule
  // sessionFor states - and they agree anyway. A top-level project has
  // neither, gets no element at all, and its tile is byte-identical to before.
  const cut = p.name.lastIndexOf('/');
  const parent = p.parent || (cut === -1 ? null : p.name.slice(0, cut));
  if (parent) {
    const eyebrow = document.createElement('span');
    eyebrow.className = 'tile-eyebrow';
    eyebrow.textContent = parent;   // uppercased in app.css - the DOM keeps the real folder name
    el.appendChild(eyebrow);
  }
  const name = document.createElement('span');
  name.className = 'tile-name';
  name.textContent = p.label || (cut === -1 ? p.name : p.name.slice(cut + 1));
  el.appendChild(name);
  const status = document.createElement('span');
  status.className = 'tile-status';
  status.textContent = statusLine(rs);
  el.appendChild(status);

  if (state.confirmName === p.name) {
    const q = document.createElement('div');
    q.className = 'tile-confirm';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'tile-stop-cancel';
    cancel.dataset.stopCancel = p.name;
    cancel.textContent = 'CANCEL';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'tile-stop-go';
    go.dataset.stopConfirm = p.name;
    go.textContent = rs.desk ? 'END & WRITE HANDOFF (DESKTOP)' : 'END & WRITE HANDOFF';
    q.append(cancel, go);
    el.appendChild(q);
  } else if (rs.stop) {
    el.classList.add('has-stop');
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'tile-stop';
    stop.dataset.stop = p.name;
    stop.setAttribute('aria-label', `Stop ${p.name}`);
    stop.textContent = 'STOP';
    el.appendChild(stop);
  }

  return el;
}

function buildRow(p, rs) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = rs.folder ? 'row folder' : 'row';
  // A folder row carries data-folder, NOT data-project. onProjectTap opens
  // the drill-in on [data-folder] and still launches only on [data-project],
  // so a folder can never launch - leaving the attribute off is the whole of
  // that guarantee.
  if (rs.folder) btn.dataset.folder = p.name;
  else btn.dataset.project = p.name;
  // The dot is decorative and the default status is not drawn, so the row's
  // state has to reach a screen reader some other way. This is that way, and
  // it says the same thing for every row whether or not the line is visible.
  btn.setAttribute('aria-label', `${p.name}, ${statusLine(rs)}`);

  // No dot on a folder row. Dropping the ELEMENT (rather than hiding it) is
  // also what shifts the name 20px left of its neighbours - .row's 8px dot
  // plus its 12px gap - and that break in the left edge is the row's
  // strongest signal. A hollow ring here would state a session state a folder
  // does not have. Do not add a margin to "fix" the alignment.
  if (!rs.folder) btn.appendChild(buildDot(rs.dot));

  const main = document.createElement('span');
  main.className = 'row-main';
  const nameEl = document.createElement('span');
  nameEl.className = 'row-name';
  nameEl.textContent = p.label || p.name;
  main.appendChild(nameEl);
  if (!rs.implicit) {
    const statusEl = document.createElement('span');
    statusEl.className = 'row-status';
    statusEl.textContent = statusLine(rs);
    main.appendChild(statusEl);
  }
  btn.appendChild(main);

  if (rs.folder) {
    const chev = document.createElement('span');
    chev.className = 'folder-chev';
    chev.setAttribute('aria-hidden', 'true'); // the aria-label already says it
    chev.textContent = '>';
    btn.appendChild(chev);
  }

  return btn;
}

// The way out (T100). `withAction` is false for 'unknown-shared' only - see
// the safety rule on onChooseFolders; it is the one state that must NOT
// offer the picker.
function buildEmptyState({ title, body }, withAction) {
  const el = document.createElement('div');
  el.className = 'empty';
  const t = document.createElement('div');
  t.className = 'empty-title';
  t.textContent = title;
  el.appendChild(t);
  const b = document.createElement('div');
  b.className = 'empty-body';
  b.textContent = body;
  el.appendChild(b);
  if (withAction) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'empty-action';
    btn.dataset.choose = '1';
    btn.textContent = CHOOSE_FOLDERS_BUTTON;
    el.appendChild(btn);
  }
  return el;
}

// One gone root's notice (T100), additive above the rows - see the
// precedence rules in renderProjects. `.share-new` is reused wholesale for
// REMOVE: same bordered, unfilled, colourless language as everywhere else in
// this app, and no new rule to carry.
function buildGoneNotice(root) {
  const el = document.createElement('div');
  el.className = 'gone';
  const name = crumbSegments(root.path).at(-1).label;
  const t = document.createElement('div');
  t.className = 'gone-title';
  t.textContent = rootGoneTitle(name);
  el.appendChild(t);
  const p = document.createElement('div');
  p.className = 'gone-path';
  p.textContent = root.path;
  el.appendChild(p);
  const b = document.createElement('div');
  b.className = 'gone-body';
  b.textContent = ROOT_GONE_BODY;
  el.appendChild(b);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'share-new';
  btn.dataset.removeRoot = root.path;
  btn.setAttribute('aria-label', `Remove ${name}`);
  btn.textContent = REMOVE_BUTTON;
  el.appendChild(btn);
  return el;
}

// The project name the launch banner is about, or null. Held because the
// launch banner is the only one with no natural end: nothing but load()
// ever hid it, so "- start requested." stayed on screen until the owner
// manually refreshed, long after the session was live. Cleared by every
// other banner too, so this can never hide someone else's message.
let launchBannerFor = null;

function setBanner(tone, parts) {
  launchBannerFor = null;
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
  launchBannerFor = null;
  const el = document.getElementById('banner');
  el.hidden = true;
  el.innerHTML = '';
}

// Drops the launch banner as soon as the session it names stops being
// `starting` - the tile says the rest better than the banner can. Kept while
// the entry is still absent (the launch has not landed in state.sessions
// yet) or still starting; a `failed` entry clears it here and maybeFailedBanner()
// puts the real message up immediately after, which is why callers run this
// FIRST.
// A launch result exists only to cover the gap between the 202 and the entry
// showing up in state.sessions - rowState falls back to it when there is no
// session yet. Once the server HAS an entry for that project the result is
// redundant, and leaving it is what froze a tile on "starting..." after a
// PWA-launched session was exited at the desk (owner, 2026-08-27): the entry
// was pruned server-side, rowState fell back to the stale result, and with
// nothing watchable the poll loop had already stopped - only a manual refresh
// (which resets state.results) cleared it. Dropped as soon as it is covered,
// so there is nothing left to fall back to when the session later goes away.
// A launch result is keyed by the row's identity, which for a drill-in row
// is the two-segment '<container>/<child>' string - and state.projects holds
// top-level entries only, so a plain `.find` misses it. The pathless
// stand-in still resolves it, because sessionFor's second key is the
// registry's `project` and a nested launch records exactly that string;
// `path: null` never matches a real session (s.path is always a string), so
// the stand-in can only ever match by name. Without it, both bugs fixed for
// top-level projects came straight back inside a folder: a launch banner
// that never cleared, and a tile frozen on "starting..." after a desk exit.
function dropCoveredResults() {
  for (const name of [...state.results.keys()]) {
    const p = state.projects.find((x) => x.name === name) ?? { name, path: null };
    if (sessionFor(p)) state.results.delete(name);
  }
}

function clearSettledLaunchBanner() {
  if (launchBannerFor === null) return;
  // See dropCoveredResults for why the pathless stand-in is needed here too.
  const p = (state.projects || []).find((x) => x.name === launchBannerFor)
    ?? { name: launchBannerFor, path: null };
  const s = sessionFor(p);
  if (s) {
    if (s.status === 'starting') return; // still coming up, the banner is the only signal
    hideBanner();
    return;
  }
  // No entry at all, and that means one of two opposite things. A session
  // EXITED AT THE DESK is dropped outright by the registry (registry.js:571,
  // dead pid -> drop, not `failed`), so "no entry" cannot be read as "not
  // landed yet" - doing that left the banner up forever (owner, 2026-08-27).
  // state.results is the discriminator: dropCoveredResults() deletes it the
  // first time an entry is seen, and it runs BEFORE this in both loops. Still
  // holding it -> the launch has not landed. Gone -> it landed and the
  // session has since disappeared, so there is nothing left to wait for.
  if (!state.results.has(launchBannerFor)) hideBanner();
}

function setErrorBanner(code, status) {
  // The '!' glyph is the only visual weight an error gets - the palette's
  // one accent (`#7ee787`) means "active" and its one danger colour
  // (`#ff7b72`) is reserved for destructive actions only, never for an
  // error or a banner.
  setBanner('error', [{ text: '! ' + errorCopy(code, status) }]);
}

// Announces each ended record exactly once, keyed by session_name in the
// module-level `reported` set. Accepted ceiling: with two unreported ended
// records the last one processed wins the single banner line.
function reportEnded() {
  for (const s of (state.sessions || [])) {
    if (s.status !== 'ended' || reported.has(s.session_name)) continue;
    reported.add(s.session_name);
    dismissEnded(s.session_name); // fire-and-forget: a lost dismiss just re-announces next open
    if (s.handoff_ok) setBanner('info', [{ text: 'Handoff written for ' }, { b: s.project }, { text: '.' }]);
    // 'interrupted' means the AGENT lost the verdict (it was restarted while
    // the handoff ran), NOT that the handoff failed - the file is very often
    // there. Saying "was not written" for that case is a lie the owner caught
    // 2026-08-27: email-lint's HANDOFF.md was on disk, written two minutes
    // before the restart, while the banner claimed it was not.
    else if (s.handoff_result === 'interrupted') setBanner('error', [
      { text: '! ' }, { b: s.project }, { text: " ended, but the agent restarted before it could confirm the handoff. Check that project's HANDOFF.md." },
    ]);
    else setBanner('error', [{ text: '! Session ended, but the handoff was not written.' }]);
  }
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

// Checks at roughly 3s, 8s, 33s and 123s after the trigger. The last is past
// STARTING_GRACE_MS, which is the whole point: it is the first moment the
// agent can return a `failed` verdict, so without it the owner never sees
// one. Gaps, not absolute offsets - they are awaited in sequence.
// The 90s gap was added when STARTING_GRACE_MS went from 30s to 120s (see
// agent/registry.js for the cold-boot measurement that moved it). Without
// it the sequence would end at 33s, well inside the grace window, and a
// launch that really did fail would sit as `starting` with no banner until
// the owner pulled REFRESH - the watch loop drops a `failed` entry out of
// anyWatchable() and stops rather than announcing it.
const CONFIRM_GAPS_MS = [3000, 5000, 25000, 90000];
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
      dropCoveredResults();
      render();
      clearSettledLaunchBanner();
      maybeFailedBanner();
      if (!anyStarting()) return;
    }
  } finally {
    confirming = false;
    // Bounded at CONFIRM_GAPS_MS.length x (1 + forced calls arriving
    // mid-sequence). This call runs
    // with `confirming` already false, so it ENTERS the loop rather than
    // setting the flag again - a sequence can never re-arm itself, which is
    // what caps the chain. It does NOT rely on anyStarting() going false:
    // an entry that never resolves still stops after its gaps. Do not
    // rewrite this into a loop keyed on anyStarting(); that reintroduces the
    // unbounded case this shape avoids.
    if (rearm) {
      rearm = false;
      confirmStarting(true);
    }
    // A `starting` entry that just turned `running` (or `handoff`) here is
    // exactly what the 5s watch loop exists to keep polling - without this
    // call it never starts, since the loop's only other call sites run
    // before the new session is in state.sessions. `watching` makes this
    // free when a loop is already up.
    watchSessions();
  }
}

const WATCH_GAP_MS = 5000;
let watching = false;

// `starting` included (owner, 2026-08-27): a launch cancelled at the desk
// otherwise sat on the phone as a stale tile until REFRESH, because the
// bounded confirm sequence had ended and nothing else polled. The server
// ages a dead `starting` entry into `failed` and prunes it; the watch just
// has to keep asking until it is either running or gone.
function anyWatchable() {
  return (state.sessions || []).some((s) => s.status === 'running' || s.status === 'handoff' || s.status === 'starting');
}

// A separate loop from confirmStarting(), deliberately: that sequence is
// bounded and exists to catch a launch landing. This one has an explicit
// stop condition and no timer at all when nothing is running.
async function watchSessions() {
  if (watching) return;
  watching = true;
  try {
    while (document.visibilityState === 'visible' && anyWatchable()) {
      await sleep(WATCH_GAP_MS);
      if (document.visibilityState !== 'visible') return;
      if (!anyWatchable()) return;
      const s = await getSessions();
      if (!s.ok) return;
      state.sessions = s.data.sessions;
      dropCoveredResults();
      clearSettledLaunchBanner();
      reportEnded();
      render();
    }
  } finally {
    watching = false;
  }
}

// Gaps between automatic retries while the agent is unreachable; the last
// one repeats for as long as the app is open and in front. Short at first
// because a PC that is merely finishing its boot comes back in seconds, then
// backing off so a machine that is genuinely off is not hammered.
const WAIT_GAPS_MS = [2000, 3000, 5000, 10000, 15000];
let waiting = false;

// A phone cannot tell "the PC is off", "the PC is still booting" and
// "Tailscale has not connected yet" apart - they are the same silence - and
// the last two end on their own within a minute. The app used to answer all
// three with CANNOT REACH AGENT and a REFRESH button, which put the owner in
// front of a dead screen with no idea whether waiting would help (owner,
// 2026-08-28: "we need something to show when the PWA is reloading in the
// background when the system has shut down. I was soo confused fr").
// So it waits, visibly, and comes back by itself. Bounded the same way
// watchSessions is - by the visibility gate and by its own stop condition,
// not by a timer that runs while the app is in the background.
async function waitForAgent() {
  if (waiting) return;
  waiting = true;
  try {
    while (state.reachable === 'waiting' && document.visibilityState === 'visible') {
      await sleep(WAIT_GAPS_MS[Math.min(state.waitTries, WAIT_GAPS_MS.length - 1)]);
      if (state.reachable !== 'waiting' || document.visibilityState !== 'visible') return;
      state.waitTries += 1;
      renderConn();
      // Re-entrant by design: load() calls waitForAgent() again on a failure,
      // and `waiting` is still true here, so that call returns immediately
      // and THIS loop keeps ownership of the retrying.
      await load();
    }
  } finally {
    waiting = false;
  }
}

// The splash is part of the page's initial state, so it is already covering
// the window before this module parses. Dropping it is unconditional: it goes
// as soon as a real screen has painted, and again if boot throws, so a
// failure can never leave the owner staring at a logo with no way forward.
function hideSplash() {
  document.getElementById('splash').hidden = true;
}

// The status line belongs to the project list and to nothing else, so it is
// put away again whenever the passcode screen comes back.
function hideConn() {
  document.getElementById('conn').hidden = true;
}

function hideAccept() {
  document.getElementById('accept').hidden = true;
}

function renderConn() {
  const conn = document.getElementById('conn');
  const dot = conn.querySelector('.dot');
  const text = conn.querySelector('.conn-text');

  if (state.reachable === null) {
    setDot(dot, 'dim');
    text.textContent = 'CONNECTING';
    text.classList.remove('reachable');
  } else if (state.reachable === 'waiting') {
    // The accent ring, not the dim one: dim is "nothing is happening", and
    // something IS happening - the app is retrying on its own. The counter
    // is the proof of that to someone watching a screen that would otherwise
    // look identical to a frozen one.
    setDot(dot, 'accent');
    text.textContent = state.waitTries > 0 ? `WAITING FOR PC (${state.waitTries})` : 'WAITING FOR PC';
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

  // The line describes the project list, so it is on screen exactly when the
  // project list is. Read the picker's live state rather than assume this
  // render belongs to it: a request already in flight when the token expires
  // resolves and renders AFTER the passcode screen is back up, and an
  // unconditional reveal there would light the line on a screen it says
  // nothing true about. The picker ships hidden, so an unexpected state
  // leaves the line away rather than on.
  conn.hidden = document.getElementById('picker').hidden;
}

function renderProjects() {
  const tilesEl = document.getElementById('tiles');
  const listEl = document.getElementById('projects');
  const runCount = document.getElementById('run-count');
  const allCount = document.getElementById('all-count');

  tilesEl.innerHTML = '';
  listEl.innerHTML = '';

  // The folder is held by NAME, so if it is gone (deleted, no longer a
  // container, or the agent is unreachable and the list is empty) the screen
  // falls back to the top-level list. Ceiling: its pushed history entry is
  // deliberately NOT popped here, because renderProjects already owns one
  // pop below (the stale-confirm reconcile) that assumes the confirm's entry
  // is on top, and a second pop here could take the wrong one. Cost is one
  // dead back press in the case that needs a folder to vanish mid-session;
  // onPopState clears folderPushed when that entry is finally popped.
  const open = state.openFolder === null
    ? null
    : (state.projects.find((p) => p.name === state.openFolder && p.container) ?? null);
  if (state.openFolder !== null && !open) state.openFolder = null;

  // Section 2a of T100's spec, driven by one call - see listZoneState for the
  // precedence order and why "unreachable" must beat every shared-set check.
  const zone = listZoneState({
    reachable: state.reachable,
    openFolderEmpty: !!open && (open.children || []).length === 0,
    projectCount: state.projects.length,
    shared: state.shared,
  });
  // With no usable root, POST /api/projects can only answer base_unavailable,
  // and a control that can only fail is the failed screen this task exists
  // to delete.
  const canCreate = zone.kind !== 'nothing-shared' && zone.kind !== 'all-gone' && zone.kind !== 'unknown-shared';
  renderBackBar(open, canCreate);

  const rows = open
    ? (open.children || []).map((c) => {
        const p = childProject(open, c);
        return { p, rs: rowState(p) };
      })
    : state.projects.map((p) => ({ p, rs: rowState(p) }));

  // A desk session whose cwd is a project SUBFOLDER has no row of its own
  // above - state.projects lists project ROOTS only - so it gets a
  // synthetic project-shaped row here, named by the subfolder (owner,
  // 2026-08-27: "it should tell me the name of the project"). A desk
  // session AT a project root already matched that project's own row via
  // sessionFor() and needs none of this; the path check below is what
  // tells the two apart.
  // No source check here: while a subfolder session's handoff runs, the
  // registry reports it as a launched-shaped entry, and it must keep its
  // tile ("writing handoff...") for that window. The path check alone is
  // sufficient - a launched session's path is always a listed project.
  // Skipped entirely inside a folder (see `open`): a desk session DEEPER
  // than a child root (say <container>/<child>/docs) already has its own
  // synthetic tile on the top-level list, named by its basename, and that
  // stays unchanged - building one here too would need a path-prefix test
  // and a second identity scheme for one rare case.
  if (!open) {
    for (const s of (state.sessions || [])) {
      if (s.status === 'ended') continue; // its one banner is the receipt; no phantom row
      if (state.projects.some((p) => p.path === s.path)) continue;
      const synthetic = { name: s.project, path: s.path };
      // Display only - never part of the row's identity. The name stays
      // exactly what the agent reported, because that is what endTargetFor,
      // dataset.stop and every state key resolve on. This is the ONLY route
      // that gives a nested DESK session its parent, since its name is a bare
      // basename. Accepted ceiling: if the project list failed to load while
      // the session list did not, every session becomes a synthetic row and
      // this names the base folder over all of them - the list beside it
      // already says "Cannot reach the agent", and the next good load corrects
      // it.
      synthetic.parent = parentFolderName(s.path);
      rows.push({ p: synthetic, rs: rowState(synthetic) });
    }
  }

  // A stale confirm re-attaching to a later session is worse than the
  // accepted "one stale history entry" ceiling: it is a live STOP confirm
  // sitting on a project the owner never asked to end. Reconciled here,
  // before tiles are built, so this same render never draws it either.
  if (state.confirmName && !rows.some((r) => r.p.name === state.confirmName && r.rs.stop)) {
    state.confirmName = null;
    if (confirmPushed) { confirmPushed = false; history.back(); }
  }

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

  // State 2 (T100): additive, above the rows it never blanks. An unreachable
  // agent never gets to accuse a folder of being gone, and the drill-in
  // screen is scoped to one container - a whole-share notice there is noise.
  if (state.reachable === true && state.openFolder === null) {
    for (const root of missingRoots(state.shared)) listEl.appendChild(buildGoneNotice(root));
  }

  if (zone.kind === 'waiting') {
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = 'Waiting for the PC. This screen will fill in on its own as soon as the agent answers.';
    listEl.appendChild(msg);
  } else if (zone.kind === 'unreachable') {
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = 'Cannot reach the agent.';
    listEl.appendChild(msg);
  } else if (zone.kind === 'folder-empty') {
    // a marked container can legitimately hold no project folders
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = 'This folder has no projects in it.';
    listEl.appendChild(msg);
  } else if (zone.kind === 'rows') {
    for (const { p, rs } of list) listEl.appendChild(buildRow(p, rs));
  } else if (zone.kind === 'unknown-shared') {
    // The one state that must NOT offer the picker - see the safety rule on
    // onChooseFolders. Entering blind would open the picker with initial =
    // [] and a SAVE from there wipes every shared folder.
    listEl.appendChild(buildEmptyState(SHARED_UNKNOWN, false));
  } else if (zone.kind === 'nothing-shared') {
    listEl.appendChild(buildEmptyState(NOTHING_SHARED, true));
  } else if (zone.kind === 'all-gone') {
    listEl.appendChild(buildEmptyState(ALL_ROOTS_GONE, true));
  } else if (zone.kind === 'empty-day-one') {
    const names = zone.roots.map((r) => crumbSegments(r.path).at(-1).label);
    listEl.appendChild(buildEmptyState({ title: emptyDayOneTitle(names), body: EMPTY_DAY_ONE_BODY }, true));
  }

  allCount.textContent = String(state.projects.length);
  // Pinned verbatim above as the top-level rule by a pre-existing test, so
  // this is an override rather than a ternary: inside a folder ALL PROJECTS
  // counts that folder's own children instead.
  if (open) allCount.textContent = String((open.children || []).length);

  if (state.focusName) {
    const target = Array.from(listEl.children).find((c) => c.dataset && c.dataset.project === state.focusName);
    if (target) target.focus();
    state.focusName = null;
  }

  return rows;
}

function renderFooter(rows) {
  const footer = document.getElementById('footer');
  // TOTAL counts things that can be STARTED, so a container is not one of
  // them - its children are. 14 projects + 5 nested = 19 for the owner's
  // folder set, where ALL PROJECTS above still reads 15 top-level rows.
  const total = state.projects.reduce((n, p) => n + (p.container ? (p.children || []).length : 1), 0);
  // Inside a folder every row on screen is a child, so the rows ARE the
  // count - `rows` is already scoped to the open folder by renderProjects.
  // `running` below needs no such override: it is already computed from
  // `rows`.
  const shown = state.openFolder === null ? total : rows.length;
  if (state.sessions === null && state.results.size === 0) {
    footer.textContent = `SESSION STATE UNKNOWN · ${shown} TOTAL`;
    return;
  }
  const running = rows.filter((r) => r.rs.dot === 'filled').length;
  footer.textContent = `${running} ACTIVE · ${shown} TOTAL`;
}

// The two-segment identity for a container child. It, not the child's own
// name, is what keys state.launching / state.results / state.stopping /
// state.confirmName, what data-project carries (so onProjectTap sends it to
// launchSession unchanged and the agent resolves the pair), and exactly the
// `project` a nested launch records (so sessionFor's registry-name fallback
// finds the right session) - and it can never collide with a top-level
// folder of the same name. `label` is what the screen draws, because the
// back bar above it already names the container.
function childProject(container, child) {
  return { name: `${container.name}/${child.name}`, label: child.name, path: child.path };
}


// open = the resolved container entry (from renderProjects), or null.
// canCreate defaults true so every existing call/test that only ever passed
// `open` keeps working with no edit - T100 is the only caller that passes
// false, and only when nothing usable is shared (see renderProjects).
function renderBackBar(open, canCreate = true) {
  document.getElementById('backbar').hidden = open === null;
  // The + creates a TOP-LEVEL project only - the agent's create route is one
  // level deep, which is what the "No \ or / - projects are created directly
  // in Repos" copy already says - so inside a folder it has nothing true to
  // offer. Also hidden at the top level when there is no usable root to
  // create into - a control that can only fail is not an affordance.
  document.getElementById('newproj').hidden = open !== null || !canCreate;
  if (open === null) return;
  document.getElementById('backbar-name').textContent = open.name;
  document.getElementById('backbar-path').textContent = open.path;
  document.getElementById('backbar').setAttribute('aria-label', `Back to all projects. Inside ${open.name}.`);
  closeNewProjectPanel(); // a top-level create form must not sit on the folder screen
}

function render() {
  renderConn();
  renderSettings(); // a background load() must refresh the row while Settings is on screen
  const rows = renderProjects();
  renderFooter(rows);
}

async function load() {
  state.results = new Map();
  hideBanner();

  const [proj, sess, ack] = await Promise.allSettled([getProjects(), getSessions(), getAcknowledged()]);
  const p = proj.value; // api.js never throws - always fulfilled
  if (p.ok) {
    state.projects = p.data.projects;
    state.reachable = true;
    state.waitTries = 0;
  } else if (p.code === 'network' || p.code === 'timeout') {
    // The only two codes that mean "the agent said nothing at all", and so
    // the only two that a PC finishing its boot produces. Everything else is
    // the agent ANSWERING with a refusal, which waiting cannot fix - those
    // keep the old dead-end banner, correctly.
    state.projects = [];
    state.reachable = 'waiting';
    setBanner('info', [{ text: 'No answer from the PC yet - it may still be waking up, or Tailscale may not be connected. Retrying automatically.' }]);
    waitForAgent();
  } else {
    state.projects = [];
    state.reachable = false;
    state.waitTries = 0;
    setErrorBanner(p.code, p.status);
  }

  // Any sessions failure, including 404, means "unknown" - it never blanks
  // the project list and never sets reachable = false on its own.
  const s = sess.value;
  state.sessions = s.ok ? s.data.sessions : null;
  reportEnded();

  // A failed acknowledge call is not fatal and gets no banner: a project list
  // that loaded fine leaves state.shared = null, precedence rule 4 wins
  // whenever there are rows, and the screen is byte-identical to today.
  const a = ack.value;
  state.shared = a.ok && Array.isArray(a.data.shared_folders) ? a.data.shared_folders : null;

  render();
  // `=== true` and not a truthiness test: 'waiting' is truthy, and on that
  // path state.sessions is null anyway, so this would only ever be a no-op
  // that reads as if it were not one.
  if (state.reachable === true) maybeFailedBanner();
  confirmStarting();
  watchSessions();
}

async function onProjectTap(e) {
  // The two T100 checks come first, each with an early return, so neither
  // can fall through to [data-folder] or [data-project].
  const choose = e.target.closest('[data-choose]');
  if (choose) { onChooseFolders(); return; }
  const remove = e.target.closest('[data-remove-root]');
  if (remove) { onRemoveRoot(remove.dataset.removeRoot); return; }

  // A tap on a folder row while a confirm is open answers the question
  // instead of opening the folder: the history invariant (see folderPushed)
  // requires the confirm's entry to always be the top one, and renderProjects' stale-
  // confirm reconcile assumes it can pop that entry safely - a folder opened
  // underneath it would break that assumption.
  const folder = e.target.closest('[data-folder]');
  if (folder) {
    if (cancelOpenConfirm()) return;
    openFolderScreen(folder.dataset.folder);
    return;
  }
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
    setBanner('info', [{ b: name }, { text: ' - start requested.' }]);
    launchBannerFor = name;
  } else if (res.ok && res.status === 200) {
    state.results.set(name, { kind: 'reused', session: res.data });
    setBanner('info', [{ b: name }, { text: ' is already running.' }]);
  } else if (res.ok) {
    // Any other 2xx: never assume, treat as started but say we don't know.
    state.results.set(name, { kind: 'started', session: res.data });
    setBanner('info', [{ b: name }, { text: " - the agent accepted the request but reported a status this app doesn't know." }]);
    launchBannerFor = name;
  } else {
    state.results.set(name, { kind: 'error', code: res.code });
    setErrorBanner(res.code, res.status);
  }

  state.focusName = name;
  render();
  // force: state.sessions does not yet contain the new entry, and the first
  // check at 3s is what brings it in.
  if (res.ok && res.status === 202) confirmStarting(true);
  watchSessions();
}

// T100's two new #projects delegate targets - onProjectTap's first two
// checks, above.

async function onChooseFolders() {
  if (state.shared === null || state.shared === undefined) return; // never enter blind
  await showFolders(sharedToTicks(state.shared));   // showFolders calls showScreen('folders')
  showScreen('list');
  await load(); // the agent decides what is shared now, never an optimistic write
}

// Guarded against a double tap the same way onSave is: one in-flight write
// at a time.
let removingRoot = false;

async function onRemoveRoot(rootPath) {
  if (removingRoot) return;
  removingRoot = true;
  const res = await putShared(withoutRoot(state.shared, rootPath));
  removingRoot = false;
  if (res.ok) {
    state.shared = res.data.shared_folders ?? null;
    await load();
    return;
  }
  // The existing banner channel, no new one. write_failed and
  // config_unreadable are already in ERROR_COPY; a 401 is handled by api.js
  // re-locking, exactly as everywhere else.
  setErrorBanner(res.code, res.status);
}

// Same order and same reason as onTileTap's CANCEL branch: mutate and render
// SYNCHRONOUSLY, then a guarded history.back(), so a double tap can never pop
// the app's own entry. onTileTap keeps its own inline copy of this because a
// pre-existing test pins that block's exact text - do not "dedupe" it into
// this helper. Returns true when a confirm was actually open (and therefore
// cancelled), so a caller can swallow the tap that triggered it.
function cancelOpenConfirm() {
  if (state.confirmName === null) return false;
  state.confirmName = null;
  render();
  if (confirmPushed) { confirmPushed = false; history.back(); }
  return true;
}

function onTileTap(e) {
  const cancel = e.target.closest('[data-stop-cancel]');
  if (cancel) {
    // Mutate and render SYNCHRONOUSLY before the history call: a double tap
    // must never issue a second history.back() and pop the app's own entry.
    state.confirmName = null;
    render();
    if (confirmPushed) { confirmPushed = false; history.back(); }
    return;
  }
  const go = e.target.closest('[data-stop-confirm]');
  if (go) { runStop(go.dataset.stopConfirm); return; }
  const stop = e.target.closest('[data-stop]');
  if (stop) { openConfirm(stop.dataset.stop); }
}

// True exactly while a confirm's history entry is on the stack and this
// session is the one that pushed it. Set on pushState, cleared on popstate
// AND on any of our own history.back() calls that consume it - the second
// tap of a double-tap must never fire a second history.back(), which would
// pop the app's own entry instead of an already-gone confirm entry.
let confirmPushed = false;

// Same shape as confirmPushed, same double-tap guard: a second tap must
// never push a second history entry or fire a second history.back().
// Whenever both a folder and a confirm entry exist, the confirm's is always
// the top one - onPopState and the three sites that consume confirmPushed
// all depend on that ordering. THE GUARD THAT MAKES IT TRUE IS NOT IN
// openFolderScreen: it is the cancelOpenConfirm() early return at each of
// the two chrome taps that can move between screens - the folder-row branch
// of onProjectTap, and the back-bar listener in wireEvents. A THIRD caller
// of openFolderScreen would have to repeat that guard or the ordering breaks
// silently.
let folderPushed = false;

function openConfirm(name) {
  if (state.confirmName === name) return;
  const first = state.confirmName === null;
  state.confirmName = name;
  if (first) {
    history.pushState({ stopConfirm: true }, '');   // Android back = CANCEL
    confirmPushed = true;
  }
  render();
}

// The { drill: name } payload is load-bearing, not decoration: it is what
// onPopState reads to tell "the folder's entry survived this pop" (a confirm
// on top of it just popped) from "the folder's entry was this pop" (leaving
// the folder). No entry is pushed on a second call for the same name - same
// double-tap guard as openConfirm.
function openFolderScreen(name) {
  if (state.openFolder === name) return;
  state.openFolder = name;
  if (!folderPushed) {
    history.pushState({ drill: name }, '');   // Android back = LEAVE THE FOLDER
    folderPushed = true;
  }
  render();
}

function closeFolderScreen() {
  state.openFolder = null;
  render();
  if (folderPushed) { folderPushed = false; history.back(); }
}

// The way out, once, for every screen. An installed PWA has no address bar
// and no back button, so a screen with no route home is a force-quit.
// ONE history move per tap, never two: confirmPushed goes false the instant a
// guarded history.back() is ISSUED, and stacking two moves in one gesture is
// the race onPopState's comment already documents.
function goHome() {
  // The gate and the warning are gates, not screens you got lost on. #home is
  // disabled on both; this is the second lock, not the only one.
  if (state.screen === 'gate' || state.screen === 'accept') return;
  // Leaving the picker by the mark is a CANCEL, never a save - finishFolders
  // never calls putShared, and it is what SKIP/CANCEL already does.
  if (state.screen === 'folders') { finishFolders(); return; }
  if (state.screen === 'settings') { closeSettings(); return; }
  // On the project list, home means the TOP of the project list. Both of the
  // app's own entries come off in one guarded traversal, the same discipline
  // finishFolders uses: state is mutated and rendered synchronously first, so
  // a double tap finds nothing left to pop.
  const n = (confirmPushed ? 1 : 0) + (folderPushed ? 1 : 0);
  state.confirmName = null;
  state.openFolder = null;
  confirmPushed = false;
  folderPushed = false;
  render();
  if (n > 0) history.go(-n);
}

// Extracted to a named function (rather than the inline arrow it replaces)
// so the four back-gesture cases are independently testable. history.state
// after a pop is the state of the entry the browser landed ON, which is what
// tells the two pushed entries apart - popstate cannot tell which one popped
// from the event alone.
// Two accepted ceilings, neither worth code. FORWARD: back out of a folder
// then press forward and the browser re-enters the {drill} entry, this
// returns early, and the app sits on that entry showing the top-level list -
// the next back press is a dead one. Standalone PWA mode offers no forward
// affordance, which is the daily-use case. RACE: confirmPushed goes false
// the instant a guarded history.back() is ISSUED, not when its popstate
// lands, so a folder-row tap inside that sub-millisecond window pushes under
// a confirm entry that is still on the stack and the traversal bounces the
// owner back out of the folder. Same class of race the single-entry code
// already had, and a second tap recovers.
function onPopState() {
  // Settings' entry is ALWAYS the top one while Settings is on screen:
  // nothing reachable from Settings pushes, openSettings refuses to push
  // under an open confirm, and the picker is entered only after this entry
  // has come off. So a pop landing here is that entry's own pop, and the
  // early return leaves the confirm/drill reconciliation below untouched -
  // including a {drill} entry still sitting underneath, which is why
  // state.openFolder is not cleared here.
  if (state.screen === 'settings') {
    settingsPushed = false;
    showScreen('list');
    render();
    return;
  }
  confirmPushed = false;
  if (state.confirmName !== null) { state.confirmName = null; render(); }
  if (history.state && history.state.drill) return; // the folder's entry survived this pop
  folderPushed = false;
  if (state.openFolder !== null) { state.openFolder = null; render(); }
}

// A synthetic desk-subfolder tile is named by the subfolder's BASENAME -
// registry.js reports a desk view's `project` as path.basename(cwd) - so it
// carries no container prefix and is a SINGLE segment, not the
// '<container>/<child>' form resolveProjectPath also accepts since T68
// (sessions.js). Resolved as a single segment it would point at a top-level
// folder, not the subfolder, so such a tile must END by session_name instead
// (see agent/server.js, the end-session route). Any name that IS a listed
// project - including a root-level desk session - keeps the original
// project-name contract unchanged.
// A '/' means a container child - the two-segment '<container>/<child>' form
// the agent accepts. It resolves to the nested folder and derives the same
// session name desk discovery derives for that folder, so ending by project
// is right for a nested LAUNCHED session and a nested DESK one alike. No
// other name in this app can contain '/': a Windows folder name cannot, and
// a synthetic desk row is named by a basename.
// Known ceiling, still true for synthetic rows only (the nested case above is
// now settled): a subfolder whose basename also happens to name a top-level
// project takes the first branch and ends by project name, which resolves to
// the TOP-LEVEL folder's session. Same display-name collision sessionFor
// documents; the fix for both is to key tiles on path.
function endTargetFor(name) {
  if (name.includes('/') || state.projects.some((p) => p.name === name)) return { project: name };
  const s = (state.sessions || []).find((sess) => sess.source === 'desk' && sess.project === name);
  return { session_name: s ? s.session_name : name };
}

// Reconciled by renderProjects() too: if the session ends server-side while
// a confirm is open, the next render clears confirmName and pops the
// history entry itself, rather than leaving a stale confirm to re-attach to
// a later session.
async function runStop(name) {
  if (state.stopping.has(name)) return;
  state.confirmName = null;
  if (confirmPushed) { confirmPushed = false; history.back(); } // pop the confirm entry; popstate is then a no-op
  state.stopping.add(name);
  state.results.delete(name);
  hideBanner();
  render();

  const res = await endSession(endTargetFor(name));
  state.stopping.delete(name);

  if (res.ok && res.data.result === 'handoff_started') {
    // no banner: the kill gets no toast, the handoff result gets the one line
  } else if (res.ok && res.data.result === 'already_ended') {
    setBanner('info', [{ b: name }, { text: ' had already ended.' }]);
  } else if (res.ok && res.data.result === 'kill_failed') {
    setBanner('error', [{ text: '! Could not end ' }, { b: name }, { text: '. It is still running - close it at the desk.' }]);
  } else if (res.ok) {
    setBanner('info', [{ b: name }, { text: " - the agent accepted the request but reported a result this app doesn't know. Check its terminal window on the PC." }]);
  } else {
    setErrorBanner(res.code, res.status);
  }

  const s = await getSessions();          // never optimistic: the agent decides
  if (s.ok) state.sessions = s.data.sessions;
  reportEnded();
  render();
  watchSessions();
}

function newProjectNameEl() { return document.getElementById('newproj-name'); }

function currentNameTrimmed() {
  // Client-side trim only: the server is the boundary, this is UX so the
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
    // Re-fetch, never optimistic insert: the list is the single source of
    // truth once the agent has confirmed it.
    await load();
    return;
  }

  // Name stays in the field so it can be corrected.
  errorEl.textContent = newProjectErrorCopy(res.code);
  errorEl.hidden = false;
  updateNewProjectTarget();
}

function onNewProject() {
  openNewProjectPanel();
}

// ============================================================================
// The folder picker (T97). One screen, three steps: drive list -> drill-in ->
// checkbox list. Its own state lives here, module-level but off `state` - the
// screen is entirely expressed by `hidden` plus an awaited promise, the same
// way the accept screen is, so no existing test that builds a `state` object
// needs touching.
// ============================================================================

const share = {
  ticks: [],        // [{ path, name, newFolders }] - client-side until SAVE
  path: null,       // the folder being listed, or null = the drive list
  parent: null,     // the agent's own answer for UP; null = the drive list
  rows: [],         // drives, or folders, as returned
  total: 0,
  loading: false,   // a fetch for the current level is in flight - the list
                     // zone draws one dim line and no rows while this is true
  // ponytail: bumped by openDrives/openPath, compared after their await - a
  // response whose token no longer matches share.nav is stale (an older
  // request that lost a race with a newer one) and is dropped rather than
  // repainted. Ceiling: per in-flight request only, never needs a reset.
  nav: 0,
  errorIndex: null, // the row a 400/409 named
  error: null,      // { text, retry } | null - the one banner this screen owns
  busy: false,      // a PUT is in flight
  pushed: 0,        // history entries THIS run pushed
};

function hideFolders() {
  document.getElementById('folders').hidden = true;
}

function shareEls() {
  return {
    up: document.getElementById('share-up'),
    upName: document.getElementById('share-up-name'),
    upPath: document.getElementById('share-up-path'),
    crumb: document.getElementById('share-crumb'),
    msg: document.getElementById('share-msg'),
    pickedZone: document.getElementById('share-picked-zone'),
    pickedCount: document.getElementById('share-picked-count'),
    picked: document.getElementById('share-picked'),
    hideNote: document.getElementById('share-hide-note'),
    listLabel: document.getElementById('share-list-label'),
    listCount: document.getElementById('share-list-count'),
    list: document.getElementById('share-list'),
    save: document.getElementById('share-save'),
    skip: document.getElementById('share-skip'),
  };
}

// Windows join only - every base path here is the agent's own `resolved` or
// `path`, already backslash-formed. A drive root already carries its
// trailing separator (T92's normal form is "F:\"); a deeper folder does not.
function joinShare(base, name) {
  return base.endsWith('\\') ? `${base}${name}` : `${base}\\${name}`;
}

// The NAME of whichever ticked root covers `candidate`, or '' if none - a
// single-element coverageOf call per tick, so this reuses the one segment-
// aware comparison folders-ui.js already exports rather than re-implementing it.
function coveringTickName(ticks, candidate) {
  const hit = ticks.find((t) => coverageOf(candidate, [t.path]) === 'covered');
  return hit ? hit.name : '';
}

// A blocked drive or an unreadable folder: no <button>, no <input>, no
// data-open, no data-tick - structurally unenterable, not merely styled as
// disabled, the same way a project-list folder row carries no data-project.
function buildInertRow(name, status) {
  const row = document.createElement('div');
  row.className = 'share-row share-off';
  const main = document.createElement('span');
  main.className = 'row-main';
  const nameEl = document.createElement('span');
  nameEl.className = 'row-name';
  nameEl.textContent = name;
  main.appendChild(nameEl);
  const statusEl = document.createElement('span');
  statusEl.className = 'row-status';
  statusEl.textContent = status;
  main.appendChild(statusEl);
  row.appendChild(main);
  return row;
}

// A drive or a folder that CAN be ticked/entered: two siblings, never nested
// interactive elements - data-tick / data-open are the whole guarantee.
// tickable defaults true; buildDriveRow passes false for an enterable drive -
// PUT /api/shared rejects every drive root with 400 drive_root, so the
// checkbox stays present (same alignment as a covered row) but disabled
// rather than removed, which is buildInertRow's job.
function buildTickableRow({
  path, name, status, coverage, tickable = true,
}) {
  const row = document.createElement('div');
  row.className = 'share-row';

  const label = document.createElement('label');
  label.className = 'share-tick';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.dataset.tick = path;
  if (coverage === 'ticked') input.checked = true;
  if (coverage === 'covered' || coverage === 'covers' || !tickable) input.disabled = true;
  label.appendChild(input);
  row.appendChild(label);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'share-open';
  btn.dataset.open = path;
  const main = document.createElement('span');
  main.className = 'row-main';
  const nameEl = document.createElement('span');
  nameEl.className = 'row-name';
  nameEl.textContent = name;
  main.appendChild(nameEl);
  if (status) {
    const statusEl = document.createElement('span');
    statusEl.className = 'row-status';
    statusEl.textContent = status;
    main.appendChild(statusEl);
  }
  btn.appendChild(main);
  const chev = document.createElement('span');
  chev.className = 'folder-chev'; // reused wholesale, adds no new rule
  chev.setAttribute('aria-hidden', 'true');
  chev.textContent = '>';
  btn.appendChild(chev);
  row.appendChild(btn);

  return row;
}

function buildDriveRow(drive, ticks) {
  const rowState = driveRowState(drive);
  if (!rowState.enabled) return buildInertRow(drive.label, rowState.note);
  const driveRootPath = `${drive.letter}\\`;
  const coverage = coverageOf(driveRootPath, ticks.map((t) => t.path));
  const status = coverage === 'covered'
    ? `already shared as part of ${coveringTickName(ticks, driveRootPath)}`
    : coverage === 'covers'
      ? 'contains a folder you already picked'
      : `${drive.letter} - pick a folder inside it`;
  return buildTickableRow({
    path: driveRootPath, name: drive.label, status, coverage, tickable: false,
  });
}

function buildFolderRow(folder, basePath, ticks) {
  if (!folder.readable) return buildInertRow(folder.name, 'no permission to open this folder');
  const childPath = joinShare(basePath, folder.name);
  const coverage = coverageOf(childPath, ticks.map((t) => t.path));
  const status = coverage === 'covered'
    ? `already shared as part of ${coveringTickName(ticks, childPath)}`
    : coverage === 'covers'
      ? 'contains a folder you already picked'
      : '';
  return buildTickableRow({
    path: childPath, name: folder.name, status, coverage,
  });
}

function buildPickedRow(tick, index) {
  const row = document.createElement('div');
  row.className = index === share.errorIndex ? 'share-row share-picked-row share-bad' : 'share-row share-picked-row';

  const main = document.createElement('span');
  main.className = 'row-main';
  const name = document.createElement('span');
  name.className = 'row-name';
  name.textContent = tick.name;
  main.appendChild(name);
  const status = document.createElement('span');
  status.className = 'row-status';
  status.textContent = tick.path;
  main.appendChild(status);
  row.appendChild(main);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'share-new';
  toggle.dataset.newfolders = tick.path;
  toggle.textContent = tick.newFolders === 'hide' ? 'NEW FOLDERS: HIDE' : 'NEW FOLDERS: SHOW';
  row.appendChild(toggle);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'share-remove';
  remove.dataset.untick = tick.path;
  remove.setAttribute('aria-label', `Remove ${tick.name}`);
  remove.textContent = '\u00d7';
  row.appendChild(remove);

  return row;
}

// Full rebuild, same posture as render() - no diffing.
function renderShare() {
  const el = shareEls();

  el.crumb.textContent = crumbSegments(share.path).map((s) => s.label).join(' / ');
  if (share.path === null) {
    el.up.hidden = true;
  } else {
    const upSeg = crumbSegments(share.parent).at(-1);
    el.upName.textContent = upSeg.label;
    el.upPath.textContent = upSeg.path || '';
    el.up.hidden = false;
  }

  if (share.error) {
    el.msg.hidden = false;
    el.msg.textContent = `! ${share.error.text}`;
  } else {
    el.msg.hidden = true;
    el.msg.textContent = '';
  }

  el.picked.innerHTML = '';
  el.pickedCount.textContent = String(share.ticks.length);
  el.pickedZone.hidden = share.ticks.length === 0;
  share.ticks.forEach((t, i) => el.picked.appendChild(buildPickedRow(t, i)));
  const anyHide = share.ticks.some((t) => t.newFolders === 'hide');
  el.hideNote.hidden = !anyHide;
  if (anyHide) {
    el.hideNote.textContent = 'HIDE is saved but not enforced yet - a folder added later still appears.';
  }

  el.listLabel.textContent = share.path === null ? 'DRIVES' : 'FOLDERS';
  el.list.innerHTML = '';
  if (share.loading) {
    // The loading branch wins over everything else in the list zone: no
    // rows, no "No folders in here.", no truncation note, count 0. No
    // spinner - tokens.md defines no motion vocabulary, and this reuses the
    // app's existing dim-.msg-line idiom for "nothing to act on yet".
    el.listCount.textContent = '0';
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = share.path === null ? 'Reading the drives on the PC.' : 'Reading that folder on the PC.';
    el.list.appendChild(msg);
  } else if (share.path === null) {
    el.listCount.textContent = String(share.rows.length);
    for (const d of share.rows) el.list.appendChild(buildDriveRow(d, share.ticks));
    // RETRY lives here, not in #share-msg: onShareListClick's delegate is on
    // #share-list, so this is the only subtree a tap on it is ever heard from.
    if (share.error && share.error.retry) {
      const row = document.createElement('div');
      row.className = 'share-row';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'share-new';
      retry.dataset.shareRetry = '1';
      retry.textContent = 'RETRY';
      row.appendChild(retry);
      el.list.appendChild(row);
    }
  } else {
    el.listCount.textContent = String(share.rows.length);
    if (share.rows.length === 0 && !share.error) {
      const msg = document.createElement('div');
      msg.className = 'msg';
      msg.textContent = 'No folders in here.';
      el.list.appendChild(msg);
    }
    // Moved above the row loop (T100): a cap notice printed under 500 rows
    // is not a notice - the owner would have to scroll past all of them to
    // read it.
    const note = truncatedNote(share.total, share.rows.length);
    if (note) {
      const t = document.createElement('div');
      t.className = 'share-note';
      t.textContent = note;
      el.list.appendChild(t);
    }
    for (const f of share.rows) el.list.appendChild(buildFolderRow(f, share.path, share.ticks));
  }

  el.save.disabled = share.ticks.length === 0 || share.busy;
}

// The folder/drive whose name a freshly-ticked path should carry - looked up
// off whatever `share.rows` currently holds, since that is the only place
// the display name exists before SAVE.
function shareNameFor(path) {
  if (share.path === null) {
    const d = share.rows.find((x) => `${x.letter}\\` === path);
    return d ? d.label : path;
  }
  const f = share.rows.find((x) => joinShare(share.path, x.name) === path);
  return f ? f.name : path;
}

function toggleTick(path, checked) {
  share.errorIndex = null;
  if (checked) {
    if (share.ticks.some((t) => t.path === path)) { renderShare(); return; }
    if (share.ticks.length >= MAX_SHARED_ROOTS) {
      // A silent refusal reads as a broken control, not a capped one.
      share.error = { text: shareErrorMessage('too_many_roots', 400, null, share.ticks).text, retry: false };
      renderShare();
      return;
    }
    share.error = null;
    share.ticks.push({ path, name: shareNameFor(path), newFolders: 'show' });
  } else {
    share.error = null;
    share.ticks = share.ticks.filter((t) => t.path !== path);
  }
  renderShare();
}

function toggleNewFolders(path) {
  const t = share.ticks.find((x) => x.path === path);
  if (!t) return;
  t.newFolders = t.newFolders === 'hide' ? 'show' : 'hide';
  renderShare();
}

async function openDrives() {
  const nav = ++share.nav; // ponytail: see share.nav's comment
  share.path = null;
  share.parent = null;
  share.error = null;
  share.rows = [];
  share.total = 0;
  share.loading = true;
  renderShare();
  const res = await getDrives();
  if (nav !== share.nav) return; // a newer nav/openPath already repainted this level
  if (shareAuthLost(res)) { share.loading = false; return; } // onAuthLost owns the recovery
  if (!res.ok || res.data.error) {
    share.loading = false;
    share.rows = [];
    share.error = { text: 'Could not read your drives.', retry: true };
    renderShare();
    return;
  }
  share.loading = false;
  share.rows = res.data.drives;
  renderShare();
}

// push:true is a real drill-in (a tap on a row); push:false is a popstate or
// a retry replaying the same level without touching history.
async function openPath(p, opts = {}) {
  const push = opts.push !== false;
  const nav = ++share.nav; // ponytail: see share.nav's comment
  share.loading = true;
  renderShare();
  const res = await getFolders(p);
  if (nav !== share.nav) return; // a newer nav/openDrives already repainted this level
  if (shareAuthLost(res)) { share.loading = false; return; } // onAuthLost owns the recovery
  if (!res.ok) {
    // A failed drill-in returns the owner to the level he was on - share.rows
    // and share.path are deliberately left untouched.
    share.loading = false;
    share.error = { text: shareErrorMessage(res.code, res.status, null, share.ticks).text, retry: false };
    renderShare();
    return;
  }
  share.loading = false;
  share.path = res.data.path;
  share.parent = res.data.parent;
  share.rows = res.data.folders;
  share.total = res.data.total;
  share.error = null;
  if (push) {
    history.pushState({ folders: p }, '');
    share.pushed += 1;
  }
  renderShare();
}

// api.js has already re-locked and onAuthLost will bring this screen back and
// reload the level, so painting a refusal here would only leave a stale,
// unactionable message behind the passcode gate.
function shareAuthLost(res) { return !res.ok && res.status === 401; }

// The current level, re-fetched. RETRY and the post-401 re-entry are the same
// action: whatever level the screen is showing was never loaded.
function reloadShareLevel() {
  if (share.path === null) openDrives();
  else openPath(share.path, { push: false });
}

// history.state after a pop is the state of the entry the browser landed ON -
// same technique onPopState uses for the project list's two entry kinds.
function onFoldersPop() {
  share.pushed = Math.max(0, share.pushed - 1);
  const st = history.state;
  if (st && typeof st.folders === 'string') { openPath(st.folders, { push: false }); return; }
  openDrives();
}

let resolveFolders = null;

function finishFolders() {
  const els = shareEls();
  els.list.removeEventListener('change', onShareListChange);
  els.list.removeEventListener('click', onShareListClick);
  els.picked.removeEventListener('click', onSharePickedClick);
  els.up.removeEventListener('click', onShareUpClick);
  els.save.removeEventListener('click', onSave);
  els.skip.removeEventListener('click', onSkipClick);
  window.removeEventListener('popstate', onFoldersPop);
  // Same double-tap discipline as cancelOpenConfirm: never more than one go().
  if (share.pushed > 0) {
    const n = share.pushed;
    share.pushed = 0;
    history.go(-n);
  }
  hideFolders();
  const resolve = resolveFolders;
  resolveFolders = null;
  // Nulled HERE, synchronously with the rest of the teardown - not in a
  // .finally on the pendingFolders promise. ensureAccepted's re-entrancy
  // condition reads pendingFolders as "a run is live", so exactly one place
  // may own its lifetime.
  pendingFolders = null;
  if (resolve) resolve();
}

async function onSave() {
  if (share.busy) return;
  share.error = null;
  share.errorIndex = null;
  share.busy = true;
  shareEls().save.disabled = true;
  const res = await putShared(sharedBody(share.ticks));
  if (shareAuthLost(res)) { share.busy = false; return; } // onAuthLost owns the recovery
  const result = applySaveResult(share, res);
  share.busy = false;
  if (result.done) {
    finishFolders();
    return;
  }
  // A failed SAVE never clears the tick set - result.ticks is share.ticks,
  // untouched. Only the mark and the message change.
  share.errorIndex = result.errorIndex;
  share.error = { text: result.message, retry: false };
  renderShare();
}

// SKIP is finishFolders() and nothing else - it must not call putShared. Same
// guard as onSave: let an in-flight SAVE finish and tear the screen down
// itself, rather than racing it.
function onSkipClick() {
  if (share.busy) return;
  finishFolders();
}

function onShareListChange(e) {
  const box = e.target.closest('[data-tick]');
  if (box) toggleTick(box.dataset.tick, box.checked);
}

function onShareListClick(e) {
  const retry = e.target.closest('[data-share-retry]');
  if (retry) { reloadShareLevel(); return; }
  const open = e.target.closest('[data-open]');
  if (open) openPath(open.dataset.open, { push: true });
}

function onSharePickedClick(e) {
  const untick = e.target.closest('[data-untick]');
  if (untick) { toggleTick(untick.dataset.untick, false); return; }
  const nf = e.target.closest('[data-newfolders]');
  if (nf) toggleNewFolders(nf.dataset.newfolders);
}

// Guarded the same way cancelOpenConfirm/closeFolderScreen guard their own
// history.back() - #share-up is hidden at the drive list, where pushed is 0.
function onShareUpClick() {
  if (share.pushed > 0) history.back();
}

/**
 * Reached only on first run, from ensureAccepted() below, AFTER the accept
 * screen resolves. Same shape as showAccept(): put the screen up, resolve on
 * a successful SAVE, remove every listener on the way out. Re-entrant on
 * purpose (the `pendingFolders` guard) - api.js re-locks on a 401,
 * onAuthLost re-runs ensureAccepted, and a second run would otherwise stack a
 * second set of closures over the same nodes, the exact hazard lock.js's
 * `pending` guard exists for. The reveal runs on EVERY call so the screen the
 * gate hid comes back; the tick set survives because the in-flight run keeps
 * owning it.
 */
let pendingFolders = null;

function showFolders(initial) {
  showScreen('folders');
  document.getElementById('folders').hidden = false;
  // The fetch that 401'd is why the current level is empty - revealing it
  // with no error and no RETRY would be the same dead end in a different
  // costume, so a re-entrant call reloads before handing back the same promise.
  if (pendingFolders) { reloadShareLevel(); return pendingFolders; }

  // mode/excludes are carried through ONLY when the caller supplied them
  // (T100's onChooseFolders, via sharedToTicks) - a tick made by ticking a
  // row in this screen never has them, and that shape must stay exactly
  // 3 keys for sharedBody's own defaulting to apply.
  share.ticks = (initial || []).map((t) => {
    const tick = { path: t.path, name: t.name, newFolders: t.newFolders === 'hide' ? 'hide' : 'show' };
    if (t.mode !== undefined) tick.mode = t.mode;
    if (t.excludes !== undefined) tick.excludes = t.excludes;
    return tick;
  });
  share.path = null;
  share.parent = null;
  share.rows = [];
  share.total = 0;
  share.errorIndex = null;
  share.error = null;
  share.busy = false;
  share.pushed = 0;

  const els = shareEls();
  // Entering with nothing shared is a skip; entering from state 4 with roots
  // already shared is a cancel - calling that "skip" would read as "skip my
  // existing folders".
  els.skip.textContent = (initial || []).length === 0 ? PICKER_SKIP : PICKER_CANCEL;
  els.list.addEventListener('change', onShareListChange);
  els.list.addEventListener('click', onShareListClick);
  els.picked.addEventListener('click', onSharePickedClick);
  els.up.addEventListener('click', onShareUpClick);
  els.save.addEventListener('click', onSave);
  els.skip.addEventListener('click', onSkipClick);
  window.addEventListener('popstate', onFoldersPop);

  pendingFolders = new Promise((resolve) => {
    resolveFolders = resolve;
  });

  openDrives();

  return pendingFolders;
}

// ============================================================================
// Settings root (T77). One screen: a group heading, a list of navigation
// rows, and nowhere else to go but the home control in the shared header.
// ============================================================================

// Same shape as confirmPushed/folderPushed: true exactly while Settings'
// history entry is on the stack and this session is the one that pushed it.
let settingsPushed = false;

// The third caller of the history-push pattern folderPushed's comment
// documents: cancelOpenConfirm() must run FIRST, or Settings' entry could
// land above a live confirm entry and break "the confirm's entry is always
// the top one".
function openSettings() {
  if (cancelOpenConfirm()) return;
  showScreen('settings');
  renderSettings();
  if (!settingsPushed) {
    history.pushState({ screen: 'settings' }, '');   // Android back = leave Settings
    settingsPushed = true;
  }
}

// Same double-tap discipline as closeFolderScreen: mutate/reveal
// synchronously, then a guarded history.back(), so a double tap can never pop
// the app's own base entry and close the PWA.
function closeSettings() {
  showScreen('list');
  render();
  if (settingsPushed) { settingsPushed = false; history.back(); }
}

// One picker, two doors, ONE implementation of the door.
// THE ORDER IS LOAD-BEARING, but not for the reason it first looks. Swapped,
// closeSettings()'s showScreen('list') would run AFTER showScreen('folders')
// and hide the picker outright the moment it opened.
// What it does NOT do is keep Settings' entry away from onFoldersPop:
// history.back() is queued, not synchronous, so the picker registers
// onFoldersPop in the same task and that listener DOES receive Settings' pop.
// It is harmless only because share.pushed is clamped at 0 at the drive list,
// so the pop costs one redundant GET /api/drives and nothing else.
// T78 KEPT THIS BODY. There is no separate Shared Folders screen - the row
// goes straight into the picker, whose SELECTED zone already shows what is
// shared. onChooseFolders stays the ONLY way in, so a second door cannot
// route around the unknown-set guard. Do not reorder these two calls and do
// not add a third call into showFolders.
function openSharedFolders() {
  closeSettings();
  onChooseFolders();
}

// A settings row IS a folder row: empty left slot, name and state stacked in
// the middle, chevron on the right. The empty left slot is deliberate - see
// buildRow's comment on why a folder row appends no dot, and never fix the
// alignment with padding.
// `enterable === false` means the row carries NO data-settings attribute at
// all: structurally untappable, the same guarantee buildInertRow gives a
// blocked drive and buildRow gives a container (no data-project, so it can
// never launch). A disabled-looking row that still answers a tap is what this
// avoids.
function buildSettingsRow({
  id, name, state: stateText, enterable,
}) {
  const el = document.createElement(enterable ? 'button' : 'div');
  el.className = 'row folder';
  if (enterable) {
    el.type = 'button';
    el.dataset.settings = id;
  }
  el.setAttribute('aria-label', `${name}, ${stateText}`);

  const main = document.createElement('span');
  main.className = 'row-main';
  const nameEl = document.createElement('span');
  nameEl.className = 'row-name';
  nameEl.textContent = name;
  main.appendChild(nameEl);
  const statusEl = document.createElement('span');
  statusEl.className = 'row-status';
  statusEl.textContent = stateText;
  main.appendChild(statusEl);
  el.appendChild(main);

  // The chevron is the promise that this row goes somewhere. A row that
  // cannot be entered must not make it - `shared === null` is the DAILY case
  // here (a sleeping PC, a dropped link), not a rare one, so a bright name
  // and an accent chevron over a row that ignores the tap is a dead control
  // someone meets often. `.share-off` sets the same precedent: an inert row
  // mutes its name and draws no chevron.
  if (enterable) {
    const chev = document.createElement('span');
    chev.className = 'folder-chev';
    chev.setAttribute('aria-hidden', 'true'); // the aria-label already says it
    chev.textContent = '>';
    el.appendChild(chev);
  } else {
    el.className += ' set-off';
  }

  return el;
}

function renderSettings() {
  const listEl = document.getElementById('settings-list');
  listEl.innerHTML = '';
  const shared = sharedRowState(state.shared);
  listEl.appendChild(buildSettingsRow({
    id: 'shared', name: 'Shared folders', state: shared.text, enterable: shared.enterable,
  }));
}

/**
 * Which screen follows the passcode gate, from GET /api/acknowledge's result.
 * Pure, so it is unit-testable in a runtime with no DOM.
 * NEVER fails open: anything other than an explicit `true` - a network
 * failure, a timeout, a body this app does not understand - shows the accept
 * screen. Showing a warning twice costs a tap; skipping it once is the whole
 * failure this screen exists to prevent. It also matches the copy's own rule
 * ("shown when that field is absent"): an unknown state is not "present".
 */
function screenAfterUnlock(res) {
  return res.ok && res.data.acknowledged === true ? 'list' : 'accept';
}

/**
 * Runs between the gate and the project list. lock.js un-hides #picker on
 * unlock and knows nothing about this screen, so the picker is put away again
 * HERE, synchronously - no paint happens between a promise resolving and its
 * continuation, so the project list can never flash ahead of a warning the
 * owner has not read. The window while the check is in flight shows the app
 * header and nothing under it, which is a normal one-round-trip state and not
 * the blank-before-any-script case #splash exists for.
 */
async function ensureAccepted() {
  const picker = document.getElementById('picker');
  picker.hidden = true;
  const res = await getAcknowledged();
  // 401 means api.js has already re-locked and onAuthLost will re-run this
  // whole function after the next unlock. Returning here - without revealing
  // the picker and without opening the accept screen - is what stops two
  // screens racing onto the page at once.
  if (!res.ok && res.status === 401) return;
  // Stashed here too (load() also does this) so the very first render after
  // unlock is not "unknown" - ensureAccepted has already fetched this exact
  // answer, and waiting for the first load() would draw one wrong frame.
  state.shared = res.ok && Array.isArray(res.data.shared_folders) ? res.data.shared_folders : null;
  // Pinned verbatim by the suite - see the comment above it. The picker call
  // below reads the same pure answer rather than restructuring this line.
  const firstRun = screenAfterUnlock(res) === 'accept';
  // THIS LINE IS THE ACKNOWLEDGEMENT GATE. Do not replace it, and do not make
  // it conditional on anything else - without it the warning screen is never
  // shown and no test fails, because the suite checks what showAccept() does,
  // not that boot still calls it.
  if (screenAfterUnlock(res) === 'accept') await showAccept();
  // showAccept() resolves only once the agent has confirmed the write, so
  // reaching here on a first run means the warning was read and accepted, and
  // nothing is shared yet. The folder picker is the next screen, not the
  // project list - an empty list with no way to fill it is not a screen.
  // A 401 mid-picker re-runs this function after the re-unlock, and by then
  // firstRun is false - the acknowledgement was written before the picker ever
  // opened. Without `|| pendingFolders` the screen is never brought back and
  // the promise the first run is awaiting never resolves.
  if (firstRun || pendingFolders) await showFolders(share.ticks);
  picker.hidden = false;
  showScreen('list');
}

/**
 * The accept screen. Resolves ONLY once the agent has confirmed the write -
 * there is no skip, no cancel and no dismiss on this screen (skipping is
 * offered later, from the empty project list, T100). Same shape as
 * lock.js's showGate(): put the screen up, resolve on success, and remove
 * every listener on the way out so a second run cannot stack a duplicate
 * closure over the same nodes.
 */
function showAccept() {
  showScreen('accept');
  const el = {
    accept: document.getElementById('accept'),
    title: document.getElementById('accept-title'),
    lede1: document.getElementById('accept-lede-1'),
    lede2: document.getElementById('accept-lede-2'),
    sections: document.getElementById('accept-sections'),
    more: document.getElementById('accept-more'),
    summary: document.getElementById('accept-more-sum'),
    consent: document.getElementById('accept-consent'),
    consentText: document.getElementById('accept-consent-text'),
    note: document.getElementById('accept-note'),
    go: document.getElementById('accept-go'),
    check: document.getElementById('accept-check'),
    msg: document.getElementById('accept-msg'),
  };

  el.title.textContent = TITLE;
  el.lede1.textContent = LEDE[0];
  el.lede2.textContent = LEDE[1];
  renderSections(el.sections);
  el.summary.textContent = SECTIONS_TOGGLE;
  el.consentText.textContent = CONSENT_LABEL;
  el.note.textContent = SETTINGS_NOTE;
  el.go.textContent = ACCEPT_BUTTON;
  el.accept.hidden = false;
  // Derived from the DOM, never stored: on the one path that re-enters this
  // screen (an auth loss mid-warning) the <details> is still on the page with
  // whatever the owner left it as, and re-locking a checkbox he has already
  // earned would be a regression.
  el.check.disabled = !el.more.open;

  return new Promise((resolve) => {
    let inFlight = false;

    function onCheck() {
      el.go.disabled = !el.check.checked;
    }

    // The sections are one tap away now, so the tick is gated on that tap
    // having happened: "I understand what this can see" must not be claimable
    // about words that were never on screen. Opening is not reading, but it is
    // the difference between a warning and a formality.
    function onToggle() {
      if (el.more.open) el.check.disabled = false;
    }

    // A disabled checkbox under a label is a dead control, and a dead control
    // is the UX complaint this task exists to answer. Tapping the consent row
    // before the sections have been shown does the thing the label describes:
    // it shows them. The second tap ticks. Once the box is live this handler
    // does nothing and the native label behaviour takes over.
    function onConsentTap() {
      if (el.check.disabled) el.more.open = true;
    }

    async function onClick() {
      // A double tap on a phone is ordinary - lock.js's onSubmit has the same
      // guard and the same reason.
      if (inFlight) return;
      inFlight = true;
      el.go.disabled = true;

      const res = await acknowledge();

      if (res.ok) {
        el.accept.hidden = true;
        el.msg.hidden = true;
        el.msg.textContent = '';
        el.check.removeEventListener('change', onCheck);
        el.go.removeEventListener('click', onClick);
        el.more.removeEventListener('toggle', onToggle);
        el.consent.removeEventListener('click', onConsentTap);
        resolve();
        return;
      }

      el.msg.textContent = errorCopy(res.code, res.status);
      el.msg.hidden = false;
      inFlight = false;
      el.go.disabled = false; // the box is still ticked, so the button is the retry
    }

    el.check.addEventListener('change', onCheck);
    el.go.addEventListener('click', onClick);
    el.more.addEventListener('toggle', onToggle);
    el.consent.addEventListener('click', onConsentTap);
  });
}

function wireEvents() {
  document.getElementById('projects').addEventListener('click', onProjectTap);
  document.getElementById('tiles').addEventListener('click', onTileTap);
  document.getElementById('newproj').addEventListener('click', onNewProject);
  document.getElementById('refresh').addEventListener('click', () => load());
  document.getElementById('newproj-cancel').addEventListener('click', closeNewProjectPanel);
  document.getElementById('newproj-create').addEventListener('click', onCreateProject);
  newProjectNameEl().addEventListener('input', updateNewProjectTarget);
  document.getElementById('backbar').addEventListener('click', () => {
    if (cancelOpenConfirm()) return;
    closeFolderScreen();
  });
  document.getElementById('home').addEventListener('click', goHome);
  document.getElementById('settings-open').addEventListener('click', openSettings);
  document.getElementById('settings-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-settings]');
    if (row && row.dataset.settings === 'shared') openSharedFolders();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') load();
  });
  window.addEventListener('popstate', onPopState);
}

function registerServiceWorker() {
  // .catch(() => {}) is load-bearing: over plain HTTP on a Tailscale IP the
  // origin is not a secure context, registration throws, and the app must
  // carry on working with no cache at all.
  if (!('serviceWorker' in navigator)) return;

  // A shipped change used to take TWO launches to appear: the page painted
  // from the old cache while the new worker installed behind it, so the
  // owner opened the app, saw yesterday's build, and reasonably concluded
  // nothing had shipped. sw.js calls skipWaiting() and clients.claim(), so a
  // new worker takes over THIS page a moment after it loads - controllerchange
  // is that moment. Reloading there collapses the two launches into one.
  //
  // `refreshing` guards the reload loop, and the initial-controller check is
  // the other half of it: on the very first visit there is no controller, and
  // claim() fires controllerchange for that too. Reloading THEN would be a
  // reload on every first run, for no new content at all.
  let refreshing = false;
  const hadController = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing || !hadController) return;
    refreshing = true;
    location.reload();
  });

  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
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
  registerServiceWorker(); // above the gate: the PWA must stay installable
                            // from the lock screen
  // hideAccept() is not decoration: if the token expires while the accept
  // screen is up, showGate() un-hides #gate but nothing else hides #accept,
  // and two <main>s render stacked. ensureAccepted() after the re-unlock
  // brings the screen back if it was never accepted - and returns
  // immediately, one round trip, if it was.
  // hideConn/hideAccept/hideFolders are now redundant with showScreen('gate'),
  // which also hides #settings - a screen this callback never named - but
  // three tests pin the three hides verbatim, so they stay, in this order,
  // before it.
  onAuthLost(async () => { hideConn(); hideAccept(); hideFolders(); showScreen('gate'); await showGate(); await ensureAccepted(); await load(); });
  // showGate() puts the passcode screen on the page before it awaits
  // anything, but does not resolve until the owner has unlocked. Drop the
  // splash against the first of those, not the second, or it would sit on
  // top of the passcode screen for as long as the owner takes to type.
  showScreen('gate');
  const unlocked = showGate();
  hideSplash();
  await unlocked;
  await ensureAccepted();
  wireEvents();
  render();
  await load();
}

boot().finally(hideSplash);
