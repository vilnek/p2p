// The 24 recovery words on screen: never visible by default (Dr Vijay, 23 Oct 2026).
//   - They sit under a frosted cover: "Tap and hold to show your 24 words". Only while held are they
//     put on the page at all (a numbered 2-column grid); letting go removes them again.
//   - Hidden again after 30 s, and whenever the app goes to the background.
//   - Copy: copies them numbered, one per line ("1. apple"), then empties the clipboard after 60 s where
//     the platform allows (best effort). Restore reads that text back (identity.ts normalisePhrase).
//   - "I've written them down" goes straight on (Dr Vijay, 24 Oct 2026: no 3-word check, it was too hard).
// They never go into a toast, title, notification, log, embed event or URL.
// In the phone apps a device-lock check (Face ID / fingerprint / PIN) would come first; there is no
// native biometric plugin yet, so the hold is the check for now.

import { h, iconBtn } from './dom';
import { icon } from './icons';

const SHOW_MS = 30_000;
const CLIPBOARD_MS = 60_000;

/** The covered words, with Copy and the paper note. */
export function wordsPanel(phrase: string): HTMLElement {
  const words = phrase.trim().split(/\s+/);
  const grid = h('div', { class: 'words-slot' });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const hide = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    grid.replaceChildren();
    cover.classList.remove('open');
    cover.setAttribute('aria-pressed', 'false');
  };
  const show = () => {
    if (timer) return;
    grid.replaceChildren(h('ol', { class: 'words', 'data-testid': 'phrase' }, ...words.map((w) => h('li', {}, w))));
    cover.classList.add('open');
    cover.setAttribute('aria-pressed', 'true');
    timer = setTimeout(hide, SHOW_MS);
  };
  const cover = h('button', { class: 'words-cover', type: 'button', 'data-testid': 'words-cover', 'aria-pressed': 'false',
    'aria-label': 'Tap and hold to show your 24 words',
    onpointerdown: (e: Event) => {
      (e as PointerEvent).preventDefault();
      show();
    },
    onpointerup: hide, onpointerleave: hide, onpointercancel: hide,
    oncontextmenu: (e: Event) => e.preventDefault(),
    onkeydown: (e: Event) => ((e as KeyboardEvent).key === ' ' || (e as KeyboardEvent).key === 'Enter') && show(),
    onkeyup: hide, onblur: hide },
    h('span', { class: 'wc-face' }, icon('eye', 22), h('span', {}, 'Tap and hold to show your 24 words')));
  const onHidden = () => {
    if (document.visibilityState === 'hidden') hide();
    if (!panel.isConnected) document.removeEventListener('visibilitychange', onHidden); // the screen is gone
  };
  document.addEventListener('visibilitychange', onHidden);
  const copied = h('span', { class: 'muted small', 'data-testid': 'words-copied' });
  const panel = h('div', { class: 'words-panel' },
    h('div', { class: 'words-box' }, grid, cover),
    h('div', { class: 'row tight words-actions' },
      iconBtn('copy', 'Copy', { class: 'btn sec2 small with-icon', 'data-testid': 'words-copy', onclick: async () => {
        const ok = await navigator.clipboard?.writeText(numberedWords(words)).then(() => true, () => false);
        copied.textContent = ok ? 'Copied. The clipboard is cleared in 1 minute.' : 'Couldn’t copy. Write them down instead.';
        if (ok) setTimeout(() => void navigator.clipboard?.writeText('').catch(() => undefined), CLIPBOARD_MS);
      } }, 'Copy'),
      copied),
    h('p', { class: 'warn small' }, 'Write them on paper. Don’t screenshot or share them.'));
  return panel;
}

/** The words as Copy gives them: a heading, then one numbered word per line. */
export const numberedWords = (words: string[]): string =>
  ['P2P Talk: my 24 words', ...words.map((w, i) => `${i + 1}. ${w}`)].join('\n');
