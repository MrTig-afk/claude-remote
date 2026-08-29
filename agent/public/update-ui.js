// Pure shell module for Lane 5 (updates). No DOM access anywhere - not at
// module scope, not inside a function - so `node --test` imports it directly,
// the same way it imports folders-ui.js and copy.js. app.js is the only place
// any of this touches the page.

/**
 * Is there an update waiting?
 *
 * The Decided table is exact about what this means: "the phone's cached shell
 * is older than the agent. Detected LOCALLY, no network. The app NEVER polls
 * GitHub for versions." So the whole comparison is between two facts the app
 * already holds - SHELL_VERSION, baked into whatever copy of app.js this
 * phone has cached, and the version the agent reported on GET /api/status.
 * Nothing here fetches anything.
 *
 * FALSE whenever the answer is not known: no status yet, a body this app does
 * not understand, or a version string that is not a string. A dot claiming an
 * update that does not exist sends someone to a screen with nothing on it;
 * showing no dot for one round trip costs nothing.
 *
 * Deliberately `!==` and not a semver comparison. The agent is the only thing
 * that serves this app, so "different" and "newer" are the same event here,
 * and a version parser would be code that can be wrong about a string this
 * app already controls. It also means a DOWNGRADE on the PC correctly shows
 * as an update: the phone's cached shell still does not match what is being
 * served, which is the thing the owner has to fix.
 */
export function updateAvailable(shellVersion, status) {
  if (status === null || status === undefined) return false;
  if (typeof status.version !== 'string' || status.version === '') return false;
  if (typeof shellVersion !== 'string' || shellVersion === '') return false;
  return status.version !== shellVersion;
}

/**
 * The release entry the agent serves, or null. Same fail-quiet rule as
 * updateAvailable: a malformed entry is no entry, never a half-drawn screen.
 */
export function releaseOf(status) {
  const r = status && status.release;
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return null;
  if (typeof r.version !== 'string' || r.version === '') return null;
  if (!Array.isArray(r.notes) || r.notes.length === 0) return null;
  return r;
}

/**
 * One line per note, as the artifact's "What changed" list draws them:
 * a '+' in the accent colour for something added, a '~' in the warning
 * colour for something changed.
 *
 * release-notes.json holds plain strings, so the mark is opted into by
 * PREFIXING the note with '+ ' or '~ ' when it is written. The prefix is
 * stripped from the text - it is a mark, not words.
 *
 * An unmarked note is '+'. Not a guess dressed as a default: the file is
 * hand-written per release (Decided), every note in it today describes
 * something the release adds, and '+' is the honest reading of an unmarked
 * entry in a list of what is new. A writer who means "changed" types '~ '.
 *
 * -> [{ mark: '+'|'~', text }]
 */
export function releaseLines(notes) {
  return (notes || [])
    .filter((n) => typeof n === 'string' && n.trim() !== '')
    .map((n) => {
      const m = /^([+~])\s+(.*)$/s.exec(n.trim());
      if (m) return { mark: m[1], text: m[2].trim() };
      return { mark: '+', text: n.trim() };
    });
}

/**
 * The one sentence at the top of the update screen: "Version 1.1 is ready.
 * You are on 1.0.0." Pure so the wording is pinned without a DOM.
 */
export function readyLine(release, shellVersion) {
  return `Version ${release.version} is ready. You are on ${shellVersion}.`;
}

/**
 * The About row's sub-line. The artifact writes it in the accent colour as
 * "version 1.1 available"; with nothing waiting the row just carries the
 * version this phone is running.
 */
export function aboutRowState(shellVersion, status) {
  if (!updateAvailable(shellVersion, status)) return { text: shellVersion, update: false };
  return { text: `version ${status.version} available`, update: true };
}
