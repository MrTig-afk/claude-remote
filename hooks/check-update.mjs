// SessionStart hook: say so when the plugin carries a newer agent than the copy
// that actually runs.
//
// /claude-remote:setup copies agent/ (minus its tests) and release-notes.json
// into %LOCALAPPDATA%\claude-remote, because the plugin's own folder is named
// after its version and moves on every update - autostart cannot point at it.
// So a plugin update changes nothing on its own; the copy keeps running until
// setup runs again. This compares the two by content, which needs no version
// number, and prints one line when they differ.
//
// Silent in every other case - never set up, nothing changed, anything
// unreadable. A hook that fires in every session of every project must never
// be the thing that breaks one.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MESSAGE = 'Claude Remote has an update. Run /claude-remote:setup to install it on this PC.';

/** One hash over every file setup copies: agent/ minus agent/test, plus release-notes.json. */
export function installedHash(root) {
  const agent = path.join(root, 'agent');
  const files = fs.readdirSync(agent, { recursive: true })
    .map((rel) => rel.split(path.sep).join('/'))
    .filter((rel) => rel !== 'test' && !rel.startsWith('test/')   // setup does not copy the tests
      && fs.statSync(path.join(agent, rel)).isFile());
  const hash = crypto.createHash('sha256');
  for (const rel of files.sort()) {
    hash.update(`agent/${rel}\0`).update(fs.readFileSync(path.join(agent, rel))).update('\0');
  }
  return hash.update(fs.readFileSync(path.join(root, 'release-notes.json'))).digest('hex');
}

/** The message to show, or null. Never throws. */
export function updateMessage(pluginRoot, installRoot) {
  try {
    if (!fs.existsSync(path.join(installRoot, 'agent', 'server.js'))) return null;   // never set up
    return installedHash(pluginRoot) === installedHash(installRoot) ? null : MESSAGE;
  } catch {
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const local = process.env.LOCALAPPDATA;
  const msg = pluginRoot && local ? updateMessage(pluginRoot, path.join(local, 'claude-remote')) : null;
  if (msg) process.stdout.write(JSON.stringify({ systemMessage: msg }));
}
