# Integration note: files with no size limit, and groups

**Status:** engine modules built and unit-tested, 23 Oct 2026. They are **not wired** into the UI,
`peer.ts` or `hub.ts` yet. This note says how to wire them.
Design: the file bubble with
progress (screen 2 of the project designs).

| File | What it is |
|---|---|
| `src/core/channel.ts` | The `Channel` interface both modules use, plus `rtcBinaryChannel()` (a Channel over one binary `RTCDataChannel`) and `waitDrained()` |
| `src/core/sinks.ts` | Where files are read from and written to: `FileSource`, `FileSink`, File System Access, OPFS, memory, Save / Share |
| `src/net/files.ts` | `FileTransfers`: offer / accept / decline / cancel / pause / resume, 256 KB locked chunks, resume, progress (re-exports `sinks.ts`) |
| `src/net/groups.ts` | `GroupManager`: signed group records, sender keys, group messages, relay among members, join / leave / admin |
| `tests/unit/files.test.ts`, `tests/unit/groups.test.ts`, `tests/unit/memlink.ts` | 13 + 15 tests; `memlink.ts` is an in-memory Channel pair (delays, drops, corruption, disconnects) |

No new libraries. Everything uses WebCrypto (AES-256-GCM, SHA-256) and the libraries already in
`package.json` (`@noble/hashes` for the streaming whole-file SHA-256, `@noble/curves` for X25519 / Ed25519).

---

## 1. The Channel interface (what `peer.ts` must provide)

```ts
export interface Channel {
  send(frame: object | Uint8Array): Promise<void>;
  onFrame(cb: (frame: object | Uint8Array) => void): () => void;
  bufferedAmount?(): number;        // back-pressure
  drained?(below: number): Promise<void>; // optional: bufferedAmountLowThreshold + 'bufferedamountlow'
  close?(): void;                   // file data channels only
  readonly peerId: string;          // 24-digit P2P ID of the other side
}
```

Two kinds are needed:

### 1.1 The locked chat channel (JSON frames)

The existing `p2ptalk` data channel, through `SessionLock` exactly like `msg`. Suggested additions
to `Peer` (the other agent owns `peer.ts`; these are suggestions, nothing here edits it):

```ts
import { FILE_KINDS, FILE_FEATURE } from './files';
import { GROUP_KINDS, GROUP_FEATURE } from './groups';
import { rtcBinaryChannel, type Channel } from '../core/channel';

// 1. Hello: say we understand them.
export const FEATURES = [...existing, FILE_FEATURE /* 'files2' */, GROUP_FEATURE /* 'groups1' */];

// 2. Route the new kinds in receive(), in the default branch (after hello, in arrival order):
default:
  if (FILE_KINDS.has(w.k) || GROUP_KINDS.has(w.k)) { this.emit('frame', w); break; }
  if (CALL_KINDS.has(w.k)) this.onCallSignal(w);

// 3. A public sender for these frames (same outbox / lock as every other frame):
sendFrame(f: object): Promise<void> { return this.send(f as Wire); }

// 4. The Channel for the modules:
chatChannel(): Channel {
  return {
    peerId: this.peer!.id,
    send: (f) => this.sendFrame(f as object),
    onFrame: (cb) => { this.on('frame', cb); return () => this.off('frame', cb); }, // needs an off()
  };
}
```

`Peer` has `on()` but no `off()`; add one (or keep a small listener set just for `frame`).

### 1.2 One dedicated data channel per file transfer (binary frames)

```ts
// Sender: FileTransfers calls this when it starts or resumes sending a file.
openFileChannel(id: string): Promise<Channel> {
  const dc = this.pc.createDataChannel(`file:${id}`, { ordered: true }); // reliable (no maxRetransmits)
  return rtcBinaryChannel(dc, this.peer!.id);
}
```

**Important, or the chat breaks:** today `pc.addEventListener('datachannel', (e) => this.attach(e.channel))`
takes **every** incoming data channel as the chat channel. It must branch on the label:

```ts
this.pc.addEventListener('datachannel', (e) => {
  if (e.channel.label.startsWith('file:')) {           // FILE_CHANNEL_PREFIX
    void rtcBinaryChannel(e.channel, this.peer!.id).then((ch) => this.emit('fileChannel', ch));
    return;
  }
  this.attach(e.channel);
});
```

