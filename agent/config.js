import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FALLBACK_BASE_DIR = 'F:\\Dev\\Projects\\Repos';

/**
 * Absolute path of the claude-remote config file, same folder the
 * PowerShell side (Get-ConfigFilePath, ClaudeRemote.psm1:102) reads.
 */
export function getConfigFilePath() {
  return path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-remote-claude-remote', 'config.json');
}

/** Absolute path of the session registry file, beside the config. */
export function getRegistryFilePath() {
  return path.join(path.dirname(getConfigFilePath()), 'sessions.json');
}

/** Absolute path of the directory launch-session.ps1 writes pid files into. */
export function getPidDirPath() {
  return path.join(path.dirname(getConfigFilePath()), 'session-pids');
}

/** The two Claude Code profile session directories, newest-profile-first order
 *  is irrelevant - both are read. Only <pid>.json is ever opened from them. */
export function getSessionDirPaths() {
  return [
    path.join(os.homedir(), '.claude-max', 'sessions'),
    path.join(os.homedir(), '.claude-pro', 'sessions'),
  ];
}

/** Absolute path of the passcode hash file, beside the config. */
export function getPasscodeFilePath() {
  return path.join(path.dirname(getConfigFilePath()), 'passcode.json');
}

/** Absolute path of the failed-attempt counter, beside the config. */
export function getAttemptsFilePath() {
  return path.join(path.dirname(getConfigFilePath()), 'passcode-attempts.json');
}

/**
 * Resolves the base project directory from the claude-remote config file,
 * mirroring Get-DefaultBaseFolder (ClaudeRemote.psm1:133) and falling back
 * to FALLBACK_BASE_DIR whenever the config is absent, empty or invalid.
 */
export function resolveBaseDir(configPath = getConfigFilePath()) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`claude-remote agent: could not read config '${configPath}': ${err.code || err.message}`);
    }
    return FALLBACK_BASE_DIR;
  }

  if (raw.trim() === '') {
    return FALLBACK_BASE_DIR;
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error(`claude-remote config '${configPath}' is not valid JSON`);
  }

  const value = config && config.default_base_folder;
  if (typeof value !== 'string' || value.trim() === '') {
    return FALLBACK_BASE_DIR;
  }

  if (!path.isAbsolute(value)) {
    console.warn(`claude-remote agent: config '${configPath}' has a relative default_base_folder; ignoring it`);
    return FALLBACK_BASE_DIR;
  }

  return path.resolve(value);
}

/**
 * Reads and parses the claude-remote config file with no schema opinions -
 * the shared read/parse T87, T91 and T94 all need, so a corrupt config is
 * one real fault (thrown, same contract as resolveBaseDir) rather than three
 * slightly different silent failures. Returns a plain object; callers that
 * need to merge a write into the existing file (T94) get every unrelated
 * key back untouched.
 */
export function readConfig(configPath = getConfigFilePath()) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`claude-remote agent: could not read config '${configPath}': ${err.code || err.message}`);
    }
    return {};
  }

  if (raw.trim() === '') {
    return {};
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error(`claude-remote config '${configPath}' is not valid JSON`);
  }

  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return {};
  }

  return config;
}

/**
 * Normalises one shared_folders array into the four-key entry shape,
 * dropping anything malformed with a warn rather than aborting the whole
 * array - this file is hand-editable, so one bad line must not cost every
 * good one. Never sanitizes a bad path; only resolve()'s an already-valid
 * absolute one, same posture as resolveBaseDir.
 */
function normaliseSharedFolders(entries, configPath) {
  const result = [];

  entries.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      console.warn(`claude-remote agent: config '${configPath}' shared_folders[${index}] is not an object; ignoring it`);
      return;
    }

    if (typeof entry.path !== 'string' || entry.path.trim() === '' || !path.isAbsolute(entry.path)) {
      console.warn(`claude-remote agent: config '${configPath}' shared_folders[${index}] has no absolute path; ignoring it`);
      return;
    }

    result.push({
      path: path.resolve(entry.path),
      mode: entry.mode === 'container' || entry.mode === 'single' ? entry.mode : 'container',
      excludes: Array.isArray(entry.excludes)
        ? entry.excludes.filter((name) => typeof name === 'string' && name.trim() !== '')
        : [],
      new_folders: entry.new_folders === 'show' || entry.new_folders === 'hide' ? entry.new_folders : 'show',
    });
  });

  return result;
}

/**
 * Silently migrates an old default_base_folder into one container root -
 * no prompt, no screen, and this never writes the migration back. A value
 * that is not a usable absolute path is a warn, not a fallback: unlike
 * resolveBaseDir, there is nothing that must always be listed here, and
 * defaulting to FALLBACK_BASE_DIR would silently share a folder the owner
 * never ticked.
 */
function migrateDefaultBaseFolder(config, configPath) {
  const value = config.default_base_folder;

  if (typeof value !== 'string' || value.trim() === '' || !path.isAbsolute(value)) {
    if (value !== undefined) {
      console.warn(`claude-remote agent: config '${configPath}' has no usable default_base_folder for migration; ignoring it`);
    }
    return [];
  }

  return [{ path: path.resolve(value), mode: 'container', excludes: [], new_folders: 'show' }];
}

/**
 * Resolves the owner's shared-folder set: shared_folders if the key is
 * PRESENT (even empty, null, or malformed - see spec), otherwise a silent
 * migration of default_base_folder. Presence, not truthiness, decides:
 * `shared_folders?.length ? ... : migrate()` would re-share a root the
 * owner deliberately removed the moment the array is empty, which is the
 * one failure this reader exists to prevent. Share less, never more.
 */
export function resolveSharedFolders(configPath = getConfigFilePath()) {
  const config = readConfig(configPath);

  if (Object.prototype.hasOwnProperty.call(config, 'shared_folders')) {
    if (!Array.isArray(config.shared_folders)) {
      console.warn(`claude-remote agent: config '${configPath}' has a non-array shared_folders; ignoring it`);
      return [];
    }
    return normaliseSharedFolders(config.shared_folders, configPath);
  }

  return migrateDefaultBaseFolder(config, configPath);
}
