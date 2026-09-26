import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Absolute path of the claude-remote config file. It used to be shared with a
 * PowerShell reader (Get-ConfigFilePath); that path was deleted by T53 on
 * 2026-09-05, so this is now the ONLY reader and the location is free to
 * change if there is ever a reason.
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

/**
 * The Claude Code profile directory launched sessions should use, or null to
 * leave it alone and let Claude Code pick its own default (`~/.claude`).
 *
 * T56: this used to be one specific personal profile directory, hardcoded into
 * launch-session.ps1. A stranger got every session launched against a profile
 * directory that does not exist on their machine. ABSENT BY DEFAULT is the
 * point - an unset config means "do not set CLAUDE_CONFIG_DIR at all", not
 * "set it to something we guessed".
 */
let warnedRelativeConfigDir = false;
let warnedMissingConfigDir = false;
export function resolveClaudeConfigDir(configPath = getConfigFilePath()) {
  const value = readConfig(configPath).claude_config_dir;
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (!path.isAbsolute(value)) {
    // ONCE. getSessionDirPaths calls this from readSessionFiles, which runs on
    // every 5s status poll - so an unguarded warn here would put roughly 17k
    // identical lines a day in the agent's terminal for one misconfiguration,
    // and bury anything worth reading.
    if (!warnedRelativeConfigDir) {
      warnedRelativeConfigDir = true;
      console.warn(`claude-remote agent: config '${configPath}' has a relative claude_config_dir; ignoring it`);
    }
    return null;
  }
  const resolved = path.resolve(value);
  // MUST EXIST. Absolute is not enough: a typo like `.claude-mx` is absolute,
  // so it passed, reached `-ConfigDir`, and Claude Code created that profile
  // from scratch - with no `hasTrustDialogAccepted` for the project. The
  // session then stops on the workspace-trust modal, which is the exact
  // unanswerable-from-a-phone hang the launcher's else-branch exists to avoid,
  // and it is INVISIBLE: getSessionDirPaths scans the same empty directory, so
  // no session file is ever found and the tile just ages into `failed`.
  // Falling back to null means "no profile configured", which is the safe
  // default rather than a guess.
  if (!fs.existsSync(resolved)) {
    if (!warnedMissingConfigDir) {
      warnedMissingConfigDir = true;
      console.warn(`claude-remote agent: config '${configPath}' points claude_config_dir at '${resolved}', which does not exist; ignoring it`);
    }
    return null;
  }
  return resolved;
}

/**
 * The command to run in the project directory before `claude` starts, or null
 * to keep the launcher's own `venv`/`.venv` auto-detect. ABSENT BY DEFAULT,
 * same as claude_config_dir above: an unset key means "do what you already
 * do", never "run something we guessed".
 *
 * `pre_launch_commands` (keyed by project path) wins, then `pre_launch_command`
 * (one string) for everything else. The map exists because the global alone
 * silently disabled venv activation for every OTHER project once set (F6-003).
 *
 * THIS IS ARBITRARY CODE EXECUTION BY DESIGN - launch-session.ps1 runs the
 * value through Invoke-Expression. Acceptable ONLY because setting it requires
 * desk access to config.json, and anyone with that can already run anything as
 * this user. It must therefore NEVER become settable over the API, which
 * `accept.test.js` pins behaviourally.
 */
// ONCE PER KEY, not once overall. A single boolean here meant the first
// malformed key silenced every other one for the life of the process - and the
// agent is a long-lived scheduled task, so "for the life of the process" is
// until reboot. A bad per-project entry would hide a bad global, and both route
// to the same silently-no-environment-step outcome this feature exists to stop.
const warnedBadCommands = new Set();
function usableCommand(value, configPath, where) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    // Still throttled: this is on the launch path, and an unguarded warn would
    // print on every launch and bury anything worth reading.
    if (!warnedBadCommands.has(where)) {
      warnedBadCommands.add(where);
      console.warn(`claude-remote agent: config '${configPath}' has a ${where} that is not a non-empty string; ignoring it`);
    }
    return null;
  }
  return value;
}

/**
 * Its own path normaliser rather than shared.js's `pathKey`. NOT an oversight:
 * shared.js imports this module (writeConfig), so importing back would be a
 * cycle. Two lines duplicated across that boundary is the cheaper of the two
 * problems - keep them in step by hand if either changes.
 */