- A new data channel on an open connection does **not** need renegotiation (it is opened inside the
  existing SCTP association), so no QR, relay or `sdp` message is involved.
- Big transfers get their own SCTP stream, so chat, call signalling and heartbeats are not stuck
  behind 10 GB of file data.
- Back-pressure: `rtcBinaryChannel` exposes `bufferedAmount` and `drained()` (it sets
  `bufferedAmountLowThreshold` and waits for `bufferedamountlow`). The sender stops at **4 MB**
  queued and goes on at **1 MB** (Chrome refuses sends past 16 MB).
- Message size: chunks are cut into frames of at most **64 KB** (safe in every browser). The peer
  may pass `maxFrame: Math.min(pc.sctp?.maxMessageSize ?? 65536, 262144)` for fewer frames.
- If `openData` is not given, chunks go over the chat channel as binary frames. The current chat
  channel only carries locked JSON, so always give `openData`.

### 1.3 Why chunks are locked again (and not only by DTLS)

Every chunk is sealed with a **per-file AES-256-GCM key** (random, 32 bytes) that travels inside the
`file-offer`, which itself goes over the **locked** chat channel. So a file keeps the same two locks
as a chat message (DTLS + app lock), and:

- a file data channel opened by anyone who is not this contact, or a chunk moved to another file or
  position, does not open (the key is per file; the associated data binds the file id and chunk index);
- if WebRTC's DTLS were ever broken or misused (e.g. a future relay path), files stay locked;
- each chunk also carries its own SHA-256 inside the lock (plan §8.3: "each piece checked"), and the
  whole file is checked with a running SHA-256 at the end.

Cost: 60 bytes per 256 KB chunk and one AES-GCM pass (native WebCrypto, fast).

---

## 2. Files: wiring

### 2.1 One `FileTransfers` per contact, kept across reconnects

```ts
import { FileTransfers, FILE_FEATURE, canPickSaveFile, pickSaveSink, opfsSink, memorySink, blobSource, shareOrDownload, removeOpfsFile } from './net/files';

const files = new Map<string, FileTransfers>(); // by contact P2P ID
function filesFor(id: string) {
  let f = files.get(id);
  if (!f) {
    f = new FileTransfers(id, {
      autoAcceptBelow: 100 * 1024 * 1024,            // plan: the receiver accepts files over 100 MB
      autoSink: async (t) => (t.size <= 20 * 1024 * 1024 ? memorySink(t.size, t.mime) : opfsSink(t.id, t.name)),
    });
    f.on('offer', showAcceptCard);     // files of 100 MB and more: "Ravi wants to send seva-film.mp4 (12.4 GB) · Accept / Decline"
    f.on('update', drawFileBubble);    // progress bar: "7.7 of 12.4 GB · 3 min left"
    f.on('done', saveFileMessage);     // incoming: t.result = { file?, where, opfsName? }
    files.set(id, f);
  }
  return f;
}

peer.on('ready', (p) => {
  if (!peer.supports(FILE_FEATURE)) return;        // older builds: keep the old in-memory 'file' path
  const f = filesFor(p.id);
  f.attach(peer.chatChannel(), (id) => peer.openFileChannel(id)); // transfers in progress resume here
  peer.on('fileChannel', (ch) => f.addDataChannel(ch));
});
peer.on('closed', () => files.get(peer.peer!.id)?.detach());      // transfers show "waiting"
```

Attach inside the `ready` handler (before later frames are handled), so no file frame is missed.

### 2.2 Sending and receiving

| Action | Call |
|---|---|
| Send (from the + button) | `await filesFor(id).send(blobSource(file))`: returns the transfer id at once. The File is read piece by piece (`Blob.slice`), never whole. |
| Accept (button tap) | Chrome / Edge desktop, Android Chrome: `if (canPickSaveFile()) sink = await pickSaveSink(t.name)` **inside the tap** (it needs a user gesture). Else `sink = await opfsSink(t.id, t.name)`. Then `files.accept(t.id, sink)`. |
| Decline / Cancel | `decline(id)` / `cancel(id)` (either side) |
| Pause / Resume | `pause(id)` / `resume(id)` (either side; `t.pausedByMe`, `t.pausedByThem`) |
| Progress | `update` events: `bytes`, `size`, `speed` (bytes/s over ~5 s), `eta` (s), `state` |
| After OPFS | "Save / Share": `shareOrDownload(t.result.file, t.name)` (iPhone share sheet → Save to Files), then `removeOpfsFile(t.result.opfsName)` |

