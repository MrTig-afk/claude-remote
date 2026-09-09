import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import {
  getConfigFilePath, readConfig, resolveSharedFolders,
  resolveClaudeConfigDir, getSessionDirPaths, resolvePreLaunchCommand,
  resolveOpeningReport,
} from '../config.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-agent-config-'));

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeConfig(name, contents) {
  const configPath = path.join(dir, name);
  if (contents !== undefined) {
    fs.writeFileSync(configPath, contents);
  }
  return configPath;
}

test('getConfigFilePath ends with the shared claude-remote config path', () => {
  const configPath = getConfigFilePath();
  assert.ok(configPath.endsWith(path.join('.claude', 'plugins', 'data', 'claude-remote-claude-remote', 'config.json')));
});

// Same save/replace/restore-in-finally shape as agent/test/registry.test.js's
// console.warn capture, so a warn assertion never leaks into another test.
function captureWarnings(fn) {
  const warn = console.warn;
  const lines = [];
  console.warn = (msg) => lines.push(String(msg));
  try { return { result: fn(), lines }; } finally { console.warn = warn; }
}

test('resolveSharedFolders returns [] when the config file does not exist', () => {
  const configPath = writeConfig('shared-missing.json');
  assert.deepEqual(resolveSharedFolders(configPath), []);
});

test('resolveSharedFolders migrates a lone default_base_folder to one container root', () => {
  const configPath = writeConfig('shared-migrate.json', JSON.stringify({ default_base_folder: 'D:\\Some Where\\Projects\\' }));
  assert.deepEqual(resolveSharedFolders(configPath), [
    { path: path.resolve('D:\\Some Where\\Projects'), mode: 'container', excludes: [], new_folders: 'show' },
  ]);
});

test('resolveSharedFolders passes shared_folders through, normalised', () => {
  const configPath = writeConfig('shared-passthrough.json', JSON.stringify({
    shared_folders: [
      { path: 'F:\\Dev\\Projects\\Workspace', mode: 'single', excludes: ['Archive', '', 7, 'old-stuff'], new_folders: 'hide', colour: 'red' },
    ],
  }));
  assert.deepEqual(resolveSharedFolders(configPath), [
    { path: path.resolve('F:\\Dev\\Projects\\Workspace'), mode: 'single', excludes: ['Archive', 'old-stuff'], new_folders: 'hide' },
  ]);
});

test('resolveSharedFolders: shared_folders wins over default_base_folder when both are present', () => {
  const configPath = writeConfig('shared-wins.json', JSON.stringify({
    default_base_folder: 'D:\\Ignored\\Path',
    shared_folders: [{ path: 'F:\\Dev\\Projects\\Workspace' }],
  }));
  const result = resolveSharedFolders(configPath);
  assert.equal(result.length, 1);
  assert.equal(result[0].path, path.resolve('F:\\Dev\\Projects\\Workspace'));
  const ignoredPath = path.resolve('D:\\Ignored\\Path');
  assert.ok(!result.some((entry) => entry.path === ignoredPath));
});

test('resolveSharedFolders: an empty shared_folders wins over default_base_folder and yields []', () => {
  const configPath = writeConfig('shared-empty-wins.json', JSON.stringify({
    default_base_folder: 'D:\\Ignored\\Path',
    shared_folders: [],
  }));
  assert.deepEqual(resolveSharedFolders(configPath), []);
});

test('resolveSharedFolders: a non-array shared_folders yields [] with a warn, even beside a valid default_base_folder', () => {
  const configPath = writeConfig('shared-non-array.json', JSON.stringify({
    default_base_folder: 'D:\\Ignored\\Path',
    shared_folders: 'F:\\Whatever',
  }));
  const { result, lines } = captureWarnings(() => resolveSharedFolders(configPath));
  assert.deepEqual(result, []);
  assert.ok(lines.length >= 1);
});

test('resolveSharedFolders drops a garbage entry beside a good one, with a warn, and does not throw', () => {
  const configPath = writeConfig('shared-garbage.json', JSON.stringify({
    shared_folders: ['nope', { path: 'Some\\Relative\\Path' }, { path: 'F:\\Dev\\Projects\\Workspace' }, null, 42, {}],
  }));
  const { result, lines } = captureWarnings(() => resolveSharedFolders(configPath));
  assert.equal(result.length, 1);
  assert.equal(result[0].path, path.resolve('F:\\Dev\\Projects\\Workspace'));
  assert.equal(result[0].mode, 'container');
  assert.ok(lines.length >= 1);
});

