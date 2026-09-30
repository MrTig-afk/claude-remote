// Which Claude account a session starts in. Accounts are
// found on disk, named after the shell alias that opens them, picked by NAME
// from the phone, and remembered per project.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import { listAccounts, readAliases, readLastAccounts, getSessionDirPaths } from '../config.js';
import { launchSession, deriveSessionName } from '../sessions.js';
import { pidFileNameFor } from '../registry.js';
import { handoffCopy } from '../public/handoff-ui.js';
import { seedPasscode, issueTestToken, makeAuthedFetch, fixtureServer, testSessionDirs } from './helper-auth.js';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

// A profile folder; signedIn puts Claude's sign-in file in it (empty - it is
// only ever checked for existing).
function profile(home, name, signedIn = true) {
  const d = path.join(home, name);
  fs.mkdirSync(d, { recursive: true });
  if (signedIn) fs.writeFileSync(path.join(d, '.credentials.json'), '');
  return d;
}

function write(file, text, encoding = 'utf8') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, encoding);
}

const noConfig = (home) => path.join(home, 'no-config.json');
// readAliases' shape, for listAccounts' seam.
const aliasMap = (pairs) => new Map(pairs.map(([dir, name]) => [path.resolve(dir).toUpperCase(), { name, dir: path.resolve(dir) }]));

// ---- readAliases -----------------------------------------------------------

test('readAliases finds the owner-shaped PowerShell and bash definitions', () => {
  const home = tmp('cr-alias-');
  // The shape this PC's profile.ps1 has: a helper that sets the variable from
  // a parameter, and one-line functions naming the folder.
  write(path.join(home, 'Documents', 'WindowsPowerShell', 'profile.ps1'), [
    '# CLAUDE_CONFIG_DIR is set for the child only, e.g. .claude-comment',
    'function Invoke-ClaudeProfile {',
    '    param([string]$ConfigDir)',
    '    $env:CLAUDE_CONFIG_DIR = Join-Path $env:USERPROFILE $ConfigDir',
    '    & claude.cmd @Rest',
    '}',
    "function claudemax { Invoke-ClaudeProfile -ConfigDir '.claude-max' -Rest $args }",
  ].join('\r\n'));
  write(path.join(home, '.bashrc'), [
    '_claude_launch() {',
    '  local dir="$1"; shift',
    '  CLAUDE_CONFIG_DIR="$dir" claude "$@"',
    '}',
    'claudepro() { _claude_launch "$HOME/.claude-pro" "$@"; }',
  ].join('\n'));
  const a = readAliases(home);
  assert.equal(a.get(path.join(home, '.claude-max').toUpperCase()).name, 'claudemax');
  assert.equal(a.get(path.join(home, '.claude-pro').toUpperCase()).name, 'claudepro');
  assert.equal(a.size, 2, 'the helper and the comment name no folder of their own');
});

test('readAliases reads a multi-line function with an absolute folder, an alias line, and a UTF-16 profile', () => {
  const home = tmp('cr-alias2-');
  write(path.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
    '\uFEFF' + ['function claudework {', '  $env:CLAUDE_CONFIG_DIR = "D:\\profiles\\work"', '  claude @args', '}'].join('\r\n'),
    'utf16le');
  write(path.join(home, '.zshrc'), "alias claudeplain='CLAUDE_CONFIG_DIR=~/.claude claude'\n");
  const a = readAliases(home);
  assert.deepEqual(a.get(path.resolve('D:\\profiles\\work').toUpperCase()), { name: 'claudework', dir: path.resolve('D:\\profiles\\work') });
  assert.equal(a.get(path.join(home, '.claude').toUpperCase()).name, 'claudeplain');
});

test("readAliases never takes Claude's state file for a folder, and forgets a function at its closing brace", () => {
  const home = tmp('cr-alias3-');
  write(path.join(home, '.bashrc'), [
    'backup() {',
    `  cp ~/.claude${'.json'} /tmp/`,
    '}',
    'export CLAUDE_CONFIG_DIR_HINT=~/.claude-stray',
  ].join('\n'));
  assert.equal(readAliases(home).size, 0);
});

