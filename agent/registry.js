import fs from 'node:fs';
import path from 'node:path';

import { getRegistryFilePath, getPidDirPath } from './config.js';
import { resolveProjectPath, deriveSessionName } from './sessions.js';

export const STARTING_GRACE_MS = 30_000;
export const REGISTRY_VERSION = 1;

/** process.kill(pid, 0): true if a process with that pid exists. Never throws. */
// ponytail: Windows recycles pids, and nothing in node's builtins can tell a
// recycled pid from the original. A session whose pid is later reused by an
// unrelated process reports "running" forever, so the owner can never relaunch
// that project from the phone. Upgrade path if it ever bites: store the
// process start time alongside the pid and compare both. Not worth it until
// someone actually hits it - pid space is large and sessions are short-lived.
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves <pidDir>/<sessionName>.pid, refusing to act on it unless it is a
 * direct child of pidDir. sessionName always comes from deriveSessionName in
 * practice, so this never trips - it exists as a defensive backstop, not a
 * sanitizer.
 */
function pidFilePathFor(pidDir, sessionName) {
  const resolvedDir = path.resolve(pidDir);
  const pidFilePath = path.join(resolvedDir, `${sessionName}.pid`);
  if (path.dirname(pidFilePath) !== resolvedDir) {
    return null;
  }
  return pidFilePath;
}

/** Reads a pid file, returning a positive integer pid or null (no file / junk). */
function readPidFile(pidDir, sessionName) {
  const pidFilePath = pidFilePathFor(pidDir, sessionName);
  if (pidFilePath === null) return null;

  let raw;
  try {
    raw = fs.readFileSync(pidFilePath, 'utf8');
  } catch {
    return null;
  }

  raw = raw.replace(/^﻿/, '').trim();
  if (raw === '') return null;

  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** Best-effort unlink of <pidDir>/<sessionName>.pid. Never throws. */
export function clearPidFile(ctx, sessionName) {
  const pidDir = ctx.pidDir || getPidDirPath();
  const pidFilePath = pidFilePathFor(pidDir, sessionName);
  if (pidFilePath === null) return;
  try {
    fs.unlinkSync(pidFilePath);
  } catch {
    // ENOENT (already gone) or anything else - best effort, never throw.
  }
}

function writeRegistry(registryPath, sessions) {
  try {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const json = JSON.stringify({ version: REGISTRY_VERSION, sessions }, null, 2);
    const tmp = `${registryPath}.tmp`;
    // ponytail: read-modify-write with no lock. Two concurrent POSTs for
    // different projects can interleave so the second overwrites the first's
    // entry, losing it from the registry (worst case: a duplicate session
    // later). Single-user agent on loopback, so the window is theoretical.
    // Upgrade path: an O_EXCL lockfile around read+write, or an append-only
    // log compacted on read.
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, registryPath);
  } catch (err) {
    console.warn(`claude-remote agent: could not write registry '${registryPath}': ${err.code || err.message}`);
  }
}

/**
 * Every live session, pruned and re-validated against ctx.baseDir. Writes
 * the pruned registry back only if entries were dropped. Never throws: any
 * read/parse/validate failure yields [].
 */
export function listSessions(ctx) {
  const {
    baseDir,
    registryPath = getRegistryFilePath(),
    pidDir = getPidDirPath(),
    isPidAlive: isAlive = isPidAlive,
    now = Date.now,
  } = ctx;

  let raw;
  try {
    raw = fs.readFileSync(registryPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`claude-remote agent: could not read registry '${registryPath}': ${err.code || err.message}`);
    }
    return [];
  }

  if (raw.trim() === '') return [];

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }

  if (
    data === null ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    data.version !== REGISTRY_VERSION ||
    !Array.isArray(data.sessions)
  ) {
    return [];
  }

  const nowMs = now();
  const survivors = [];
  const views = [];
  let droppedAny = false;

  for (const entry of data.sessions) {
    const drop = (sessionNameForCleanup) => {
      droppedAny = true;
      if (typeof sessionNameForCleanup === 'string' && sessionNameForCleanup !== '') {
        clearPidFile({ pidDir }, sessionNameForCleanup);
      }
    };

    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      drop(undefined);
      continue;
    }

    const { session_name: sessionName, project, original_path: originalPath, started_at: startedAt } = entry;

    if (
      typeof sessionName !== 'string' || sessionName === '' ||
      typeof project !== 'string' || project === '' ||
      typeof originalPath !== 'string' || originalPath === '' ||
      !Number.isFinite(Date.parse(startedAt))
    ) {
      drop(sessionName);
      continue;
    }

    const r = resolveProjectPath(baseDir, project);
    if (!r.ok) {
      drop(sessionName);
      continue;
    }
    if (r.path !== path.resolve(originalPath)) {
      drop(sessionName);
      continue;
    }
    if (deriveSessionName(r.path) !== sessionName) {
      drop(sessionName);
      continue;
    }

    const pid = readPidFile(pidDir, sessionName);
    let status;
    if (pid !== null) {
      if (isAlive(pid)) {
        status = 'running';
      } else {
        drop(sessionName);
        continue;
      }
    } else if (nowMs - Date.parse(startedAt) < STARTING_GRACE_MS) {
      status = 'starting';
    } else {
      drop(sessionName);
      continue;
    }

    survivors.push(entry);
    views.push({
      session_name: sessionName,
      project,
      path: r.path,
      status,
      started_at: startedAt,
      pid: status === 'running' ? pid : null,
    });
  }

  if (droppedAny) {
    writeRegistry(registryPath, survivors);
  }

  return views;
}

/** The live SessionView whose session_name === sessionName, or null. */
export function findLiveSession(ctx, sessionName) {
  const sessions = listSessions(ctx);
  return sessions.find((s) => s.session_name === sessionName) || null;
}

/**
 * Appends a launch record, creating the data directory if absent, and
 * returns the SessionView for it (status 'starting', pid null). Never
 * throws; a write failure is logged and the SessionView is still returned.
 */
export function recordLaunch(ctx, { sessionName, project, projectPath }) {
  const { registryPath = getRegistryFilePath(), now = Date.now } = ctx;

  const startedAt = new Date(now()).toISOString();

  let sessions = [];
  try {
    const raw = fs.readFileSync(registryPath, 'utf8');
    if (raw.trim() !== '') {
      const parsed = JSON.parse(raw);
      if (
        parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
        parsed.version === REGISTRY_VERSION && Array.isArray(parsed.sessions)
      ) {
        sessions = parsed.sessions;
      }
    }
  } catch {
    // Missing or corrupt - treated as empty, same contract as listSessions.
  }

  sessions.push({
    session_name: sessionName,
    project,
    original_path: projectPath,
    started_at: startedAt,
  });

  writeRegistry(registryPath, sessions);

  return {
    session_name: sessionName,
    project,
    path: projectPath,
    status: 'starting',
    started_at: startedAt,
    pid: null,
  };
}
