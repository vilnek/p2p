// One-scan connect.
//   A: shows a small card (QR / invite link) and listens on the relays for its reply box.
//   B: scans it, makes the WebRTC offer, locks it to A's box and posts it on the relays (resent every 3 s).
//   A: opens and checks it, answers, locks the answer to B's fresh key and posts it back.
// The box is single-use and dies at expiry. Relays only ever see locked data and random tags.

import { fromB64url, fromUtf8, toB64url, toHex, utf8 } from '../core/bytes';
import { decodeCode, verifyCode } from '../core/signal';
import { p2pId } from '../core/identity';
import {
  CardError,
  decodeCard,
  newCard,
  offerTag,
  openBox,
  openReply,
  replyTag,
  sameKey,
  sealReply,
  sealToBox,
  type Card,
} from '../core/card';
import { Peer, type Me } from './peer';
import { RelayPool } from './relay';

const RELAY_WAIT_MS = 6000;
/** No relay answered: one more try this much later (a busy moment, a relay limiting new connections). */
export const RELAY_RETRY_MS = 2000;

/** Connects a pool; if no relay opens, waits RELAY_RETRY_MS and tries once more with `retryWith`. */
async function connectWithRetry(relays: string[], retryWith: string[]): Promise<{ pool: RelayPool; connected: string[] }> {
  let pool = new RelayPool(relays);
  let connected = await pool.connect(RELAY_WAIT_MS);
  if (connected.length) return { pool, connected };
  pool.close();
  await new Promise((r) => setTimeout(r, RELAY_RETRY_MS));
  pool = new RelayPool([...new Set(retryWith)]);
  connected = await pool.connect(RELAY_WAIT_MS);
  return { pool, connected };
}
const RESEND_MS = 3000;
const GIVE_UP_MS = 120_000;

type ReplyMsg = { ok: true; code: string } | { ok: false; why: 'used' | 'expired' };

export class RelaysUnreachable extends Error {
  constructor() {
    super('Couldn’t reach the public relays.');
  }
}

const bindFor = (boxId: Uint8Array) => `box:${toHex(boxId)}`;

export interface HostedCard {
  link: string;
  text: string;
  card: Card;
  relays: string[];
  close(): void;
}

/**
 * A: open the relays and make a card. Returns null when no relay can be reached (use two-step codes).
 * `onPeer` is called with the connection made from the first valid offer (and again if the same
 * person tries again, for example after an automatic retry or a page reload).
 */
export async function hostCard(me: Me, relays: string[], onPeer: (p: Peer) => void, otherRelays: string[] = []): Promise<HostedCard | null> {
  // The retry also tries the other built-in relays (`otherRelays`), before falling back to two-step codes.
  const { pool, connected } = await connectWithRetry(relays, [...relays, ...otherRelays]);
  if (!connected.length) {
    pool.close();
    return null;
  }
  const { card, boxSecret, text, link } = newCard(me.secretKey, me.publicKey, connected);
  /** The identity that took this card. The same person may try again (automatic retry, page reload). */
  let acceptedKey: string | null = null;
  const answered: Uint8Array[] = [];
  const refused: Uint8Array[] = [];
  const stops: (() => void)[] = [];

  const answer = async (sealPub: Uint8Array, msg: ReplyMsg) => {
    const blob = await sealReply(boxSecret, card.boxId, sealPub, utf8(JSON.stringify(msg)));
    stops.push(pool.repeat(replyTag(card.boxId), toB64url(blob), RESEND_MS, msg.ok ? GIVE_UP_MS : 15_000));
  };
  const refuseOnce = async (sealPub: Uint8Array, why: 'used' | 'expired') => {
    if (refused.some((r) => sameKey(r, sealPub))) return;
    refused.push(sealPub);
    await answer(sealPub, { ok: false, why });
  };

  pool.subscribe(offerTag(card.boxId), async (content) => {
    let opened: { sealPub: Uint8Array; plain: Uint8Array };
    try {
      opened = await openBox(boxSecret, card.boxId, fromB64url(content));
    } catch {
      return; // not locked to this box: ignore
    }
    if (answered.some((r) => sameKey(r, opened.sealPub))) return; // the same attempt, resent
    const text = fromUtf8(opened.plain);
    let who: string;
    try {
      who = toB64url(verifyCode(await decodeCode(text), 'offer', bindFor(card.boxId)).identityKey);
    } catch {
      return; // bad signature or wrong box: refuse quietly
    }
    // Single use: anyone else is told this code was already used.
    if (acceptedKey && who !== acceptedKey) return refuseOnce(opened.sealPub, 'used');
    // Too late: say so, instead of leaving them waiting.
    if (!acceptedKey && Date.now() > card.expires + 60_000) return refuseOnce(opened.sealPub, 'expired');
    answered.push(opened.sealPub);
    let made: { peer: Peer; code: string };
    try {
      made = await Peer.reply(me, text, bindFor(card.boxId));
    } catch {
      return; // own code, or damaged
    }
    if (acceptedKey && acceptedKey !== who) return made.peer.close(); // another person won while we were checking
    acceptedKey = who;
    made.peer.diag.kind = 'One-scan code (they scanned mine)';
    made.peer.diag.relays = connected;
    onPeer(made.peer);
    await answer(opened.sealPub, { ok: true, code: made.code });
    made.peer.on('ready', () => {
      stops.forEach((s) => s());
    });
  });

  // Keep listening a little past expiry, to tell late scanners the code has expired.
  const expiry = setTimeout(() => pool.close(), Math.max(0, card.expires + 3 * 60_000 - Date.now()));
  return {
    link,
    text,
    card,
    relays: connected,
    close: () => {
      clearTimeout(expiry);
      stops.forEach((s) => s());
      pool.close();
    },
  };
}

