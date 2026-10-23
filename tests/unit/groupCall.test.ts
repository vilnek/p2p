import { describe, expect, it } from 'vitest';
import { toB64url } from '../../src/core/bytes';
import { newGuestIdentity, p2pId, sign } from '../../src/core/identity';
import { GroupManager } from '../../src/net/groups';
import {
  AUDIO_MAX_BITRATE,
  GroupCallManager,
  frameBytes,
  videoStep,
  type GroupCallFrame,
  type GroupCallInfo,
  type GroupSource,
  type Participant,
} from '../../src/net/groupCall';

// Group calls with fake WebRTC: a fake RTCPeerConnection (offer / answer / rollback, transceivers,
// track events, a "connection" once both sides agree on each other's fingerprints) and an
// in-memory network of locked 1:1 channels between the people.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 8000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(3);
  }
}

// ---- fake media -----------------------------------------------------------------------------------------

let trackNo = 0;
class FakeTrack extends EventTarget {
  id = `t${++trackNo}`;
  enabled = true;
  readyState: 'live' | 'ended' = 'live';
  contentHint = '';
  constructor(
    readonly kind: 'audio' | 'video',
    public muted = false,
    readonly label = kind,
  ) {
    super();
  }
  stop() {
    this.readyState = 'ended';
  }
  setMuted(m: boolean) {
    if (this.muted === m) return;
    this.muted = m;
    this.dispatchEvent(new Event(m ? 'mute' : 'unmute'));
  }
}