States: `offered` → `active` → `verifying` → `done` (out); `incoming` → `active` → `verifying` → `done` (in);
plus `paused`, `waiting` (not connected; resumes on the next `attach`), `declined`, `cancelled`, `failed` (`t.error` says why).
Screens should say "Waiting for Ravi to come online", never a technical word.

### 2.3 Wire format (to add to PROTOCOL.md)

Control frames (JSON, locked chat channel). New kinds; the old `file`, `chunk`, `file-end`,
`file-cancel` (feature `file`) are untouched and do not clash.

| `k` | Fields | From | Meaning |
|---|---|---|---|
| `file-offer` | `v:1, id, name, size, mime, sha256?, chunk:262144, key, ts` | sender | `id` = b64url(9 random bytes); `key` = b64url(32-byte AES-256-GCM key); `sha256` optional (hex) |
| `file-accept` | `id, from` | receiver | "Send from chunk `from`". Used for Accept, resume after a reconnect, and asking again after a bad or missing chunk |
| `file-decline` | `id` | receiver | No |
| `file-stop` | `id, why?` | either | Cancel (`why`: `unknown`, `busy`, `corrupt`, `error`) |
| `file-pause` / `file-resume` | `id` | either | Pause / go on (after `file-resume` the receiver answers with `file-accept`) |
| `file-ack` | `id, have` | receiver | Chunks `0..have-1` are written (every 8 chunks = 2 MB). The sender keeps at most 32 chunks (8 MB) beyond the last ack, so a slow disk never fills the receiver's memory |
| `file-hash` | `id, sha256` | sender | Whole-file SHA-256 (hex), after the last chunk |
| `file-done` | `id, ok` | receiver | The whole file matched (`ok:true`) or not |

Data frames (binary, `file:<id>` channel):

```
chunk i:  sealed = nonce(12) ‖ AES-256-GCM(fileKey, nonce, aad, SHA-256(data) ‖ data)
          aad    = utf8("p2ptalk-file-v1") ‖ id(9 bytes) ‖ u32be(i)
frame:    0x01 ‖ id(9) ‖ u32be(i) ‖ u16be(part) ‖ u16be(parts) ‖ piece of sealed
```

Labels: `p2ptalk-file-v1`. Limits: size ≤ 2^50, chunk 16 KB–1 MB (default 256 KB), 8 incoming
transfers at a time, 3 tries per bad chunk, stall check 15 s.

### 2.4 Limits and what is not done

- **Resume works across reconnects within one app session.** After the app is closed, the sender's
  `File` and the receiver's running SHA-256 are gone. Later: keep the `FileSystemFileHandle` (Chrome)
  in IndexedDB, and re-hash the partly received file from the sink on restart.
- **OPFS on older Safari:** `opfsSink` needs `createWritable()` on the main thread (Chrome 102+,
  Firefox 111+, Safari 26+). Older Safari only allows `createSyncAccessHandle()` in a worker; this
  one-file page's content policy has no `worker-src`, so that path needs `worker-src blob:` added to
  `p2p.html` and a small inline worker. `opfsSupported()` tells which is available; without it, use
  `memorySink` for files up to ~100 MB and say "Bigger files need the app" on that device.
- Chrome's File System Access writes into a temporary `.crswap` file until `close()`; a cancelled
  transfer leaves nothing behind (`abort()`).
- Feature check: send only to peers whose hello has `files2`; otherwise the old 200 MB path.

---

## 3. Groups: wiring

### 3.1 One `GroupManager` per account

```ts
import { GroupManager, GROUP_FEATURE, type GroupMember } from './net/groups';

const groups = new GroupManager(me, { storeNote: (id, frame) => hub.storeNote(id, frame) });
groups.importState(await loadGroups());                      // from IndexedDB (see 3.4)
groups.on('invite', (g, by) => showInvite(g, by));         // "Ravi added you to Seva team · Join / Leave"
groups.on('message', (m) => saveGroupMessage(m));          // {gid, mid, from, fromName, ts, body}
groups.on('group', (g) => saveAndRedraw(g));               // created, joined, renamed, members changed
groups.on('removed', (g) => markRemoved(g));
groups.on('conflict', (g, dropped) => toast('Another admin changed the group at the same time. Try again.'));

peer.on('ready', (p) => {
  if (!peer.supports(GROUP_FEATURE)) return;
  const detach = groups.attach(peer.chatChannel());        // every contact AND every group member
  peer.on('closed', detach);
});
```

