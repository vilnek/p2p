// What both the screens and the embedded mode do around a connection: this device's key and
// certificate, remembering a contact (and which of their devices we saw), and telling each other
// about the other devices of the same account.

import { toB64url } from '../core/bytes';
import { cleanDeviceName, defaultDeviceName, newDevice, renameDevice, verifyCert, type StoredDevice } from '../core/device';
import { emojiCode } from '../core/identity';
import { loadContact, loadDevice, loadMyDevices, saveContact, saveDevice, saveMyDevices, type Contact, type SeenDevice, type StoredMe } from '../core/store';
import type { Me, Peer } from './peer';

const KEEP_DEVICES = 8;
const SHARE_WITHIN_MS = 30 * 24 * 3600_000;

export const platformDeviceName = () =>
  defaultDeviceName(globalThis.navigator?.userAgent ?? '', globalThis.navigator?.maxTouchPoints ?? 0);

/** This device's key: the stored one if it belongs to this identity, else a new one. */
export async function ensureDevice(me: StoredMe, name?: string): Promise<StoredDevice> {
  const old = await loadDevice();
  const wanted = name ? cleanDeviceName(name) : '';
  if (old && verifyCert(me.publicKey, old.cert)) {
    if (!wanted || wanted === old.name) return old;
    const renamed = renameDevice(me.secretKey, me.publicKey, old, wanted); // same device key, new name
    await saveDevice(renamed);
    return renamed;
  }
  const d = newDevice(me.secretKey, me.publicKey, wanted || platformDeviceName());
  await saveDevice(d);
  return d;
}

export const meWithDevice = (me: StoredMe, d: StoredDevice | null): Me => ({
  secretKey: me.secretKey,
  publicKey: me.publicKey,
  name: me.name,
  device: d ? { secretKey: d.secretKey, publicKey: d.publicKey, cert: d.cert } : undefined,
});

/** The same 24-digit ID with a different key: never taken silently ("Safety code changed"). */
export class KeyChanged extends Error {
  constructor(readonly old: Contact) {
    super('Safety code changed');
  }
}

/**
 * On "ready": save the contact (name, key, which device of theirs), then share what we know.
 * Throws KeyChanged when a known contact's ID now comes with another key, unless `acceptNewKey`.
 */
export async function rememberContact(p: Peer, relays: string[], acceptNewKey = false): Promise<Contact> {
  const info = p.peer!;
  const old = await loadContact(info.id);
  if (old && old.publicKey !== toB64url(info.publicKey) && !acceptNewKey) throw new KeyChanged(old);
  let devices = old && old.publicKey === toB64url(info.publicKey) ? (old.devices ?? []) : [];
  if (info.device) {
    devices = [{ cert: info.device.cert, seen: Date.now() }, ...devices.filter((d) => d.cert.dk !== info.device!.key)].slice(0, KEEP_DEVICES);
  }
  const c: Contact = {
    ...old,
    id: info.id,
    publicKey: toB64url(info.publicKey),
    name: info.name || old?.name || '',
    lastSeen: Date.now(),
    emoji: emojiCode(info.publicKey),
    relays: old?.relays?.length ? old.relays : relays,
    devices,
  };
  await saveContact(c);
  // Their other devices I have seen recently: they learn about their own devices this way.
  if (p.supports('devs')) {
    const others = devices.filter((d) => d.cert.dk !== info.device?.key && Date.now() - d.seen < SHARE_WITHIN_MS);
    await p.sendDevices(others.map((d) => ({ c: d.cert, s: d.seen })));
  }
  return c;
}

/** A contact told me which of MY devices they saw. Keep only certificates signed by my identity key. */
export async function learnMyDevices(me: StoredMe, myDeviceKey: string, list: { c: unknown; s: unknown }[]): Promise<SeenDevice[]> {
  const mine = await loadMyDevices();
  const byKey = new Map(mine.map((d) => [d.cert.dk, d]));
  for (const item of list) {
    const info = verifyCert(me.publicKey, item?.c);
    if (!info || info.key === myDeviceKey) continue;
    const seen = Math.min(Number(item.s) || 0, Date.now());
    const had = byKey.get(info.key);
    if (!had || had.seen < seen || had.cert.dn !== info.name) byKey.set(info.key, { cert: item.c as SeenDevice['cert'], seen: Math.max(seen, had?.seen ?? 0) });
  }
  const next = [...byKey.values()].sort((a, b) => b.seen - a.seen).slice(0, 10);
  await saveMyDevices(next);
  return next;
}

/** The newest device name we know for a contact ("iPhone"), if any. */
export const deviceNameOf = (p: Peer) => p.peer?.device?.name ?? '';