class FakeStream {
  constructor(private tracks: FakeTrack[] = []) {}
  addTrack(t: FakeTrack) {
    if (!this.tracks.includes(t)) this.tracks.push(t);
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
}

// ---- fake RTCPeerConnection -----------------------------------------------------------------------------

const pcs = new Map<string, FakePC>(); // by fingerprint
const levels = new Map<string, number>(); // speaking level by owner P2P ID

class FakeSender {
  params: { encodings: Record<string, unknown>[] } = { encodings: [{}] };
  constructor(
    readonly pc: FakePC,
    public track: FakeTrack | null,
  ) {}
  async replaceTrack(t: FakeTrack | null) {
    this.track = t;
    this.pc.peer()?.refresh();
  }
  getParameters() {
    return { encodings: this.params.encodings.map((e) => ({ ...e })) };
  }
  async setParameters(p: { encodings: Record<string, unknown>[] }) {
    this.params = { encodings: p.encodings.map((e) => ({ ...e })) };
  }
  setStreams() {}
}

class FakeTransceiver {
  mid: string | null = null;
  currentDirection: string | null = null;
  sender: FakeSender;
  receiver: { track: FakeTrack };
  fired = false;
  constructor(
    pc: FakePC,
    kind: 'audio' | 'video',
    track: FakeTrack | null,
    public direction: string,
  ) {
    this.sender = new FakeSender(pc, track);
    this.receiver = { track: new FakeTrack(kind, true) };
  }
}

const randomFp = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
const sdpFp = (sdp: string) => /a=fingerprint:sha-256 (\S+)/.exec(sdp)![1];

class FakePC extends EventTarget {
  fp = randomFp();
  signalingState = 'stable';
  connectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  currentRemoteDescription: { type: string; sdp: string } | null = null;
  transceivers: FakeTransceiver[] = [];
  remoteFp = '';
  offers = 0;
  rollbacks = 0;
  candidates = 0;
  closed = false;
  constructor(readonly owner: string) {
    super();
    pcs.set(this.fp, this);
  }
  peer(): FakePC | undefined {
    const o = pcs.get(this.remoteFp);
    return o && !o.closed && o.remoteFp === this.fp ? o : undefined;
  }
  addTransceiver(trackOrKind: FakeTrack | 'audio' | 'video', init: { direction: string }) {
    const track = typeof trackOrKind === 'string' ? null : trackOrKind;
    const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind.kind;
    const t = new FakeTransceiver(this, kind, track, init.direction);
    this.transceivers.push(t);
    return t;
  }
  getTransceivers() {
    return this.transceivers;
  }
  private sdp(type: string) {
    return [`v=0`, `a=x-type:${type}`, `a=fingerprint:sha-256 ${this.fp}`, ...this.transceivers.map((t, i) => `m=${t.receiver.track.kind} ${i}`), ''].join('\r\n');
  }
  async createOffer() {
    if (this.closed) throw new Error('closed');
    this.offers++;
    return { type: 'offer', sdp: this.sdp('offer') };
  }
  async createAnswer() {
    if (this.signalingState !== 'have-remote-offer') throw new Error('no offer');
    return { type: 'answer', sdp: this.sdp('answer') };
  }
  async setLocalDescription(d?: { type: string; sdp?: string }) {
    await Promise.resolve();
    if (this.closed) throw new Error('closed');
    if (d?.type === 'rollback') {
      if (this.signalingState !== 'have-local-offer') throw new Error('nothing to roll back');
      this.rollbacks++;
      this.signalingState = 'stable';
      return;
    }
    if (d!.type === 'offer') {
      if (this.signalingState !== 'stable') throw new Error(`offer in ${this.signalingState}`);
      this.transceivers.forEach((t, i) => (t.mid ??= String(i)));
      this.localDescription = { type: 'offer', sdp: d!.sdp! };
      this.signalingState = 'have-local-offer';
    } else {
      if (this.signalingState !== 'have-remote-offer') throw new Error(`answer in ${this.signalingState}`);
      this.localDescription = { type: 'answer', sdp: d!.sdp! };
      this.currentRemoteDescription = this.remoteDescription;
      this.signalingState = 'stable';
      this.transceivers.forEach((t) => (t.currentDirection = t.direction));
      this.tryConnect();
    }
    setTimeout(() => {
      if (this.closed) return;
      const c = { candidate: `candidate:1 1 udp 1 127.0.0.1 ${9000 + this.offers} typ host`, sdpMid: '0', sdpMLineIndex: 0 };
      this.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate: { toJSON: () => c } }));
    }, 0);
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    await Promise.resolve();
    if (this.closed) throw new Error('closed');
    const kinds = [...d.sdp.matchAll(/^m=(audio|video) /gm)].map((m) => m[1] as 'audio' | 'video');
    if (d.type === 'offer') {
      if (this.signalingState !== 'stable') throw new Error(`remote offer in ${this.signalingState}`);
      this.remoteDescription = d;
      this.remoteFp = sdpFp(d.sdp);
      this.signalingState = 'have-remote-offer';
      kinds.forEach((k, i) => {
        let t = this.transceivers[i];
        if (!t) {
          t = new FakeTransceiver(this, k, null, 'recvonly');
          this.transceivers.push(t);
        }
        t.mid ??= String(i);
      });
      this.fireTracks();
    } else {
      if (this.signalingState !== 'have-local-offer') throw new Error(`remote answer in ${this.signalingState}`);
      this.remoteDescription = this.currentRemoteDescription = d;
      this.remoteFp = sdpFp(d.sdp);
      this.signalingState = 'stable';
      this.transceivers.forEach((t) => (t.currentDirection = t.direction));
      this.fireTracks();
      this.tryConnect();
    }
  }
  private fireTracks() {
    for (const t of this.transceivers) {
      if (t.fired || t.mid === null) continue;
      t.fired = true;
      this.dispatchEvent(Object.assign(new Event('track'), { track: t.receiver.track, streams: [], transceiver: t }));
    }
  }
  private tryConnect() {
    const o = this.peer();
    if (!o || o.signalingState !== 'stable' || this.signalingState !== 'stable' || !o.currentRemoteDescription || !this.currentRemoteDescription) return;
    for (const pc of [this, o]) {
      if (pc.connectionState !== 'connected') {
        pc.connectionState = 'connected';
        pc.dispatchEvent(new Event('connectionstatechange'));
      }
    }
    this.refresh();
    o.refresh();
  }
  /** My receivers: unmuted while their sender on the same line has a track. */
  refresh() {
    const o = this.peer();
    if (!o || this.connectionState !== 'connected') return;
    this.transceivers.forEach((t, i) => t.receiver.track.setMuted(!o.transceivers[i]?.sender.track));
  }
  async addIceCandidate(c: unknown) {
    if (!this.remoteDescription) throw new Error('no remote description');
    if (c) this.candidates++;
  }
  async getStats() {
    const o = this.peer();
    const m = new Map<string, Record<string, unknown>>();
    m.set('ia', { type: 'inbound-rtp', kind: 'audio', audioLevel: o ? (levels.get(o.owner) ?? 0) : 0, bytesReceived: 100 });
    m.set('iv', { type: 'inbound-rtp', kind: 'video', bytesReceived: 1000, framesDecoded: 10, frameWidth: 640, frameHeight: 480 });
    return m;
  }
  close() {
    this.closed = true;
    this.connectionState = 'closed';
    this.signalingState = 'closed';
  }
}

// ---- people and groups ----------------------------------------------------------------------------------

interface Rec {
  id: string;
  name: string;
  members: { p2pId: string; identityKey: string; name: string }[];
}

class FakeGroups implements GroupSource {
  status = 'joined';
  private fns = new Map<string, Set<(g: { id: string }) => void>>();
  constructor(private readonly shared: { rec: Rec }) {}
  record(gid: string) {
    return gid === this.shared.rec.id ? this.shared.rec : undefined;
  }
  get(gid: string) {
    return gid === this.shared.rec.id ? { status: this.status, name: this.shared.rec.name } : undefined;
  }
  on(k: 'group' | 'removed', fn: (g: { id: string }) => void) {
    const s = this.fns.get(k) ?? new Set();
    s.add(fn);
    this.fns.set(k, s);
    return () => s.delete(fn);
  }
  fire(k: 'group' | 'removed') {
    for (const fn of this.fns.get(k) ?? []) fn({ id: this.shared.rec.id });
  }
}

