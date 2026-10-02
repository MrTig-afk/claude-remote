// SessionStart hook: the plugin updates the agent by itself, in the
// background, with no window - and sets it up only when asked.
//
// SET UP ON THE PERSON'S ASK, NEVER BY ITSELF (PRD R21.0, Artifact sequence
// 35; owner at the Dell test, 2026-10-02: "it is RELENTLESS"). With no agent in
// %LOCALAPPDATA%\claude-remote, a Claude start installs nothing and opens
// nothing: it says NOT_SET_UP, at every start until set up. The ask is --now
// (the one-line install, and /claude-remote:setup's first step): it checks the
// machine can run it and starts update-agent.ps1 as a DETACHED, WINDOWLESS
// job, then returns at once.
//
// An agent already here that differs from the plugin's, compared by content
// (no version number needed), is updated at a Claude start, the same hidden
// way. The job records how it went; the NEXT start prints that, once.
//
// Silent in every case the spec gives no line for, and on any error. A hook
// that fires in every session of every project must never be the thing that
// breaks one.
//
// A PC WHOSE LOGON TASK RUNS AN AGENT FROM ANYWHERE ELSE IS LEFT ALONE - no
// install, no update, no line. A git checkout started by the task
// is a real set-up, and update-agent.ps1 would stop it and re-point the task.
//
// No phone code at a Claude start (cut at sequence 35): the browser shows it
// after the passcode, and /claude-remote:setup prints it (--print-qr <url>).
//
// WHY THE JOB IS A SECOND NODE PROCESS, NOT POWERSHELL DIRECTLY. Measured on
// Windows 11, 2026-09-27:
//   - A child spawned WITHOUT `detached` died the moment its node parent
//     exited; a detached one lived on. So the job must be detached.
//   - But `detached` is DETACHED_PROCESS, a process with no console at all,
//     and PowerShell started that way did not run its script: `Start-Sleep
//     20` was gone within 1.5s, and a stand-in install script never wrote its
//     last line, in 3 of 3 runs.
//   - So the hook starts a DETACHED NODE (no console, so no window), and that
//     node starts PowerShell with windowsHide and piped output, which libuv
//     turns into CREATE_NO_WINDOW: a console with no window, inherited by the
//     robocopy, csc and cmd below it.
// The check: every visible top-level window enumerated every ~20ms (by
// window, not by process - a Windows 11 console belongs to WindowsTerminal),
// through this hook end to end with a stand-in update-agent.ps1 that runs
// robocopy, cmd, csc, where, a CIM query and the hidelaunch probe: 0 new
// windows in 4 runs. Positive controls, same watcher: a console program
// started by a console-less parent without windowsHide, and Start-Process of
// one, each put a Windows Terminal window up (and took focus) within a second.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { qrMatrix } from '../agent/public/qr.js';

// Verbatim.
export const SETTING_UP = 'Claude Remote is setting itself up on this PC. Your browser will open on its passcode screen in a moment.';
export const NEEDS_TAILSCALE = 'Claude Remote needs Tailscale on this PC, running and signed in, before it can set itself up. Get it from tailscale.com/download, sign in, then run /claude-remote:setup.';
// Opened alongside NEEDS_TAILSCALE: a new PC gets the page, not only a sentence.
export const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download';
export const NOT_WINDOWS = 'Claude Remote runs on Windows 10 and 11 only, so it has not set itself up here.';
export const NEEDS_NODE = 'Claude Remote needs Node.js 24.2 or newer. Install it from nodejs.org, then run /claude-remote:setup.';
// Sequence 36: pointers, at every Claude start until the PC is set up.
export const NOT_SET_UP = [
  'Claude Remote is installed but not set up yet.',
  '• Set it up: run /claude-remote:setup (a passcode, then a QR code for your phone)',
  '• Your phone needs the Tailscale app, signed in to the same account',
  '• Add it to your phone like an app:',
  '  - iPhone / iPad: open the link in Safari → Share → Add to Home Screen',
  '  - Android: open the link in Chrome → ⋮ → Add to Home screen',
].join('\n');
export const UPDATED = 'Claude Remote updated itself on this PC. The app on your phone picks it up the next time it opens.';
// --now only (an agent relays these; a session start stays silent there).
export const ALREADY_RUNNING = 'Claude Remote is already setting itself up on this PC.';
export const UP_TO_DATE = 'Claude Remote is already installed and up to date on this PC.';
export const RUNS_ELSEWHERE = 'Claude Remote did not install: this PC already runs its agent another way, so it was left as it is.';
export const UPDATING = 'Claude Remote is updating itself on this PC in the background.';
export function setupFailed(reason) {
  return `Claude Remote couldn't set itself up: ${reason}. Run /claude-remote:setup to try again and see the details.`;
}
export function updateFailed(reason) {
  return `Claude Remote couldn't update itself: ${reason}. Run /claude-remote:setup to try again and see the details.`;
}

