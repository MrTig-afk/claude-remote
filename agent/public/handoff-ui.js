// Pure shell module for Lane 10 (R1, R2) - the hand-off to the Claude app.
// No DOM access anywhere, not at module scope and not inside a function, so
// `node --test` imports it directly the same way it imports update-ui.js,
// folders-ui.js and copy.js. app.js is the only place any of this touches
// the page.
//
// WHY THIS EXISTS AT ALL. `agent/launch-session.ps1` runs
// `claude.cmd --remote-control <name>`. There is no terminal in this PWA, so
// a session started here is driven from the Claude app's Code tab. Until
// this module shipped, the app never said so: you tapped a project, watched a
// tile go green, and were given no reason to think anything else had to
// happen. The owner knew because he built it. Nobody else would.

/**
 * The deep link the hand-off button opens.
 *
 * !! UNVERIFIED ON A DEVICE. Read this before trusting the button. !!
 *
 * The owner chose a deep link over `https://claude.ai/code` (Artifact Q3),
 * accepting one known ceiling: on a device WITHOUT the Claude app installed
 * the link does nothing and shows no error. That ceiling is deliberate.
 *
 * What is NOT deliberate is the value of this string. The exact scheme the
 * Claude mobile app registers has not been confirmed on a real phone from
 * this machine, and a wrong scheme fails the SAME silent way as a missing
 * app - which means it would be broken for EVERYONE, including the owner,
 * and would look exactly like the accepted ceiling rather than like a bug.
 *
 * So: one constant, one place to fix. Verify by tapping the button on a
 * phone that HAS the Claude app and confirming it opens. If it does not,
 * change this line only - nothing else in the app hardcodes a scheme.
 *
 * The banner text above the button names the destination in words
 * ("Open Claude -> Code"), so the instruction survives even when the tap
 * does not. That is the whole reason the copy is not just a button label.
 */
export const CLAUDE_APP_LINK = 'claude://';

/**
 * Statuses that mean "the session is up and you can go and type in it".
 *
 * Deliberately an allow-list, not `!== 'starting'`. The statuses this app can
 * see are starting, running, busy, waiting, handoff, ended and failed; only
 * three of them mean the thing the banner promises. A deny-list would send
 * someone to the Claude app to look for a session that had already failed or
 * was in the middle of being torn down, which is a worse failure than saying
 * nothing - they would go, find nothing, and distrust the app afterwards.
 */
const LIVE = new Set(['running', 'busy', 'waiting']);

/**
 * Should the hand-off banner be on screen?
 *
 * `session` is the registry entry for the project this device just launched,
 * or null/undefined while the launch has not landed yet.
 *
 * FALSE while the answer is not yet known - no entry, or still `starting`.
 * The "start requested" banner is already covering that window and is the
 * better message for it: the session genuinely is not there to open.
 */
export function handoffReady(session) {
  if (session === null || session === undefined) return false;
  return LIVE.has(session.status);
}

/**
 * The banner's two lines. `project` is the project's own display name.
 *
 * The Claude app is NAMED rather than described (Artifact Q2). A generic
 * "your session is ready elsewhere" is not an instruction - it tells someone
 * who does not already know the flow exactly nothing, which is the failure
 * this banner exists to fix.
 *
 * Accepted cost, recorded in the Artifact: if the app is renamed or the Code
 * tab moves, this copy goes stale and has to be edited. That is a cheap edit
 * and a real instruction beats a vague one that never goes stale because it
 * never said anything.
 */
export function handoffCopy(project) {
  return {
    title: 'Ready in the Claude app.',
    body: `Open Claude → Code, and tap ${project} to start typing.`,
    button: 'OPEN THE CLAUDE APP',
  };
}

/**
 * Browser-storage key for R2's once-only sheet. (Named, not spelled: a test
 * asserts this module references no browser global at all, and it reads the
 * source rather than the bindings - so writing the API's name here, even in a
 * comment, fails it. Same trap this project has hit twice before.)
 *
 * Per DEVICE, not per install, and that is the right scope: the sheet
 * explains that this app hands off to another one, which is something each
 * new phone's owner needs telling once. It is also the only per-device state
 * in the app - everything else is derived from the PC (Artifact Lane 14), and
 * this is a viewer convenience rather than product state, which is exactly
 * what browser storage is for.
 *
 * A failed read or a cleared store just shows the sheet once more. Harmless,
 * so every access is wrapped and no failure is worth reporting.
 */
export const SHEET_SEEN_KEY = 'cr.handoffSheetSeen';

/**
 * The sheet's copy. Three numbered lines, in the Artifact's own order and
 * wording.
 *
 * Line 1 is the one that matters and is deliberately first: "this app starts
 * sessions, it does not show them". Everything else follows from it.
 */
export const SHEET = {
  title: 'It is running on your PC',
  steps: [
    'This app starts sessions. It does not show them.',
    'Open the Claude app, go to Code, and your session is the row named after the project.',
    'Come back here to stop it, or to start another one.',
  ],
  button: 'GOT IT',
  note: 'Shown once. Always in Settings › About.',
};