test('readAliases does not credit a later folder to a one-line function', () => {
  const home = tmp('cr-alias5-');
  write(path.join(home, '.bashrc'), 'll() { ls -la; }\nexport CLAUDE_CONFIG_DIR=~/.claude-pro\n');
  write(path.join(home, 'Documents', 'WindowsPowerShell', 'profile.ps1'), 'function prompt { "PS> " }\r\n$x = "$HOME\\.claude-max"\r\n');
  assert.equal(readAliases(home).size, 0);
});

test('readAliases keeps the whole path: nested under home, Git Bash drive paths, and a variable it cannot see', () => {
  const home = tmp('cr-alias6-');
  write(path.join(home, '.bashrc'), [
    'alias cm="CLAUDE_CONFIG_DIR=~/profiles/.claude claude"',
    'cw() { CLAUDE_CONFIG_DIR=/d/profiles/.claude-work claude "$@"; }',
    'cv() { CLAUDE_CONFIG_DIR="$dir" claude "$@"; }',
  ].join('\n'));
  const a = readAliases(home);
  assert.equal(a.get(path.join(home, 'profiles', '.claude').toUpperCase()).name, 'cm');
  assert.equal(a.get(path.resolve('D:\\profiles\\.claude-work').toUpperCase()).name, 'cw');
  assert.equal(a.has(path.join(home, '.claude').toUpperCase()), false, 'the plain profile is not mislabelled');
  assert.equal(a.size, 2, '$dir names nothing');
});

test('readAliases skips an over-long line and an over-size file rather than stalling', () => {
  const home = tmp('cr-alias7-');
  write(path.join(home, '.bashrc'), `cx() { CLAUDE_CONFIG_DIR=~/.claude-x claude; } # ${'C:/'.repeat(2000)}\n`);
  write(path.join(home, '.zshrc'), `cy() { CLAUDE_CONFIG_DIR=~/.claude-y claude; }\n${'#'.repeat(1024 * 1024 + 1)}\n`);
  const started = Date.now();
  assert.equal(readAliases(home).size, 0);
  assert.ok(Date.now() - started < 1000);
});

test('readAliases re-reads a profile that changed', () => {
  const home = tmp('cr-alias8-');
  const rc = path.join(home, '.bashrc');
  write(rc, 'ca() { CLAUDE_CONFIG_DIR=~/.claude-a claude; }\n');
  assert.equal(readAliases(home).size, 1);
  write(rc, 'ca() { CLAUDE_CONFIG_DIR=~/.claude-a claude; }\ncb() { CLAUDE_CONFIG_DIR=~/.claude-b claude; }\n');
  assert.equal(readAliases(home).size, 2);
});

test('an alias folder outside the home folder is scanned for sessions too', () => {
  const home = tmp('cr-alias9-');
  const elsewhere = path.join(tmp('cr-elsewhere2-'), '.claude-work');
  fs.mkdirSync(path.join(elsewhere, 'sessions'), { recursive: true });
  write(path.join(home, '.bashrc'), `cw() { CLAUDE_CONFIG_DIR="${elsewhere.replace(/\\/g, '/')}" claude; }\n`);
  assert.ok(getSessionDirPaths(noConfig(home), home).includes(path.join(elsewhere, 'sessions')));
});

test('readAliases: the CLAUDE_CONFIG_DIR line wins over a folder mentioned earlier in the function', () => {
  const home = tmp('cr-alias10-');
  write(path.join(home, '.bashrc'), 'claudemax() {\n  python ~/.claude-tools/pre.py\n  CLAUDE_CONFIG_DIR=~/.claude-max claude "$@"\n}\n');
  const a = readAliases(home);
  assert.equal(a.get(path.join(home, '.claude-max').toUpperCase()).name, 'claudemax');
  assert.equal(a.size, 1);
});

