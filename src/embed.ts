// Embedded mode: p2p.vilnek.in/p2p.html?embed=1 inside a host app (Vilnek OS opens it in a hidden
// WebKit view and draws its own screens). No screens here; the host drives everything through
// window.P2PTalk and hears events through P2PTalk.on() and, when present, the WebKit message handler
// "p2ptalk". The identity is given by the host and held in memory only (unless `keep: true`).
// Full API: docs/EMBEDDING.md.

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { fromB64url, fromHex, toB64url, toHex } from './core/bytes';
import { cardTextFrom, decodeCard, newCard } from './core/card';
import { cleanDeviceName, deviceCode, renameDevice, type StoredDevice } from './core/device';
import { emojiCode, identityFromPhrase, newPhrase, p2pId } from './core/identity';
import { PATH_TEXT } from './core/path';
import {
  addMessage,
  loadContact,
  loadContacts,
  loadMe,
  loadMessages,
  loadMyDevices,
  saveDevice,
  saveInvite,
  saveMe,
  useDatabase,
  type Contact,
  type StoredMe,
} from './core/store';
import { allowedRelays, myRelays, testInviteTtl } from './net/config';
import { Hub, joinInvite } from './net/hub';
import { joinCard } from './net/oneScan';
import { FEATURES, Peer, PROTOCOL_VERSION, type CallInfo } from './net/peer';
import { lastAttempt, report } from './net/diag';
import { blobSource, FILE_FEATURE, FileTransfers, type TransferInfo } from './net/files';
import { receiveSink } from './native/nativeFiles';
import { PhotoLink, PIC_FEATURE, PIC_KINDS } from './net/photos';
import { parseReceipt, RCPT_FEATURE } from './net/receipts';
import type { StoredPhoto } from './core/photo';
import { loadPics, savePics } from './core/store';
import { ensureDevice, KeyChanged, learnMyDevices, meWithDevice, rememberContact } from './net/session';

// ---- events ---------------------------------------------------------------------------------------