test('resolveSharedFolders throws, and the message names the config file path, when the file is not valid JSON', () => {
  const configPath = writeConfig('shared-invalid.json', '{ not valid json');
  assert.throws(() => resolveSharedFolders(configPath), (err) => err.message.includes(configPath));
});

test('resolveSharedFolders preserves the path exactly as the owner wrote it, case included', () => {
  const configPath = writeConfig('shared-case.json', JSON.stringify({
    shared_folders: [{ path: 'F:\\Dev\\PROJECTS\\Workspace' }],
  }));
  assert.deepEqual(resolveSharedFolders(configPath), [
    { path: 'F:\\Dev\\PROJECTS\\Workspace', mode: 'container', excludes: [], new_folders: 'show' },
  ]);
});

test('readConfig returns {} for an absent file', () => {
  const configPath = writeConfig('read-missing.json');
  assert.deepEqual(readConfig(configPath), {});
});

test('readConfig hands back the whole parsed object, acknowledged_at included', () => {
  const configPath = writeConfig('read-whole.json', JSON.stringify({
    acknowledged_at: '2026-08-29T13:04:11.882Z',
    shared_folders: [],
  }));
  assert.deepEqual(readConfig(configPath), {
    acknowledged_at: '2026-08-29T13:04:11.882Z',
    shared_folders: [],
  });
});

test('readConfig returns {} for a top-level JSON array', () => {
  const configPath = writeConfig('read-array.json', '[]');
  assert.deepEqual(readConfig(configPath), {});
});

// --- T56: the Claude profile is a config value, absent by default -----------
// It used to be the owner's `.claude-max`, hardcoded into launch-session.ps1,
// so every session a stranger launched pointed at a profile directory that does
// not exist on their machine.

test('resolveClaudeConfigDir - absent config means ABSENT, not a guessed default', () => {
  assert.equal(resolveClaudeConfigDir(writeConfig('t56-missing.json')), null);
});

test('resolveClaudeConfigDir - an empty or blank value is absent too', () => {
  assert.equal(resolveClaudeConfigDir(writeConfig('t56-empty.json', '{"claude_config_dir":"   "}')), null);
});

test('resolveClaudeConfigDir - returns the configured absolute path', () => {
  const want = path.join(dir, 'my-profile');
  fs.mkdirSync(want, { recursive: true });   // must EXIST - see the typo test below
  const configPath = writeConfig('t56-set.json', JSON.stringify({ claude_config_dir: want }));
  assert.equal(resolveClaudeConfigDir(configPath), path.resolve(want));
});

test('resolveClaudeConfigDir - a path that does not exist is ignored, not passed on', () => {
  // A typo is ABSOLUTE, so the absolute check alone let it through: Claude Code
  // then created that profile from scratch, with no workspace-trust acceptance
  // for the project, and the session stopped on a modal nobody can answer from
  // a phone. Invisible too - getSessionDirPaths scans the same empty directory,
  // so no session file is ever found and the tile just ages into `failed`.
  const typo = path.join(dir, '.claude-mx-does-not-exist');
  const configPath = writeConfig('t56-typo.json', JSON.stringify({ claude_config_dir: typo }));
  assert.equal(resolveClaudeConfigDir(configPath), null);
});

test('resolveClaudeConfigDir - a relative path is ignored rather than resolved against cwd', () => {
  // Resolving it would silently point sessions at a directory under whatever
  // the agent's cwd happened to be.
  assert.equal(resolveClaudeConfigDir(writeConfig('t56-rel.json', '{"claude_config_dir":".claude"}')), null);
});

test('getSessionDirPaths - always scans the DEFAULT ~/.claude profile', () => {
  // The stranger's sessions land here. It was missing entirely: the agent
  // launched into one profile and then looked for the record in two others.
  const dirs = getSessionDirPaths(writeConfig('t56-none.json'));
  assert.ok(
    dirs.includes(path.join(os.homedir(), '.claude', 'sessions')),
    `expected the default profile in ${JSON.stringify(dirs)}`,
  );
});