test('readAliases: only a function that starts claude names a folder', () => {
  const home = tmp('cr-alias11-');
  write(path.join(home, 'Documents', 'WindowsPowerShell', 'profile.ps1'), [
    'function backup-max { cp -r ~/.claude-max/projects /d/bak }',
    'function copy-max { robocopy "$HOME/.claude-max" D:\bak /E }',
    'function cdc { cd ~/.claude/hooks; }',
    "function claudemax { $env:CLAUDE_CONFIG_DIR = \"$HOME\\.claude-max\"; claude @args }",
  ].join('\r\n'));
  write(path.join(home, '.bashrc'), 'cs() { claude --settings ~/.claude/settings.json; }\n');
  const a = readAliases(home);
  assert.deepEqual([...a.values()].map((x) => x.name), ['claudemax']);
});

test('readAliases: a } closing an inner block does not end the function, and a scope prefix is not the name', () => {
  const home = tmp('cr-alias12-');
  write(path.join(home, 'Documents', 'PowerShell', 'profile.ps1'), [
    'function global:claudemax {',
    '    if ($args.Count -eq 0) {',
    "        Write-Host 'x'",
    '    }',
    '    $env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\\.claude-max"',
    '    claude @args',
    '}',
  ].join('\r\n'));
  assert.equal(readAliases(home).get(path.join(home, '.claude-max').toUpperCase()).name, 'claudemax');
});

test('getSessionDirPaths scans one profile once, however an alias spells its case', () => {
  const home = tmp('cr-alias13-');
  fs.mkdirSync(path.join(home, '.claude-max', 'sessions'), { recursive: true });
  write(path.join(home, '.bashrc'), 'cm() { CLAUDE_CONFIG_DIR="$HOME/.Claude-Max" claude; }\n');
  const dirs = getSessionDirPaths(noConfig(home), home).map((d) => d.toUpperCase());
  assert.equal(dirs.filter((d) => d === path.join(home, '.claude-max', 'sessions').toUpperCase()).length, 1);
});

test('readAliases: a launcher is a function whose COMMAND runs claude, and only a folder in that command counts', () => {
  const home = tmp('cr-alias14-');
  write(path.join(home, '.bashrc'), [
    "say() { echo 'claude'; ls ~/.claude-max; }",
    'cm() { CLAUDE_CONFIG_DIR=~/.claude-pro claude "$@"; }',
    'bk() { cm; rsync -a ~/.claude-work /backup; }',
    'cw() { /c/Users/me/AppData/Roaming/npm/claude --add-dir ~/.claude-work2 "$@"; }',
    "ca() { export CLAUDE_CONFIG_DIR=\"$P/.claude-a\"; claude --add-dir ~/.claude-b; }",
  ].join('\n'));
  write(path.join(home, 'Documents', 'WindowsPowerShell', 'profile.ps1'), [
    '<#',
    '  Example: function claudex { $env:CLAUDE_CONFIG_DIR = "$HOME/.claude-x"; claude }',
    '#>',
    "function claudey { $env:CLAUDE_CONFIG_DIR = \"$HOME/.claude-y\"; & \"$env:APPDATA/npm/claude.cmd\" }",
  ].join('\r\n'));
  const names = Object.fromEntries([...readAliases(home).values()].map((a) => [path.basename(a.dir), a.name]));
  // Not .claude-work2 or .claude-b: a folder handed to claude ITSELF is not its
  // profile, and an unreadable CLAUDE_CONFIG_DIR ($P) names nothing at all.
  assert.deepEqual(names, { '.claude-pro': 'cm', '.claude-y': 'claudey' });
});

