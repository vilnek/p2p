// The 24 recovery words on screen: never visible by default (Dr Vijay, 23 Oct 2026).
//   - They sit under a frosted cover: "Tap and hold to show your 24 words". Only while held are they
//     put on the page at all (a numbered 2-column grid); letting go removes them again.
//   - Hidden again after 30 s, and whenever the app goes to the background.
//   - Copy: copies them, then empties the clipboard after 60 s where the platform allows (best effort).
//   - "I've written them down" asks for 3 random words back before going on.
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
        const ok = await navigator.clipboard?.writeText(words.join(' ')).then(() => true, () => false);
        copied.textContent = ok ? 'Copied. The clipboard is cleared in 1 minute.' : 'Couldn’t copy. Write them down instead.';
        if (ok) setTimeout(() => void navigator.clipboard?.writeText('').catch(() => undefined), CLIPBOARD_MS);
      } }, 'Copy'),
      copied),
    h('p', { class: 'warn small' }, 'Write them on paper. Don’t screenshot or share them.'));
  return panel;
}

/** Three different positions (1–24), in order. */
export function pickThree(n = 24, rnd: () => number = Math.random): number[] {
  const out = new Set<number>();
  while (out.size < 3) out.add(1 + Math.floor(rnd() * n));
  return [...out].sort((a, b) => a - b);
}

/** Do the typed words match? (case and spaces don't matter) */
export const wordsMatch = (phrase: string, answers: [number, string][]): boolean => {
  const words = phrase.trim().toLowerCase().split(/\s+/);
  return answers.every(([n, w]) => words[n - 1] === w.trim().toLowerCase());
};

/** "Check your paper": three words back, then `ok`. `back` shows the words again. */
export function wordsCheck(phrase: string, ok: () => void, back: () => void): HTMLElement {
  const ns = pickThree(phrase.trim().split(/\s+/).length);
  const err = h('p', { class: 'error', role: 'alert', 'data-testid': 'words-check-error' });
  const inputs = ns.map((n) => h('input', { class: 'field', 'data-testid': 'check-word', 'data-n': String(n), placeholder: `Word #${n}`, 'aria-label': `Word number ${n}`,
    autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }) as HTMLInputElement);
  const go = () => {
    if (!wordsMatch(phrase, inputs.map((el, i) => [ns[i], el.value]))) {
      err.textContent = 'That doesn’t match your paper. Check the numbers and try again.';
      return;
    }
    ok();
  };
  inputs.at(-1)!.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  return h('section', { class: 'card pad', 'data-testid': 'words-check' },
    h('h2', {}, 'Check your paper'),
    h('p', { class: 'muted' }, `Type words #${ns[0]}, #${ns[1]} and #${ns[2]} from your paper.`),
    ...inputs.map((el, i) => h('label', { class: 'check-row' }, h('span', { class: 'num' }, `#${ns[i]}`), el)),
    err,
    h('button', { class: 'btn pri', 'data-testid': 'words-check-go', type: 'button', onclick: go }, 'Continue'),
    h('button', { class: 'btn ghost', 'data-testid': 'words-check-back', type: 'button', onclick: back }, 'Show the words again'));
}
