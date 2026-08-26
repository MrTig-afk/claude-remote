// Static regression guard: every test ctx object
// literal that carries `registryPath` must also carry `sessionDirs`, or
// endSession -> findLiveSession -> listSessions -> readSessionFiles falls
// back to `ctx.sessionDirs ?? getSessionDirPaths()` (registry.js), which
// reads the owner's REAL ~/.claude-max/sessions and ~/.claude-pro/sessions.
// tree-kill.test.js was exactly this bug: its ctx carried registryPath and
// pidDir but no sessionDirs, and it is the one test that runs a real
// taskkill. Running every test file's private ctx builders generically
// (they are not exported and share no common shape) is impractical - this
// text scan is the practical fallback the review asked for.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/** Every balanced-brace object-literal substring in src that defines
 *  `registryPath` as one of ITS OWN (non-destructured) properties - not a
 *  `ctx.registryPath` read, not a destructuring target, not a function
 *  parameter name. */
function findRegistryPathLiterals(src) {
  const literals = [];
  const re = /registryPath\b/g;
  let m;
  while ((m = re.exec(src))) {
    const idx = m.index;
    if (src[idx - 1] === '.') continue; // ctx.registryPath - a read, not a definition

    // The character immediately before the token (past whitespace) must be
    // a property-list boundary ('{' the first property, or ',' any other).
    let j = idx - 1;
    while (j >= 0 && /\s/.test(src[j])) j -= 1;
    if (j < 0 || (src[j] !== '{' && src[j] !== ',')) continue;

    // Find the enclosing '{' with a backward depth scan from the token.
    let depth = 0;
    let k = idx - 1;
    let openIdx = -1;
    while (k >= 0) {
      if (src[k] === '}') depth += 1;
      else if (src[k] === '{') {
        if (depth === 0) { openIdx = k; break; }
        depth -= 1;
      }
      k -= 1;
    }
    if (openIdx === -1) continue;

    // A destructuring target ('const {' / 'let {' / 'var {') is not a
    // literal being constructed - skip it.
    let p = openIdx - 1;
    while (p >= 0 && /\s/.test(src[p])) p -= 1;
    const before = src.slice(Math.max(0, p - 4), p + 1);
    if (/\b(const|let|var)$/.test(before)) continue;

    // Balanced forward scan from the open brace to its matching close.
    let d = 0;
    let closeIdx = -1;
    for (let n = openIdx; n < src.length; n += 1) {
      if (src[n] === '{') d += 1;
      else if (src[n] === '}') {
        d -= 1;
        if (d === 0) { closeIdx = n; break; }
      }
    }
    if (closeIdx === -1) continue;

    literals.push({ start: openIdx, text: src.slice(openIdx, closeIdx + 1) });
  }
  const seen = new Set();
  return literals.filter((l) => (seen.has(l.start) ? false : (seen.add(l.start), true)));
}

test('every test ctx object literal carrying registryPath also carries sessionDirs', () => {
  const files = fs.readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(TEST_DIR, f))
    .filter((f) => f !== SELF);

  assert.ok(files.length > 5, 'sanity: the test dir listing must not come back near-empty');

  const failures = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const literal of findRegistryPathLiterals(src)) {
      if (!literal.text.includes('sessionDirs')) {
        const line = src.slice(0, literal.start).split('\n').length;
        failures.push(`${path.basename(file)}:${line}`);
      }
    }
  }

  assert.deepEqual(
    failures,
    [],
    'ctx literal(s) with registryPath but no sessionDirs - would fall back to the '
    + `owner's REAL ~/.claude-max / ~/.claude-pro sessions dirs: ${failures.join(', ')}`,
  );
});
