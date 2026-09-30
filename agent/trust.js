// Claude Code's workspace-trust answer for a folder, set by the agent.
//
// A launch into a folder that profile has never opened stops on Claude Code's
// "Is this a project you created or one you trust?" modal, which needs a real
// terminal. From the phone nobody can answer it, so the session never joins
// Remote Control and the tile ages into "hasn't confirmed it started". Found
// on the Dell install test, 2026-09-27; the owner chose to have the app answer
// it for shared folders ("go with C"), at the moment a session starts in one
// (owner, 2026-09-27). The accept screen and the README say so.
//
// It writes the same field the real dialog writes -
// projects["<path with forward slashes>"].hasTrustDialogAccepted = true - in
// the profile's .claude.json: the home directory one by default, the one
// inside CLAUDE_CONFIG_DIR when claude_config_dir is configured. That file and
// key format are what the owner's trust-new-projects.py hook has written on
// this machine since 2026-08-24, and what Claude Code itself wrote on the Dell.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function claudeStatePath(configDir) {
  return path.join(configDir || os.homedir(), '.claude.json');
}

const ATTEMPTS = 3;

/**
 * Marks `folder` trusted. Returns true when it is trusted afterwards, false
 * when it could not be done - never throws, because a launch must not fail
 * over this: the worst case is the modal the owner already had.
 *
 * NEVER creates the file and NEVER rewrites one it cannot parse: it belongs to
 * Claude Code, and a missing one means that profile has never run, so there is
 * no login for a session to use anyway.
 */
export function trustFolder(folder, configDir) {
  // The real file, so a symlinked .claude.json (dotfiles, a synced profile)
  // is written through rather than replaced by the rename below.
  let file;
  try {
    file = fs.realpathSync(claudeStatePath(configDir));
  } catch {
    return false;
  }
  // EXACT key, never a case-insensitive match: Claude Code looks the folder up
  // by its own cwd string, so trust set on a differently-cased key it never
  // reads would leave the modal up while this returned true on every later
  // launch. A stray second key is harmless; a wrong one is not.
  const key = folder.replace(/\\/g, '/');

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (attempt > 0) pause(25);
    let before;
    let state;
    try {
      before = fs.statSync(file).mtimeMs;
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return false;
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
    if (state.projects === undefined) state.projects = {};
    if (!state.projects || typeof state.projects !== 'object' || Array.isArray(state.projects)) return false;
    const entry = state.projects[key];
    if (entry && typeof entry === 'object' && entry.hasTrustDialogAccepted === true) return true;
    if (entry !== undefined && (!entry || typeof entry !== 'object' || Array.isArray(entry))) return false;
    state.projects[key] = { ...(entry || {}), hasTrustDialogAccepted: true };

    const tmp = `${file}.claude-remote-tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      // Running Claude sessions rewrite this file often. If one did
      // since the read, renaming now would throw its write away: drop ours
      // and merge again on the fresh copy instead.
      // Known limit: stat-compare, not a lock, and it only protects THEIR write.
      // Two windows stay open: a write landing between this check and the
      // rename is lost, and a session that read the file before our rename
      // and saves after it drops OUR key - that one is as long as
      // its own read-modify-write. Either way the launch just meets the modal,
      // as it did before this file existed, and sessions.js logs the miss.
      // Upgrade path: honour Claude Code's own lock if it ever documents one.
      if (fs.statSync(file).mtimeMs === before) {
        fs.renameSync(tmp, file);
        return true;
      }
    } catch {
      // Also a busy file: Windows refuses the rename for a moment while
      // another process has it open, so it is retried like a race.
    }
    try { fs.unlinkSync(tmp); } catch { /* nothing left to clean */ }
  }
  return false;
}

// A short synchronous wait between attempts - trustFolder runs inside one
// request and is never awaited, so there is no event loop turn to yield to.
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
