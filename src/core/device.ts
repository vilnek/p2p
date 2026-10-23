// Several devices, one account (Dr Vijay, 22 Oct 2026: "add multi device support with same 24 digit
// id with device name").
//
// The same 24 words give the same identity key, P2P ID and emoji code on every device. Each device
// also makes its own random Ed25519 **device key** and a **device certificate**, signed by the
// identity key:
//
//   cert = { dk: b64url(device public key), dn: device name, ts: created (ms), g: signature }
//   g    = Ed25519.sign(identity, utf8(JSON(["p2ptalk-device-v1", b64url(identity public key), dk, dn, ts])))
//
// On every connection the device also proves it holds the device key, bound to that connection:
//
//   proof = Ed25519.sign(device, utf8(JSON(["p2ptalk-device-hello-v1", senderFingerprint, receiverFingerprint])))
//
// Contacts check both and show "Dr Vijay · on iPhone". The device key never leaves its device.

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { concat, fromB64url, toB64url, toHex, utf8 } from './bytes';
import { sign, verify } from './identity';

export const DEVICE_NAME_MAX = 32;

export interface DeviceCert {
  dk: string;
  dn: string;
  ts: number;
  g: string;
}

export interface StoredDevice {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  name: string;
  created: number;
  cert: DeviceCert;
}

/** A device as a contact sees it, after checking its certificate. */
export interface DeviceInfo {
  key: string; // b64url device public key
  name: string;
  created: number;
}

export const cleanDeviceName = (name: string) => name.replace(/\s+/g, ' ').trim().slice(0, DEVICE_NAME_MAX);

const certBytes = (identity: string, dk: string, dn: string, ts: number) => utf8(JSON.stringify(['p2ptalk-device-v1', identity, dk, dn, ts]));

export function certify(identitySecret: Uint8Array, identityPublic: Uint8Array, devicePublic: Uint8Array, name: string, created: number): DeviceCert {
  const dk = toB64url(devicePublic);
  const dn = cleanDeviceName(name);
  return { dk, dn, ts: created, g: toB64url(sign(identitySecret, certBytes(toB64url(identityPublic), dk, dn, created))) };
}

/** A new device key and its certificate. */
export function newDevice(identitySecret: Uint8Array, identityPublic: Uint8Array, name: string, now = Date.now()): StoredDevice {
  const secretKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(secretKey);
  const cert = certify(identitySecret, identityPublic, publicKey, name, now);
  return { secretKey, publicKey, name: cert.dn, created: now, cert };
}

/** Same device key, new name: a fresh certificate. */
export function renameDevice(identitySecret: Uint8Array, identityPublic: Uint8Array, d: StoredDevice, name: string): StoredDevice {
  const cert = certify(identitySecret, identityPublic, d.publicKey, name, d.created);
  return { ...d, name: cert.dn, cert };
}

/** Checks a certificate against the identity key it claims. Returns null if anything is wrong. */
export function verifyCert(identityPublic: Uint8Array, cert: unknown): DeviceInfo | null {
  const c = cert as DeviceCert;
  if (!c || typeof c.dk !== 'string' || typeof c.dn !== 'string' || typeof c.ts !== 'number' || typeof c.g !== 'string') return null;
  if (c.dn.length > DEVICE_NAME_MAX) return null;
  let dk: Uint8Array;
  try {
    dk = fromB64url(c.dk);
  } catch {
    return null;
  }
  if (dk.length !== 32) return null;
  if (!verify(identityPublic, certBytes(toB64url(identityPublic), c.dk, c.dn, c.ts), fromB64url(c.g))) return null;
  return { key: c.dk, name: c.dn, created: c.ts };
}

const proofBytes = (senderFp: string, receiverFp: string) => utf8(JSON.stringify(['p2ptalk-device-hello-v1', senderFp, receiverFp]));

export const deviceProof = (deviceSecret: Uint8Array, myFingerprint: string, theirFingerprint: string) =>
  toB64url(sign(deviceSecret, proofBytes(myFingerprint, theirFingerprint)));

export function verifyDeviceProof(deviceKey: string, proof: unknown, senderFingerprint: string, receiverFingerprint: string): boolean {
  if (typeof proof !== 'string') return false;
  try {
    return verify(fromB64url(deviceKey), proofBytes(senderFingerprint, receiverFingerprint), fromB64url(proof));
  } catch {
    return false;
  }
}

/** A short code for a device key, to tell devices apart in Settings: "A1B2 C3D4". */
export function deviceCode(devicePublic: Uint8Array | string): string {
  const k = typeof devicePublic === 'string' ? fromB64url(devicePublic) : devicePublic;
  const hex = toHex(sha256(concat(utf8('p2ptalk-device-code-v1'), k)).subarray(0, 4)).toUpperCase();
  return `${hex.slice(0, 4)} ${hex.slice(4)}`;
}

/** A plain default name from the platform: "iPhone", "Mac", "Android phone", "Chrome on Mac"… */
export function defaultDeviceName(ua: string, touchPoints = 0): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  const os = /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  if (os === 'Mac' && (browser === 'Safari' || !browser)) return 'Mac';
  if (os && browser) return `${browser} on ${os}`;
  return os || browser || 'This device';
}