test('getSessionDirPaths - a configured profile is scanned first, and never twice', () => {
  const want = path.join(dir, 'my-profile');
  fs.mkdirSync(want, { recursive: true });
  const dirs = getSessionDirPaths(writeConfig('t56-first.json', JSON.stringify({ claude_config_dir: want })));
  assert.equal(dirs[0], path.join(path.resolve(want), 'sessions'));
  assert.equal(new Set(dirs).size, dirs.length, 'no directory may be scanned twice');
});

test('getSessionDirPaths - any ~/.claude-* profile holding sessions/ is DISCOVERED', () => {
  // RED WHEN: the discovery is removed and the list goes back to two fixed
  // entries. That removal is not cosmetic - desk-session discovery
  // (readSessionFiles -> discoverDeskSessions) is the only source of the
  // "desktop" tiles, so a desk session under any non-default profile stops
  // appearing in the picker and cannot be stopped from the phone.
  // A fake home, so this asserts the RULE rather than whatever profiles happen
  // to exist on the machine running the suite.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-home-'));
  for (const p of ['.claude', '.claude-work', '.claude-other']) {
    fs.mkdirSync(path.join(home, p, 'sessions'), { recursive: true });
  }
  fs.mkdirSync(path.join(home, '.claude-hooks'), { recursive: true });   // no sessions/
  fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });       // not a profile
  const dirs = getSessionDirPaths(writeConfig('discover.json'), home);

  assert.ok(dirs.includes(path.join(home, '.claude-work', 'sessions')));
  assert.ok(dirs.includes(path.join(home, '.claude-other', 'sessions')));
  assert.ok(dirs.includes(path.join(home, '.claude', 'sessions')), 'the default is always scanned');
  assert.ok(
    !dirs.some((d) => d.includes('.claude-hooks')),
    'a sibling with no sessions/ is not a profile - this is what keeps .claude-hooks out',
  );
  assert.ok(!dirs.some((d) => d.includes('Documents')), 'a non-.claude directory is never scanned');
  assert.equal(new Set(dirs).size, dirs.length, 'no directory may be scanned twice');
  fs.rmSync(home, { recursive: true, force: true });
});

// pre_launch_command. ABSENT BY DEFAULT is the behaviour under test as much as
// the happy path: an unset key must mean "keep the venv auto-detect that has
// always run", never "run something we guessed".
test('pre_launch_command is null when the key is absent, and null on a missing config', () => {
  assert.equal(resolvePreLaunchCommand(writeConfig('prelaunch-absent.json', JSON.stringify({}))), null);
  assert.equal(resolvePreLaunchCommand(writeConfig('prelaunch-nofile.json')), null);
});

test('pre_launch_command returns the configured string verbatim', () => {
  const configPath = writeConfig('prelaunch-set.json', JSON.stringify({
    pre_launch_command: 'conda activate myenv',
  }));
  assert.equal(resolvePreLaunchCommand(configPath), 'conda activate myenv');
});

test('pre_launch_command ignores a non-string or blank value rather than running it', () => {
  // Each of these would otherwise reach Invoke-Expression in the launcher, so
  // "ignored" is the security-relevant behaviour, not just tidiness. A blank
  // string is rejected too: it would bind to -PreLaunch and suppress the venv
  // auto-detect while doing nothing, which is the worst of both.
  for (const bad of [42, true, {}, [], '', '   ']) {
    const configPath = writeConfig(`prelaunch-bad-${JSON.stringify(bad)}.json`.replace(/[^\w.-]/g, '_'),
      JSON.stringify({ pre_launch_command: bad }));
    assert.equal(resolvePreLaunchCommand(configPath), null, `${JSON.stringify(bad)} must be ignored`);
  }
});

// --- T120: per-project beats global -----------------------------------------
// The global-only version silently disabled venv activation for every OTHER
// project the moment it was set (F6-003), which is what this map exists to fix.