type EventName = 'loaded' | 'ready' | 'contact' | 'request' | 'message' | 'message-status' | 'call' | 'stream' | 'recording' | 'screen' | 'invite' | 'devices' | 'file';
type Handler = (data: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

interface WebKitWindow {
  webkit?: { messageHandlers?: { p2ptalk?: { postMessage(m: unknown): void } } };
}

/** To in-page listeners (full data, with MediaStreams) and to the host app (plain data only). */
function emit(event: EventName, data: unknown, forHost: unknown = data): void {
  for (const fn of [...(handlers.get(event) ?? [])]) {
    try {
      fn(data);
    } catch (e) {
      console.warn('P2PTalk listener', e);
    }
  }
  try {
    (window as unknown as WebKitWindow).webkit?.messageHandlers?.p2ptalk?.postMessage({ event, data: forHost });
  } catch {
    /* no host */
  }
}

// ---- state ------------------------------------------------------------------------------------------

let me: StoredMe | null = null;
let device: StoredDevice | null = null;
let keep = false;
let hub: Hub | null = null;
/** One live connection per contact (24-digit ID). */
const peers = new Map<string, Peer>();
const LAST_KEY = 'p2ptalk-embed-last';

const TTL: Record<string, number> = { '1h': 3600_000, '24h': 24 * 3600_000, '7d': 7 * 24 * 3600_000 };

function need(): StoredMe {
  if (!me) throw new Error('Call P2PTalk.start() first.');
  return me;
}

/** The database of an embedded identity (host mode, ?embed=1&ui=1, uses the same one: chats carry over). */
export const dbFor = (pub: Uint8Array) => `p2ptalk-embed-${toHex(sha256(pub)).slice(0, 16)}`;

function meInfo() {
  const m = need();
  return {
    id: p2pId(m.publicKey),
    name: m.name,
    emoji: emojiCode(m.publicKey),
    publicKey: toB64url(m.publicKey),
    deviceName: device?.name ?? '',
    deviceCode: device ? deviceCode(device.publicKey) : '',
    kept: keep,
  };
}

function pathOf(p: Peer) {
  return { kind: p.path.kind, label: PATH_TEXT[p.path.kind].label };
}

/** Contacts' pictures (checked by net/photos.ts: type, size, magic bytes, hash). For the host as a data: URL. */
let embedPics: Record<string, StoredPhoto> = {};
const photoOf = (id: string): string | null => {
  const p = embedPics[id];
  if (!p) return null;
  const b64 = toB64url(p.b).replace(/-/g, '+').replace(/_/g, '/');
  return `data:${p.t};base64,${b64}${'='.repeat((4 - (b64.length % 4)) % 4)}`;
};

function contactInfo(c: Contact) {
  const p = peers.get(c.id);
  return {
    photo: photoOf(c.id),
    id: c.id,
    name: c.name,
    emoji: c.emoji ?? emojiCode(fromB64url(c.publicKey)),
    online: !!p?.isOnline,
    lastSeen: p?.lastSeen || c.lastSeen,
    path: p ? pathOf(p) : { kind: 'offline', label: PATH_TEXT.offline.label },
    device: p?.peer?.device?.name ?? c.devices?.[0]?.cert.dn ?? null,
  };
}

function peerContact(p: Peer) {
  const info = p.peer!;
  return {
    photo: photoOf(info.id),
    id: info.id,
    name: info.name,
    emoji: emojiCode(info.publicKey),
    online: p.isOnline,
    lastSeen: p.lastSeen,
    path: pathOf(p),
    device: info.device?.name ?? null,
  };
}

const callData = (p: Peer, c: CallInfo) => ({
  contactId: p.peer?.id ?? '',
  state: c.state,
  video: c.video,
  outgoing: c.outgoing,
  reason: c.failure ?? null,
  connectedAt: c.connectedAt ?? null,
});

const callPeer = () => [...peers.values()].find((p) => p.inCallNow) ?? null;

// ---- connections ------------------------------------------------------------------------------------

function adopt(p: Peer): void {
  p.otherCallBusy = () => [...peers.values()].some((q) => q !== p && q.inCallNow);
  let id = '';
  const onReady = () => {
    if (id) return;
    id = p.peer!.id;
    const old = peers.get(id);
    if (old && old !== p) old.close();
    peers.set(id, p);
    if (p.supports(FILE_FEATURE)) {
      const f = filesFor(id);
      f.attach(p.chatChannel(), (tid) => p.openFileChannel(tid));
      p.on('fileChannel', (ch) => f.addDataChannel(ch));
    }
    if (p.supports(RCPT_FEATURE))
      p.on('frame', (fr) => {
        const r = parseReceipt(fr);
        if (r && !r.g) for (const mid of r.mids) emit('message-status', { contactId: id, mid, status: r.st === 'r' ? 'read' : 'delivered' });
      });
    if (p.supports(PIC_FEATURE)) {
      // Embedded mode receives contacts' pictures (event 'contact' with photo); it sends none of its own.
      const link = new PhotoLink(id, (fr) => p.sendFrame(fr), {
        mine: () => null,
        stored: (key) => embedPics[key],
        isMember: () => false,
        received: (key, photo) => {
          if (photo) embedPics[key] = photo;
          else delete embedPics[key];
          void savePics(embedPics);
          if (p.peer) emit('contact', peerContact(p));
        },
      });
      p.on('frame', (fr) => PIC_KINDS.has((fr as { k: string }).k) && link.onFrame(fr));
      void loadPics().then((stored) => {
        embedPics = { ...stored, ...embedPics };
        void link.announce();
      });
    }
    // A known ID with another key is refused (the host can show "Safety code changed").
    void myRelays().then((r) => rememberContact(p, r)).catch((e) => {
      if (e instanceof KeyChanged) {
        p.close();
        emit('contact', { ...peerContact(p), online: false, keyChanged: true });
      }
    });
    emit('contact', peerContact(p));
  };
  p.on('ready', onReady)
    .on('presence', () => id && emit('contact', peerContact(p)))
    .on('path', () => id && emit('contact', peerContact(p)))
    .on('message', (m) => {
      if (!p.peer) return;
      void addMessage({ peer: p.peer.id, from: 'them', text: m.text, ts: m.ts, mid: m.mid });
      emit('message', { contactId: p.peer.id, from: 'them', mid: m.mid, text: m.text, ts: m.ts });
      // Delivered (two grey ticks on their side). Read receipts are the host's to send: markRead().
      if (p.supports(RCPT_FEATURE)) void p.sendFrame({ k: 'rcpt', mids: [m.mid], st: 'd' }).catch(() => undefined);
    })
    .on('call', (c) => emit('call', callData(p, c)))
    .on('remoteStream', (s) => emit('stream', { contactId: p.peer?.id, kind: 'remote', stream: s }, { contactId: p.peer?.id, kind: 'remote', tracks: s?.getTracks().map((t) => t.kind) ?? [] }))
    .on('localStream', (s) => emit('stream', { contactId: p.peer?.id, kind: 'local', stream: s }, { contactId: p.peer?.id, kind: 'local', tracks: s?.getTracks().map((t) => t.kind) ?? [] }))
    .on('recording', (on) => emit('recording', { contactId: p.peer?.id, on }))
    .on('screen', (x) => emit('screen', { contactId: p.peer?.id, ...x }))
    .on('devices', (l) => {
      if (me && device) void learnMyDevices(me, toB64url(device.publicKey), l).then((list) => emit('devices', list.map(deviceRow)));
    })
    .on('closed', () => {
      if (id && peers.get(id) === p) {
        peers.delete(id);
        files.get(id)?.detach();
        emit('contact', { ...peerContact(p), online: false, path: { kind: 'offline', label: PATH_TEXT.offline.label } });
      }
    });
  if (p.ready && p.peer) onReady();
}


// ---- files (the files2 engine: one data channel per transfer, resume, Accept above 100 MB) ---------

const files = new Map<string, FileTransfers>();
const fileData = (t: TransferInfo) => ({
  contactId: t.peerId,
  fid: t.id,
  name: t.name,
  size: t.size,
  type: t.mime,
  from: t.dir === 'out' ? 'me' : 'them',
  done: t.bytes,
  speed: t.speed,
  eta: t.eta,
  state: t.state,
});

function filesFor(id: string): FileTransfers {
  let f = files.get(id);
  if (!f) {
    f = new FileTransfers(id, { autoAcceptBelow: 100 * 1024 * 1024, autoSink: async (t) => receiveSink(t.name, t.size, t.mime), maxFrame: peers.get(id)?.maxFrame ?? 65_536 });
    const ev = (t: TransferInfo) => emit('file', { ...fileData(t), blob: t.result?.file ?? null }, fileData(t));
    f.on('offer', ev);
    f.on('update', ev);
    f.on('done', (t) => {
      ev(t);
      // BUG-7: a file in the browser's private file area is kept there; only its name goes into the database.
      const opfs = t.result?.where === 'opfs' ? t.result.opfsName : undefined;
      void addMessage({ peer: t.peerId, from: t.dir === 'out' ? 'me' : 'them', text: '', ts: Date.now(), mid: t.id, file: { name: t.name, size: t.size, type: t.mime }, blob: t.result?.where === 'memory' ? t.result.file : undefined, opfs });
    });
    files.set(id, f);
  }
  return f;
}

const deviceRow = (d: { cert: { dk: string; dn: string }; seen: number }) => ({ name: d.cert.dn, code: deviceCode(d.cert.dk), seen: d.seen });

function startHub(): void {
  hub?.stop();
  hub = new Hub(
    meWithDevice(need(), device),
    myRelays,
    allowedRelays,
    {
      peer: (p) => adopt(p),
      request: (inv, req) =>
        emit('request', { requestId: `${inv.id}:${req.k}`, inviteId: inv.id, id: p2pId(fromB64url(req.k)), name: req.n, note: req.note }),
      accepted: (c) => {
        emit('contact', contactInfo(c));
        void connectSoon(c);
      },
      refused: (pnd) => emit('invite', { state: 'refused', id: pnd.id }),
      changed: () => undefined,
    },
    // Any number of chats at once; a contact's reconnect is ignored only while in a call with them.
    (id) => !peers.get(id)?.inCallNow,
  );
  hub.start();
}

async function connectSoon(c: Contact): Promise<void> {
  for (let i = 0; i < 3 && !peers.get(c.id)?.ready; i++) {
    try {
      adopt(await hub!.connectTo(c));
      return;
    } catch {
      /* try again */
    }
  }
}

function untilReady(p: Peer, ms = 15_000): Promise<void> {
  if (p.ready) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('offline')), ms);
    p.on('ready', () => {
      clearTimeout(t);
      resolve();
    }).on('closed', () => {
      clearTimeout(t);
      reject(new Error('offline'));
    });
  });
}