const projectKey = (p) => path.resolve(p).replace(/[\\/]+$/, '').toUpperCase();

/**
 * A key that names a project without depending on where the agent was started:
 * a drive-qualified path or a UNC path. NOT `path.isAbsolute`, which returns
 * TRUE on win32 for a drive-RELATIVE root like `/Dev/x` - the natural thing to
 * type, and the very form the docs warn about. That key then resolves against
 * the agent's cwd, so whether it matches flips with how the agent was launched.
 */
const DRIVE_QUALIFIED = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * Warns once per `pre_launch_commands` key that is not drive-qualified. Such a
 * key resolves against the agent's working directory, so it USUALLY matches
 * nothing and the owner sees only the wrong interpreter inside a session on his
 * phone - but "usually", not "never": start the agent inside the projects root
 * and a relative key does match. The warning says that, because a diagnostic
 * that overstates its case teaches the reader to distrust it.
 */
const warnedUnmatchableKeys = new Set();
function warnUnmatchableKeys(byProject, configPath) {
  for (const key of Object.keys(byProject)) {
    if (DRIVE_QUALIFIED.test(key) || warnedUnmatchableKeys.has(key)) continue;
    warnedUnmatchableKeys.add(key);
    console.warn(`claude-remote agent: config '${configPath}' has a pre_launch_commands key '${key}' with no drive letter, so it resolves against the agent's working directory and will usually match no project ('~' is never expanded)`);
  }
}

export function resolvePreLaunchCommand(configPath = getConfigFilePath(), projectPath = null) {
  const config = readConfig(configPath);

  // PER-PROJECT WINS, and it is looked up before the global is even read.
  // Owner decision 2026-09-09 (T120): keyed by project path in the central
  // config, NOT a file inside the project. A file that travels with a repo
  // would let a cloned project execute a command the moment its tile is
  // tapped - the direnv problem - and this setting reaches Invoke-Expression.
  // Central config cannot be written by any API route, so no repo can inject.
  const byProject = config.pre_launch_commands;
  if (projectPath && byProject && typeof byProject === 'object' && !Array.isArray(byProject)) {
    warnUnmatchableKeys(byProject, configPath);
    const want = projectKey(projectPath);
    const hit = Object.entries(byProject).find(([configured]) => projectKey(configured) === want);
    if (hit) {
      const [key, command] = hit;
      // EXPLICIT OPT-OUT: literal `null` only, and it must come before the
      // usable check. It means "this project needs nothing" - keep the venv
      // auto-detect, do NOT fall through to the global. Without it there is no
      // way to say that at all.
      // NOT a blank string. A blank is far more likely a half-finished edit
      // than a stated intention, it is an undocumented second spelling, and
      // treating it as opt-out silently drops the environment step where the
      // previous build warned. Blank stays MALFORMED below: warn, then the
      // global, which is the better guess when the owner clearly meant to type
      // something.
      if (command === null) return null;
      const usable = usableCommand(command, configPath, `pre_launch_commands entry for '${key}'`);
      if (usable) return usable;
    }
  }

  return usableCommand(config.pre_launch_command, configPath, 'pre_launch_command');
}

/**
 * Whether a PWA-launched session opens by reporting where the work stands.
 * ONLY an explicit `false` switches it off - a missing, null or malformed key
 * leaves it ON, because the failure it guards is a silent phone-launched
 * session, which gives the owner nothing to diagnose.
 */
export function resolveOpeningReport(configPath = getConfigFilePath()) {
  return readConfig(configPath).opening_report !== false;
}

/** Claude Code profile session directories to scan. Only <pid>.json is ever
 *  opened from them, so listing a directory that does not exist costs nothing
 *  and every entry here is a candidate rather than a requirement.
 *  A configured profile is scanned first; the default `~/.claude` is always
 *  included (T56 - it was missing entirely, so a stranger's sessions were
 *  launched into a profile nothing then looked in); and any other
 *  `~/.claude-*` profile that actually holds a `sessions` directory is
 *  DISCOVERED, never hardcoded - see the note in the body for why that
 *  matters. `homeDir` is a test seam and nothing in production passes it. */
