// The words on the accept screen, and - read only, with no checkbox - in
// Settings > What this app can see (T81). ONE copy of them, because two
// copies drift.
//
// Source of record: design/accept-screen-copy.txt, written and reviewed
// 2026-08-29. Verbatim. Do not paraphrase, do not soften, do not add.
//
// LEDE[1] is a separate export from LEDE[0] on purpose: it is the sentence
// the whole screen exists for, it is drawn in primary text, and every round
// of editing will want to make it friendlier. It should not be friendlier.
//
// Never write, here or in any screen that reuses this:
//   "We take your privacy seriously" - says nothing, and there is no "we"
//   "Secure"                         - a claim, not a fact the reader can check
//   "Only you can access it"         - untrue; anyone with the passcode can
//   "By continuing you agree"        - this is not a contract, it is a warning
// This is a statement of capability, not a licence agreement. The MIT licence
// lives in the repo.

export const TITLE = 'Read this before you continue.';

export const LEDE = [
  'claude-remote starts Claude Code on this PC.',
  'Anything Claude Code can do on this machine, it can do from your phone.',
];

export const SECTIONS = [
  {
    heading: 'WHAT IT CAN SEE',
    items: [
      'The folders you pick, and the names of folders inside them.',
      'While you are choosing folders, folder names on your other drives.',
    ],
  },
  {
    heading: 'WHAT IT CANNOT SEE',
    items: [
      'The contents of your files. It never opens them.',
      'Your C: drive. It is blocked and cannot be shared.',
    ],
  },
  {
    heading: 'WHO CAN REACH IT',
    items: [
      'Any device on your private network that knows your passcode.',
      'It is not on the public internet.',
    ],
  },
  {
    heading: 'WHAT LEAVES THIS MACHINE',
    items: [
      'Nothing. There is no account and no server of ours.',
      'If you turn notifications on later, an encrypted ping goes out through Apple or Google. They can see that one was sent, not what it says.',
    ],
  },
];

export const CONSENT_LABEL = 'I understand what this can see';
export const SETTINGS_NOTE = 'You can change which folders are shared at any time in Settings.';
export const ACCEPT_BUTTON = 'CHOOSE FOLDERS';

// The accept screen collapses SECTIONS behind this control (T103); Settings >
// What this app can see renders the same SECTIONS expanded, with no
// disclosure, because a screen someone navigates to on purpose must not hide
// its payload behind a second tap.
//
// It is a table of contents, not a "learn more": it names all four sections in
// their own order, so the collapsed screen still states the shape of what is
// behind it. Do not shorten it to two of the four, and do not make it sound
// reassuring - the file header's banned-wording rule binds this string too.
export const SECTIONS_TOGGLE = 'What it can see, what it cannot, who can reach it, what leaves this machine';

/**
 * Draws SECTIONS into `host`, replacing whatever is there. The one piece of
 * DOM in this module, so the accept screen (T96) and the read-only Settings
 * screen (T81) cannot render the same words two different ways. Touches
 * `document` only inside this body, so node can import this module.
 */
export function renderSections(host) {
  host.innerHTML = '';
  for (const section of SECTIONS) {
    const wrap = document.createElement('div');
    wrap.className = 'copy-section';
    const h = document.createElement('div');
    h.className = 'copy-heading';
    h.textContent = section.heading;
    wrap.appendChild(h);
    for (const item of section.items) {
      const line = document.createElement('div');
      line.className = 'copy-item';
      line.textContent = item;
      wrap.appendChild(line);
    }
    host.appendChild(wrap);
  }
}

// Below: the empty/broken project list (T100) - state 1 (nothing shared),
// state 2 (a shared root gone), and state 4 (shared, empty on day one).
// T78 added no screen and no words: the Settings row re-enters this same picker.

export const CHOOSE_FOLDERS_BUTTON = 'CHOOSE FOLDERS';
export const PICKER_SKIP = 'SKIP FOR NOW';
export const PICKER_CANCEL = 'CANCEL';
export const REMOVE_BUTTON = 'REMOVE';
// R4. The offline state's only control: there is nothing to choose here,
// only something to fix, and it is on this device.
export const RETRY_BUTTON = 'TRY AGAIN';

export const NOTHING_SHARED = {
  title: 'No folders shared yet.',
  body: 'Pick the folder your projects are in. Nothing outside it is listed here.',
};

/**
 * R4 (Lane 13). The phone has no network at all - a DIFFERENT failure from
 * "the PC has not answered", and the app must not confuse them. The shipped
 * app had one story for both, and when the phone is the one that is offline
 * that story sends someone to go and physically check a machine that is
 * fine.
 *
 * Tailscale is named because on this setup it is the most common cause: the
 * phone has signal, the tailnet is simply not up. "Check your connection" on
 * its own would leave someone staring at a full signal bar.
 */
export const PHONE_OFFLINE = {
  title: 'This phone is offline.',
  body: 'Nothing is wrong with your PC. Check your connection, then check Tailscale is on.',
};

export const SHARED_UNKNOWN = {
  title: 'The agent did not say which folders are shared.',
  body: 'Tap REFRESH. If it keeps happening, check the agent on the PC.',
};

export const ALL_ROOTS_GONE = {
  title: 'The folders you shared are not on the PC any more.',
  body: 'They were renamed, moved or deleted. Pick them again.',
};

export const ROOT_GONE_BODY = 'It was renamed, moved or deleted. Remove it, then pick it again if you still want it.';

/** One gone root's headline. `name` is the folder's own name, never a path. */
export function rootGoneTitle(name) {
  return `${name} is not on the PC any more.`;
}

/**
 * State 4's headline. Naming the folder is what makes this visibly a
 * different screen from NOTHING_SHARED rather than the same words twice.
 */
export function emptyDayOneTitle(names) {
  return names.length === 1 ? `Nothing in ${names[0]} yet.` : 'Nothing in your shared folders yet.';
}

export const EMPTY_DAY_ONE_BODY = 'No project folders in there yet. Tap + to make one, or share a different folder.';

// CHOOSE_FOLDERS_BUTTON duplicates ACCEPT_BUTTON's value on purpose and must
// NOT be aliased to it: ACCEPT_BUTTON is verbatim accept-screen copy owned by
// design/accept-screen-copy.txt, and coupling another screen's control to it
// would mean an edit to that file silently renames a button it does not own.
// Two constants, same string, different owners.
