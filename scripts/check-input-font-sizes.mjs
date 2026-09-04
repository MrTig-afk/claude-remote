#!/usr/bin/env node
// Ground truth for the iOS input-zoom rule: what font-size does the browser
// ACTUALLY compute for every text input in the shell?
//
// Mobile Safari zooms the whole page in when a focused text input is smaller
// than 16px, and does not zoom back out on blur. The owner hit this naming a
// project on 2026-09-05 - the panel zoomed, the header was cut off both sides,
// and it stayed that way.
//
// This replaces a static regex sweep of app.css that tried to answer the same
// question by parsing selectors. That sweep accumulated six holes across three
// review rounds (at-rule stripping that swallowed the next rule, a floor inside
// a media query reading as unqualified, a custom property winning over the real
// declaration, `.dense.pin` and `:is(.pin)` escaping the class match) and two of
// the holes were introduced by hardening it. A regex cannot do cascade,
// specificity and inheritance; the browser already does all three. So ask it.
//
// Zero dependencies, deliberately: the agent has none, and this machine runs
// near 500MB-1GB free of 7.9GB. Chrome over CDP using node's built-in
// WebSocket (node >= 22), no playwright, no puppeteer.
//
// Serves agent/public/ over a throwaway HTTP server rather than opening the
// file directly: index.html links `/app.css` ABSOLUTELY, which under file://
// resolves to the filesystem root, so the stylesheet silently never loads and
// every input reads back at the UA default. That would be a false FAIL now and,
// worse, a false PASS the day the floor is removed. No agent and no passcode -
// this is the static shell, not the running app.
//
// Every TEXT input in this app is static in index.html; the only two built by
// script (app.js share-tick rows) are type="checkbox", which iOS never zooms.
// If a text input is ever created dynamically, this check stops seeing it and
// must be pointed at the running agent instead.
//
// Usage:  node scripts/check-input-font-sizes.mjs [--out <path>]
// Or import runCheck({ publicDir }) - that is how the test suite drives it.
// Exits non-zero if any text input computes under 16px.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FLOOR_PX = 16;
const REPO = path.resolve(import.meta.dirname, '..');
export const DEFAULT_PUBLIC = path.join(REPO, 'agent', 'public');

// Only the three that can change a computed font-size. Everything else the
// shell asks for (icons, manifest) falls back to octet-stream and is irrelevant
// here - the module type matters because a wrong one blocks the script, and the
// stylesheet type matters because a wrong one drops the CSS.
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

