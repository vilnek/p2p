// "Connection details": what the last connection attempt did, for debugging on real devices.
// Text only; network addresses are masked (last part hidden). Nothing leaves the device unless
// the person copies it.

export interface CandSummary {
  total: number;
  host: number;
  mdns: number;
  srflx: number;
  prflx: number;
  relay: number;
  ipv4: number;
  ipv6: number;
}

export interface Attempt {
  kind: string;
  started: number;
  log: string[];
  local?: CandSummary;
  remote?: CandSummary;
  pair?: string;
  relays: string[];
  error?: string;
  ok?: boolean;
}

let last: Attempt | null = null;
const listeners = new Set<() => void>();

export function beginAttempt(kind: string): Attempt {
  last = { kind, started: Date.now(), log: [], relays: [] };
  return last;
}

export const lastAttempt = () => last;
export const onAttempt = (fn: () => void) => listeners.add(fn);

export function note(a: Attempt, what: string): void {
  a.log.push(`${((Date.now() - a.started) / 1000).toFixed(1)} s  ${what}`);
  if (a.log.length > 80) a.log.splice(0, a.log.length - 80);
  if (a === last) listeners.forEach((fn) => fn());
}

/** Masks an address: 192.168.1.23 -> 192.168.1.*, 2405:201:abcd:… -> 2405:201:*, x.local -> (mDNS name). */
export function mask(addr: string | undefined): string {
  if (!addr) return '?';
  if (addr.endsWith('.local')) return '(mDNS name)';
  if (addr.includes(':')) return addr.split(':').slice(0, 2).join(':') + ':*';
  const parts = addr.split('.');
  return parts.length === 4 ? `${parts.slice(0, 3).join('.')}.*` : '*';
}

/** Counts the ICE candidates written in a session description. */
export function summarize(sdp: string): CandSummary {
  const s: CandSummary = { total: 0, host: 0, mdns: 0, srflx: 0, prflx: 0, relay: 0, ipv4: 0, ipv6: 0 };
  for (const m of sdp.matchAll(/^a=candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ (\S+)/gm)) {
    const [addr, typ] = [m[1], m[2]];
    s.total++;
    if (typ === 'host') {
      if (addr.endsWith('.local')) s.mdns++;
      else s.host++;
    } else if (typ === 'srflx') s.srflx++;
    else if (typ === 'prflx') s.prflx++;
    else if (typ === 'relay') s.relay++;
    if (addr.includes(':')) s.ipv6++;
    else if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) s.ipv4++;
  }
  return s;
}

/** Only same-network candidates (host / mDNS) on both sides: typical of a blocked local-network permission. */
export function onlyLocal(a: Attempt | null): boolean {
  if (!a?.local || !a.remote) return false;
  const local = (c: CandSummary) => c.srflx + c.relay + c.prflx === 0;
  return local(a.local) || local(a.remote);
}

const fmt = (c?: CandSummary) =>
  c ? `${c.total} (host ${c.host}, mDNS host ${c.mdns}, srflx ${c.srflx}, prflx ${c.prflx}, relay ${c.relay}; IPv4 ${c.ipv4}, IPv6 ${c.ipv6})` : 'none yet';

export function report(a: Attempt | null, extra: string[] = []): string {
  if (!a) return 'No connection attempt yet on this page.';
  return [
    `Connection details · ${new Date(a.started).toLocaleString()}`,
    `Attempt: ${a.kind}${a.ok ? ' · connected' : a.error ? ' · failed' : ''}`,
    `Local candidates: ${fmt(a.local)}`,
    `Remote candidates: ${fmt(a.remote)}`,
    `Selected pair: ${a.pair ?? 'none'}`,
    `Relays connected: ${a.relays.length ? a.relays.map((r) => r.replace(/^wss?:\/\//, '')).join(', ') : 'none'}`,
    `Last error: ${a.error ?? 'none'}`,
    ...extra,
    'States over time:',
    ...a.log.map((l) => `  ${l}`),
  ].join('\n');
}