| Action | Call |
|---|---|
| New group (from contacts) | `groups.create(name, members)` (`GroupMember = {p2pId, identityKey (b64url), name}`; from `Contact`: `{p2pId: c.id, identityKey: c.publicKey, name: c.name}`) |
| Add / remove / rename / admin | `addMembers(gid, [...])`, `removeMembers(gid, [ids])`, `rename(gid, name)`, `setAdmin(gid, id, true/false)`. Only admins; others get "Only admins can change the group." |
| Invite through a contact | Adding a contact is the invite: they get a `g-invite` on our locked channel and see Join / Leave (`acceptInvite(gid)` / `declineInvite(gid)`) |
| Leave | `leave(gid)` (admins remove the leaver automatically; an admin leaving makes the removal record itself, and if they were the last admin the member with the lowest ID becomes admin) |
| Send | `groups.send(gid, { text })` → `{ mid, ts, direct, waiting }` (`waiting` = members not reachable now; others carry it) |
| Lists | `groups.list()`, `groups.get(gid)` (`status`: `invited`, `joined`, `removed`, `left`; `iAmAdmin`) |

### 3.2 Reaching members who are not contacts

**Built 23 Oct 2026** (PROTOCOL.md §13.5): the member pair secret is bound to the group id
(`memberPairKeys`), the app sets `hub.groupMembers`, `hub.connectTo()` picks the member pair for a
non-contact, `GroupManager({ connect })` asks for links on demand, and `Peer.memberOf` marks such a
link (no chat, no contact). The original design notes follow.

A member is someone whose **identity key** is in the signed record, so the pair-secret reconnect of
`hub.ts` (§13 of PROTOCOL.md) works for them too, even if they never scanned each other:

- In `Hub.doRefresh()`, subscribe to the pair tags of every **group member** as well as contacts
  (build a contact-like object `{id: m.p2pId, publicKey: m.identityKey, name: m.name, relays: built-in}`).
  Group records carry no relays, so use the built-in relays.
- To send to a member right now, `hub.connectTo(memberAsContact)` as for a contact. Connect on demand
  (when there is something to send), not to all 49 members at once.
- Show such peers as "Member of Seva team" (not a contact) unless they are also a contact.

### 3.3 Locked notes on the relays for offline members (`storeNote`)

`GroupManager` calls `storeNote(p2pId, frame)` for `g-key`, `g-rec` and `g-invite` frames to members
it can't reach (messages are carried by members instead, see 3.5). Suggested `hub.ts` addition:

```ts
// Sender: lock to the member (fresh X25519 key → their identity, plus the pair secret: forward secrecy
// for the note), store for 24 h on 2+ relays.
async storeNote(toId: string, frame: object): Promise<void> {
  const m = memberOrContact(toId);                               // identity key from contacts or group records
  const pair = pairKeys(this.me.secretKey, this.me.publicKey, fromB64url(m.publicKey));
  const { blob } = await sealPairOffer(pair, fromB64url(m.publicKey), utf8(JSON.stringify(frame)));
  await this.pool.store(pairMailTag(pair.secret), toB64url(blob), Date.now() + 24 * 3600_000);
}
// Receiver (in doRefresh, for every contact / member): subscribe STORED_KIND on
// pairMailTagsAround(pair.secret) since now − 24 h; openPairOffer(); then
groups.onFrame(theirId, JSON.parse(plain));                      // same path as a live frame
```

`pairMailTag` is new: like `pairTag` but with a **daily** number (`p2ptalk-pair-v2 tag mail <day>`),
so a receiver only has to ask for today's and yesterday's tags. (`PairDir` in `core/pair.ts` gets a
`'mail'` value.) Relays see a random tag and a locked blob; they don't learn the group, its name or
its members. Frames are idempotent, so a note that arrives after the live copy does nothing.

### 3.4 Saving state

