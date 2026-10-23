// Manual check against the REAL public relays (not part of the automated tests).
// For each built-in relay it checks, with throwaway keys and random test bytes only:
//   1. connect,
//   2. live (ephemeral, kind 25050) events are accepted and passed to another connection,
//   3. stored (kind 30078) events with a 10-minute NIP-40 expiration are accepted and can be read back.
// Usage: node scripts/probe-relays.mjs [wss://relay ...]
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from 'node:crypto';

const RELAYS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://offchain.pub', 'wss://nostr.mom',
];
const hex = (b) => Buffer.from(b).toString('hex');
const enc = new TextEncoder();

function makeEvent(kind, tags) {
  const secret = randomBytes(32);
  const pubkey = hex(schnorr.getPublicKey(secret));
  const created_at = Math.floor(Date.now() / 1000);
  const content = randomBytes(96).toString('base64'); // looks like a locked blob; means nothing
  const id = hex(sha256(enc.encode(JSON.stringify([0, pubkey, created_at, kind, tags, content]))));
  const sig = hex(schnorr.sign(id, secret));
  return { id, pubkey, created_at, kind, tags, content, sig };
}

function open(url, ms = 7000) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { ws.terminate(); rej(new Error('connect timeout')); }, ms);
    ws.once('open', () => { clearTimeout(t); res(ws); });
    ws.once('error', (e) => { clearTimeout(t); rej(e); });
  });
}

function waitFor(ws, pred, ms) {
  return new Promise((res) => {
    const t = setTimeout(() => { ws.off('message', on); res(null); }, ms);
    function on(raw) {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (pred(m)) { clearTimeout(t); ws.off('message', on); res(m); }
    }
    ws.on('message', on);
  });
}

async function probe(url) {
  const r = { relay: url, connect: '✗', liveAccepted: '✗', liveForwarded: '✗', storedAccepted: '✗', storedReadBack: '✗', note: '' };
  let a, b;
  try {
    const t0 = Date.now();
    [a, b] = await Promise.all([open(url), open(url)]);
    r.connect = `✓ ${Date.now() - t0} ms`;

    // live
    const tag = hex(randomBytes(16));
    b.send(JSON.stringify(['REQ', 'live', { kinds: [25050], '#t': [tag] }]));
    await waitFor(b, (m) => m[0] === 'EOSE' && m[1] === 'live', 3000);
    const live = makeEvent(25050, [['t', tag]]);
    const gotLive = waitFor(b, (m) => m[0] === 'EVENT' && m[1] === 'live' && m[2]?.id === live.id, 6000);
    a.send(JSON.stringify(['EVENT', live]));
    const ok1 = await waitFor(a, (m) => m[0] === 'OK' && m[1] === live.id, 6000);
    r.liveAccepted = ok1 ? (ok1[2] ? '✓' : `✗ ${ok1[3] || ''}`.trim()) : '? no reply';
    r.liveForwarded = (await gotLive) ? '✓' : '✗';

    // stored, expires in 10 minutes
    const tag2 = hex(randomBytes(16));
    const stored = makeEvent(30078, [['t', tag2], ['d', hex(randomBytes(8))], ['expiration', String(Math.floor(Date.now() / 1000) + 600)]]);
    a.send(JSON.stringify(['EVENT', stored]));
    const ok2 = await waitFor(a, (m) => m[0] === 'OK' && m[1] === stored.id, 6000);
    r.storedAccepted = ok2 ? (ok2[2] ? '✓' : `✗ ${ok2[3] || ''}`.trim()) : '? no reply';
    await new Promise((s) => setTimeout(s, 800));
    b.send(JSON.stringify(['REQ', 'back', { kinds: [30078], '#t': [tag2] }]));
    const back = await waitFor(b, (m) => (m[0] === 'EVENT' && m[1] === 'back' && m[2]?.id === stored.id) || (m[0] === 'EOSE' && m[1] === 'back'), 6000);
    r.storedReadBack = back && back[0] === 'EVENT' ? '✓' : '✗';
  } catch (e) {
    r.note = String(e.message || e);
  } finally {
    a?.close(); b?.close();
  }
  return r;
}

const results = await Promise.all(RELAYS.map(probe));
console.table(results);
const good = results.filter((r) => r.liveForwarded === '✓' && r.storedReadBack === '✓').length;
console.log(`${good} of ${results.length} relays passed both live and stored checks.`);
