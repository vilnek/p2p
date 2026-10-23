// Test page for group calls (tests/e2e/group-call.spec.ts): one person per browser context, with a
// real GroupCallManager, real RTCPeerConnections and Chrome's fake camera / microphone. The test
// carries the signalling frames between the pages (standing in for the locked 1:1 chat channels).
// Not part of the app build: the spec bundles this file with esbuild.

import { toB64url } from '../../src/core/bytes';
import { newGuestIdentity, p2pId } from '../../src/core/identity';
import { GroupCallManager, type GroupCallInfo } from '../../src/net/groupCall';

interface Rec {
  id: string;
  name: string;
  members: { p2pId: string; identityKey: string; name: string }[];
}

declare global {
  interface Window {
    gcSend(to: string, frame: unknown): Promise<void>;
    gc: unknown;
  }
}

const ident = newGuestIdentity();
const id = p2pId(ident.publicKey);
let rec: Rec | null = null;
let mgr: GroupCallManager | null = null;
const invites: string[] = [];
const calls: GroupCallInfo[] = [];
/** When each person's state changed here (ms since the page loaded), for the setup times. */
const timeline: { t: number; id: string; state: string }[] = [];
let sentFrames = 0;
let recvFrames = 0;
let shareError = '';


const tiles = document.getElementById('tiles')!;
function tile(pid: string, stream: MediaStream | null) {
  let v = document.querySelector<HTMLVideoElement>(`video[data-id="${pid}"]`);
  if (!stream) {
    v?.remove();
    return;
  }
  if (!v) {
    v = document.createElement('video');
    v.dataset.id = pid;
    v.autoplay = true;
    v.playsInline = true;
    v.width = 160;
    v.height = 120;
    tiles.append(v);
  }
  if (v.srcObject !== stream) {
    v.srcObject = stream;
    void v.play().catch(() => undefined);
  }
}

window.gc = {
  id,
  key: toB64url(ident.publicKey),
  setup(name: string, r: Rec) {
    rec = r;
    const groups = {
      record: (gid: string) => (rec && gid === rec.id ? rec : undefined),
      get: (gid: string) => (rec && gid === rec.id ? { status: 'joined', name: rec.name } : undefined),
    };
    mgr = new GroupCallManager({
      me: { ...ident, name },
      groups,
      // Like a data channel send: queued at once (the test keeps the order per direction). Awaiting the
      // test's round trip here would add 0.2–2 s per frame on a loaded machine.
      send: async (to, f) => {
        sentFrames++;
        void window.gcSend(to, f);
      },
      connect: async () => undefined,
      ringMs: 60_000,
      reachMs: 30_000, // the test relay is slow on a loaded machine (the app keeps 8 s, like 1:1 calls)
    });
    mgr.on('invite', (c) => invites.push(c.callId));
    mgr.on('call', (c) => calls.push(c));
    mgr.on('participant', (p) => {
      tile(p.id, p.stream);
      const last = [...timeline].reverse().find((x) => x.id === p.id);
      if (last?.state !== p.state) timeline.push({ t: Math.round(performance.now()), id: p.id, state: p.state });
    });
  },
  deliver(from: string, f: unknown) {
    recvFrames++;
    mgr!.onFrame(from, f);
  },
  invites: () => invites,
  timeline: () => timeline,
  now: () => Math.round(performance.now()),
  frames: () => ({ sent: sentFrames, received: recvFrames }),
  calls: () => calls,
  start: (gid: string, video: boolean) => mgr!.start(gid, { video }),
  join: (cid: string) => mgr!.join(cid),
  leave: () => mgr!.leave(),
  stopScreen: () => mgr!.stopScreen(),
  shareError: () => shareError,
  screenBy: () => mgr!.screenBy,
  call: () => mgr!.call,
  size: () => mgr!.size,
  parts: () => mgr!.participants().map((p) => ({ id: p.id, name: p.name, state: p.state, reason: p.reason, hasVideo: p.hasVideo, screen: p.screen, speaking: p.speaking, path: p.path?.kind })),
  stats: () => mgr!.stats(),
  senderParams: (pid: string) => mgr!.senderParams(pid),
  localVideoLabel: () => mgr!.localStream?.getVideoTracks()[0]?.label ?? '',
};

// Screen sharing needs a click (a user gesture) in Chrome.
document.getElementById('share')!.addEventListener('click', () => {
  shareError = '';
  mgr!.startScreen().catch((e: Error) => (shareError = e.message));
});