function parseSecretKey(k: string): Uint8Array {
  const t = k.trim();
  const raw = /^[0-9a-fA-F]{64}$/.test(t) ? fromHex(t.toLowerCase()) : fromB64url(t);
  if (raw.length !== 32) throw new Error('The secret key must be 32 bytes (64 hex characters or 43 base64url characters).');
  return raw;
}

// ---- the API ----------------------------------------------------------------------------------------

export interface StartOptions {
  /** The 24 words. */
  words?: string;
  /** Or the identity secret key: 64 hex or 43 base64url characters. */
  secretKey?: string;
  /** Or: the identity kept by an earlier start({ keep: true }). */
  resume?: boolean;
  name?: string;
  deviceName?: string;
  /** Store the identity in this page's storage (default false: memory only). */
  keep?: boolean;
}

const api = {
  /** {protocol, build, features} of this page. */
  version: () => ({ protocol: PROTOCOL_VERSION, build: __BUILD__, features: [...FEATURES] }),

  /** 24 new words, for a new account (the host shows them to the user and keeps nothing). */
  newWords: () => newPhrase(),

  async start(o: StartOptions) {
    if (me) throw new Error('Already started. Call P2PTalk.stop() first.');
    let secretKey: Uint8Array;
    let publicKey: Uint8Array;
    let stored: StoredMe | undefined;
    if (o.words) ({ secretKey, publicKey } = await identityFromPhrase(o.words));
    else if (o.secretKey) {
      secretKey = parseSecretKey(o.secretKey);
      publicKey = ed25519.getPublicKey(secretKey);
    } else if (o.resume) {
      let last: string | null = null;
      try {
        last = localStorage.getItem(LAST_KEY);
      } catch {
        /* no storage */
      }
      if (!last) throw new Error('Nothing kept on this page.');
      useDatabase(last);
      stored = await loadMe();
      if (!stored) throw new Error('Nothing kept on this page.');
      ({ secretKey, publicKey } = stored);
    } else throw new Error('Give words, secretKey or resume.');
    useDatabase(dbFor(publicKey));
    keep = !!o.keep || !!o.resume;
    me = { secretKey, publicKey, name: (o.name ?? stored?.name ?? '').slice(0, 40), created: stored?.created ?? Date.now() };
    if (keep) {
      await saveMe(me);
      try {
        localStorage.setItem(LAST_KEY, dbFor(publicKey));
      } catch {
        /* no storage */
      }
    }
    device = await ensureDevice(me, o.deviceName);
    startHub();
    const info = meInfo();
    emit('ready', info);
    return info;
  },

  /** Closes every connection and forgets the identity (the stored one too, unless kept). */
  stop() {
    hub?.stop();
    hub = null;
    for (const p of peers.values()) p.close();
    peers.clear();
    me = null;
    device = null;
  },

  me: () => meInfo(),

  async setName(name: string) {
    need().name = name.slice(0, 40);
    if (keep) await saveMe(me!);
    startHub();
    return meInfo();
  },

  async setDeviceName(name: string) {
    const m = need();
    const n = cleanDeviceName(name);
    if (!n || !device) throw new Error('Give a device name.');
    device = renameDevice(m.secretKey, m.publicKey, device, n);
    await saveDevice(device);
    startHub();
    return meInfo();
  },

  /** My other devices that contacts saw recently. */
  async myDevices() {
    need();
    return (await loadMyDevices()).map(deviceRow);
  },

  async contacts() {
    need();
    return (await loadContacts()).sort((a, b) => b.lastSeen - a.lastSeen).map(contactInfo);
  },

  async history(contactId: string) {
    need();
    return (await loadMessages(contactId)).map((m) => ({ from: m.from, mid: m.mid, text: m.text, ts: m.ts, ...(m.st ? { status: m.st } : {}) }));
  },

  /** The host shows these messages of theirs: send read receipts (blue ticks on their side). */
  async markRead(contactId: string, mids: string[]) {
    need();
    const p = peers.get(String(contactId));
    if (!p?.ready || !p.supports(RCPT_FEATURE) || !Array.isArray(mids) || !mids.length) return false;
    await p.sendFrame({ k: 'rcpt', mids: mids.map(String).slice(0, 200), st: 'r' });
    return true;
  },

  async makeInvite(o: { ttl?: '1h' | '24h' | '7d'; name?: string } = {}) {
    const m = need();
    const relays = await myRelays();
    const ttlMs = testInviteTtl ? testInviteTtl * 1000 : TTL[o.ttl ?? '24h'] ?? TTL['24h'];
    const { card, boxSecret, link } = newCard(m.secretKey, m.publicKey, relays, Date.now(), { invite: true, ttlMs, name: o.name ?? m.name });
    const inviteId = toHex(card.boxId);
    await saveInvite({ id: inviteId, link, boxSecret, created: Date.now(), expires: card.expires, relays, status: 'waiting', blocked: [] });
    await hub?.refresh();
    return { link, inviteId, expires: card.expires };
  },

  /**
   * Open someone's invite link (or connect card). Resolves with
   * {state: 'connected' | 'request-sent' | 'refused' | 'connecting', contactId}.
   */
  async openLink(link: string) {
    const m = need();
    const text = cardTextFrom(link);
    if (!text) throw new Error('This is not a P2P Talk link.');
    const card = decodeCard(text);
    const contactId = p2pId(card.identityKey);
    if (card.kind !== 'invite') {
      const j = await joinCard(meWithDevice(m, device), text, allowedRelays());
      adopt(j.peer);
      await j.done;
      return { state: 'connecting', contactId };
    }
    const j = await joinInvite(meWithDevice(m, device), card, allowedRelays());
    void hub?.refresh();
    return new Promise<{ state: string; contactId: string }>((resolve, reject) => {
      j.connected.then((p) => {
        adopt(p);
        resolve({ state: 'connected', contactId });
      });
      j.refused.then(() => {
        emit('invite', { state: 'refused', id: contactId });
        resolve({ state: 'refused', contactId });
      });
      j.requestSent.then(() => resolve({ state: 'request-sent', contactId }), reject);
    });
  },

  /** Waiting invite requests (also announced by the "request" event). */
  requests() {
    return [...(hub?.requests ?? new Map())].map(([requestId, r]) => ({
      requestId,
      inviteId: r.invite.id,
      id: p2pId(fromB64url(r.req.k)),
      name: r.req.n,
      note: r.req.note,
    }));
  },

  async accept(requestId: string) {
    const c = await hub?.accept(requestId);
    if (!c) throw new Error('No such request.');
    emit('contact', contactInfo(c));
    return contactInfo(c);
  },

  async block(requestId: string) {
    await hub?.block(requestId);
  },

  async blockContact(contactId: string) {
    const c = await loadContact(contactId);
    peers.get(contactId)?.close();
    if (c) await hub?.blockContact(c);
  },

  /** Connect to a contact through the relays (resolves when the chat is open). */
  async connect(contactId: string) {
    need();
    const have = peers.get(contactId);
    if (have?.ready) return;
    const c = await loadContact(contactId);
    if (!c) throw new Error('Not a contact.');
    if (!hub) throw new Error('Not started.');
    const p = await hub.connectTo(c);
    adopt(p);
    await untilReady(p);
  },

  async send(contactId: string, text: string) {
    const p = peers.get(contactId);
    if (!p?.ready) throw new Error('offline');
    const m = await p.sendText(String(text));
    await addMessage({ peer: contactId, from: 'me', text: String(text), ts: m.ts, mid: m.mid });
    return m;
  },

  /** Call a contact (connects first if needed). States arrive as "call" events. */
  async call(contactId: string, o: { video?: boolean } = {}) {
    if (callPeer()) throw new Error('Already in a call.');
    let p = peers.get(contactId);
    if (!p?.ready) {
      try {
        await api.connect(contactId);
      } catch {
        emit('call', { contactId, state: 'failed', video: !!o.video, outgoing: true, reason: 'offline', connectedAt: null });
        return;
      }
      p = peers.get(contactId)!;
    }
    await p.startCall(!!o.video);
  },

  async acceptCall() {
    await [...peers.values()].find((p) => p.call.state === 'incoming')?.acceptCall();
  },

  async declineCall() {
    await [...peers.values()].find((p) => p.call.state === 'incoming')?.declineCall();
  },

  async hangUp() {
    await callPeer()?.hangUp();
  },

  setMicOn: (on: boolean) => callPeer()?.setMicOn(on),
  setCameraOn: (on: boolean) => callPeer()?.setCameraOn(on),

  /** Send another video track instead of the camera (screen share); null stops sending video. */
  async replaceVideoTrack(track: MediaStreamTrack | null) {
    const p = callPeer();
    if (!p) throw new Error('No call.');
    await p.replaceVideoTrack(track);
  },

  /** Share my screen in the current call (desktop browsers / WebKit with screen capture). */
  async startScreenShare() {
    const p = callPeer();
    if (!p) throw new Error('No call.');
    await p.startScreenShare();
  },

  async stopScreenShare() {
    await callPeer()?.stopScreenShare();
  },

  /** While sharing: my device sound on / off (it is mixed with the microphone). */
  setScreenSound(on: boolean) {
    callPeer()?.setScreenSound(!!on);
  },

  /** Send a file (Blob or File), as the original. Progress arrives as "file" events (with speed and eta). */
  async sendFile(contactId: string, file: Blob, name = (file as File).name ?? 'file') {
    const p = peers.get(contactId);
    if (!p?.ready) throw new Error('offline');
    if (!p.supports(FILE_FEATURE)) throw new Error('Their app can’t receive files yet.');
    const fid = await filesFor(contactId).send(blobSource(file, name));
    return { fid, name, size: file.size };
  },

  /** Files of 100 MB and more ask first ("file" event, state "incoming"). */
  async acceptFile(contactId: string, fid: string) {
    const t = files.get(contactId)?.get(fid);
    if (t) await files.get(contactId)!.accept(fid, receiveSink(t.name, t.size, t.mime));
  },
  declineFile: (contactId: string, fid: string) => files.get(contactId)?.decline(fid),
  cancelFile: (contactId: string, fid: string) => files.get(contactId)?.cancel(fid),
  pauseFile: (contactId: string, fid: string) => files.get(contactId)?.pause(fid),
  resumeFile: (contactId: string, fid: string) => files.get(contactId)?.resume(fid),

  /** The last connection attempt, as plain text (addresses masked), for support. */
  connectionDetails: () => report(lastAttempt()),

  getLocalStream: () => callPeer()?.localStream ?? null,
  getRemoteStream: () => callPeer()?.remoteStream ?? null,

  /** Tell the other side this call is being recorded (they see "● <name> is recording"). */
  async setRecording(on: boolean) {
    const p = callPeer();
    if (!p) throw new Error('No call.');
    await p.setRecording(!!on);
  },

  on(event: EventName, fn: Handler) {
    let set = handlers.get(event);
    if (!set) handlers.set(event, (set = new Set()));
    set.add(fn);
    return () => api.off(event, fn);
  },

  off(event: EventName, fn: Handler) {
    handlers.get(event)?.delete(fn);
  },
};

export type P2PTalkApi = typeof api;

export function startEmbed(): void {
  document.getElementById('app')?.replaceChildren();
  (window as unknown as { P2PTalk: P2PTalkApi }).P2PTalk = api;
  emit('loaded', api.version());
}