test('readAliases: the shapes a real profile uses', () => {
  const home = tmp('cr-alias16-');
  write(path.join(home, '.bashrc'), [
    "alias c1='CLAUDE_CONFIG_DIR=~/.claude-1 claude'  # first account",
    'c2() { env CLAUDE_CONFIG_DIR=~/.claude-2 claude "$@"; }',
    'c3() { CLAUDE_CONFIG_DIR=~/.claude-3 npx @anthropic-ai/claude-code "$@"; }',
  ].join('\n'));
  write(path.join(home, 'Documents', 'WindowsPowerShell', 'profile.ps1'), [
    'function Invoke-ClaudeProfile { param($D) $env:CLAUDE_CONFIG_DIR = Join-Path $HOME $D; & claude.cmd @args }',
    "function c4 { $env:CLAUDE_CONFIG_DIR = \"$HOME/.claude-4\"; & 'C:\\Program Files\\nodejs\\claude.cmd' @args }",
    'function c5 { $env:CLAUDE_CONFIG_DIR = "$HOME/.claude-5"; Start-Process -FilePath claude.cmd }',
    'function c6 { $env:CLAUDE_CONFIG_DIR = "$HOME/.claude-6"; cmd /c claude }',
    'function c7 {',
    '  function Local:log { Write-Host x }',
    '  $env:CLAUDE_CONFIG_DIR = "$HOME/.claude-7"',
    '  claude @args',
    '}',
    'function foo { <#',
    '  claude ~/.claude-x',
    '#>',
    '  Write-Host hi }',
  ].join('\r\n'));
  // The helper lives in another file and is called in lower case.
  write(path.join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'), "function c8 { invoke-claudeprofile '.claude-8' }\r\n");
  const names = Object.fromEntries([...readAliases(home).values()].map((a) => [path.basename(a.dir), a.name]));
  assert.deepEqual(names, {
    '.claude-1': 'c1', '.claude-2': 'c2', '.claude-3': 'c3', '.claude-4': 'c4',
    '.claude-5': 'c5', '.claude-6': 'c6', '.claude-7': 'c7', '.claude-8': 'c8',
  });
});

test('readAliases: an over-long line still closes its function', () => {
  const home = tmp('cr-alias15-');
  write(path.join(home, '.bashrc'), `f() {\n  echo hi\n} # ${'x'.repeat(2100)}\nexport CLAUDE_CONFIG_DIR=~/.claude-z\n`);
  assert.equal(readAliases(home).size, 0);
});

test('readAliases on a home with no profiles is empty, never a throw', () => {
  assert.equal(readAliases(tmp('cr-alias4-')).size, 0);
});

// ---- listAccounts ----------------------------------------------------------

test('listAccounts: signed-in folders only, alias names first, folder names otherwise', () => {
  const home = tmp('cr-acct-');
  const max = profile(home, '.claude-max');
  profile(home, '.claude-work');
  profile(home, '.claude-tools', false);   // not a profile at all
  profile(home, '.claude', false);         // never signed in
  const accounts = listAccounts(noConfig(home), home, aliasMap([[max, 'claudemax']]));
  assert.deepEqual(accounts.map((a) => a.name), ['claudemax', 'claude-work']);
  assert.equal(accounts[0].dir, path.resolve(max));
});

test("listAccounts: plain ~/.claude with no alias is called 'claude'", () => {
  const home = tmp('cr-acct2-');
  profile(home, '.claude');
  assert.deepEqual(listAccounts(noConfig(home), home, new Map()).map((a) => a.name), ['claude']);
});

test('listAccounts: a folder an alias opens is found outside the home folder', () => {
  const home = tmp('cr-acct3-');
  const elsewhere = profile(tmp('cr-elsewhere-'), 'work');
  const accounts = listAccounts(noConfig(home), home, aliasMap([[elsewhere, 'claudework']]));
  assert.deepEqual(accounts, [{ name: 'claudework', dir: path.resolve(elsewhere) }]);
});

test('listAccounts: alias names are given out first; a folder name already taken gets its folder added', () => {
  const home = tmp('cr-acct4-');
  profile(home, '.claude');
  const pro = profile(home, '.claude-pro');
  const accounts = listAccounts(noConfig(home), home, aliasMap([[pro, 'claude']]));
  assert.deepEqual(accounts.map((x) => [x.name, x.dir]), [['claude (.claude)', path.join(home, '.claude')], ['claude', pro]]);
});

test('listAccounts: a name never moves to another folder when one signs in or out', () => {
  const home = tmp('cr-acct6-');
  profile(home, '.claude', false);
  const pro = profile(home, '.claude-pro');
  const aliases = aliasMap([[pro, 'claude']]);
  assert.deepEqual(listAccounts(noConfig(home), home, aliases).map((x) => [x.name, x.dir]), [['claude', pro]]);
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '');
  assert.equal(listAccounts(noConfig(home), home, aliases).find((x) => x.name === 'claude').dir, pro);
});


// ---- launchSession with an account -----------------------------------------

