// Message ticks (PROTOCOL.md §22): waiting · sent · delivered · read, on my own messages.
//
//   {k:'rcpt', mids:[…], st:'d'|'r', g?}   over the locked chat channel, from the other side of the chat
//   (or, with g, from a member of that group) to the message's sender. 'd' = their device received and
//   stored it; 'r' = it was on their screen (chat open, page visible) and they have read receipts on.
// A receipt is used only for my own messages in that chat; unknown message ids are ignored.

export const RCPT_FEATURE = 'rcpt1';
export const RCPT_KINDS = new Set(['rcpt']);

/** wait: not sent yet (offline) · sent: left this device · d: delivered · r: read. */
export type TickStatus = 'wait' | 'sent' | 'd' | 'r';
const ORDER: Record<TickStatus, number> = { wait: 0, sent: 1, d: 2, r: 3 };

/** Statuses only go forward (a late 'd' never undoes an 'r'). */
export const upgrade = (cur: TickStatus | undefined, next: TickStatus): TickStatus => (ORDER[next] > ORDER[cur ?? 'sent'] ? next : (cur ?? 'sent'));

/** With my read receipts off I don't see others' blue ticks either (as on WhatsApp). */
export const shownStatus = (st: TickStatus | undefined, readReceipts: boolean): TickStatus => {
  const s = st ?? 'sent';
  return s === 'r' && !readReceipts ? 'd' : s;
};

/** A group message: delivered when every other member has it, read when every one has read it. */
export function groupStatus(st: TickStatus | undefined, rc: Record<string, 'd' | 'r'> | undefined, others: string[]): TickStatus {
  if ((st ?? 'sent') === 'wait') return 'wait';
  if (!others.length) return 'sent';
  const got = others.map((m) => rc?.[m]);
  if (got.every((x) => x === 'r')) return 'r';
  if (got.every((x) => x === 'd' || x === 'r')) return 'd';
  return 'sent';
}

export interface Receipt {
  mids: string[];
  st: 'd' | 'r';
  g?: string;
}

/** A received rcpt frame, checked; null if malformed. */
export function parseReceipt(f: unknown): Receipt | null {
  const r = f as { k?: unknown; mids?: unknown; st?: unknown; g?: unknown };
  if (!r || r.k !== 'rcpt' || (r.st !== 'd' && r.st !== 'r') || !Array.isArray(r.mids) || r.mids.length > 500) return null;
  const mids = r.mids.filter((m): m is string => typeof m === 'string' && m.length > 0 && m.length <= 64);
  if (!mids.length) return null;
  if (r.g !== undefined && (typeof r.g !== 'string' || r.g.length > 64)) return null;
  return { mids, st: r.st, ...(r.g !== undefined ? { g: r.g as string } : {}) };
}

/**
 * Receipts I owe, by recipient: batched (a burst of messages makes one frame), and kept until they
 * could be sent (the recipient offline: sent when the link opens again).
 */
export class ReceiptOutbox {
  private due = new Map<string, Map<string, Receipt>>(); // to → (g|''+st) → receipt
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private trySend: (to: string, r: Receipt) => Promise<boolean>,
    private delay = 150,
  ) {}

  add(to: string, mids: string[], st: 'd' | 'r', g?: string): void {
    if (!mids.length) return;
    let m = this.due.get(to);
    if (!m) this.due.set(to, (m = new Map()));
    const key = `${g ?? ''} ${st}`;
    const r = m.get(key) ?? { mids: [], st, ...(g ? { g } : {}) };
    for (const id of mids) if (!r.mids.includes(id)) r.mids.push(id);
    m.set(key, r);
    this.timer ??= setTimeout(() => void this.flush(), this.delay);
  }

  /** Sends what can be sent now (all, or to one recipient whose link just opened). */
  async flush(only?: string): Promise<void> {
    if (!only) this.timer = null;
    for (const [to, m] of [...this.due]) {
      if (only && to !== only) continue;
      for (const [key, r] of [...m]) {
        while (r.mids.length) {
          const part = { ...r, mids: r.mids.slice(0, 200) };
          if (!(await this.trySend(to, part).catch(() => false))) break;
          r.mids.splice(0, part.mids.length);
        }
        if (!r.mids.length) m.delete(key);
      }
      if (!m.size) this.due.delete(to);
    }
  }

  /** For storage across restarts. */
  snapshot(): [string, Receipt[]][] {
    return [...this.due].map(([to, m]) => [to, [...m.values()].map((r) => ({ ...r, mids: [...r.mids] }))]);
  }

  restore(s: [string, Receipt[]][] | undefined): void {
    for (const [to, list] of s ?? []) for (const r of list) this.add(to, r.mids, r.st, r.g);
  }
}
