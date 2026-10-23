// 1:1 call races in peer.ts, with a fake RTCPeerConnection and a pass-through lock (no WebRTC, no crypto
// on the frames: the frames sent are read back as JSON).
//   1. The caller cancels while the camera / microphone prompt is open: no `call` goes out afterwards,
//      and the devices just opened are stopped (before the fix: the callee rang for a cancelled call,
//      and the caller's camera stayed on).
//   2. The caller hangs up while the callee's prompt is open: no `accept` goes out, devices stopped.
//   3. The media timeout armed while 'connecting' does not fire into a call that reconnected.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromUtf8, utf8 } from '../../src/core/bytes';
import { newGuestIdentity } from '../../src/core/identity';
import { Peer } from '../../src/net/peer';

const SDP = 'v=0\r\na=fingerprint:sha-256 ' + Array.from({ length: 32 }, (_, i) => (0x10 + i).toString(16).toUpperCase()).join(':') + '\r\n';

class FakeDC {
  readyState = 'open';
  binaryType = '';
  sent: { k: string; cid?: string }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(b: Uint8Array) {
    this.sent.push(JSON.parse(fromUtf8(b)));
  }
  close() {
    this.readyState = 'closed';
  }
}

class FakePC extends EventTarget {
  iceGatheringState = 'complete';
  iceConnectionState = 'connected';
  connectionState = 'connected';
  signalingState = 'stable';
  localDescription: { type: string; sdp: string; toJSON(): object } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  sctp = null;
  dc = new FakeDC();
  createDataChannel() {
    return this.dc;
  }
  async createOffer() {
    return { type: 'offer', sdp: SDP };
  }
  async setLocalDescription(d?: { type: string; sdp: string }) {
    const x = d ?? { type: 'offer', sdp: SDP };
    this.localDescription = { ...x, toJSON: () => ({ type: x.type, sdp: x.sdp }) };
  }
  async setRemoteDescription() {}
  restartIce() {}
  getTransceivers() {
    return [];
  }
  getSenders() {
    return [];
  }
  addTrack() {}
  async getStats() {
    return new Map();
  }
  close() {
    this.connectionState = 'closed';
  }
}

class FakeTrack {
  stopped = false;
  enabled = true;
  constructor(readonly kind: string) {}
  stop() {
    this.stopped = true;
  }
}

interface Gum {
  resolve(tracks: FakeTrack[]): void;
  calls: number;
}

function installFakes(): Gum {
  const gum: Gum = { resolve: () => {}, calls: 0 };
  (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePC;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () =>
          new Promise<{ getTracks(): FakeTrack[]; getAudioTracks(): FakeTrack[]; getVideoTracks(): FakeTrack[] }>((resolve) => {
            gum.calls++;
            gum.resolve = (tracks) => resolve({ getTracks: () => tracks, getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'), getVideoTracks: () => tracks.filter((t) => t.kind === 'video') });
          }),
      },
    },
  });
  return gum;
}

/** A Peer that looks ready (hello exchanged) without any network: private fields set directly. */
async function readyPeer(): Promise<{ p: Peer; dc: FakeDC; receive(f: object): Promise<void> }> {
  const me = { ...newGuestIdentity(), name: 'Me' };
  const { peer: p } = await Peer.start(me);
  const them = newGuestIdentity();
  const x = p as unknown as {
    isReady: boolean;
    online: boolean;
    lock: { seal(b: Uint8Array): Promise<Uint8Array>; open(b: Uint8Array): Promise<Uint8Array> };
    peer: { id: string; publicKey: Uint8Array; name: string; version: number; features: string[] };
    dc: FakeDC;
    receive(f: Uint8Array): Promise<void>;
  };
  x.isReady = true;
  x.online = true;
  x.lock = { seal: async (b) => b, open: async (b) => b };
  x.peer = { id: '0'.repeat(24), publicKey: them.publicKey, name: 'Ravi', version: 1, features: ['call'] };
  const dc = x.dc;
  return { p, dc, receive: (f) => x.receive(utf8(JSON.stringify(f))) };
}

describe('1:1 call races (peer.ts)', () => {
  let gum: Gum;
  beforeEach(() => {
    gum = installFakes();
  });
  afterEach(() => {
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    delete (globalThis as { navigator?: unknown }).navigator;
    vi.useRealTimers();
  });

  it('caller hangs up while the prompt is open: no call frame, devices stopped', async () => {
    const { p, dc } = await readyPeer();
    const calling = p.startCall(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(p.call.state).toBe('reaching');
    expect(gum.calls).toBe(1);
    await p.hangUp();
    expect(p.call.state).toBe('ended');
    const mic = new FakeTrack('audio');
    gum.resolve([mic]);
    await calling;
    expect(dc.sent.map((f) => f.k)).toEqual(['hangup']);
    expect(mic.stopped).toBe(true);
    expect(p.localStream).toBeNull();
    p.close();
  });

  it('callee: the caller hangs up while the prompt is open: no accept frame, devices stopped', async () => {
    const { p, dc, receive } = await readyPeer();
    await receive({ k: 'call', cid: 'c1', video: true });
    await new Promise((r) => setTimeout(r, 0)); // the ring-ack leaves through the outbox
    expect(p.call.state).toBe('incoming');
    expect(dc.sent.map((f) => f.k)).toEqual(['ring']);
    const accepting = p.acceptCall();
    await new Promise((r) => setTimeout(r, 0));
    expect(p.call.state).toBe('connecting');
    await receive({ k: 'hangup', cid: 'c1' });
    expect(p.call.state).toBe('ended');
    const tracks = [new FakeTrack('audio'), new FakeTrack('video')];
    gum.resolve(tracks);
    await accepting;
    expect(dc.sent.map((f) => f.k)).toEqual(['ring']);
    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(p.localStream).toBeNull();
    p.close();
  });

  it('a stall while connecting: the old media timeout does not end the resumed call', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { p, dc, receive } = await readyPeer();
    const pc = p.pc as unknown as FakePC;
    const calling = p.startCall(false);
    await vi.advanceTimersByTimeAsync(0);
    gum.resolve([new FakeTrack('audio')]);
    await calling;
    expect(dc.sent.map((f) => f.k)).toEqual(['call']);
    const cid = dc.sent[0].cid!;
    await receive({ k: 'ring', cid });
    await receive({ k: 'accept', cid });
    expect(p.call.state).toBe('connecting'); // media timeout armed: 25 s from now
    await vi.advanceTimersByTimeAsync(20_000);
    pc.iceConnectionState = 'disconnected';
    pc.dispatchEvent(new Event('iceconnectionstatechange'));
    expect(p.call.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(2_000);
    pc.iceConnectionState = 'connected';
    pc.dispatchEvent(new Event('iceconnectionstatechange'));
    expect(p.call.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(4_000); // 26 s after the first arm: the old timer would have fired here
    expect(p.call.state).toBe('connecting');
    expect(dc.sent.some((f) => f.k === 'hangup')).toBe(false);
    await vi.advanceTimersByTimeAsync(22_000); // 25 s after the resume: the fresh timeout
    expect(p.call.state).toBe('failed');
    expect(p.call.failure).toBe('media');
    p.close();
  });
});