function fakeSpawner() {
  const calls = [];
  const spawner = (file, args) => {
    calls.push(args);
    return { pid: 4242, unref() {}, on() { return this; } };
  };
  return { spawner, calls };
}

function launchCtx(extra = {}) {
  const dir = tmp('cr-launch-');
  const base = path.join(dir, 'projects');
  fs.mkdirSync(path.join(base, 'Beacon'), { recursive: true });
  const { spawner, calls } = fakeSpawner();
  return {
    calls,
    ctx: {
      baseDir: base,
      spawner,
      registryPath: path.join(dir, 'sessions.json'),
      pidDir: path.join(dir, 'pids'),
      sessionDirs: testSessionDirs(dir),
      lastAccountsPath: path.join(dir, 'last-accounts.json'),
      configPath: path.join(dir, 'config.json'),
      isPidAlive: () => false,
      claudeConfigDir: 'C:\\configured',
      openingReport: false,
      preLaunchCommand: null,
      accounts: [{ name: 'claudemax', dir: 'C:\\p\\max' }, { name: 'claudepro', dir: 'C:\\p\\pro' }, { name: 'claude', dir: path.join(os.homedir(), '.claude') }],
      ...extra,
    },
  };
}

const configDirArg = (args) => { const i = args.indexOf('-ConfigDir'); return i === -1 ? null : args[i + 1]; };

test('a picked account launches in its folder, is named on the view, and is remembered for the project', () => {
  const { ctx, calls } = launchCtx();
  const r = launchSession(ctx, 'Beacon', 'claudepro');
  assert.equal(r.ok, true);
  assert.equal(configDirArg(calls[0]), 'C:\\p\\pro');
  assert.equal(r.session.account, 'claudepro');
  assert.equal(r.session.row_name, 'Beacon', 'the 202 says what the Code tab calls it');
  assert.deepEqual(readLastAccounts(ctx.lastAccountsPath), { [path.join(ctx.baseDir, 'Beacon')]: 'claudepro' });
});

test('an account not on the list is refused and nothing starts', () => {
  for (const bad of ['claudegone', '', null, 7, { name: 'claudemax' }, 'C:\\p\\max']) {
    const { ctx, calls } = launchCtx();
    assert.deepEqual(launchSession(ctx, 'Beacon', bad), { ok: false, status: 400, error: 'account_unknown' }, String(bad));
    assert.equal(calls.length, 0);
    assert.equal(fs.existsSync(ctx.lastAccountsPath), false);
  }
});

test('the plain ~/.claude account launches with no profile folder, even when another is configured', () => {
  const trusted = [];
  const { ctx, calls } = launchCtx({ trustFolders: true, trustFolder: (folder, dir) => { trusted.push(dir); return true; } });
  launchSession(ctx, 'Beacon', 'claude');
  assert.equal(configDirArg(calls[0]), null);
  assert.deepEqual(trusted, [null], 'trust goes to the home state file, as for a plain claude');
});

test('a refused account touches nothing: a failed launch keeps its pid and reason files', () => {
  const { ctx } = launchCtx();
  const name = deriveSessionName(path.join(ctx.baseDir, 'Beacon'), ctx.baseDir);
  const pidFile = path.join(ctx.pidDir, pidFileNameFor(name));
  fs.mkdirSync(ctx.pidDir, { recursive: true });
  fs.writeFileSync(`${pidFile}.err`, 'could not start: example');
  assert.equal(launchSession(ctx, 'Beacon', 'claudegone').error, 'account_unknown');
  assert.equal(fs.readFileSync(`${pidFile}.err`, 'utf8'), 'could not start: example');
});

test('a project already starting is reported as it is, whatever account a second tap names, and nothing new starts', () => {
  const { ctx, calls } = launchCtx();
  launchSession(ctx, 'Beacon', 'claudemax');
  const again = launchSession(ctx, 'Beacon', 'claudegone');
  assert.equal(again.reused, true);
  assert.equal(again.session.account, 'claudemax');
  assert.equal(calls.length, 1);
});

