// "My code" / "their code": the connection offer or reply that two devices swap by QR or text.
// No server: the text carries the WebRTC session description, the sender's identity key,
// a fresh X25519 key for the chat lock, and an Ed25519 signature over the DTLS fingerprint.

import { fromB64url, fromUtf8, toB64url, utf8 } from './bytes';
import { sign, verify } from './identity';

export const CODE_PREFIX = 'P2P1.';

export type CodeKind = 'offer' | 'answer';

export interface SignedCode {
  v: 1;
  t: 'o' | 'a';
  /** Session description (SDP) text. */
  s: string;
  /** Sender's Ed25519 identity public key (base64url). */
  k: string;
  /** Sender's one-time X25519 public key for this connection (base64url). */
  e: string;
  /** Display name (may be empty). */
  n: string;
  /** Signature (base64url) over signedBytes(). */
  g: string;
}

export interface VerifiedCode {
  kind: CodeKind;
  sdp: string;
  identityKey: Uint8Array;
  ephemeralKey: Uint8Array;
  name: string;
  fingerprint: string;
}

/** The DTLS certificate fingerprint written in an SDP, e.g. "sha-256 AB:CD:...". */
export function sdpFingerprint(sdp: string): string {
  const found = new Set<string>();
  for (const m of sdp.matchAll(/^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)\s*$/gm)) {
    found.add(`${m[1].toLowerCase()} ${m[2].toUpperCase()}`);
  }
  if (found.size !== 1) throw new Error('The code has no single link fingerprint.');
  const fp = [...found][0];
  if (!fp.startsWith('sha-256 ')) throw new Error('Unsupported link fingerprint.');
  return fp;
}

/**
 * Bytes the sender signs. For an answer, `peerFingerprint` is the offer's fingerprint, so an
 * old answer can't be replayed into a new connection.
 */
export function signedBytes(
  t: 'o' | 'a',
  fingerprint: string,
  identityKey: string,
  ephemeralKey: string,
  name: string,
  peerFingerprint: string,
): Uint8Array {
  return utf8(JSON.stringify(['p2ptalk-sig-v1', t, fingerprint, identityKey, ephemeralKey, name, peerFingerprint]));
}

export function makeCode(args: {
  kind: CodeKind;
  sdp: string;
  identitySecret: Uint8Array;
  identityPublic: Uint8Array;
  ephemeralPublic: Uint8Array;
  name: string;
  peerFingerprint?: string;
}): SignedCode {
  const t = args.kind === 'offer' ? 'o' : 'a';
  const fp = sdpFingerprint(args.sdp);
  const k = toB64url(args.identityPublic);
  const e = toB64url(args.ephemeralPublic);
  const name = args.name.slice(0, 40);
  const g = toB64url(sign(args.identitySecret, signedBytes(t, fp, k, e, name, args.peerFingerprint ?? '')));
  return { v: 1, t, s: args.sdp, k, e, n: name, g };
}

/**
 * Checks the signature over the DTLS fingerprint found in the SDP. Throws (refuses the
 * connection) if anything doesn't match.
 */
export function verifyCode(code: SignedCode, expect: CodeKind, peerFingerprint = ''): VerifiedCode {
  if (!code || code.v !== 1) throw new Error('This code is from a different version of the app.');
  const kind: CodeKind = code.t === 'o' ? 'offer' : 'answer';
  if (kind !== expect) {
    throw new Error(expect === 'offer' ? 'This is a reply code. Scan their first code.' : 'This is not a reply code.');
  }
  const fp = sdpFingerprint(code.s);
  const identityKey = fromB64url(code.k);
  const ephemeralKey = fromB64url(code.e);
  if (identityKey.length !== 32 || ephemeralKey.length !== 32) throw new Error('This code is damaged.');
  const n = code.n ?? '';
  if (typeof n !== 'string') throw new Error('This code is damaged.');
  const ok = verify(identityKey, signedBytes(code.t, fp, code.k, code.e, n, peerFingerprint), fromB64url(code.g));
  if (!ok) throw new Error('Safety check failed: this code was changed on the way. Not connecting.');
  // The name is the sender's own claim: shown as text only, and never longer than makeCode() allows.
  return { kind, sdp: code.s, identityKey, ephemeralKey, name: n.slice(0, 40), fingerprint: fp };
}

// ---- Text form: deflate + base64url ----------------------------------------------------------

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function encodeCode(code: SignedCode): Promise<string> {
  const packed = await pipe(utf8(JSON.stringify(code)), new CompressionStream('deflate'));
  return CODE_PREFIX + toB64url(packed);
}

export async function decodeCode(text: string): Promise<SignedCode> {
  let t = text.trim();
  const hash = t.indexOf('#');
  if (hash >= 0) t = t.slice(hash + 1); // also accept a link with the code after "#"
  if (!t.startsWith(CODE_PREFIX)) throw new Error('This is not a P2P Talk code.');
  try {
    const raw = await pipe(fromB64url(t.slice(CODE_PREFIX.length)), new DecompressionStream('deflate'));
    return JSON.parse(fromUtf8(raw)) as SignedCode;
  } catch {
    throw new Error('This code is incomplete or damaged. Copy all of it.');
  }
}
