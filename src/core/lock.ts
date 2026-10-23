// App-level lock for the data channel, on top of WebRTC's own DTLS lock.
//
//   ikm  = X25519(my one-time key, their one-time key) || X25519(my identity, their identity)
//   salt = SHA-256(both identity keys, both one-time keys, both DTLS fingerprints)
//   keys = HKDF-SHA256(ikm, salt) -> one AES-256-GCM key per direction
//
// The one-time keys are signed (inside the offer/answer) by the identity keys, and the identity
// keys are mixed into the secret and into every message's associated data, so a message only
// opens for the two identities that made the connection. Each message carries a counter: the
// nonce is never reused and old messages can't be replayed.
//
// Phase 1 replaces this with the Double Ratchet (vodozemac) for a new key on every message.

import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { concat, readU64be, u64be, utf8 } from './bytes';
import { x25519PublicFromEd, x25519SecretFromEd } from './identity';

export type Role = 'offerer' | 'answerer';

export interface SessionInput {
  role: Role;
  myIdentitySecret: Uint8Array;
  myIdentityPublic: Uint8Array;
  myEphemeralSecret: Uint8Array;
  myEphemeralPublic: Uint8Array;
  peerIdentityPublic: Uint8Array;
  peerEphemeralPublic: Uint8Array;
  offerFingerprint: string;
  answerFingerprint: string;
}

export function newEphemeral(): { secret: Uint8Array; public: Uint8Array } {
  const secret = x25519.utils.randomPrivateKey();
  return { secret, public: x25519.getPublicKey(secret) };
}

function dh(secret: Uint8Array, pub: Uint8Array): Uint8Array {
  const s = x25519.getSharedSecret(secret, pub);
  if (s.every((b) => b === 0)) throw new Error('bad key');
  return s;
}

/** Raw key material (exported for tests: both sides must derive the same two keys). */
export function deriveKeys(i: SessionInput): { send: Uint8Array; recv: Uint8Array } {
  const offerer = i.role === 'offerer';
  const [oId, aId] = offerer ? [i.myIdentityPublic, i.peerIdentityPublic] : [i.peerIdentityPublic, i.myIdentityPublic];
  const [oEph, aEph] = offerer ? [i.myEphemeralPublic, i.peerEphemeralPublic] : [i.peerEphemeralPublic, i.myEphemeralPublic];
  const ikm = concat(
    dh(i.myEphemeralSecret, i.peerEphemeralPublic),
    dh(x25519SecretFromEd(i.myIdentitySecret), x25519PublicFromEd(i.peerIdentityPublic)),
  );
  const salt = sha256(concat(utf8('p2ptalk-lock-v1'), oId, aId, oEph, aEph, utf8(i.offerFingerprint), utf8(i.answerFingerprint)));
  const o2a = hkdf(sha256, ikm, salt, utf8('p2ptalk-lock-v1 offerer->answerer'), 32);
  const a2o = hkdf(sha256, ikm, salt, utf8('p2ptalk-lock-v1 answerer->offerer'), 32);
  return offerer ? { send: o2a, recv: a2o } : { send: a2o, recv: o2a };
}

const importKey = (raw: Uint8Array, use: KeyUsage) =>
  crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [use]);

export class SessionLock {
  private sendCounter = 0;
  private lastRecv = 0;

  private constructor(
    private readonly sendKey: CryptoKey,
    private readonly recvKey: CryptoKey,
    private readonly me: Uint8Array,
    private readonly peer: Uint8Array,
  ) {}

  static async create(i: SessionInput): Promise<SessionLock> {
    const k = deriveKeys(i);
    return new SessionLock(await importKey(k.send, 'encrypt'), await importKey(k.recv, 'decrypt'), i.myIdentityPublic, i.peerIdentityPublic);
  }

  private static nonce(counter: number): Uint8Array {
    return concat(new Uint8Array(4), u64be(counter));
  }

  private static aad(sender: Uint8Array, receiver: Uint8Array, counter: number): Uint8Array {
    return concat(utf8('p2ptalk-msg-v1'), sender, receiver, u64be(counter));
  }

  /** Locks one message. Output: 8-byte counter || AES-GCM ciphertext and tag. */
  async seal(plain: Uint8Array): Promise<Uint8Array> {
    const n = ++this.sendCounter;
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: SessionLock.nonce(n) as BufferSource, additionalData: SessionLock.aad(this.me, this.peer, n) as BufferSource },
      this.sendKey,
      plain as BufferSource,
    );
    return concat(u64be(n), new Uint8Array(ct));
  }

  /** Opens one message; throws on a changed, replayed or foreign message. Call in arrival order. */
  async open(frame: Uint8Array): Promise<Uint8Array> {
    if (frame.length < 8 + 16) throw new Error('too short');
    const n = readU64be(frame);
    if (n <= this.lastRecv) throw new Error('replayed message');
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: SessionLock.nonce(n) as BufferSource, additionalData: SessionLock.aad(this.peer, this.me, n) as BufferSource },
      this.recvKey,
      frame.subarray(8) as BufferSource,
    );
    this.lastRecv = n;
    return new Uint8Array(pt);
  }
}
