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
 * The two facts /api/status needs at boot: whether the accept screen has
 * been dismissed, and how many shared roots exist. Never throws -
 * `/api/status` is the first request the phone makes after unlocking, and a
 * 500 there turns a hand-edited config into a dead app. Unlike
 * resolveBaseDir, which throws on invalid JSON because it runs at startup
 * where a loud stop is right, this degrades to `acknowledged: false` on a
 * parse failure: that re-shows the accept screen, which is fail-safe, not
 * fail-open.
 *
 * shared_count today only knows default_base_folder (one root). T91 lands
 * the real shared_folders reader on a different branch; when
 * resolveSharedFolders exists, shared_count becomes its length and this
 * function keeps only the acknowledged read. An empty shared_folders: []
 * beside a default_base_folder counts 0 here, pre-honouring T91's
 * owner-approved precedence (shared_folders wins) - the opposite answer
 * would silently re-add a root the owner removed.
 */
export function readStatusFacts(configPath = getConfigFilePath()) {
  const zero = { acknowledged: false, shared_count: 0 };

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`claude-remote agent: could not read config '${configPath}': ${err.code || err.message}`);
    }
    return zero;
  }

  if (raw.trim() === '') {
    return zero;
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    console.warn(`claude-remote agent: config '${configPath}' is not valid JSON; treating as unacknowledged`);
    return zero;
  }

  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return zero;
  }

  const acknowledged = typeof config.acknowledged_at === 'string' && config.acknowledged_at.trim() !== '';

  let shared_count;
  if (Array.isArray(config.shared_folders)) {
    shared_count = config.shared_folders.length;
  } else if (typeof config.default_base_folder === 'string' && config.default_base_folder.trim() !== '') {
    shared_count = 1;
  } else {
    shared_count = 0;
  }

  return { acknowledged, shared_count };
}
