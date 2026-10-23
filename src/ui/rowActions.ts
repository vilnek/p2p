// Options for a row in the Chats, Groups and Calls lists (design approved 23 Oct 2026):
//   hold the row (touch), right-click it (mouse), or press the Menu key / Shift+F10 on it (keyboard):
//   its options sheet opens;
//   on touch, swiping the row to the left shows one red button (Delete chat, Leave group, Remove…).

import { h } from './dom';
import { icon, type IconName } from './icons';

export const HOLD_MS = 500;
/** How far the row slides to show its red button, and how far a swipe must go to keep it open. */
const SLIDE = 104;
const KEEP_OPEN = 48;

export interface RowActions {
  /** Opens the row's options sheet. */
  menu(): void;
  /** The red button a left swipe shows (touch only). */
  swipe?: { label: string; icon: IconName; testid: string; act(): void };
}

let openRow: HTMLElement | null = null;
/** A finger is on a row (hold or swipe in progress). */
let touching = 0;
/** True while a row is swiped open or being held / swiped: the list waits before redrawing (it would undo it). */
export const listBusy = (): boolean => !!openRow?.isConnected || touching > 0;
/** Closes a row that was swiped open (tapping elsewhere, or opening another one). */
export function closeSwiped(): void {
  if (!openRow) return;
  openRow.classList.remove('swiped');
  const r = openRow.querySelector<HTMLElement>(':scope > .row');
  if (r) r.style.transform = '';
  openRow = null;
}
if (typeof addEventListener === 'function') {
  addEventListener('pointerdown', (e) => {
    if (openRow && !openRow.contains(e.target as Node)) closeSwiped();
  }, true);
}

/**
 * Gives a list row its options. Returns the element to put in the list (the row itself, or the row
 * inside a wrapper that holds the red swipe button).
 */
export function withActions(row: HTMLElement, a: RowActions): HTMLElement {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let held = false;
  let start: { x: number; y: number; id: number; touch: boolean } | null = null;
  let dx = 0;
  let sliding = false;
  const wrap = a.swipe
    ? h('div', { class: 'swipe-row' },
        h('button', { class: 'swipe-act', type: 'button', 'data-testid': a.swipe.testid, tabindex: '-1', 'aria-hidden': 'true', onclick: () => {
          closeSwiped();
          a.swipe!.act();
        } }, icon(a.swipe.icon, 20), h('span', {}, a.swipe.label)),
        row)
    : row;
  const stopHold = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  row.setAttribute('aria-keyshortcuts', 'Shift+F10');
  row.title = 'Hold or right-click for options';
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    stopHold();
    held = true; // a long press on touch also fires contextmenu: one sheet only
    setTimeout(() => (held = false), 400);
    a.menu();
  });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      a.menu();
    }
  });
  row.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    held = false;
    dx = 0;
    sliding = false;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId, touch: e.pointerType !== 'mouse' };
    if (!start.touch) return; // a mouse uses right-click
    touching = 1;
    stopHold();
    timer = setTimeout(() => {
      timer = null;
      held = true;
      start = null;
      touching = 0;
      closeSwiped();
      a.menu();
    }, HOLD_MS);
  });
  row.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const mx = e.clientX - start.x;
    const my = e.clientY - start.y;
    if (Math.abs(mx) > 8 || Math.abs(my) > 8) stopHold();
    if (!a.swipe || !start.touch) return;
    if (!sliding && Math.abs(mx) > 12 && Math.abs(mx) > Math.abs(my) * 1.5) {
      sliding = true;
      if (openRow && openRow !== wrap) closeSwiped();
      wrap.classList.add('swiping');
    }
    if (!sliding) return;
    const base = wrap.classList.contains('swiped') ? -SLIDE : 0;
    dx = Math.max(-SLIDE - 24, Math.min(0, base + mx));
    row.style.transform = `translateX(${dx}px)`;
  });
  const end = () => {
    stopHold();
    if (sliding) {
      wrap.classList.remove('swiping');
      if (dx < -KEEP_OPEN) {
        wrap.classList.add('swiped');
        row.style.transform = `translateX(${-SLIDE}px)`;
        openRow = wrap;
      } else closeSwiped();
      held = true; // the swipe is not a tap
      setTimeout(() => (held = false), 300);
    }
    start = null;
    sliding = false;
    touching = 0;
  };
  row.addEventListener('pointerup', end);
  row.addEventListener('pointercancel', end);
  row.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && end());
  // The tap that ends a hold or a swipe does not open the chat.
  row.addEventListener('click', (e) => {
    if (held || wrap.classList.contains('swiped')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (wrap.classList.contains('swiped') && !held) closeSwiped();
    }
  }, true);
  return wrap;
}

/** One option in a row's options sheet. */
export function menuItem(name: IconName, label: string, testid: string, onclick: () => void, danger = false): HTMLElement {
  return h('button', { class: `kv tap menu-item${danger ? ' dang' : ''}`, type: 'button', 'data-testid': testid, onclick },
    icon(name, 22), h('div', { class: 'k' }, label));
}