interface Person {
  name: string;
  id: string;
  ident: { secretKey: Uint8Array; publicKey: Uint8Array };
  gcm: GroupCallManager;
  groups: FakeGroups;
  invites: GroupCallInfo[];
  calls: GroupCallInfo[];
  screens: (string | null)[];
  speakers: (string | null)[];
  busy: boolean;
  online: boolean;
}

const GID = 'G1seva';
type Tap = (from: Person, to: Person, f: GroupCallFrame) => GroupCallFrame | null;

function world(names: string[], opts: { pollMs?: number; ringMs?: number; mediaMs?: number; fanout?: boolean } = {}) {
  const shared: { rec: Rec } = { rec: { id: GID, name: 'Seva team', members: [] } };
  const byId = new Map<string, Person>();
  const links = new Set<string>();
  const key = (a: string, b: string) => [a, b].sort().join('|');
  const sent: { from: string; to: string; f: GroupCallFrame }[] = [];
  let tap: Tap | null = null;
  const fanned: { from: string; f: GroupCallFrame }[] = [];

  const make = (name: string, ident = newGuestIdentity()): Person => {
    const id = p2pId(ident.publicKey);
    const groups = new FakeGroups(shared);
    const p = { name, id, ident, groups, invites: [], calls: [], screens: [], speakers: [], busy: false, online: true } as unknown as Person;
    p.gcm = new GroupCallManager({
      me: { ...ident, name },
      groups,
      send: async (to, f) => {
        const q = byId.get(to);
        if (!q || !links.has(key(id, to)) || !p.online || !q.online) throw new Error('not connected');
        let frame: GroupCallFrame | null = JSON.parse(JSON.stringify(f));
        sent.push({ from: id, to, f: frame! });
        if (tap) frame = tap(p, q, frame!);
        if (!frame) return;
        setTimeout(() => byId.get(to)?.gcm.onFrame(id, frame), 0);
      },
      connect: async (to) => {
        const q = byId.get(to);
        if (!q || !q.online || !p.online) throw new Error('offline');
        link(p, q);
      },
      fanout: opts.fanout ? async (_gid, f) => void fanned.push({ from: id, f: JSON.parse(JSON.stringify(f)) }) : undefined,
      busy: () => p.busy,
      createPeerConnection: () => new FakePC(id) as unknown as RTCPeerConnection,
      getUserMedia: async (c) => new FakeStream([...(c.audio ? [new FakeTrack('audio')] : []), ...(c.video ? [new FakeTrack('video', false, 'camera')] : [])]) as unknown as MediaStream,
      getDisplayMedia: async () => new FakeStream([new FakeTrack('video', false, 'screen')]) as unknown as MediaStream,
      newStream: () => new FakeStream() as unknown as MediaStream,
      ringMs: opts.ringMs ?? 3000,
      reachMs: 1500,
      mediaMs: opts.mediaMs ?? 8000,
      connectMs: 500,
      pollMs: opts.pollMs ?? 0,
    });
    p.gcm.on('invite', (c) => p.invites.push(c));
    p.gcm.on('call', (c) => p.calls.push(c));
    p.gcm.on('screen', (s) => p.screens.push(s));
    p.gcm.on('speaker', (s) => p.speakers.push(s));
    byId.set(id, p);
    return p;
  };

  const link = (a: Person, b: Person) => {
    if (links.has(key(a.id, b.id))) return;
    links.add(key(a.id, b.id));
    a.gcm.peerReady(b.id);
    b.gcm.peerReady(a.id);
  };

  const people = names.map((n) => make(n));
  shared.rec.members = people.map((p) => ({ p2pId: p.id, identityKey: toB64url(p.ident.publicKey), name: p.name }));
  const mesh = () => people.forEach((a, i) => people.slice(i + 1).forEach((b) => a.online && b.online && links.add(key(a.id, b.id))));

  const part = (p: Person, q: Person): Participant | undefined => p.gcm.participants().find((x) => x.id === q.id);
  const allConnected = (group: Person[]) => group.every((p) => group.every((q) => p === q || part(p, q)?.state === 'connected'));
  const pcOf = (p: Person, q: Person): FakePC | undefined =>
    [...pcs.values()].find((pc) => pc.owner === p.id && !pc.closed && pc.peer()?.owner === q.id);

  return {
    people,
    byId,
    shared,
    sent,
    fanned,
    mesh,
    link,
    make,
    part,
    allConnected,
    pcOf,
    setTap: (t: Tap | null) => (tap = t),
    unlink: (a: Person, b: Person) => links.delete(key(a.id, b.id)),
    async settle(ms = 30) {
      await sleep(ms);
      await Promise.all(people.map((p) => p.gcm.idle()));
    },
  };
}

