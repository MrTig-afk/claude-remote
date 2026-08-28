import { getProjects, getSessions, launchSession, endSession, dismissEnded, createProject, onAuthLost } from './api.js';
import { showGate } from './lock.js';

// Single module-level state. 15 rows today - full rebuild on every render(),
// no diffing, no framework, no template engine.
const state = {
  projects: [], // from /api/projects
  sessions: null, // array, or null = unknown (fetch failed / 404)
  launching: new Set(), // project names with a POST in flight
  results: new Map(), // name -> { kind:'started'|'reused'|'error', session?, code? }
  reachable: null, // null = not tried yet, true, false
  stopping: new Set(), // project names with an end POST in flight - CLIENT ONLY
  confirmName: null, // the ONE project whose tile is currently the question
  openFolder: null, // the open container's NAME, or null = the top-level list.
  // Held by NAME, never as an object reference, so a state.projects reload
  // cannot leave a stale folder on screen. Set by openFolderScreen(name) only;
  // cleared by closeFolderScreen(), the popstate handler, and renderProjects
  // when the name no longer resolves to a container.
};

// Ended records announced this open. Announcing also dismisses at the agent,
// so a record shows once; the 24h retention is the never-opened fallback.
const reported = new Set();

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
  // A desk session opened IN the container's own root folder is invisible
  // from here - this returns before sessionFor, and renderProjects'
  // synthetic-row loop skips it because the container's path IS a listed
  // project. That is the settled design (a container is not startable, so
  // it reports no session as a row of its own); the drill-in screen's self
  // row (buildSelfRow) reports such a session read-only when the folder is
  // open.
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
  const name = document.createElement('span');
  name.className = 'tile-name';
  name.textContent = p.label || p.name;
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
      dropCoveredResults();
      render();
      clearSettledLaunchBanner();
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

function renderConn() {
  const conn = document.getElementById('conn');
  const dot = conn.querySelector('.dot');
  const text = conn.querySelector('.conn-text');

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
  renderBackBar(open);

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

  if (state.reachable === false) {
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = 'Cannot reach the agent.';
    listEl.appendChild(msg);
  } else if (open && (open.children || []).length === 0) {
    // a marked container can legitimately hold no project folders
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = 'This folder has no projects in it.';
    listEl.appendChild(msg);
  } else if (state.projects.length === 0) {
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = "No project folders found. Check the agent's base folder on the PC.";
    listEl.appendChild(msg);
  } else {
    for (const { p, rs } of list) listEl.appendChild(buildRow(p, rs));
  }
  if (open) listEl.appendChild(buildSelfRow(open));

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
  // Inside a folder every STARTABLE row is a child, so the rows ARE the count
  // - `rows` is already scoped to the open folder by renderProjects, and the
  // dimmed self row is on screen but is not in `rows` because the folder
  // itself cannot be started. `running` below needs no such override:
  // it is already computed from `rows`.
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

// The container's own folder, drawn dimmed below its children. Not part of
// `rows`: it is never counted, never becomes a tile, never focused and never
// reconciled. It exists because the owner asked to keep the folder itself
// visible; it is the only place a desk session in the container's own root
// can appear at all, because rowState short-circuits a container before
// sessionFor and the synthetic-row loop in renderProjects skips that path
// since it IS a listed project. Ceiling: it is reported, not endable - a
// list row carries no STOP control, so that session is ended at the desk.
// Upgrade path: the agent already accepts { project: '<container name>' }
// for it, so all that is missing is a control.
function buildSelfRow(open) {
  const el = document.createElement('div');
  el.className = 'row self';
  const main = document.createElement('span');
  main.className = 'row-main';
  const nameEl = document.createElement('span');
  nameEl.className = 'row-name';
  nameEl.textContent = open.name;
  main.appendChild(nameEl);
  const s = sessionFor({ name: open.name, path: open.path });
  const rs = s && s.status === 'running'
    ? { status: `the folder itself - ${s.activity || 'active session'}`,
        idle: elapsed(s.started_at),
        ...(s.source === 'desk' ? { suffix: 'desktop' } : {}) }
    : { status: 'the folder itself - not a project', idle: '—' };
  const statusEl = document.createElement('span');
  statusEl.className = 'row-status';
  statusEl.textContent = statusLine(rs);
  main.appendChild(statusEl);
  el.appendChild(main);
  return el;
}

// open = the resolved container entry (from renderProjects), or null.
function renderBackBar(open) {
  document.getElementById('backbar').hidden = open === null;
  // The + creates a TOP-LEVEL project only - the agent's create route is one
  // level deep, which is what the "No \ or / - projects are created directly
  // in Repos" copy already says - so inside a folder it has nothing true to
  // offer.
  document.getElementById('newproj').hidden = open !== null;
  if (open === null) return;
  document.getElementById('backbar-name').textContent = open.name;
  document.getElementById('backbar-path').textContent = open.path;
  document.getElementById('backbar').setAttribute('aria-label', `Back to all projects. Inside ${open.name}.`);
  closeNewProjectPanel(); // a top-level create form must not sit on the folder screen
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
  reportEnded();

  render();
  if (state.reachable) maybeFailedBanner();
  confirmStarting();
  watchSessions();
}

async function onProjectTap(e) {
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
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') load();
  });
  window.addEventListener('popstate', onPopState);
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
  registerServiceWorker(); // above the gate: the PWA must stay installable
                            // from the lock screen
  onAuthLost(async () => { hideConn(); await showGate(); await load(); });
  // showGate() puts the passcode screen on the page before it awaits
  // anything, but does not resolve until the owner has unlocked. Drop the
  // splash against the first of those, not the second, or it would sit on
  // top of the passcode screen for as long as the owner takes to type.
  const unlocked = showGate();
  hideSplash();
  await unlocked;
  wireEvents();
  render();
  await load();
}

boot().finally(hideSplash);
