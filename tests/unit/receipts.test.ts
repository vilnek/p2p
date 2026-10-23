// Message ticks (net/receipts.ts): transitions, the read-receipts switch, groups, frames, the outbox.
import { describe, expect, it } from 'vitest';
import { groupStatus, parseReceipt, ReceiptOutbox, shownStatus, upgrade, type Receipt } from '../../src/net/receipts';

describe('ticks', () => {
  it('only go forward: wait → sent → delivered → read', () => {
    expect(upgrade('wait', 'sent')).toBe('sent');
    expect(upgrade('sent', 'd')).toBe('d');
    expect(upgrade('d', 'r')).toBe('r');
    expect(upgrade('r', 'd')).toBe('r'); // a late "delivered" never undoes "read"
    expect(upgrade(undefined, 'd')).toBe('d');
    expect(upgrade('wait', 'r')).toBe('r'); // a receipt can come before my own "sent" is stored
  });

  it('read receipts off: I see their read as delivered (and send none: main.ts readNow)', () => {
    expect(shownStatus('r', true)).toBe('r');
    expect(shownStatus('r', false)).toBe('d');
    expect(shownStatus('wait', false)).toBe('wait');
    expect(shownStatus(undefined, true)).toBe('sent');
  });

  it('groups: two ticks when every other member has it, blue when every one has read it', () => {
    const others = ['b', 'c'];
    expect(groupStatus('sent', undefined, others)).toBe('sent');
    expect(groupStatus('sent', { b: 'd' }, others)).toBe('sent');
    expect(groupStatus('sent', { b: 'd', c: 'r' }, others)).toBe('d');
    expect(groupStatus('sent', { b: 'r', c: 'r' }, others)).toBe('r');
    expect(groupStatus('wait', { b: 'r', c: 'r' }, others)).toBe('wait');
    expect(groupStatus('sent', {}, [])).toBe('sent');
  });

  it('frames are checked', () => {
    expect(parseReceipt({ k: 'rcpt', mids: ['a', 'b'], st: 'd' })).toEqual({ mids: ['a', 'b'], st: 'd' });
    expect(parseReceipt({ k: 'rcpt', mids: ['a'], st: 'r', g: 'g1' })).toEqual({ mids: ['a'], st: 'r', g: 'g1' });
    expect(parseReceipt({ k: 'rcpt', mids: ['a'], st: 'x' })).toBeNull();
    expect(parseReceipt({ k: 'rcpt', mids: [], st: 'd' })).toBeNull();
    expect(parseReceipt({ k: 'rcpt', mids: 'a', st: 'd' })).toBeNull();
    expect(parseReceipt({ k: 'rcpt', mids: [1, 'x'.repeat(65)], st: 'd' })).toBeNull();
    expect(parseReceipt({ k: 'msg', mids: ['a'], st: 'd' })).toBeNull();
  });

  it('the outbox batches, keeps what could not be sent (offline), and sends it on reconnect', async () => {
    const sent: [string, Receipt][] = [];
    let online = false;
    const box = new ReceiptOutbox(async (to, r) => {
      if (!online) return false;
      sent.push([to, r]);
      return true;
    }, 5);
    box.add('ravi', ['m1'], 'd');
    box.add('ravi', ['m2', 'm1'], 'd');
    box.add('ravi', ['m1'], 'r');
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]); // offline: kept
    const saved = box.snapshot();
    const again = new ReceiptOutbox(async (to, r) => (sent.push([to, r]), true));
    again.restore(saved); // after a restart
    online = true;
    await again.flush('ravi');
    expect(sent).toEqual([['ravi', { mids: ['m1', 'm2'], st: 'd' }], ['ravi', { mids: ['m1'], st: 'r' }]]);
    expect(again.snapshot()).toEqual([]);
  });
});
