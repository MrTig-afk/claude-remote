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
 * Whole-file config write, tmp + rename. Returns true on success, false with
 * a warn on failure - same contract and same shape as registry.js's
 * writeRegistry. Never throws.
 * ponytail: read-modify-write with no lock. Single-user agent on loopback,
 * so the window is theoretical. Upgrade path: an O_EXCL lockfile around
 * read+write.
 */
export function writeConfig(configPath, config) {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const json = JSON.stringify(config, null, 2);
    const tmp = `${configPath}.tmp`;
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, configPath);
    return true;
  } catch (err) {
    console.warn(`claude-remote agent: could not write config '${configPath}': ${err.code || err.message}`);
    return false;
  }
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

/**
 * True iff the owner has been through the accept screen. NEVER throws: an
 * unreadable or corrupt config reads as NOT acknowledged, because showing the
 * warning a second time is harmless and skipping it is the one failure that
 * matters. Same "share less, never more" posture resolveSharedFolders takes.
 */
export function isAcknowledged(configPath = getConfigFilePath()) {
  let config;
  try {
    config = readConfig(configPath);   // throws on invalid JSON
  } catch {
    return false;
  }
  return typeof config.acknowledged_at === 'string' && config.acknowledged_at.trim() !== '';
}

/**
 * The two facts /api/status needs at boot: whether the accept screen has been
 * dismissed, and how many roots are shared. Never throws - /api/status is the
 * first request the phone makes after unlocking, and a 500 there turns a
 * hand-edited config into a dead app. A parse failure degrades to
 * `acknowledged: false`, which re-shows the accept screen: fail-safe, not
 * fail-open.
 *
 * Rebuilt on isAcknowledged + resolveSharedFolders when M9 merged, which is
 * exactly what this function's first version said should happen once
 * resolveSharedFolders existed. It no longer parses the config itself, so
 * shared_count now honours every rule M9 settled - shared_folders wins over
 * default_base_folder, a malformed entry is dropped, an empty array counts 0
 * - instead of a second, simpler count that would drift from the real one.
 */
export function readStatusFacts(configPath = getConfigFilePath()) {
  try {
    return {
      acknowledged: isAcknowledged(configPath),
      shared_count: resolveSharedFolders(configPath).length,
    };
  } catch {
    // isAcknowledged swallows its own read failure, but resolveSharedFolders
    // lets readConfig's invalid-JSON throw through. Catching here is what
    // keeps the never-throws promise above true.
    return { acknowledged: false, shared_count: 0 };
  }
}
/**
 * Writes acknowledged_at once and never again. The early return below is what
 * makes idempotency STRUCTURAL rather than behavioural: on a second call this
 * function does not write at all, so there is no code path that could
 * overwrite the first timestamp even if it wanted to. Nothing anywhere clears
 * this field - undoing it means editing the config file on the PC by hand,
 * which is a deliberate act rather than a button someone taps by accident.
 * Merged into the object readConfig returned, so shared_folders and every
 * unrelated key survive untouched.
 * -> { ok: true, acknowledged_at } | { ok: false, status, error }
 */
export function acknowledge(configPath = getConfigFilePath()) {
  let config;
  try {
    config = readConfig(configPath);
  } catch {
    // Refuse rather than write a fresh object over a file we could not read -
    // that would silently destroy shared_folders. Same call, same reasoning
    // and the same error code as putSharedFolders in agent/shared.js.
    return { ok: false, status: 500, error: 'config_unreadable' };
  }

  const existing = config.acknowledged_at;
  if (typeof existing === 'string' && existing.trim() !== '') {
    return { ok: true, acknowledged_at: existing };
  }

  config.acknowledged_at = new Date().toISOString();
  if (!writeConfig(configPath, config)) {
    return { ok: false, status: 500, error: 'write_failed' };
  }
  return { ok: true, acknowledged_at: config.acknowledged_at };
}
