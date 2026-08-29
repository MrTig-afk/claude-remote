// The ONLY module in the app that calls fetch(). The unlock token lives only
// in this module-level variable, deliberately not in any browser persistence
// layer, cookie, or on-device database - so a reload or relaunch loses it and
// the lock screen returns. Nothing is written to the phone's disk, so a
// stolen device yields no credential at rest.
let token = null;
let authLost = null;
const TIMEOUT_MS = 10_000;

export function setToken(t) { token = t; }
export function clearToken() { token = null; }
export function onAuthLost(cb) { authLost = cb; }

/**
 * @returns {{ok:true, status:number, data:object}
 *          |{ok:false, status:number|0, code:string}}
 * Never throws. `code` is one of: the server's own `error` string,
 * 'network', 'timeout', 'bad_response', 'http'.
 */
async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(token ? { 'X-Claude-Remote-Token': token } : {}),
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, status: 0, code: err.name === 'TimeoutError' ? 'timeout' : 'network' };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, status: res.status, code: 'bad_response' };
  }

  // A body that parses to a non-object (null, a bare number/string/bool)
  // has no .error to read below, and callers of the ok:true path index
  // into .data (e.g. data.projects) - both need an object shape.
  if (!data || typeof data !== 'object') {
    return { ok: false, status: res.status, code: 'bad_response' };
  }

  if (res.ok) {
    return { ok: true, status: res.status, data };
  }

  // One place, so every current AND future caller re-locks without its own
  // 401 branch. /api/auth/* is excluded: a wrong passcode there is not a
  // lost session, it's the lock screen's own business.
  if (res.status === 401 && !path.startsWith('/api/auth/') && authLost) {
    clearToken();
    authLost();
  }

  return { ok: false, status: res.status, code: typeof data.error === 'string' ? data.error : 'http', data };
}

function post(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function getProjects() {
  return request('/api/projects');
}

export function getAcknowledged() {
  return request('/api/acknowledge');
}

// Empty body by contract - the server reads nothing from it. `{}` rather than
// no body at all so this can go through the same post() helper as every other
// write in this file.
export function acknowledge() {
  return post('/api/acknowledge', {});
}

export function getSessions() {
  return request('/api/sessions');
}

export function launchSession(projectName) {
  return post('/api/sessions', { project: projectName });
}

// target is { project } for a launched session or a root-level desk session,
// or { session_name } for a desk session in a project subfolder (it has no
// project name the server would accept - see server.js).
export function endSession(target) {
  return post('/api/sessions/end', target);
}

export function dismissEnded(sessionName) {
  return post('/api/sessions/dismiss', { session_name: sessionName });
}

export function createProject(name) {
  return post('/api/projects', { name });
}

export function getAuthStatus() {
  return request('/api/auth/status');
}

export function setPasscode(pc, confirm) {
  return post('/api/auth/passcode', { passcode: pc, confirm });
}

export function unlock(pc) {
  return post('/api/auth/unlock', { passcode: pc });
}
