// The ONLY module in the app that calls fetch(). T33 adds the passcode
// header on the one line marked below, and every request carries it.
const AUTH_HEADERS = {}; // T33: { 'X-Claude-Remote-Passcode': ... }
const TIMEOUT_MS = 10_000;

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
        ...AUTH_HEADERS,
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
  return { ok: false, status: res.status, code: typeof data.error === 'string' ? data.error : 'http' };
}

export function getProjects() {
  return request('/api/projects');
}

export function getSessions() {
  return request('/api/sessions');
}

export function launchSession(projectName) {
  return request('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: projectName }),
  });
}

export function createProject(name) {
  return request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}