// Static server over the shell directory, on an ephemeral port. Only reason it
// exists is that the shell's asset links are absolute; see the note at the top.
function servePublic(PUBLIC) {
  const server = createServer(async (req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(PUBLIC, rel === '/' ? 'index.html' : rel);
    // Never serve outside agent/public, even for a local throwaway. Checked
    // with path.relative rather than startsWith: a bare prefix test has no
    // separator boundary, so `/../public-notes/x` resolves to a SIBLING
    // directory whose path still starts with PUBLIC and would be served.
    const within = path.relative(PUBLIC, file);
    if (within.startsWith('..') || path.isAbsolute(within)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve, reject) => {
    // REJECTS on a failed listen. Without this the promise could only ever
    // settle from the success callback, so an EACCES/EADDRNOTAVAIL under a
    // restrictive sandbox hung here forever - before the try/finally is even
    // entered, so the mkdtemp profile leaked too. Same silent-infinite-hang
    // shape the CDP client's `dead` flag exists to prevent, one function up.
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Windows only, like the rest of this project (PowerShell launcher, WSL1,
// Windows OpenSSH). Anywhere else, CHROME=<path> is the whole answer, which is
// why there is no list of other platforms' install locations here.
const CHROME_CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

function findChrome() {
  const hit = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!hit) {
    throw new Error(
      `no Chrome found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME=<path> to override.`,
    );
  }
  return hit;
}

// Chrome writes the port it actually bound to into DevToolsActivePort, which is
// how --remote-debugging-port=0 is read back. Polled rather than assumed: a
// fixed port collides with whatever else is debugging on this machine.
async function readDevToolsPort(userDataDir, deadline) {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(portFile, 'utf8');
      // Require the NEWLINE before trusting the first line. Chrome does not
      // write this file atomically and its format is `PORT\n/devtools/...`, so
      // a read landing mid-write can return "93" for port 9382 - after which
      // firstPageTarget polls the wrong port until the deadline and the run
      // dies with the misleading "no CDP page target appeared". The newline is
      // what makes the first line self-validating.
      if (raw.includes('\n')) {
        const port = raw.split('\n')[0].trim();
        if (port) return Number(port);
      }
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Chrome never wrote DevToolsActivePort - it failed to start');
}

async function firstPageTarget(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // devtools endpoint not up yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('no CDP page target appeared');
}

// Minimal CDP client. One in-flight map keyed by message id; that is the whole
// protocol we need for a single Runtime.evaluate.
function cdp(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });
  // Every in-flight call is settled when the socket dies. Without this, a
  // Chrome that exits mid-call (a crash, or the OOM this machine can genuinely
  // reach at ~1GB free) leaves `await client.send(...)` pending FOREVER: the
  // deadline below is only consulted between awaits, so the script would hang
  // silently with no output and no exit code rather than failing.
  // `dead` covers the half failAll cannot: a send issued AFTER the socket has
  // gone. ws.send() on a CLOSED socket discards the data silently per spec, so
  // that call would sit in `pending` with nothing left to settle it - the exact
  // infinite hang this block exists to prevent, just one step later.
  let dead = null;
  const failAll = (why) => {
    dead = why;
    for (const [id, slot] of pending) {
      pending.delete(id);
      slot.reject(new Error(`CDP ${slot.method}: ${why}`));
    }
  };
  ws.addEventListener('close', () => failAll('socket closed before the reply arrived'));
  ws.addEventListener('error', () => failAll('socket error'));
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    // slot.method, not msg.method: a CDP RESPONSE frame carries id +
    // result/error and no method, so this reported "undefined: <reason>" and
    // named neither the call nor the stage it died at.
    if (msg.error) slot.reject(new Error(`${slot.method}: ${msg.error.message}`));
    else slot.resolve(msg.result);
  });
  return {
    async send(method, params = {}) {
      await ready;
      if (dead) throw new Error(`CDP ${method}: ${dead}`);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

// Runs INSIDE the page. Reads computed style, which is cascade, specificity,
// inheritance, media queries and `font:` shorthand already resolved - every one
// of the things the regex sweep got wrong.
const ENUMERATE = `(${(() => {
  const NON_TEXT = new Set([
    'checkbox', 'radio', 'button', 'submit', 'reset',
    'file', 'range', 'color', 'image', 'hidden',
  ]);
  return [...document.querySelectorAll('input, textarea, select')].map((el) => {
    const cs = getComputedStyle(el);
    const type = el.tagName === 'INPUT'
      ? (el.getAttribute('type') || 'text').toLowerCase()
      : el.tagName.toLowerCase();
    return {
      id: el.id || null,
      cls: el.className || null,
      type,
      computedFontSizePx: parseFloat(cs.fontSize),
      // textarea and select zoom on iOS too, not just <input>.
      textEntry: !NON_TEXT.has(type),
      visible: !!(el.offsetParent || cs.position === 'fixed'),
    };
  });
}).toString()})()`;

/**
 * Runs the check against a shell directory and RETURNS the report. Exported so
 * the test suite can drive it - including against a deliberately broken COPY of
 * the shell, which is how the guard is proved able to fail without any test
 * mutating a file the rest of the suite is reading in parallel.
 */
export async function runCheck({ publicDir = DEFAULT_PUBLIC } = {}) {
  const PUBLIC = publicDir;
  const SHELL = path.join(PUBLIC, 'index.html');
  if (!existsSync(SHELL)) throw new Error(`shell not found at ${SHELL}`);
  const chrome = findChrome();
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'input-font-check-'));
  const deadline = Date.now() + 30_000;
  const { server, port: httpPort } = await servePublic(PUBLIC);

  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  // A failed spawn (EACCES, the binary moved between existsSync and here, an
  // antivirus block) emits 'error' with no 'exit' to follow. Unhandled, that
  // throws as an uncaught exception - which, now that this runs inside
  // `node --test`, would take down the whole test PROCESS rather than fail one
  // test. Captured and rethrown below so it surfaces as an ordinary failure.
  let spawnError = null;
  child.on('error', (err) => { spawnError = err; });

  let client;
  try {
    const cdpPort = await readDevToolsPort(userDataDir, deadline).catch((err) => {
      // A spawn failure is the real cause; the port timeout is just its symptom.
      throw spawnError ? new Error(`Chrome failed to start: ${spawnError.message}`) : err;
    });
    client = cdp(await firstPageTarget(cdpPort, deadline));

    // Navigate explicitly rather than trusting a launch argument: the first
    // page target may be the new-tab page, and reading font sizes off the wrong
    // document reports nothing and looks like a broken shell.
    await client.send('Page.enable');
    await client.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/` });

    // Wait for the stylesheet to be applied, not merely for the DOM. A read
    // taken at readyState 'loading' returns the UA default and would PASS a
    // stylesheet that is actually broken.
    // Waits for OUR document, not merely for A document. The first CDP target
    // is about:blank, which is ALREADY readyState 'complete' - so a readyState
    // check alone can pass before the navigation commits, enumerate an empty
    // page, and die with "no inputs found - the shell did not render": a
    // misleading flake that reads as a broken stylesheet rather than a race.
    // Comparing the port is enough and needs no event plumbing.
    for (;;) {
      const { result } = await client.send('Runtime.evaluate', {
        expression: `document.location.port + '|' + document.readyState`,
        returnByValue: true,
      });
      if (result.value === `${httpPort}|complete`) break;
      if (Date.now() > deadline) {
        throw new Error(`page never loaded the shell (last state: ${result.value})`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    // MEASURED AT EVERY VIEWPORT THAT MATTERS, not just the default.
    // Headless Chrome starts at 800x600, so a rule inside
    // `@media (max-width: 430px)` would never apply - and the static test sees
    // only top-level rules, so a breakpoint was invisible to BOTH guards. That
    // is the likeliest place in a phone-first PWA for an input to be shrunk,
    // and the regex sweep this replaced did scan inside at-rules, so missing it
    // would have been a straight coverage regression.
    const enumerateAt = async (viewport) => {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: true,
      });
      const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
        expression: ENUMERATE,
        returnByValue: true,
      });
      if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text}`);
      return result.value;
    };

    const VIEWPORTS = [
      { name: 'desktop', width: 1280, height: 900 },
      { name: 'phone', width: 390, height: 844 },   // the owner's actual device size
    ];
    const passes = [];
    for (const v of VIEWPORTS) passes.push({ viewport: v, inputs: await enumerateAt(v) });

    if (!passes[0].inputs.length) throw new Error('no inputs found - the shell did not render');

    // One row per input, carrying the SMALLEST size any viewport produced and
    // saying which one. The smallest is what decides whether iOS zooms.
    const byKey = new Map();
    for (const pass of passes) {
      for (const i of pass.inputs) {
        const key = i.id || `${i.cls}|${i.type}`;
        const prev = byKey.get(key);
        if (!prev || i.computedFontSizePx < prev.computedFontSizePx) {
          byKey.set(key, { ...i, smallestAt: pass.viewport.name });
        }
      }
    }
    const inputs = [...byKey.values()];

    const below = inputs.filter((i) => i.textEntry && i.computedFontSizePx < FLOOR_PX);
    const report = {
      capturedAt: new Date().toISOString(),
      surface: `${path.join(PUBLIC, 'index.html')} - every input, computed font-size`,
      source: 'browser computed style (Chrome headless over CDP)',
      threshold: `${FLOOR_PX}px - below this iOS Safari zooms the page on focus and does not zoom back out`,
      viewports: VIEWPORTS,
      inputs,
      textInputsBelow16: below,
      verdict: below.length
        ? `FAIL - ${below.length} text input(s) under ${FLOOR_PX}px`
        : `PASS - every text input >= ${FLOOR_PX}px`,
    };

    return report;
  } finally {
    client?.close();
    server.close();
    // WAIT for Chrome to actually exit before deleting its profile. kill()
    // only signals: on Windows the profile's lock files are still held when it
    // returns, so the rm threw, the .catch() swallowed it, and every run left a
    // ~1.1MB directory behind in %TEMP% (seven of them had accumulated before
    // review caught it). Bounded so a wedged Chrome cannot hang the script.
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    // unref'd, or the pending timer keeps the event loop alive and the CLI sits
    // idle for a full 5s AFTER printing its report. It also always waited the
    // whole 5s on the spawn-failure path, where 'exit' never fires at all
    // because the child never started.
    await Promise.race([exited, new Promise((r) => { setTimeout(r, 5000).unref(); })]);
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      .catch(() => {});
  }
}

async function main() {
  const outFlag = process.argv.indexOf('--out');
  const outPath = outFlag !== -1 ? process.argv[outFlag + 1] : null;
  // No --public flag: the only caller that needs a different shell directory is
  // the test, and it imports runCheck() directly. A CLI flag nothing passes is
  // just a thing to keep working.
  const report = await runCheck();
  const json = JSON.stringify(report, null, 2);
  if (outPath) {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${json}
`);
  }
  console.log(json);

  if (report.textInputsBelow16.length) {
    console.error(`
FAIL: ${report.textInputsBelow16
      .map((i) => `${i.id || i.cls || i.type} = ${i.computedFontSizePx}px`).join('; ')}`);
    process.exitCode = 1;
  }
}

// Only when run as a CLI. Importing this module (the test does) must not launch
// a browser as a side effect.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`input font-size check failed: ${err.message}`);
    process.exitCode = 1;
  });
}
