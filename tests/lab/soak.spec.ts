import { expect, test, type Page } from '@playwright/test';
import { Lab, heapMB, metric, pair } from './lab';
import { startLabRelay, type LabRelay } from './lab-relay';

// TEST LAB · long call soak: a 1:1 video call (fake camera and microphone) for LAB_SOAK_MIN minutes
// (default 30). Every 30 s: both pages' JS heap, the call timer, the connection state and the
// incoming video/audio stats. Pass: no drop, heap growth under 20 % after warm-up, frames keep coming.
const MIN = Number(process.env.LAB_SOAK_MIN || 30);
let relay: LabRelay;
let lab: Lab;
test.beforeAll(async () => (relay = await startLabRelay()));
test.afterAll(async () => relay.stop());
test.afterEach(async () => lab.close());

/** Keeps every RTCPeerConnection the page makes, so the lab can read stats. */
const TRACK_PCS = () => {
  const Real = window.RTCPeerConnection;
  const all: RTCPeerConnection[] = [];
  (window as unknown as { __labPCs: RTCPeerConnection[] }).__labPCs = all;
  window.RTCPeerConnection = function (this: unknown, ...a: ConstructorParameters<typeof RTCPeerConnection>) {
    const pc = new Real(...a);
    all.push(pc);
    const ev = ((window as unknown as { __labPCEvents: string[] }).__labPCEvents ??= []);
    const t0 = Date.now();
    pc.addEventListener('connectionstatechange', () => ev.push(`${new Date().toISOString()} +${((Date.now() - t0) / 1000).toFixed(0)}s conn=${pc.connectionState}`));
    pc.addEventListener('iceconnectionstatechange', () => ev.push(`${new Date().toISOString()} ice=${pc.iceConnectionState}`));
    return pc;
  } as unknown as typeof RTCPeerConnection;
  window.RTCPeerConnection.prototype = Real.prototype;
  Object.assign(window.RTCPeerConnection, Real);
};

async function stats(p: Page) {
  return p.evaluate(async () => {
    const pcs = (window as unknown as { __labPCs: RTCPeerConnection[] }).__labPCs.filter((pc) => pc.connectionState !== 'closed');
    const out = { pcs: pcs.length, states: pcs.map((pc) => pc.connectionState).join(','), framesDecoded: 0, fps: 0, videoBytesIn: 0, audioBytesIn: 0, packetsLost: 0, jitterMs: 0, rttMs: 0 };
    for (const pc of pcs)
      (await pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') {
          out.framesDecoded += r.framesDecoded ?? 0;
          out.fps = Math.max(out.fps, r.framesPerSecond ?? 0);
          out.videoBytesIn += r.bytesReceived ?? 0;
          out.packetsLost += r.packetsLost ?? 0;
        }
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          out.audioBytesIn += r.bytesReceived ?? 0;
          out.jitterMs = Math.max(out.jitterMs, (r.jitter ?? 0) * 1000);
        }
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') out.rttMs = Math.max(out.rttMs, (r.currentRoundTripTime ?? 0) * 1000);
      });
    return out;
  });
}

test(`${MIN}-minute 1:1 video call: no drop, memory flat, video keeps flowing`, async ({ browser }) => {
  test.setTimeout((MIN + 10) * 60_000);
  lab = new Lab(browser, () => relay);
  // Track connections from the first script on, in fresh contexts.
  const origContext = lab.context.bind(lab);
  lab.context = async (o) => {
    const c = await origContext(o);
    await c.addInitScript(TRACK_PCS);
    return c;
  };
  const { a, b } = await pair(lab);
  await b.getByTestId('video-call').click();
  await a.getByTestId('accept').click();
  await expect(b.getByTestId('call-status')).toHaveText(/^\d\d:\d\d$/, { timeout: 25_000 });
  const rows: Record<string, unknown>[] = [];
  let heap0 = { a: 0, b: 0 };
  let prevFrames = { a: 0, b: 0 };
  let stalls = 0;
  const t0 = Date.now();
  for (let i = 0; (Date.now() - t0) / 60_000 < MIN; i++) {
    await a.waitForTimeout(30_000);
    const [ha, hb, sa, sb] = [await heapMB(a), await heapMB(b), await stats(a), await stats(b)];
    const ca = await a.getByTestId('call-status').textContent().catch(() => 'gone');
    const cb = await b.getByTestId('call-status').textContent().catch(() => 'gone');
    if (i === 3) heap0 = { a: ha, b: hb }; // after 2 min warm-up
    if (i > 0 && (sa.framesDecoded <= prevFrames.a || sb.framesDecoded <= prevFrames.b)) stalls++;
    prevFrames = { a: sa.framesDecoded, b: sb.framesDecoded };
    const row = { min: +((Date.now() - t0) / 60_000).toFixed(1), heapA: +ha.toFixed(1), heapB: +hb.toFixed(1), timerA: ca, timerB: cb, a: sa, b: sb };
    rows.push(row);
    console.log('SOAK', new Date().toISOString(), JSON.stringify(row));
    if (!/^\d\d:\d\d/.test(ca ?? '') || !/^\d\d:\d\d/.test(cb ?? '')) {
      const evA = await a.evaluate(() => (window as unknown as { __labPCEvents: string[] }).__labPCEvents);
      const evB = await b.evaluate(() => (window as unknown as { __labPCEvents: string[] }).__labPCEvents);
      metric(`soak-${MIN}min-drop`, { atMin: row.min, eventsA: evA, eventsB: evB });
    }
    expect(ca, 'A left the call').toMatch(/^\d\d:\d\d(:\d\d)?$/);
    expect(cb, 'B left the call').toMatch(/^\d\d:\d\d(:\d\d)?$/);
  }
  const last = rows.at(-1) as { heapA: number; heapB: number; a: { fps: number }; b: { fps: number } };
  const growth = { a: heap0.a ? (last.heapA - heap0.a) / heap0.a : 0, b: heap0.b ? (last.heapB - heap0.b) / heap0.b : 0 };
  metric(`soak-${MIN}min`, { heapStartMB: heap0, heapEnd: { a: last.heapA, b: last.heapB }, growthPct: { a: +(growth.a * 100).toFixed(1), b: +(growth.b * 100).toFixed(1) }, stalls, fpsEnd: { a: last.a.fps, b: last.b.fps }, samples: rows.length });
  await b.getByTestId('hang-up').click();
  await expect(a.getByTestId('call-status')).toHaveText('Call ended');
  expect(stalls, 'video stopped arriving in some 30 s windows').toBe(0);
  expect(growth.a).toBeLessThan(0.2);
  expect(growth.b).toBeLessThan(0.2);
});