test('a configured claude_config_dir is used exactly as set, even when it names ~/.claude', () => {
  const plain = path.join(os.homedir(), '.claude');
  const { ctx, calls } = launchCtx({ claudeConfigDir: plain });
  launchSession(ctx, 'Beacon');
  assert.equal(configDirArg(calls[0]), plain);
});

test('no account keeps the old launch exactly: the configured profile, nothing remembered', () => {
  const { ctx, calls } = launchCtx();
  const r = launchSession(ctx, 'Beacon');
  assert.equal(configDirArg(calls[0]), 'C:\\configured');
  assert.equal('account' in r.session, false);
  assert.equal(fs.existsSync(ctx.lastAccountsPath), false);
});

test('folder trust is written into the picked account, not the configured one', () => {
  const trusted = [];
  const { ctx } = launchCtx({ trustFolders: true, trustFolder: (folder, dir) => { trusted.push(dir); return true; } });
  launchSession(ctx, 'Beacon', 'claudemax');
  assert.deepEqual(trusted, ['C:\\p\\max']);
});

// ---- GET /api/projects ------------------------------------------------------

test('GET /api/projects carries the accounts, the last used ones and the configured one', async () => {
  const dir = tmp('cr-srv-');
  const base = path.join(dir, 'projects');
  fs.mkdirSync(path.join(base, 'Beacon'), { recursive: true });
  const ctx = {
    dir,
    baseDir: base,
    passcodePath: path.join(dir, 'passcode.json'),
    attemptsPath: path.join(dir, 'attempts.json'),
    registryPath: path.join(dir, 'sessions.json'),
    pidDir: path.join(dir, 'pids'),
    configPath: path.join(dir, 'config.json'),
    pushPath: path.join(dir, 'push.json'),
    sessionDirs: testSessionDirs(dir),
    lastAccountsPath: path.join(dir, 'last-accounts.json'),
    tokens: new Map(),
    claudeConfigDir: path.join(os.homedir(), '.claude-pro'),
    accounts: [
      { name: 'claudemax', dir: path.join(os.homedir(), '.claude-max') },
      { name: 'claudepro', dir: path.join(os.homedir(), '.claude-pro') },
    ],
  };
  fs.writeFileSync(ctx.lastAccountsPath, JSON.stringify({ 'F:\\x\\Beacon': 'claudemax' }));
  seedPasscode(ctx, '481902');
  const token = issueTestToken(ctx);
  const server = fixtureServer(ctx);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await makeAuthedFetch(`http://127.0.0.1:${server.address().port}`, token)('/api/projects');
    const body = await res.json();
    assert.deepEqual(body.accounts, [
      { name: 'claudemax', dir: path.join(os.homedir(), '.claude-max'), folder: '~/.claude-max' },
      { name: 'claudepro', dir: path.join(os.homedir(), '.claude-pro'), folder: '~/.claude-pro' },
    ]);
    assert.deepEqual(body.last_accounts, { 'F:\\x\\Beacon': 'claudemax' });
    assert.equal(body.default_account, 'claudepro');
  } finally {
    server.close();
  }
});

// ---- the phone's side --------------------------------------------------------

test('the hand-off names the account in the approved words, and the row by its folder name', () => {
  assert.equal(handoffCopy('Beacon', 'claudemax').body, 'Open Claude → Code, signed in as claudemax, and tap Beacon.');
  assert.equal(handoffCopy('Pull Requests/Vercel', 'claudemax').body, 'Open Claude → Code, signed in as claudemax, and tap Vercel.');
  assert.equal(handoffCopy('Work/email-lint', 'claudemax', 'email-lint (Work)').body, 'Open Claude → Code, signed in as claudemax, and tap email-lint (Work).');
  assert.equal(handoffCopy('Beacon').body, 'Open Claude → Code, then pick the session for Beacon.');
});

const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function makeChoices(state) {
  const src = appJs.slice(appJs.indexOf('function lastAccountFor('), appJs.indexOf('function openAcctMenu('));
  return new Function('state', src + '; return accountChoices;')(state);
}

const ACCOUNTS = [
  { name: 'claudepro', dir: 'C:\\p\\pro', folder: '~/.claude-pro' },
  { name: 'claudemax', dir: 'C:\\p\\max', folder: '~/.claude-max' },
  { name: 'claudework', dir: 'C:\\p\\work', folder: '~/.claude-work' },
];

