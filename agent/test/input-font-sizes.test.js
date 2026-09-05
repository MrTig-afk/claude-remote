// The iOS input-zoom floor, checked the only way it can be checked correctly:
// by asking a browser what font-size it actually computed.
//
// WHY THIS FILE EXISTS. T103 replaced a regex sweep of app.css with
// scripts/check-input-font-sizes.mjs, and for a while that script was run by
// nobody - no test, no npm script, no CI. Review proved the hole: an
// under-16px input rule could be added and the whole suite stayed green. A
// guard nothing invokes is not a guard, so the script runs here.
//
// It launches headless Chrome, which is slower than the rest of this suite
// (a few seconds per case) and is the reason there are exactly two cases: one
// that the real shell passes, and one that proves the check can FAIL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runCheck, DEFAULT_PUBLIC, FLOOR_PX, CHROME_UNAVAILABLE,
} from '../../scripts/check-input-font-sizes.mjs';

/**
 * Runs the check. A missing Chrome FAILS by default and skips only when the
 * runner has explicitly opted out with ALLOW_NO_CHROME=1.
 *
 * Skipping by default was wrong and review proved why: `node --test` exits 0 on
 * a skipped test, so on any machine without Chrome at a known path this - the
 * ONLY guard that can catch a shrunk existing input - would report a clean
 * 1012-pass run while the bug shipped. That is the round-1 HIGH ("a guard
 * nothing invokes is not a guard") wearing a condition. The default is
 * therefore strict; the escape hatch is explicit and has to be typed.
 */
async function check(ctx, publicDir) {
  try {
    return await runCheck({ publicDir });
  } catch (err) {
    // The CODE, not the message. This matched /no Chrome found/ until review
    // showed a CHROME pointing at a non-executable throws `spawn EFTYPE`
    // instead - so the opt-out was bypassed and the suite failed on a machine
    // that had explicitly declared it could not run this check.
    if (err.code === CHROME_UNAVAILABLE) {
      if (process.env.ALLOW_NO_CHROME === '1') {
        ctx.skip('ALLOW_NO_CHROME=1 - the input-zoom floor is NOT being checked on this run');
        return null;
      }
      throw new Error(
        `${err.message}\n\nThis is the only guard that catches an input the cascade shrinks. `
        + 'Set CHROME=<path>, or ALLOW_NO_CHROME=1 to run the suite without it - '
        + 'knowing the iOS zoom floor is then unchecked.',
      );
    }
    throw err;
  }
}

test('every text input in the shell computes at least 16px, per the browser', async (ctx) => {
  const report = await check(ctx, DEFAULT_PUBLIC);
  if (!report) return;

  assert.ok(report.inputs.length > 0, 'the shell rendered no inputs at all - the check is not measuring anything');
  assert.deepEqual(
    report.textInputsBelow16, [],
    `these text inputs are under ${FLOOR_PX}px, so iOS zooms the page on focus and does not zoom back out: ${
      report.textInputsBelow16.map((i) => `${i.id || i.cls || i.type} = ${i.computedFontSizePx}px`).join('; ')}`,
  );
});

test('the check FAILS on an input the cascade actually shrinks', async (ctx) => {
  // The teeth. Without this, the test above is satisfied by a check that can
  // never fail - the exact defect this project has now been bitten by twice
  // (HANDOFF: "a guard that re-implements the thing it guards cannot fail").
  //
  // Mutates a COPY, never agent/public itself: `node --test` runs test files in
  // parallel, and pwa-assets.test.js reads app.css. Editing the real stylesheet
  // here would make an unrelated suite fail at random.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'input-font-mutant-'));
  try {
    fs.cpSync(DEFAULT_PUBLIC, tmp, { recursive: true });
    // Appended, so it wins on source order at equal specificity - the same way
    // a real regression would arrive. This is a rule that shrinks an input that
    // ACTUALLY EXISTS, which is what the browser can see.
    fs.appendFileSync(
      path.join(tmp, 'app.css'),
      '\n.newproj-panel input { font-size: 12px; }\n',
    );

    const report = await check(ctx, tmp);
    if (!report) return;

    assert.equal(
      report.textInputsBelow16.length, 1,
      `expected exactly the shrunk input to be caught, got ${JSON.stringify(report.textInputsBelow16)}`,
    );
    assert.equal(report.textInputsBelow16[0].id, 'newproj-name');
    assert.equal(report.textInputsBelow16[0].computedFontSizePx, 12);
    assert.match(report.verdict, /^FAIL/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the check FAILS on an input shrunk only at a PHONE breakpoint', async (ctx) => {
  // The case that was invisible to BOTH guards until review caught it: the
  // static test reads top-level rules only, so it never sees inside `@media`,
  // and headless Chrome starts at 800x600, so a phone breakpoint never applied.
  // A breakpoint is the likeliest place in a phone-first PWA for an input to be
  // shrunk, and the regex sweep this replaced DID scan inside at-rules - so
  // missing it was a straight coverage regression, not a trade.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'input-font-media-'));
  try {
    fs.cpSync(DEFAULT_PUBLIC, tmp, { recursive: true });
    fs.appendFileSync(
      path.join(tmp, 'app.css'),
      '\n@media (max-width: 430px) {\n  .newproj-panel input { font-size: 12px; }\n}\n',
    );

    const report = await check(ctx, tmp);
    if (!report) return;

    assert.equal(
      report.textInputsBelow16.length, 1,
      `expected the breakpoint rule to be caught, got ${JSON.stringify(report.textInputsBelow16)}`,
    );
    assert.equal(report.textInputsBelow16[0].id, 'newproj-name');
    assert.equal(report.textInputsBelow16[0].computedFontSizePx, 12);
    assert.equal(
      report.textInputsBelow16[0].smallestAt, 'phone',
      'the report must say WHICH viewport shrank it, or the reader cannot find the rule',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