test('pre_launch_commands: a per-project entry wins over the global one', () => {
  const configPath = writeConfig('prelaunch-perproject.json', JSON.stringify({
    pre_launch_command: 'conda activate global',
    pre_launch_commands: { 'F:\\Dev\\Projects\\Workspace\\email-lint': 'poetry env activate' },
  }));
  assert.equal(
    resolvePreLaunchCommand(configPath, 'F:\\Dev\\Projects\\Workspace\\email-lint'),
    'poetry env activate',
  );
  // Any other project still gets the global one, which is the whole point.
  assert.equal(
    resolvePreLaunchCommand(configPath, 'F:\\Dev\\Projects\\Workspace\\other'),
    'conda activate global',
  );
});

test('pre_launch_commands: paths match case-insensitively and ignore a trailing separator', () => {
  // Windows paths are case-insensitive and the owner hand-edits this file, so
  // a key that differs only in case or a trailing slash must still match -
  // otherwise the entry silently does nothing and the global runs instead.
  const configPath = writeConfig('prelaunch-pathcase.json', JSON.stringify({
    pre_launch_commands: { 'f:\\dev\\projects\\workspace\\email-lint\\': 'poetry env activate' },
  }));
  assert.equal(
    resolvePreLaunchCommand(configPath, 'F:\\Dev\\Projects\\Workspace\\email-lint'),
    'poetry env activate',
  );
});

test('pre_launch_commands: an unusable per-project entry falls through to the global', () => {
  // Deliberate: the alternative is running NO environment step for the one
  // project the owner explicitly configured - the exact silent-wrong-env
  // failure this feature exists to stop.
  const configPath = writeConfig('prelaunch-badentry.json', JSON.stringify({
    pre_launch_command: 'conda activate global',
    pre_launch_commands: { 'F:\\Dev\\Projects\\Workspace\\email-lint': 42 },
  }));
  const { result } = captureWarnings(() => resolvePreLaunchCommand(
    configPath, 'F:\\Dev\\Projects\\Workspace\\email-lint',
  ));
  assert.equal(result, 'conda activate global');
});

test('pre_launch_commands: null or blank is an explicit OPT-OUT, not a fall-through', () => {
  // Without this there is no way to say "this project needs nothing": an owner
  // with a global conda command and one plain Node project would get conda run
  // there anyway. That is the silent-wrong-environment outcome the feature
  // exists to stop, reached by configuring it correctly.
  const configPath = writeConfig('prelaunch-optout.json', JSON.stringify({
    pre_launch_command: 'conda activate global',
    pre_launch_commands: {
      'F:\\Dev\\Projects\\web': null,
      'F:\\Dev\\Projects\\api': '   ',
    },
  }));
  assert.equal(resolvePreLaunchCommand(configPath, 'F:\\Dev\\Projects\\web'), null,
    'null must mean "nothing here", not "use the global"');
  // A BLANK IS NOT AN OPT-OUT. It is far more likely a half-finished edit, it
  // is an undocumented second spelling, and silently honouring it would drop
  // the environment step where the previous build warned. It stays malformed:
  // warn, then the global.
  const { result } = captureWarnings(() => resolvePreLaunchCommand(configPath, 'F:\\Dev\\Projects\\api'));
  assert.equal(result, 'conda activate global', 'a blank entry must warn and fall through, not opt out');
  // and the global still applies everywhere else
  assert.equal(resolvePreLaunchCommand(configPath, 'F:\\Dev\\Projects\\other'), 'conda activate global');
});

test('pre_launch_commands: a drive-relative key warns - path.isAbsolute says true for it on win32', () => {
  // `/Dev/Projects/web` is the natural thing to type and path.isAbsolute
  // returns TRUE for it on win32, so the first version of this guard let it
  // through. It then resolves against the agent's cwd, which means whether it
  // matches depends on how the agent was launched.
  const configPath = writeConfig('prelaunch-driverel.json', JSON.stringify({
    pre_launch_commands: { '/Dev/Projects/web': 'poetry env activate' },
  }));
  const { lines } = captureWarnings(() => resolvePreLaunchCommand(configPath, 'F:\\Dev\\Projects\\web'));
  assert.ok(lines.some((l) => l.includes('no drive letter')),
    `a drive-relative key must warn, got ${JSON.stringify(lines)}`);
});