export interface Joining {
  card: Card;
  peer: Peer;
  /** Resolves when the reply arrived and the connection is being made. */
  done: Promise<void>;
  cancel(): void;
}

/**
 * B: use A's card. Throws a plain-words error (bad / expired / own code) or RelaysUnreachable.
 * `allowed` is the set of relay addresses this device may contact (built-in list + its own extra ones).
 */
export async function joinCard(me: Me, cardText: string, allowed: string[]): Promise<Joining> {
  const card = decodeCard(cardText);
  if (p2pId(card.identityKey) === p2pId(me.publicKey)) throw new CardError('This is your own code. Scan the other device.');
  const relays = card.relays.filter((r) => allowed.includes(r));
  if (!relays.length) throw new RelaysUnreachable();
  // Their card names its relays: the retry tries the same ones again.
  const [{ pool, connected }, made] = await Promise.all([connectWithRetry(relays, relays), Peer.start(me, bindFor(card.boxId))]);
  if (!connected.length) {
    pool.close();
    made.peer.close();
    throw new RelaysUnreachable();
  }
  made.peer.diag.kind = 'One-scan code (I scanned theirs)';
  made.peer.diag.relays = connected;
  const sealed = await sealToBox(card, utf8(made.code));
  let stop = () => {};
  const done = new Promise<void>((resolve, reject) => {
    pool.subscribe(replyTag(card.boxId), async (content) => {
      let msg: ReplyMsg;
      try {
        msg = JSON.parse(fromUtf8(await openReply(sealed.sealSecret, card, fromB64url(content)))) as ReplyMsg;
      } catch {
        return; // not for us
      }
      stop();
      if (!msg.ok) {
        pool.close();
        made.peer.close();
        reject(new CardError(msg.why === 'used' ? 'This code was already used. Ask them to show a new one.' : 'This code has expired. Ask them to show a new one.'));
        return;
      }
      try {
        await made.peer.finish(msg.code, card.identityKey);
        resolve();
      } catch (e) {
        made.peer.close();
        reject(e);
      } finally {
        setTimeout(() => pool.close(), 2000);
      }
    });
    stop = pool.repeat(offerTag(card.boxId), toB64url(sealed.blob), RESEND_MS, GIVE_UP_MS, () => {
      pool.close();
      made.peer.close();
      reject(new CardError('No answer. Their code may have expired, or they closed the page.'));
    });
  });
  return {
    card,
    peer: made.peer,
    done,
    cancel: () => {
      stop();
      pool.close();
      made.peer.close();
    },
  };
}
