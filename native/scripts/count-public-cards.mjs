// Counts P2P Talk public ID cards on the built-in relays (last 26 h). Prints only numbers, never IDs or keys.
// Run from this folder: node scripts/count-public-cards.mjs ../  (uses the web app's ws package)
import { createRequire } from 'node:module';
const require = createRequire(process.argv[2] + '/package.json');
const WebSocket = require('ws');
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://offchain.pub', 'wss://nostr.mom'];
const since = Math.floor(Date.now() / 1000) - 26 * 3600;
const keys = new Set(); const stats = {};
const isCard = (c) => { try { const x = JSON.parse(c); return x && x.v === 1 && typeof x.k === 'string' && typeof x.rb === 'string' && /^[0-9a-f]{32}$/.test(x.bid) && Array.isArray(x.rr); } catch { return false; } };
function page(ws, until) {
  return new Promise((resolve) => {
    const evs = []; const sub = 'c' + until;
    const t = setTimeout(() => resolve(evs), 15000);
    const on = (m) => { const d = JSON.parse(m.toString()); if (d[1] !== sub) return; if (d[0] === 'EVENT') evs.push(d[2]); if (d[0] === 'EOSE' || d[0] === 'CLOSED') { clearTimeout(t); ws.off('message', on); resolve(evs); } };
    ws.on('message', on);
    ws.send(JSON.stringify(['REQ', sub, { kinds: [30078], since, until, limit: 500 }]));
  });
}
await Promise.all(RELAYS.map(async (url) => {
  const s = { scanned: 0, cards: 0, pages: 0 }; stats[url] = s;
  const ws = new WebSocket(url);
  try {
    await new Promise((ok, no) => { ws.once('open', ok); ws.once('error', no); setTimeout(no, 10000); });
    let until = Math.floor(Date.now() / 1000) + 60;
    for (let i = 0; i < 60; i++) {
      const evs = await page(ws, until); s.pages++;
      if (!evs.length) break;
      s.scanned += evs.length;
      for (const e of evs) if (isCard(e.content)) { s.cards++; keys.add(JSON.parse(e.content).k); }
      const oldest = Math.min(...evs.map((e) => e.created_at));
      if (oldest >= until || evs.length < 50) break;
      until = oldest - 1;
    }
  } catch { s.error = true; } finally { try { ws.close(); } catch {} }
}));
console.log(JSON.stringify({ windowHours: 26, distinctUsersWithPublicCard: keys.size, perRelay: stats }));
