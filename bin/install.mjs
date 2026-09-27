#!/usr/bin/env node
// `npx.cmd -y github:MrTig-afk/claude-remote` - the whole install in one paste
// (owner 2026-09-27: "it should be seamless"). Adds or refreshes the
// marketplace, installs or updates the plugin, asks Claude Code where the
// plugin landed - so any profile (CLAUDE_CONFIG_DIR) works - and starts the
// plugin's own setup at once (hooks/check-update.mjs --now), which opens the
// browser on the passcode screen. No restart. Every line it prints is Claude
// Code's or the hook's, except the two failures below.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NOT_WINDOWS } from '../hooks/check-update.mjs';

export const ID = 'claude-remote@claude-remote';
export const NO_CLAUDE = 'Claude Remote needs Claude Code first: install it from claude.com/claude-code, then paste this again.';
export const NOT_INSTALLED = 'Claude Remote did not install - Claude Code said why above.';

/**
 * Where `claude plugin list --json` says the plugin is installed, or null.
 * The user-scope copy - the one `plugin install` / `plugin update` just made
 * current - first: the list also carries project-scope copies from other
 * projects, possibly older and listed earlier (NPX-C1-D2-01).
 */
export function pluginRoot(listJson) {
  try {
    const hits = JSON.parse(listJson).filter((p) => p && p.id === ID && typeof p.installPath === 'string');
    return (hits.find((p) => p.scope === 'user') || hits[0] || {}).installPath || null;
  } catch {
    return null;
  }
}

/**
 * Options for every child. cwd System32, never the caller's: the line is
 * pasted into Claude Code, whose cwd is the open project, and cmd.exe looks in
 * the current folder before PATH - a cloned repo's claude.cmd would run in the
 * person's name (NPX-C1-S01). hooks/check-update.mjs does the same.
 */
export function spawnOptions(capture) {
  return {
    cwd: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
    shell: true,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  };
}

// cmd.exe finds claude.cmd (npm install) and claude.exe (native installer)
// through PATHEXT; it does not run claude.ps1, which npm always pairs with a
// .cmd. The arguments are constants.
function claude(args, capture) {
  return spawnSync(`claude ${args}`, spawnOptions(capture));
}

function main() {
  if (process.platform !== 'win32') { console.log(NOT_WINDOWS); return 1; }
  if (claude('--version', true).status !== 0) { console.log(NO_CLAUDE); return 1; }
  // Each step may say "already": a second paste must still reach the newest
  // version (NPX-C1-02), so the marketplace is refreshed and the plugin updated.
  claude('plugin marketplace add MrTig-afk/claude-remote');
  claude('plugin marketplace update claude-remote');
  claude(`plugin install ${ID}`);
  claude(`plugin update ${ID}`);
  const root = pluginRoot(claude('plugin list --json', true).stdout);
  if (!root) { console.log(NOT_INSTALLED); return 1; }
  const hook = path.join(root, 'hooks', 'check-update.mjs');
  return spawnSync(process.execPath, [hook, '--now'], { ...spawnOptions(false), shell: false }).status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = main();