`groups.exportState()` returns records, history and **secret** sender keys. Save it (e.g. IndexedDB
`kv` key `groups`) after `group` / `removed` events and every few minutes; `importState()` on start.
It holds secret keys: it belongs with the identity key in the Phase 1 sealed store, never sent anywhere.
Group messages are stored by the app like 1:1 messages (`chats`, keyed by `gid`).

### 3.5 How it works (for PROTOCOL.md)

| Part | Rule |
|---|---|
| Record | `{v:1, id, name, createdBy, admins[], members[{p2pId, identityKey, name}], epoch, prev, ts, by, sig}`. `id` = b64url(16 random bytes). ≤ 50 members, ≥ 1 admin, `p2pId` must match its key. |
| Signed bytes | `JSON["p2ptalk-group-v1", id, name, createdBy, admins sorted, members sorted by p2pId as [p2pId, identityKey, name], epoch, prev, ts, by]`, Ed25519 by `by` |
| Record hash | `rh = b64url(SHA-256(signed bytes ‖ sig))`; `prev` = `rh` of the previous record (`''` at epoch 0) |
| Accepting a change | `epoch = current + 1`, `prev = rh(current)`, `by` is an admin of the **current** record and the signature checks with `by`'s key from the current record, `createdBy` unchanged. Anything else is refused. Records ahead of the next epoch wait (and the sender is asked for what is missing, `g-sync`). |
| First sight (invite) | `g-invite` from a contact over our locked channel: the record is signed by one of its own admins, and both the contact and I are members. |
| Two admins at once | Same epoch, same `prev`, both valid: everyone keeps the **lowest `rh`**; the admin whose record lost gets a `conflict` event. |
| Sender keys | On every new epoch each member makes a random 32-byte key and sends `g-key {gid, epoch, rh, owner, to, eph, ct, sig}` to each other member: `ct = iv ‖ AES-256-GCM(HKDF(X25519(eph, to's identity), eph ‖ toX, label), label, key)`, `label = JSON["p2ptalk-gkey-v1", gid, epoch, rh, owner, to]`, `sig` = Ed25519 by `owner` over `JSON[label, eph, ct]`. Sealed to `to`, so other members may carry it. |
| Message | `g-msg {gid, epoch, mid, from, ts, ct, sig, hop, want}`; `ct = iv ‖ AES-256-GCM(senderKey(from, epoch), aad = JSON["p2ptalk-gmsg-v1", gid, epoch, from, mid], JSON(body))`; `sig` = Ed25519 by `from` over `JSON["p2ptalk-gmsg-v1", gid, epoch, mid, from, ts, ct]` (members can't pretend to be each other). Body ≤ 60,000 characters of JSON. |
| Fan-out | The sender sends to every member it reaches; up to 4 of them get `want` = the members it couldn't reach. A receiver passes it on to `want` members it reaches (`hop + 1`, and the rest of `want` while `hop + 1 < 2`) and **keeps** it for the others. **At most 2 hops.** Dedupe by `mid`. |
| Keeping for later | The sender (and each carrier) keeps a frame for every member it was meant for until that member's `g-ack` (7 days, ≤ 500 per group, saved with the state). Offered on every connection and every `g-sync`: `g-inv {ids}` → `g-req {ids, ack:1}` → the frames → `g-ack`, so usually one copy arrives even if several members kept it (BUG-6, PROTOCOL.md §20.3). |
| Old epochs | A message from the epoch just ended still opens for 1 hour (late messages in flight); keys are dropped 3 epochs later. |
| Leave | `g-leave {gid, from, epoch, ts, sig}` (signed by the leaver); an admin who gets it removes them. |
| Sync | On every connection, for each shared group: `g-sync {gid, epoch, rh}`. The side that is ahead sends the missing records (batches of 8), and each side re-sends its current sender key. |
| Labels | `p2ptalk-group-v1`, `p2ptalk-gkey-v1`, `p2ptalk-gmsg-v1`, `p2ptalk-gleave-v1` |

Frames are JSON on the locked chat channel; the biggest is a `g-rec` batch or a long `g-msg`
(well under the 256 KB data channel limit).

### 3.6 Sender keys now, MLS later (the trade-off)

| | Sender keys (built now) | MLS / OpenMLS (planned) |
|---|---|---|
| Removal | New keys from everyone on every change: a removed member can't read anything after. | Same, with one commit. |
| Forward secrecy inside an epoch | **No**: one key per member per epoch. Someone who steals a device can read that epoch's messages that they recorded. | Yes (a new key per message, ratcheted). |
| Healing after a device is stolen (post-compromise security) | Only at the next change of the group. | Yes, with any member's update. |
| Cost of a change | n × (n − 1) small key frames (2,450 for 50 people): fine for occasional changes. | O(log n) (tree). |
| Needs | Nothing new: WebCrypto + noble (already in the app). | ~1 MB WebAssembly, a delivery order for commits (hard with no server: two admins committing at once must be resolved), key packages published per device. |
| Offline / no server | Works well: keys are sealed per member and can be carried by anyone. | Commits must be applied in one order by everyone, which normally needs a server or a careful leader rule. |

So Phase 2 uses sender keys (simple, auditable, works with members carrying messages for each other).
MLS stays **planned** once a serverless ordering for commits is settled; the record chain here (epoch +
`prev` + lowest-hash rule) is a first step in that direction. Also planned: rotate a member's sender
key every N messages or every day even without a change, for some forward secrecy.

### 3.7 Group calls: design only (the other agent builds the WebRTC part)

**A small full mesh**: one `RTCPeerConnection` per **pair** of members in the call; each member sends
its camera / microphone to every other one directly. Up to **8 for voice, 4–6 for video** (plan §8.4);
past that, upload is the limit (n − 1 copies of one's own video). No server, no media relay.

1. **Ring:** the caller sends `g-call {gid, cid, video, ts}` as a group message (locked with the
   sender keys, so only current members can join). Members show "Ravi is calling Seva team · Join".
2. **Join:** a member who taps Join sends `g-call-join {cid}` to everyone in the call (group message
   or 1:1). Each pair connects with the **existing 1:1 machinery**: reuse the pair's open `Peer`
   (renegotiate as a 1:1 call over its locked channel, §8 of PROTOCOL.md), or `hub.connectTo(member)`
   first. Who offers: the member with the **lower P2P ID** in each pair (no glare).
3. **Every pair is checked** like a 1:1 call: identity-signed DTLS fingerprints, emoji code on tap.
4. **Media per pair:** voice Opus ~32 kbit/s; video `RTCRtpSender.setParameters` with a lower
   `maxBitrate` as the call grows (e.g. 1.2 Mbit/s at 2 people, 500 kbit/s at 4, 300 kbit/s at 6) and
   `scaleResolutionDownBy` for small tiles. Audio-only fallback when a pair's upload is too low.
5. **Leave / end:** `g-call-leave {cid}`; the call ends when the last two hang up. A member removed
   from the group mid-call is dropped from the call (their pairs are closed).
6. **Screen:** a tile grid (2×2, 2×3); the speaking member (audio level from `getStats`) gets the
   larger tile. The path badge per tile (direct / same Wi-Fi).
7. Each pair is independent: one person on a bad network does not break the call for the others.

---

## 4. Tests

```
npm test    # all unit tests (Vitest)
```

`tests/unit/files.test.ts` (13): 1 MB transfer; auto-accept below the limit and asking above it; empty
file; decline; cancel by each side; pause / resume; 1 MB with 8 % of data frames lost; **50 MB with
1 % lost frames and 6 random disconnects → resumes in the middle → identical SHA-256** (and less than
1.6 × the file size sent in total); a corrupted chunk is detected and sent again; a chunk that keeps
arriving damaged fails the transfer; a wrong whole-file SHA-256 fails both sides; back-pressure (never
more than highWater + one chunk queued); bad offers and stray frames are ignored.

`tests/unit/groups.test.ts` (15): create / join / send / receive; add (new member reads new, not old);
remove (keys rotate, the removed member can't read new messages even with the frame in hand, and can't
send); leave; decline an invite; admin actions; forged changes (non-admin, changed record, removed
admin, fake sender); relay through a member; store-and-forward to a member who comes back (one copy);
stops after 2 hops; dedupe; newer-epoch records and message arriving in reverse order; late message
from the previous epoch; two admins changing at once converge; export / import state.

Not covered by unit tests (needs the wiring): real `RTCDataChannel`s, File System Access and OPFS in a
browser. Suggested end-to-end test once wired: two Playwright profiles send a 300 MB generated file
with a short stall time, drop the connection halfway (`pc.close()` on one side, reconnect through
the mock relay), and compare SHA-256.