test('the question puts the last used account first and lights it, the rest by name', () => {
  const choices = makeChoices({ accounts: ACCOUNTS, lastAccounts: { 'f:\\X\\Beacon': 'claudework' }, defaultAccount: 'claudepro' })('F:\\x\\beacon');
  assert.deepEqual(choices.map((c) => [c.name, c.lit, c.last]), [
    ['claudework', true, true], ['claudemax', false, false], ['claudepro', false, false],
  ]);
});

test('a project never started lights the configured account, not as last used; with none configured nothing is lit', () => {
  const lit = makeChoices({ accounts: ACCOUNTS, lastAccounts: {}, defaultAccount: 'claudepro' })('F:\\x\\Beacon');
  assert.deepEqual(lit.map((c) => [c.name, c.lit, c.last]), [
    ['claudepro', true, false], ['claudemax', false, false], ['claudework', false, false],
  ]);
  const none = makeChoices({ accounts: ACCOUNTS, lastAccounts: {}, defaultAccount: null })('F:\\x\\Beacon');
  assert.deepEqual(none.map((c) => c.lit), [false, false, false]);
});

test('a last account that is no longer on the PC lights nothing rather than a ghost', () => {
  const choices = makeChoices({ accounts: ACCOUNTS, lastAccounts: { 'F:\\x\\Beacon': 'claudegone' }, defaultAccount: null })('F:\\x\\Beacon');
  assert.deepEqual(choices.map((c) => c.lit), [false, false, false]);
});

function makeRowState(state) {
  const src = appJs.slice(appJs.indexOf('function rowState('), appJs.indexOf('function setDot('));
  return new Function('state', 'sessionFor', 'elapsed', src + '; return rowState;')(
    state,
    (p) => (state.sessions || []).find((s) => s.path === p.path) ?? null,
    () => '1m',
  );
}

const ROW = { launching: new Set(), stopping: new Set(), results: new Map() };

test('a tile names its account only when the PC has two or more', () => {
  const sessions = [
    { path: 'F:/p/A', status: 'running', account: 'claudemax' },
    { path: 'F:/p/B', status: 'running', source: 'desk', config_dir: 'c:\\P\\PRO', activity: 'busy' },
  ];
  const two = makeRowState({ ...ROW, sessions, accounts: ACCOUNTS });
  assert.equal(two({ name: 'A', path: 'F:/p/A' }).suffix, 'claudemax');
  assert.equal(two({ name: 'B', path: 'F:/p/B' }).suffix, 'desktop - claudepro');
  const one = makeRowState({ ...ROW, sessions, accounts: [ACCOUNTS[0]] });
  assert.equal(one({ name: 'A', path: 'F:/p/A' }).suffix, undefined);
  assert.equal(one({ name: 'B', path: 'F:/p/B' }).suffix, 'desktop');
});

test('a launch the agent accepted names the account from its 202, before the registry is polled', () => {
  const results = new Map([['A', { kind: 'started', session: { started_at: new Date().toISOString(), account: 'claudepro' } }]]);
  const rs = makeRowState({ ...ROW, results, sessions: [], accounts: ACCOUNTS })({ name: 'A', path: 'F:/p/A' });
  assert.equal(rs.status, 'starting...');
  assert.equal(rs.suffix, 'claudepro');
});

test('the start banner names the account the agent answered with, not the one tapped', () => {
  const fn = appJs.slice(appJs.indexOf('async function startLaunch('), appJs.indexOf('// T100'));
  assert.match(fn, /const started = typeof res\.data\.account === 'string' \? res\.data\.account : null;/);
  assert.doesNotMatch(fn, /\.\.\.\(account \?/);
});

test('with two or more accounts a project tap asks first; with one it launches', () => {
  const tap = appJs.slice(appJs.indexOf('async function onProjectTap('), appJs.indexOf('async function startLaunch('));
  assert.match(tap, /if \(state\.accounts\.length >= 2\) \{ openAcctMenu\(name, row\.dataset\.path \|\| ''\); return; \}\s*await startLaunch\(name\);/);
});