// The longest a job can run: update-agent.ps1 is killed at INSTALL_TIMEOUT_MS,
// then a first install asks the agent up to ANSWER_TRIES times. A lock younger
// than that may belong to a live job, so the stale window is longer still.
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const ANSWER_TRIES = 60;
const ANSWER_WAIT_MS = 500;
const ANSWER_TIMEOUT_MS = 2000;
export const LONGEST_JOB_MS = INSTALL_TIMEOUT_MS + ANSWER_TRIES * (ANSWER_WAIT_MS + ANSWER_TIMEOUT_MS);
export const LOCK_STALE_MS = LONGEST_JOB_MS + 5 * 60 * 1000;   // + node's start and the state write, generously
export const DEFAULT_PORT = 8790;
export const TASK_NAME = 'Claude Remote Agent';   // register-task.ps1's default -TaskName

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

/** 'v24.2.0' or '24.2.0' -> is it at least 24.2.0. */
export function nodeVersionOk(version) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  return major > 24 || (major === 24 && minor >= 2);
}

/** `tailscale status --json` stdout -> running and signed in. */
export function tailscaleReady(stdout) {
  try {
    return JSON.parse(stdout)?.BackendState === 'Running';
  } catch {
    return false;
  }
}

/** Is `name` a file in one of PATH's folders. */
export function onPath(name, pathValue) {
  return String(pathValue || '').split(path.delimiter).some((dir) => {
    try {
      return dir !== '' && fs.statSync(path.join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
}

/** The first line worth showing from a failed update-agent.ps1: its throw message. */
export function firstReason(stderr, stdout, code) {
  const line = [stderr, stdout].map((s) => String(s || '').split(/\r?\n/)
    .map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('WARNING:')))
    .find(Boolean);
  const text = line || `update-agent.ps1 exited with code ${code}`;
  return text.replace(/[.\s]+$/, '').slice(0, 300);
}

// --- State, kept in the plugin's data folder: the one update-agent.ps1 never
// swaps, and where the passcode and config already live. -------------------

export function stateFiles(dataDir) {
  return { state: path.join(dataDir, 'auto-setup.json'), lock: path.join(dataDir, 'auto-setup.lock') };
}

function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

// THE LOCK. It appears WITH its content - written to a temp
// file first, then hard-linked into place, which fails EEXIST when a lock is
// already there - so no reader ever sees an empty lock and takes it for dead.
// It holds the taker's random token, and only that token's job removes it.

/** The lock's text; null when there is none; undefined when it cannot be read right now. */
function readLock(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err.code === 'ENOENT' ? null : undefined;
  }
}

/** A lock that cannot be read right now counts as held; one that reads as garbage (an older hook's, died mid-write) does not. */
function lockFresh(raw, now) {
  if (raw === undefined) return true;
  try {
    return now - Number(JSON.parse(raw).started) < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** A lock younger than LOCK_STALE_MS. */
export function lockHeld(lockFile, now) {
  const raw = readLock(lockFile);
  return raw !== null && lockFresh(raw, now);
}

/**
 * Removes the lock only if it still holds `raw`, the text the caller judged.
 * Moved aside first (a rename is atomic), then compared: a newer lock that
 * landed after the caller read is put back, never deleted.
 */
export function removeLockIfStill(lockFile, raw) {
  const aside = `${lockFile}.${crypto.randomUUID()}.old`;
  try {
    fs.renameSync(lockFile, aside);
  } catch {
    return;   // gone already, or busy: nothing of ours to remove
  }
  try {
    if (readLock(aside) !== raw) {
      try { fs.linkSync(aside, lockFile); } catch { /* newer still: that one stands */ }
    }
  } finally {
    fs.rmSync(aside, { force: true });
  }
}

/** Takes the install lock; -> its token, or null while another job holds it. */
export function takeLock(lockFile, now) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const token = crypto.randomUUID();
  const tmp = `${lockFile}.${token}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ token, started: now }));
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fs.linkSync(tmp, lockFile);
        return token;
      } catch (err) {
        if (err.code !== 'EEXIST') return null;
      }
      const raw = readLock(lockFile);
      if (raw !== null && lockFresh(raw, now)) return null;
      if (raw !== null) removeLockIfStill(lockFile, raw);   // a job that died without cleaning up
    }
    // Known limit: three racers on one stale lock can still leave two jobs if a
    // restore loses to a third take; each job then keeps its own token safe.
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** A job gives back only its own lock. */
export function releaseLock(lockFile, token) {
  const raw = readLock(lockFile);
  try {
    if (token && raw && JSON.parse(raw).token === token) removeLockIfStill(lockFile, raw);
  } catch { /* not ours to judge */ }
}

// --- The logon task ---------------------------------------------

function xmlText(s) {
  return s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    const named = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[e.toLowerCase()];
    if (named) return named;
    return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  });
}

/**
 * What the "Claude Remote Agent" task runs, from `schtasks /query /xml`.
 * q: { ok: true, stdout } | { ok: false, missing }. -> 'none' (no task),
 * 'ours' (it runs <target>\agent\server.js), or 'other' - another copy, or a
 * query that failed for any other reason. 'other' means leave the PC alone.
 */
export function taskVerdict(q, target) {
  if (!q || !q.ok) return q && q.missing ? 'none' : 'other';
  const args = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(String(q.stdout));
  if (!args) return 'other';
  // Quotes stripped: older installs quoted the command line differently.
  const line = ` ${xmlText(args[1]).replace(/"/g, ' ').toLowerCase()} `;
  const server = path.join(target, 'agent', 'server.js').toLowerCase();
  return line.includes(` ${server} `) ? 'ours' : 'other';
}

/** Smart App Control, from `reg query` of VerifiedAndReputablePolicyState: true for On (1) only. */
export function sacOn(stdout) {
  return /VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x1\s*$/im.test(String(stdout || ''));
}

/**
 * True when our own task still starts the self-built launcher on a PC whose
 * Smart App Control is On. Windows re-rates an unsigned program and can block
 * it at any restart (2026-09-27); register-task.ps1 uses conhost.exe there, so
 * an install made before SAC went On is re-registered.
 */
export function launcherStale(q, target) {
  if (taskVerdict(q, target) !== 'ours') return false;
  const cmd = /<Command>([\s\S]*?)<\/Command>/.exec(String(q.stdout));
  return !cmd || !/\\conhost\.exe$/i.test(xmlText(cmd[1]).trim());
}

// --- The phone code in the terminal -------------------------

/**
 * The QR for `text` in block characters, one string per line: a 2-module
 * quiet zone, the LIGHT modules drawn (a terminal's background is dark), two
 * module rows per line. The drawing measured to scan from a SessionStart
 * systemMessage on 2026-09-27.
 */
export function qrBlocks(text) {
  const dark = qrMatrix(text);
  const q = 2;
  const n = dark.length + q * 2;
  const light = (x, y) => {
    const i = y - q;
    const j = x - q;
    return !(i >= 0 && j >= 0 && i < dark.length && j < dark.length && dark[i][j]);
  };
  const lines = [];
  for (let y = 0; y < n; y += 2) {
    let s = '';
    for (let x = 0; x < n; x += 1) {
      const top = light(x, y);
      const bot = y + 1 < n ? light(x, y + 1) : false;
      s += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' ';
    }
    lines.push(s);
  }
  return lines;
}

/** The line for a finished job, or null (a first install that worked says it by opening the browser). */
export function outcomeLine(last) {
  if (last.ok) return last.kind === 'update' ? UPDATED : null;
  return last.kind === 'update' ? updateFailed(last.reason) : setupFailed(last.reason);
}

/**
 * Everything the hook does at a session start, with every outside effect
 * handed in. -> the line to show, or null.
 *
 * deps: platform, pluginRoot, localAppData, dataDir, pathValue, nodeVersion,
 * now, tailscaleStatus() -> Promise<stdout|null>, taskQuery() -> Promise<q>
 * (see taskVerdict), startJob(job), and optionally agentRunning() ->
 * Promise<boolean>, passcodeSet() -> Promise<boolean|null>, sacStatus() and
 * openBrowser(url).
 */
export async function sessionStart(deps) {
  const { pluginRoot, localAppData, dataDir } = deps;
  if (!pluginRoot || !dataDir) return null;
  // deps.explain (--now): an agent asked for this and will relay the answer,
  // so every branch that is silent at a session start says what happened.
  const quiet = (line) => (deps.explain ? line : null);
  const files = stateFiles(dataDir);
  let state = readState(files.state);

  if (deps.platform !== 'win32') {
    if (state.nonWindowsNoted) return quiet(NOT_WINDOWS);
    writeState(files.state, { ...state, nonWindowsNoted: true });
    return NOT_WINDOWS;
  }
  if (!localAppData) return quiet(setupFailed('this PC has no LOCALAPPDATA folder'));

  // The last job's outcome, once. Then stop for this start: one line per start.
  // A first install that worked has no line (the browser said it).
  if (state.last && !state.last.reported) {
    state = { ...state, last: { ...state.last, reported: true } };
    writeState(files.state, state);
    const line = outcomeLine(state.last);
    if (line) return line;
  }

  // An install still running: a second Claude says nothing and starts nothing.
  if (lockHeld(files.lock, deps.now)) return quiet(ALREADY_RUNNING);

  const target = path.join(localAppData, 'claude-remote');
  const kind = fs.existsSync(path.join(target, 'agent', 'server.js')) ? 'update' : 'install';
  const hash = installedHash(pluginRoot);
  // Up to date - unless Smart App Control went On after the install: then the
  // same version is installed again, which re-registers the task with the
  // launcher Windows allows. The failed-same-version guard below stops a loop.
  // Both asked at once: in series they came close to the hook's 10s limit.
  // A copy with no passcode yet is not set up either: the browser was closed
  // at the passcode screen. Unknown (agent not answering) stays silent.
  if (kind === 'update' && installedHash(target) === hash) {
    const [sac, q, set] = await Promise.all([
      deps.sacStatus ? deps.sacStatus() : null,
      deps.taskQuery(),
      !deps.explain && deps.passcodeSet ? deps.passcodeSet() : null,
    ]);
    if (!(sacOn(sac) && launcherStale(q, target))) return set === false ? NOT_SET_UP : quiet(UP_TO_DATE);
  }
  // Not set up, and nobody asked: this start only says so (atStart below).
  const atStart = kind === 'install' && !deps.explain;
  // A failed install is not retried by an ask - only a newer plugin, or
  // /claude-remote:setup, which clears this record.
  if (!atStart && state.last && !state.last.ok && state.last.hash === hash) return quiet(outcomeLine(state.last));
  // The three questions at once: each has its own timeout, and asked one
  // after another they came close to the hook's 10s limit.
  // Only an asked-for install needs Tailscale; an update keeps whatever sharing is on.
  const [q, running, ts] = await Promise.all([
    deps.taskQuery(),
    deps.agentRunning ? deps.agentRunning() : false,
    kind === 'install' && !atStart ? deps.tailscaleStatus() : null,
  ]);
  const verdict = taskVerdict(q, target);
  // A logon task running an agent from anywhere else - a git checkout - means
  // this PC is set up another way: installing or updating would stop that
  // agent and re-point its task. Left alone, and said nothing to.
  if (verdict === 'other') return quiet(RUNS_ELSEWHERE);
  // Same for an agent already answering with no task at all, started by hand -
  // on an update too: update-agent.ps1 stops whatever node holds the port.
  if (verdict === 'none' && running) return quiet(RUNS_ELSEWHERE);
  if (atStart) return NOT_SET_UP;

  if (kind === 'install' && !tailscaleReady(ts)) {
    // Every ask opens the page (PRD R21.1a, R21.0); a Claude start never gets here.
    // Never at the cost of the line: a failed open still says it.
    try {
      if (deps.openBrowser) await deps.openBrowser(TAILSCALE_DOWNLOAD);
    } catch { /* the line below still tells them */ }
    return NEEDS_TAILSCALE;
  }
  if (!nodeVersionOk(deps.nodeVersion)) return NEEDS_NODE;
  if (!onPath('claude.cmd', deps.pathValue)) {
    // Recorded like a failed install, so it is said once per plugin version,
    // not at every start in every project.
    const last = { kind, ok: false, hash, reported: true, reason: 'claude.cmd is not on PATH', at: new Date(deps.now).toISOString() };
    writeState(files.state, { ...state, last });
    return outcomeLine(last);
  }

  const lockToken = takeLock(files.lock, deps.now);
  if (!lockToken) return quiet(ALREADY_RUNNING);   // another start got there in the meantime
  deps.startJob({ kind, pluginRoot, target, dataDir, hash, lockToken });
  return kind === 'install' ? SETTING_UP : quiet(UPDATING);
}

// --- The background job ------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Runs the install, records the outcome, opens the browser on a first
 * install, and always gives the lock back.
 *
 * deps: runInstall(args) -> Promise<{ code, stdout, stderr }>, agentAnswers()
 * -> Promise<boolean>, openBrowser(url), port, waitMs.
 */
/** Records how a job ended, for the next start to say once. */
function recordOutcome(job, ok, reason) {
  const file = stateFiles(job.dataDir).state;
  const last = { kind: job.kind, ok, hash: job.hash, reported: false, at: new Date().toISOString() };
  if (!ok) last.reason = reason;
  writeState(file, { ...readState(file), last });
}

export async function runJob(job, deps) {
  const files = stateFiles(job.dataDir);
  try {
    const script = path.join(job.pluginRoot, 'agent', 'autostart', 'update-agent.ps1');
    const r = await deps.runInstall(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-Source', job.pluginRoot, '-Target', job.target]);
    const ok = r.code === 0;
    recordOutcome(job, ok, ok ? undefined : firstReason(r.stderr, r.stdout, r.code));
    if (ok && job.kind === 'install') {
      // update-agent.ps1 already checked /api/auth/status once; this waits
      // out a slow first answer rather than opening a browser on nothing.
      for (let i = 0; i < ANSWER_TRIES; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        if (await deps.agentAnswers()) { deps.openBrowser(`http://127.0.0.1:${deps.port}`); break; }
        // eslint-disable-next-line no-await-in-loop
        await sleep(deps.waitMs ?? ANSWER_WAIT_MS);
      }
    }
  } finally {
    releaseLock(files.lock, job.lockToken);
  }
}

// --- The real world ----------------------------------------------------------

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

/**
 * `tailscale <args>` -> stdout, or null on any failure. cwd is System32:
 * tailscaleBinary() falls back to the bare name, and libuv looks
 * a bare name up in the CHILD's cwd first - which, unset, is this hook's: the
 * project folder Claude was opened in, where anyone could plant a tailscale.exe.
 */
export function realTailscale(args, exec = execFile) {
  return import('../agent/alerts.js').then(({ tailscaleBinary }) => new Promise((resolve) => {
    exec(tailscaleBinary(), args, { windowsHide: true, timeout: 4000, cwd: SYSTEM32 }, (err, stdout) => resolve(err ? null : stdout));
  })).catch(() => null);
}

/** `schtasks /query /xml` for the agent's task -> taskVerdict's q. */
export function realTaskQuery(exec = execFile) {
  return new Promise((resolve) => {
    exec(path.join(SYSTEM32, 'schtasks.exe'), ['/query', '/tn', TASK_NAME, '/xml'], {
      windowsHide: true, timeout: 2000, cwd: SYSTEM32,
    }, (err, stdout) => {
      if (!err) { resolve({ ok: true, stdout }); return; }
      // schtasks words "no such task" in the PC's language, so the exit code
      // alone is checked against the task store itself: missing only when the
      // task file is not there. Any other answer (access denied, a timeout)
      // is 'other', and the PC is left alone.
      let missing = false;
      if (err.code === 1) {
        try { fs.statSync(path.join(SYSTEM32, 'Tasks', TASK_NAME)); } catch (e) { missing = e.code === 'ENOENT'; }
      }
      resolve({ ok: false, missing });
    });
  });
}

/** `reg query` of Smart App Control's state -> sacOn's input, or null. */
export function realSacStatus(exec = execFile) {
  return new Promise((resolve) => {
    exec(path.join(SYSTEM32, 'reg.exe'), ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy', '/v', 'VerifiedAndReputablePolicyState'], {
      windowsHide: true, timeout: 2000, cwd: SYSTEM32,
    }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/** A job that never ran: gives its lock back and leaves a failure for the next start. */
function jobFailed(job, err) {
  try {
    recordOutcome(job, false, `the background install could not start (${err?.code || err?.message || 'unknown error'})`);
  } catch { /* nobody to tell */ }
  try {
    releaseLock(stateFiles(job.dataDir).lock, job.lockToken);
  } catch { /* the stale window frees it */ }
}

export function realStartJob(job, spawnImpl = spawn) {
  try {
    const child = spawnImpl(process.execPath, [fileURLToPath(import.meta.url), '--job', JSON.stringify(job)], {
      detached: true, windowsHide: true, stdio: 'ignore', cwd: job.dataDir,
    });
    child.on('error', (err) => jobFailed(job, err));
    child.unref();
  } catch (err) {
    jobFailed(job, err);
  }
}

function realRunInstall(args) {
  return new Promise((resolve) => {
    // Full path, never the bare name: a PATH or current-folder lookup is how a
    // planted powershell.exe would run in the owner's name.
    execFile(path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args, {
      windowsHide: true, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }));
  });
}

/** Exported only so the window measurement can run this exact spawn. */
export function realOpenBrowser(url) {
  // cmd's own console is created hidden; `start` hands the URL to the
  // default browser the same way a double-click would. /s strips exactly the
  // outer pair of quotes, so the inner ones survive. Measured 2026-09-27 with
  // a harmless target in place of the URL: no window from cmd, and a program
  // started this way outlived the job that started it (a browser that was
  // not already running must not close when the job exits).
  // Resolves once cmd has handed the URL over, so a caller about to exit (the
  // hook at a session start or --now) does not exit before `start` ran.
  return new Promise((resolve) => {
    spawn(path.join(SYSTEM32, 'cmd.exe'), ['/d', '/s', '/c', `"start "" "${url}""`], {
      windowsHide: true, stdio: 'ignore', windowsVerbatimArguments: true,
    }).on('error', resolve).on('exit', resolve);
  });
}

/** Is a passcode set on the agent: true/false, or null when it does not answer. */
async function realPasscodeSet(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/status`, { signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) });
    return res.ok ? (await res.json()).configured === true : null;
  } catch {
    return null;
  }
}

async function realAgentAnswers(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/status`, { signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

// The agent's own data folder (agent/config.js getConfigFilePath's folder).
const DATA_DIR = path.join(os.homedir(), '.claude', 'plugins', 'data', 'claude-remote-claude-remote');

/** The plugin root this file sits in (<root>/hooks/check-update.mjs), for --now, where no CLAUDE_PLUGIN_ROOT is set. */
export function ownPluginRoot(fileUrl = import.meta.url) {
  return path.dirname(path.dirname(fileURLToPath(fileUrl)));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = Number(process.env.CLAUDE_REMOTE_AGENT_PORT) || DEFAULT_PORT;
  if (process.argv[2] === '--job') {
    try {
      await runJob(JSON.parse(process.argv[3]), {
        runInstall: realRunInstall, agentAnswers: () => realAgentAnswers(port), openBrowser: realOpenBrowser, port,
      });
    } catch { /* nobody to tell; the lock is gone and the next start sees no outcome */ }
  } else if (process.argv[2] === '--print-qr') {
    // /claude-remote:setup's hand-over: the same drawing, without the colour
    // codes, so the model can put it in its reply as a code block.
    if (process.argv[3]) process.stdout.write(`${qrBlocks(process.argv[3]).join('\n')}\n`);
  } else {
    // --now (AGENTS.md's third command): the same decision and hidden job as a
    // session start, run straight after `claude plugin install` so there is no
    // restart. Plain text, because an agent reads it, not Claude Code.
    const now = process.argv[2] === '--now';
    try {
      const line = await sessionStart({
        platform: process.platform,
        pluginRoot: now ? ownPluginRoot() : process.env.CLAUDE_PLUGIN_ROOT,
        localAppData: process.env.LOCALAPPDATA,
        dataDir: DATA_DIR,
        pathValue: process.env.PATH,
        nodeVersion: process.version,
        now: Date.now(),
        tailscaleStatus: () => realTailscale(['status', '--json']),
        taskQuery: () => realTaskQuery(),
        sacStatus: () => realSacStatus(),
        startJob: (job) => realStartJob(job),
        agentRunning: () => realAgentAnswers(port),
        passcodeSet: () => realPasscodeSet(port),
        openBrowser: realOpenBrowser,
        explain: now,
      });
      if (now) process.stdout.write(`${line}\n`);
      else if (line) process.stdout.write(JSON.stringify({ systemMessage: line }));
    } catch { /* silent: see the header */ }
  }
}