export function getSessionDirPaths(configPath = getConfigFilePath(), homeDir = os.homedir()) {
  // Swallows a corrupt config ON PURPOSE, and only here. readSessionFiles
  // (registry.js) documents "Never throws" and degrades to fewer records on
  // every other fault; a config this function cannot parse must therefore cost
  // the configured directory, not the whole session list. The LAUNCH path calls
  // resolveClaudeConfigDir directly and does let that error through, which is
  // where a corrupt config should actually be felt.
  let configured = null;
  try {
    configured = resolveClaudeConfigDir(configPath);
  } catch { /* fall through to the default profiles below */ }
  // DISCOVERED, NOT HARDCODED, AND NOT DROPPED EITHER.
  // Two named profiles (one owner's) were hardcoded here. T65 removed them as
  // personal strings, and that removal was WRONG ON ITS OWN: desk-session
  // discovery (readSessionFiles -> discoverDeskSessions) is the only source of
  // the "desktop" tiles, so a desk session started under any non-default
  // profile silently stopped appearing in the picker and could not be stopped
  // from the phone. `claude_config_dir` is NOT an equivalent mitigation: it
  // also drives the LAUNCH path (-ConfigDir), so it cannot be used to merely
  // ADD a directory to scan, and it holds ONE value, so two desk profiles can
  // never both be covered.
  // Discovery fixes both halves at once - no personal name in the source, and
  // wider coverage than the hardcoded list ever had, since it finds a profile
  // this project has never heard of. Gated on the profile actually holding a
  // `sessions` directory, which is what keeps `.claude-*` siblings that are
  // not profiles out. A home directory that cannot be read costs the discovery only: the
  // configured dir and the default below still stand.
  let discovered = [];
  try {
    discovered = fs.readdirSync(homeDir, { withFileTypes: true })
      // `!isFile()`, NOT `isDirectory()`: readdir does not follow links, so a
      // profile relocated to another drive by a junction or symlink - a normal
      // move on a disk-tight machine - reports isSymbolicLink() and would be
      // dropped, which is exactly the coverage gap this discovery exists to
      // close. The `sessions` check below DOES follow links and is what
      // actually decides, so relaxing this loses no exclusion.
      .filter((e) => !e.isFile() && e.name.startsWith('.claude-'))
      .map((e) => path.join(homeDir, e.name))
      .filter((d) => fs.existsSync(path.join(d, 'sessions')));
  } catch { /* unreadable home - configured + default still apply */ }
  const dirs = [
    ...(configured ? [configured] : []),
    path.join(homeDir, '.claude'),
    ...discovered,
  ];
  return [...new Set(dirs)].map((d) => path.join(d, 'sessions'));
}

/** Absolute path of the passcode hash file, beside the config. */
export function getPasscodeFilePath() {
  return path.join(path.dirname(getConfigFilePath()), 'passcode.json');
}

/** Absolute path of the failed-attempt counter, beside the config. */
export function getAttemptsFilePath() {
  return path.join(path.dirname(getConfigFilePath()), 'passcode-attempts.json');
}

/** Absolute path of the Web Push state file (VAPID keys + subscriptions), beside the config. */
export function getPushFilePath() {
  return path.join(path.dirname(getConfigFilePath()), 'push.json');
}

/** Absolute path of the one-field tailscale-serve dedupe marker, beside the config. */
export function getServeStatePath() {
  return path.join(path.dirname(getConfigFilePath()), 'serve-state.json');
}

/**
 * Reads and parses the claude-remote config file with no schema opinions -
 * the shared read/parse T87, T91 and T94 all need, so a corrupt config is
 * one real fault - INVALID JSON THROWS, naming the config path - rather than
 * three slightly different silent failures. Returns a plain object; callers that
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
 * absolute one: a relative path is WARNED AND DROPPED, never resolved against
 * the agent's cwd, which would silently share whatever directory the agent
 * happened to start in.
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
 * that is not a usable absolute path is a warn, not a fallback. There is
 * nothing that must always be listed here, so an unusable value yields NO
 * root: defaulting to some guessed directory would silently share a folder
 * the owner never ticked, which is the one outcome this whole screen exists
 * to prevent.
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
