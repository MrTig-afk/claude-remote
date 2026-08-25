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

/** Absolute path of the session registry file, beside the config (T29). */
export function getRegistryFilePath() {
  return path.join(path.dirname(getConfigFilePath()), 'sessions.json');
}

/** Absolute path of the directory launch-session.ps1 writes pid files into (T29). */
export function getPidDirPath() {
  return path.join(path.dirname(getConfigFilePath()), 'session-pids');
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