test('pre_launch_commands: a key that can never match warns rather than failing silently', () => {
  // `~` is not expanded by node and a relative key resolves against the AGENT's
  // directory, so both match nothing. The owner would see only the wrong
  // interpreter inside a session on his phone.
  const configPath = writeConfig('prelaunch-unmatchable.json', JSON.stringify({
    pre_launch_commands: { '~/Dev/Projects/web': 'poetry env activate' },
  }));
  const { lines } = captureWarnings(() => resolvePreLaunchCommand(configPath, 'F:\\Dev\\Projects\\web'));
  assert.ok(lines.some((l) => l.includes('no drive letter')), `expected an unmatchable-key warn, got ${JSON.stringify(lines)}`);
});

test('pre_launch_commands: a non-object map is ignored rather than thrown on', () => {
  const configPath = writeConfig('prelaunch-badmap.json', JSON.stringify({
    pre_launch_command: 'conda activate global',
    pre_launch_commands: ['not', 'an', 'object'],
  }));
  assert.equal(resolvePreLaunchCommand(configPath, 'F:\\Dev\\Projects\\Workspace\\x'), 'conda activate global');
});

// --- T108: the opening report is on unless explicitly switched off ----------

test('resolveOpeningReport is TRUE by default and on anything that is not exactly false', () => {
  // The default has to fail in this direction: a silent session started from a
  // phone gives the owner nothing to diagnose. Only an explicit false counts.
  assert.equal(resolveOpeningReport(writeConfig('or-absent.json', '{}')), true);
  assert.equal(resolveOpeningReport(writeConfig('or-missing-file.json')), true);
  for (const junk of ['false', 0, null, 'no', {}]) {
    const configPath = writeConfig(`or-junk-${JSON.stringify(junk)}.json`.replace(/[^\w.-]/g, '_'),
      JSON.stringify({ opening_report: junk }));
    assert.equal(resolveOpeningReport(configPath), true, `${JSON.stringify(junk)} must not switch it off`);
  }
});

test('resolveOpeningReport is FALSE only for a literal false', () => {
  assert.equal(resolveOpeningReport(writeConfig('or-off.json', '{"opening_report":false}')), false);
});

test('a profile relocated behind a junction or symlink is still discovered', () => {
  // readdir does NOT follow links, so a linked profile reports isSymbolicLink()
  // rather than isDirectory(). Relocating a profile to another drive is a
  // normal move on a disk-tight machine, and the isDirectory() predicate this
  // replaces dropped it silently - the exact regression discovery exists to
  // prevent. 'junction' is used because it needs no elevation on Windows.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-home-link-'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-remote-elsewhere-'));
  fs.mkdirSync(path.join(elsewhere, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  try {
    fs.symlinkSync(elsewhere, path.join(home, '.claude-linked'), 'junction');
  } catch (err) {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
    assert.fail(`could not create a junction, so this guard is unproven: ${err.code || err.message}`);
  }
  const dirs = getSessionDirPaths(writeConfig('discover-link.json'), home);
  assert.ok(
    dirs.includes(path.join(home, '.claude-linked', 'sessions')),
    'a linked profile holding sessions/ must be discovered, not skipped for not being a real directory',
  );
  fs.rmSync(path.join(home, '.claude-linked'), { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(elsewhere, { recursive: true, force: true });
});

test('getSessionDirPaths - an unreadable home costs the discovery ONLY', () => {
  // The configured dir and the default must survive, for the same reason the
  // corrupt-config case below survives: this list degrades, it never collapses.
  const missing = path.join(os.tmpdir(), 'claude-remote-no-such-home-9c3f1a');
  const dirs = getSessionDirPaths(writeConfig('nohome.json'), missing);
  assert.deepEqual(dirs, [path.join(missing, '.claude', 'sessions')]);
});

test('getSessionDirPaths - a corrupt config costs the configured dir, NOT the session list', () => {
  // readSessionFiles (registry.js) documents "Never throws" and degrades to
  // fewer records on every fault. A config it cannot parse must not be the one
  // thing that takes the whole list down.
  const configPath = writeConfig('t56-corrupt.json', '{ not json');
  const dirs = getSessionDirPaths(configPath);
  assert.ok(dirs.includes(path.join(os.homedir(), '.claude', 'sessions')));
  // ... while the launch path still surfaces it, rather than launching into a
  // silently wrong profile.
  assert.throws(() => resolveClaudeConfigDir(configPath), /not valid JSON/);
});