async function ringAndJoin(w: ReturnType<typeof world>, caller: Person, video: boolean, joiners: Person[]): Promise<string> {
  const cid = await caller.gcm.start(GID, { video });
  for (const j of joiners) await until(() => j.invites.some((c) => c.callId === cid), 10000, `${j.name} rings`);
  for (const j of joiners) await j.gcm.join(cid);
  return cid;
}

// ---- tests ----------------------------------------------------------------------------------------------

describe('group calls (full mesh)', { timeout: 60_000 }, () => {
  it('4 people: everyone connects to everyone, and the lower P2P ID makes each offer', async () => {
    const w = world(['A', 'B', 'C', 'D']);
    w.mesh();
    const [a, b, c, d] = w.people;
    const cid = await a.gcm.start(GID, { video: true });
    for (const p of [b, c, d]) await until(() => p.invites.length === 1, 10000, 'invite');
    expect(b.invites[0]).toMatchObject({ callId: cid, gid: GID, groupName: 'Seva team', video: true, state: 'incoming', by: a.id, byName: 'A' });
    // While not joined yet, the caller sees them ringing.
    await until(() => [b, c, d].every((p) => w.part(a, p)?.state === 'ringing'), 10000, 'ringing');
    for (const p of [b, c, d]) await p.gcm.join(cid);
    await until(() => w.allConnected(w.people), 10000, 'all connected');

    const offers = w.sent.filter((s) => s.f.k === 'gc-sdp' && s.f.d?.type === 'offer');
    expect(offers.length).toBe(6); // one per pair, no glare, no restarts
    for (const o of offers) expect(o.from < o.to).toBe(true);
    // Everyone has 3 connections, each with sound and video from the other side.
    for (const p of w.people) {
      const ps = p.gcm.participants();
      expect(ps).toHaveLength(3);
      for (const x of ps) {
        expect(x.stream!.getTracks()).toHaveLength(2);
        expect(x.hasVideo).toBe(true);
        expect(x.camera).toBe(true);
        expect(x.mic).toBe(true);
      }
      expect(p.gcm.size).toBe(4);
      expect(p.gcm.call?.state).toBe('joined');
    }
    // Every frame on the wire was signed by its sender.
    expect(w.sent.every((s) => typeof s.f.sig === 'string' && s.f.sig.length > 80 && s.f.from === s.from)).toBe(true);
  });

  it('only members of the current signed list count: outsiders, forged and passed-on frames are refused; a removed member is dropped', async () => {
    const w = world(['A', 'B', 'C', 'D']);
    w.mesh();
    const [a, b, c, d] = w.people;
    const x = w.make('Outsider'); // valid identity, not in the member list
    w.link(x, a);
    w.link(x, b);
    const signAs = (who: Person, f: Omit<GroupCallFrame, 'sig'>): GroupCallFrame => {
      const g = { ...f, sig: '' } as GroupCallFrame;
      g.sig = toB64url(sign(who.ident.secretKey, frameBytes(g)));
      return g;
    };
    // 1. An invite from someone not in the group.
    b.gcm.onFrame(x.id, signAs(x, { k: 'gc-invite', cid: 'cidX', gid: GID, from: x.id, to: b.id, ts: Date.now(), video: false, in: [{ id: x.id, sid: 's' }] }));
    // 2. An invite "from A" signed by someone else.
    b.gcm.onFrame(a.id, { ...signAs(x, { k: 'gc-invite', cid: 'cidY', gid: GID, from: a.id, to: b.id, ts: Date.now(), video: false }) });
    // 3. A genuine invite from A, passed on by C on C's own channel.
    const genuine = signAs(a, { k: 'gc-invite', cid: 'cidZ', gid: GID, from: a.id, to: b.id, ts: Date.now(), video: false });
    b.gcm.onFrame(c.id, genuine);
    // 4. The genuine invite, changed on the way.
    b.gcm.onFrame(a.id, { ...genuine, video: true });
    // 5. Another group.
    b.gcm.onFrame(a.id, signAs(a, { k: 'gc-invite', cid: 'cidW', gid: 'other', from: a.id, to: b.id, ts: Date.now(), video: false }));
    await w.settle();
    expect(b.invites).toEqual([]);
    b.gcm.onFrame(a.id, genuine); // the untouched one, on A's own channel: rings
    await until(() => b.invites.length === 1);

    // A real call: an outsider can't join it.
    const cid = await ringAndJoin(w, a, false, [b, c, d]);
    await until(() => w.allConnected([a, b, c, d]), 10000);
    a.gcm.onFrame(x.id, signAs(x, { k: 'gc-join', cid, gid: GID, from: x.id, to: a.id, ts: Date.now(), sid: 'sx' }));
    await w.settle();
    expect(a.gcm.participants().map((p) => p.id)).not.toContain(x.id);
    expect(w.sent.some((s) => s.to === x.id)).toBe(false);

    // D is removed from the group by an admin: everyone drops D, and D's call ends.
    w.shared.rec = { ...w.shared.rec, members: w.shared.rec.members.filter((m) => m.p2pId !== d.id) };
    d.groups.status = 'removed';
    for (const p of [a, b, c]) p.groups.fire('group');
    d.groups.fire('removed');
    await until(() => [a, b, c].every((p) => w.part(p, d)?.state === 'left' && w.part(p, d)?.reason === 'removed'), 10000, 'D dropped');
    await until(() => d.gcm.call === null);
    expect(d.calls.at(-1)).toMatchObject({ state: 'ended', reason: 'removed' });
    expect(w.allConnected([a, b, c])).toBe(true);
  });

  it('late join: someone offline at the start rings when they come online, joins, and connects to everyone', async () => {
    const w = world(['A', 'B', 'C']);
    const [a, b, c] = w.people;
    c.online = false;
    w.mesh();
    const cid = await ringAndJoin(w, a, true, [b]);
    await until(() => w.part(a, c)?.state === 'failed' && w.part(a, c)?.reason === 'offline', 10000, 'C offline');
    await until(() => w.allConnected([a, b]));
    expect(a.gcm.call?.state).toBe('joined'); // the call goes on

    c.online = true;
    w.link(a, c); // C's app connects to A: A rings C (the call is still running)
    await until(() => c.invites.some((i) => i.callId === cid), 10000, 'C rings');
    await c.gcm.join(cid);
    await until(() => w.allConnected([a, b, c]), 10000, 'all three'); // B was found through A's roster
    const joinsToB = w.sent.filter((s) => s.f.k === 'gc-join' && s.from === c.id && s.to === b.id);
    expect(joinsToB).toHaveLength(1);
  });

  it('a missed or declined call can still be joined while it runs', async () => {
    const w = world(['A', 'B', 'C']);
    w.mesh();
    const [a, b, c] = w.people;
    const cid = await ringAndJoin(w, a, false, [b]);
    await until(() => c.invites.length === 1);
    await c.gcm.decline(cid);
    await until(() => w.part(a, c)?.reason === 'declined');
    expect(c.gcm.joinable(GID).map((x) => x.state)).toEqual(['declined']);
    await c.gcm.join(cid);
    await until(() => w.allConnected([a, b, c]), 10000);
  });

  it('leave and rejoin: the others stay connected, and the rejoin makes new connections', async () => {
    const w = world(['A', 'B', 'C']);
    w.mesh();
    const [a, b, c] = w.people;
    const cid = await ringAndJoin(w, a, true, [b, c]);
    await until(() => w.allConnected(w.people), 10000);
    const oldAB = w.pcOf(a, b)!;
    await b.gcm.leave();
    await until(() => w.part(a, b)?.state === 'left' && w.part(c, b)?.state === 'left', 10000, 'B left');
    expect(b.gcm.call).toBeNull();
    expect(b.calls.at(-1)).toMatchObject({ state: 'ended', reason: 'left' });
    expect(oldAB.closed).toBe(true);
    expect(w.allConnected([a, c])).toBe(true);
    expect(w.part(a, b)?.stream).toBeNull();

    expect(b.gcm.joinable().map((x) => x.callId)).toEqual([cid]);
    await b.gcm.join(cid);
    await until(() => w.allConnected(w.people), 10000, 'rejoined');
    expect(w.pcOf(a, b)).not.toBe(oldAB);
    expect(w.pcOf(a, b)!.fp).not.toBe(oldAB.fp);
  });

  it('an app that restarted mid-call rejoins with a new session; the old connection is replaced', async () => {
    const w = world(['A', 'B', 'C']);
    w.mesh();
    const [a, b, c] = w.people;
    const cid = await ringAndJoin(w, a, false, [b, c]);
    await until(() => w.allConnected(w.people), 10000);
    const old = w.pcOf(a, c)!;
    // C's app restarts: a new manager, same identity, no gc-leave was sent.
    const fresh = w.make('C', c.ident);
    w.people[2] = fresh;
    w.unlink(a, fresh);
    w.link(a, fresh); // the chat channel comes back up: A gives it the invite again
    await until(() => fresh.invites.some((i) => i.callId === cid), 10000, 'rings again');
    await fresh.gcm.join(cid);
    await until(() => w.allConnected([a, b, fresh]), 10000, 'replaced');
    expect(old.closed).toBe(true);
    expect(w.pcOf(a, fresh)).not.toBe(old);
  });

  it('the call ends when the last person leaves; members still ringing are told', async () => {
    const w = world(['A', 'B', 'C'], { ringMs: 5000 });
    w.mesh();
    const [a, b, c] = w.people;
    const cid = await ringAndJoin(w, a, false, [b]);
    await until(() => c.invites.length === 1);
    await until(() => w.allConnected([a, b]));
    await b.gcm.leave();
    await until(() => w.part(a, b)?.state === 'left');
    expect(a.gcm.call?.state).toBe('joined'); // C still ringing: A waits
    expect(c.gcm.joinable().map((x) => x.callId)).toEqual([cid]);
    await a.gcm.leave();
    await until(() => c.calls.at(-1)?.canJoin === false, 10000, 'C told');
    expect(c.calls.at(-1)?.state).toBe('missed');
    expect(c.gcm.joinable()).toEqual([]);
    await expect(c.gcm.join(cid)).rejects.toThrow(/ended/);
  });

  it('when everyone else hangs up, my call ends too', async () => {
    const w = world(['A', 'B', 'C']);
    w.mesh();
    const [a, b, c] = w.people;
    await ringAndJoin(w, a, false, [b, c]);
    await until(() => w.allConnected(w.people), 10000);
    await b.gcm.leave();
    await c.gcm.leave();
    await until(() => a.gcm.call === null, 10000);
    expect(a.calls.at(-1)).toMatchObject({ state: 'ended', reason: 'everyone-left' });
  });

  it('reasons per person: declined, busy, no answer, offline; the call ends when nobody can come', async () => {
    const w = world(['A', 'B', 'C', 'D', 'E'], { ringMs: 1500 });
    const [a, b, c, d, e] = w.people;
    e.online = false;
    w.mesh();
    c.busy = true;
    await a.gcm.start(GID, { video: false });
    await until(() => b.invites.length === 1);
    await b.gcm.decline(b.invites[0].callId);
    await until(() => a.calls.at(-1)?.state === 'ended', 10000, 'ended');
    expect(a.calls.at(-1)?.reason).toBe('everyone-left');
    expect(d.invites).toHaveLength(1);
    // The caller gave up: D's screen shows a missed call, with no "Join" any more.
    await until(() => d.calls.at(-1)?.state === 'missed', 10000, 'D missed');
    expect(d.calls.at(-1)?.canJoin).toBe(false);
    expect(b.gcm.joinable()).toEqual([]); // B declined; the call is over now
    expect(c.invites).toHaveLength(0);
    // What each one sent back to A:
    const reasons = new Map<string, string | undefined>();
    for (const s of w.sent.filter((x) => x.to === a.id)) reasons.set(s.from, s.f.k);
    expect(reasons.get(b.id)).toBe('gc-decline');
    expect(reasons.get(c.id)).toBe('gc-busy');
    expect(reasons.get(d.id)).toBe('gc-ring');
    expect(reasons.has(e.id)).toBe(false);
  });

  it('participant reasons are reported on the participant events', async () => {
    const w = world(['A', 'B', 'C', 'D', 'E'], { ringMs: 1500 });
    const [a, b, c, d, e] = w.people;
    e.online = false;
    w.mesh();
    c.busy = true;
    const seen = new Map<string, string>();
    a.gcm.on('participant', (p) => p.state === 'failed' && seen.set(p.name, p.reason!));
    await a.gcm.start(GID, { video: false });
    await until(() => b.invites.length === 1);
    await b.gcm.decline(b.invites[0].callId);
    await until(() => seen.size === 4, 10000, 'all four failed');
    expect(Object.fromEntries(seen)).toEqual({ B: 'declined', C: 'busy', D: 'no-answer', E: 'offline' });
    void d;
  });

  it('bitrate steps: 1.5 Mbps up to 4 people, then 600 kbps, then 300 kbps; audio 32 kbps; a 7th on video is "full"', async () => {
    expect([2, 3, 4, 5, 6, 8].map((n) => videoStep(n).maxBitrate)).toEqual([1_500_000, 1_500_000, 1_500_000, 600_000, 300_000, 300_000]);
    expect(videoStep(6).scale).toBe(2);
    const w = world(['A', 'B', 'C', 'D', 'E', 'F', 'G'], { mediaMs: 4000 });
    w.mesh();
    const [a, b, c, d, e, f, g] = w.people;
    const cid = await ringAndJoin(w, a, true, [b, c, d]);
    const six = [a, b, c, d, e, f];
    await until(() => w.allConnected([a, b, c, d]), 10000);
    const live = (p: Person) => p.gcm.participants().filter((q) => q.state === 'connected');
    for (const p of [a, b, c, d]) for (const q of live(p)) expect(p.gcm.senderParams(q.id).video).toMatchObject({ maxBitrate: 1_500_000, scaleResolutionDownBy: 1 });
    await e.gcm.join(cid);
    await until(() => w.allConnected([a, b, c, d, e]), 10000);
    await until(() => w.pcOf(a, b) !== undefined && a.gcm.senderParams(b.id).video?.maxBitrate === 600_000, 10000, '600k');
    await f.gcm.join(cid);
    await until(() => w.allConnected(six), 10000, 'six');
    await w.settle();
    for (const p of six) {
      expect(live(p)).toHaveLength(5);
      for (const q of live(p)) {
        expect(p.gcm.senderParams(q.id).video).toMatchObject({ maxBitrate: 300_000, scaleResolutionDownBy: 2 });
        expect(p.gcm.senderParams(q.id).audio).toMatchObject({ maxBitrate: AUDIO_MAX_BITRATE });
      }
    }
    // The 7th person: the call is full (6 on video).
    await until(() => g.invites.length === 1);
    await g.gcm.join(cid);
    await until(() => g.gcm.call === null, 10000, 'full');
    expect(g.calls.at(-1)).toMatchObject({ state: 'ended', reason: 'full' });
    expect(w.allConnected(six)).toBe(true);
    // Two leave: back up to full quality.
    await e.gcm.leave();
    await f.gcm.leave();
    await until(() => a.gcm.size === 4);
    await w.settle();
    expect(a.gcm.senderParams(b.id).video).toMatchObject({ maxBitrate: 1_500_000, scaleResolutionDownBy: 1 });
  });

  it('glare: both sides restart the same connection at once; the higher ID rolls back and it settles on one', async () => {
    const w = world(['A', 'B']);
    w.mesh();
    const [p1, p2] = w.people;
    const [lo, hi] = p1.id < p2.id ? [p1, p2] : [p2, p1];
    await ringAndJoin(w, p1, true, [p2]);
    await until(() => w.allConnected(w.people));
    const pLo = w.pcOf(lo, hi)!;
    const pHi = w.pcOf(hi, lo)!;
    const mark = w.sent.length;
    const before = w.sent.filter((s) => s.f.k === 'gc-sdp').length;
    await Promise.all([lo.gcm.restartPair(hi.id), hi.gcm.restartPair(lo.id)]);
    await until(() => pLo.signalingState === 'stable' && pHi.signalingState === 'stable' && w.sent.filter((s) => s.f.k === 'gc-sdp').length >= before + 3, 10000, 'settled');
    await w.settle();
    expect(pHi.rollbacks).toBe(1); // the polite (higher) side gave way
    expect(pLo.rollbacks).toBe(0);
    expect(w.pcOf(lo, hi)).toBe(pLo); // same connections, still connected
    expect(w.pcOf(hi, lo)).toBe(pHi);
    expect(w.allConnected(w.people)).toBe(true);
    const sdp = w.sent.slice(mark).filter((s) => s.f.k === 'gc-sdp');
    expect(sdp.filter((s) => s.f.d?.type === 'offer').map((s) => s.from).sort()).toEqual([lo.id, hi.id].sort());
    expect(sdp.filter((s) => s.f.d?.type === 'answer').map((s) => s.from)).toEqual([hi.id]);
  });

  it('every offer and answer carries a signed DTLS fingerprint; a mismatch or a change drops that pair', async () => {
    const w = world(['A', 'B', 'C']);
    w.mesh();
    const [a, b, c] = w.people;
    const ids = [a, b, c].sort((x, y) => (x.id < y.id ? -1 : 1));
    const [lo, mid] = ids;
    const other = ids[2];
    // Whoever offers to `mid` from `lo` sends a SIGNED frame whose fingerprint doesn't match its SDP.
    w.setTap((from, to, f) => {
      if (f.k === 'gc-sdp' && from === lo && to === mid && f.d?.type === 'offer') {
        const g = { ...f, fp: `sha-256 ${randomFp()}` };
        g.sig = toB64url(sign(from.ident.secretKey, frameBytes(g)));
        return g;
      }
      return f;
    });
    const cid = await lo.gcm.start(GID, { video: false });
    await until(() => mid.invites.length === 1 && other.invites.length === 1);
    await mid.gcm.join(cid);
    await other.gcm.join(cid);
    await until(() => w.part(mid, lo)?.state === 'failed' && w.part(mid, lo)?.reason === 'media', 10000, 'pair refused');
    await until(() => w.allConnected([lo, other]) && w.allConnected([mid, other]), 10000);

    // A later offer whose fingerprint changed (a different connection) is refused too.
    w.setTap(null);
    const pc = w.pcOf(lo, other)!;
    pc.fp = randomFp();
    await lo.gcm.restartPair(other.id);
    await until(() => w.part(other, lo)?.state === 'failed', 10000, 'changed fingerprint refused');
    // A frame changed on the way (not re-signed) is simply ignored.
    let changed = 0;
    w.setTap((_f, _t, f) => (f.k === 'gc-media' ? (changed++, { ...f, mic: !f.mic }) : f));
    mid.gcm.setMic(false);
    await w.settle();
    expect(changed).toBeGreaterThan(0);
    expect(w.part(other, mid)?.mic).toBe(true); // the changed frame didn't count
  });

  it('screen sharing: one person at a time; it replaces the camera on every connection', async () => {
    const w = world(['A', 'B', 'C']);
    w.mesh();
    const [a, b, c] = w.people;
    await ringAndJoin(w, a, true, [b, c]);
    await until(() => w.allConnected(w.people), 10000);
    const cam = (p: Person, q: Person) => w.pcOf(p, q)!.transceivers.find((t) => t.receiver.track.kind === 'video')!.sender.track?.label;
    await a.gcm.startScreen();
    await until(() => b.screens.at(-1) === a.id && c.screens.at(-1) === a.id);
    expect(cam(a, b)).toBe('screen');
    expect(cam(a, c)).toBe('screen');
    expect(w.part(b, a)?.screen).toBe(true);
    expect(a.gcm.senderParams(b.id).video?.scaleResolutionDownBy).toBe(1);
    await expect(b.gcm.startScreen()).rejects.toThrow(/A is sharing/);
    await a.gcm.stopScreen();
    await until(() => b.screens.at(-1) === null && c.screens.at(-1) === null);
    expect(cam(a, b)).toBe('camera');

    // B and C start at the same moment: one keeps sharing, the other goes back to the camera.
    await Promise.all([b.gcm.startScreen(), c.gcm.startScreen()]);
    await w.settle(60);
    const by = a.gcm.screenBy;
    expect([b.id, c.id]).toContain(by);
    expect(b.gcm.screenBy).toBe(by);
    expect(c.gcm.screenBy).toBe(by);
    const loser = by === b.id ? c : b;
    expect(cam(loser, a)).toBe('camera');
  });

  it('mute and camera state reach everyone; a voice call can turn on the camera without a new offer', async () => {
    const w = world(['A', 'B', 'C']);
    w.mesh();
    const [a, b, c] = w.people;
    await ringAndJoin(w, a, false, [b, c]);
    await until(() => w.allConnected(w.people), 10000);
    expect(w.part(a, b)?.hasVideo).toBe(false);
    b.gcm.setMic(false);
    await until(() => w.part(a, b)?.mic === false && w.part(c, b)?.mic === false);
    const offers = w.sent.filter((s) => s.f.k === 'gc-sdp').length;
    await b.gcm.setCamera(true);
    await until(() => w.part(a, b)?.camera === true && w.part(a, b)?.hasVideo === true && w.part(c, b)?.hasVideo === true);
    expect(w.sent.filter((s) => s.f.k === 'gc-sdp').length).toBe(offers);
    await b.gcm.setCamera(false);
    await until(() => w.part(a, b)?.camera === false);
    // The device-sound mix: another audio track goes out instead of the microphone.
    const mixed = new FakeTrack('audio', false, 'mix');
    await a.gcm.setAudioTrack(mixed as unknown as MediaStreamTrack);
    expect(w.pcOf(a, b)!.transceivers.find((t) => t.receiver.track.kind === 'audio')!.sender.track).toBe(mixed);
    await a.gcm.setAudioTrack(null);
    expect(w.pcOf(a, b)!.transceivers.find((t) => t.receiver.track.kind === 'audio')!.sender.track?.label).toBe('audio');
  });

  it('active speaker from the audio level', async () => {
    const w = world(['A', 'B', 'C'], { pollMs: 15 });
    w.mesh();
    const [a, b, c] = w.people;
    await ringAndJoin(w, a, false, [b, c]);
    await until(() => w.allConnected(w.people), 10000);
    levels.set(c.id, 0.4);
    await until(() => a.speakers.at(-1) === c.id && b.speakers.at(-1) === c.id, 10000, 'C speaks');
    expect(w.part(a, c)?.speaking).toBe(true);
    levels.set(c.id, 0);
    levels.set(b.id, 0.5);
    await until(() => a.speakers.at(-1) === b.id, 10000, 'B speaks');
    await until(() => w.part(a, c)?.speaking === false, 10000);
    levels.clear();
    for (const p of w.people) await p.gcm.leave();
  });

  it('an invite carried by the group reaches a member who could not be reached directly', async () => {
    const w = world(['A', 'B', 'C'], { fanout: true, ringMs: 2000 });
    const [a, b, c] = w.people;
    c.online = false;
    w.mesh();
    const cid = await ringAndJoin(w, a, false, [b]);
    await until(() => w.fanned.length === 1, 10000, 'fanned out');
    expect(w.fanned[0].f).toMatchObject({ k: 'gc-invite', to: '', cid });
    // C comes online later and gets the group message (GroupManager 'message' event).
    c.online = true;
    expect(c.gcm.onGroupMessage({ gid: GID, from: a.id, body: { gcall: w.fanned[0].f } })).toBe(true);
    await until(() => c.invites.length === 1, 10000, 'C rings');
    await c.gcm.join(cid);
    await until(() => w.allConnected([a, b, c]), 10000);
    // A copy that is too old does not ring.
    const old = { ...w.fanned[0].f, cid: 'oldcall', ts: Date.now() - 10 * 60_000 };
    old.sig = toB64url(sign(a.ident.secretKey, frameBytes(old)));
    b.gcm.onGroupMessage({ gid: GID, from: a.id, body: { gcall: old } });
    await w.settle();
    expect(b.invites.map((i) => i.callId)).toEqual([cid]);
  });

  it('GroupManager fits the GroupSource the call manager needs', () => {
    const me = { ...newGuestIdentity(), name: 'Me' };
    const src: GroupSource = new GroupManager(me);
    expect(src.get('none')).toBeUndefined();
  });
});
