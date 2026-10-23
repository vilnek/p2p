import { describe, expect, it } from 'vitest';
import { beginAttempt, mask, note, onlyLocal, report, summarize } from '../../src/net/diag';

const SDP = [
  'v=0',
  'a=candidate:1 1 udp 2122260223 192.168.1.23 54400 typ host generation 0',
  'a=candidate:2 1 udp 2122260223 4b1c2f7e-1111-2222-3333-444455556666.local 54401 typ host',
  'a=candidate:3 1 udp 1686052607 49.36.10.200 54400 typ srflx raddr 192.168.1.23 rport 54400',
  'a=candidate:4 1 udp 2122262783 2405:201:abcd:12::5 54402 typ host',
  '',
].join('\r\n');

describe('connection details', () => {
  it('counts candidate types and address families', () => {
    expect(summarize(SDP)).toEqual({ total: 4, host: 2, mdns: 1, srflx: 1, prflx: 0, relay: 0, ipv4: 2, ipv6: 1 });
  });

  it('never shows a full address', () => {
    expect(mask('192.168.1.23')).toBe('192.168.1.*');
    expect(mask('2405:201:abcd:12::5')).toBe('2405:201:*');
    expect(mask('abc.local')).toBe('(mDNS name)');
    expect(mask(undefined)).toBe('?');
  });

  it('knows a same-network-only attempt and writes a plain report', () => {
    const a = beginAttempt('test');
    a.local = summarize(SDP.replace(/^a=candidate:3.*\r\n/m, ''));
    a.remote = summarize(SDP);
    expect(onlyLocal(a)).toBe(true);
    a.local = summarize(SDP);
    expect(onlyLocal(a)).toBe(false);
    note(a, 'iceConnectionState checking');
    a.error = 'not connected after 20 s';
    const text = report(a);
    expect(text).toContain('Local candidates: 4 (host 2, mDNS host 1, srflx 1');
    expect(text).toContain('iceConnectionState checking');
    expect(text).toContain('Last error: not connected after 20 s');
  });
});
