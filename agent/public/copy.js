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
