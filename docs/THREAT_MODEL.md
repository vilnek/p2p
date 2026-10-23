# P2P Talk threat model (draft)

**Status:** draft, updated 23 Oct 2026 (device certificates, find by ID, links that ask first, files,
groups, embedded mode). Covers the Phase 0 code (one HTML file) and marks what is **planned**.
An independent review was done on 23 Oct 2026; report security issues as described in SECURITY.md.
Protocol details: [`PROTOCOL.md`](PROTOCOL.md).

P2P Talk has no server of its own. Messages and calls go device to device. Public Nostr relays and
public STUN servers help two devices find each other, but never carry chats or calls.

---

## 1. Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| **24-word recovery phrase** | On paper with the user. Shown once; not stored by the app. | It is the master key. Anyone with it can be the user. |
| **Identity secret key** | IndexedDB on each device, **sealed** with AES-256-GCM under a non-extractable WebCrypto key kept in the same database (review M-1; `core/vault.ts`). Stops copying the files; not a script running in the app's origin. Planned: wrap that key with the phone's Keystore / Keychain | Signs codes and makes locks. Same power as the phrase on that device. |
| **Identity public key, P2P ID, emoji code** | Shared freely | Public. Their **integrity** matters: nobody must be able to pass off another key as yours. |
| **Chat content** | In transit (locked) and in IndexedDB on both devices (Phase 0: not locked at rest) | Private. |
| **Files** | In transit (DTLS + a per-file AES-256-GCM key sent inside the locked chat; each 256 KB piece checked, whole file SHA-256) and wherever the person saves them | Private. Received files are kept as plain bytes, never opened inside the app's page. |
| **Call audio and video** | In transit only (DTLS-SRTP) | Private. |
| **Contact list** | IndexedDB on the device | Reveals who talks to whom. |
| **Metadata**: IP addresses, online times, who connects with whom, message sizes and timing | Seen by the network, STUN, relays and the other person | Can reveal relationships and habits. |
| **Invite and reply-box secrets** | IndexedDB until the invite ends | Allow answering on that invite. |
| **Device key** (one per device, random Ed25519) and its **device certificate** (signed by the identity key: device key, device name, created time) | IndexedDB on that device only; the certificate is shown to contacts | Tells contacts which of my devices they talk to ("on iPhone"). The device key proves itself on every connection by signing both DTLS fingerprints. |
| **The 24 words after "Join"** (instant join from a link) | IndexedDB (`kv` `unsavedWords`, sealed like the key) until the person taps "I've written them down" | Same power as the key. Shown afterwards from a banner; deleted once confirmed. |
| **ID card request box** ("Findable by my ID") | IndexedDB, while findable is on | Lets people who have my ID send me a request. |
| **Group sender keys** | IndexedDB `kv` `groups` | Read that group's messages for the current epoch. |
| **The app itself** (the code users run) | Web page, one file, later store apps | A changed app can steal everything above. |

---

## 2. Adversaries: what each can and cannot do

### 2.1 Network observer (Wi-Fi owner, mobile company, someone on the path)

| Can | Cannot | Mitigation |
|---|---|---|
| See that a device talks to certain IP addresses, when, and how much | Read chats or hear calls | WebRTC DTLS / DTLS-SRTP on every link, plus the app-level lock on chat (PROTOCOL §6) |
| See connections to STUN servers and Nostr relays | See inside relay messages | Relay messages are locked to a one-time box (PROTOCOL §11.3) and sent over `wss://` |
| Block or slow traffic | Change messages without being noticed | AES-GCM tags; any bad frame closes the connection |
| Try to sit in the middle of the WebRTC connection | Swap in its own DTLS certificate unnoticed | Each code carries an Ed25519 signature over the DTLS fingerprint (PROTOCOL §5.3); renegotiations must keep the signed fingerprint |
| Learn that a peer-to-peer link exists between two IP addresses | — | Hide my address (Tor) is **planned** (plan §10), not for calls |

### 2.2 Nostr relay operator

| Can | Cannot | Mitigation |
|---|---|---|
| See the device's IP address when it connects | Read connection offers, answers, requests or acceptances | All content is locked (X25519 → HKDF → AES-256-GCM) |
| See the tags (64 hex characters) and timing of events | Link a one-scan or invite tag to a P2P ID by itself | One-scan and invite tags come from a random 16-byte box ID |
| **Link two contacts at the moment one of them posts a reconnect offer** (the offer goes on the tag the other side listens on). Tags come from a secret only the two contacts share, change every hour and are **per direction** (PROTOCOL §13.1), so the two sides never subscribe to the same tag | Link two contacts from their subscriptions alone (fixed, review H-3); compute or link tags without the pair secret; read anything | Still open: timing and IP address when an offer is posted; all of a device's contacts' tags in one subscription per relay (spreading over relays and decoys are not built). The ID card goes on its own connection and Nostr key, but from the same IP address |
| See an ID card (kind 30078) when someone is findable by ID: their identity key, a request box key and relay names (no name since 23 Oct 2026) | Read requests sent to that box | The card is public by choice (copying or sharing my ID turns it on; Me › Privacy turns it off and asks relays to delete it, NIP-09) |
| Drop, delay or hide events (denial of service) | Make a working connection fail silently forever | Several relays are used at once; with no relay, two-step codes work with no internet at all |
| Replay old events | Connect with a replayed offer | The answer is bound to the offer's DTLS fingerprint; without the matching DTLS private key and one-time key the link can't complete |
| Inject its own events (Nostr signatures are not checked) | Get a forged message accepted | Inner content is checked with P2P Talk's own keys and signatures |
| Store "ephemeral" events against the rules | Read them later | They are locked; the box secret is gone after use (QR) or after the invite ends |
| Keep stored invite events (kind 30078) past their NIP-40 expiry | Read them | They are locked to the invite box |

The Nostr key that signs events is a throwaway key, made fresh in memory and not linked to the
identity key or P2P ID.

### 2.3 STUN server operator (`stun.l.google.com`, `stun.cloudflare.com`)

| Can | Cannot | Mitigation |
|---|---|---|
| See the device's public IP address and port for a moment, and when it asks | See anything else: no keys, IDs, contacts or content | STUN is only used to learn one's own address. No TURN is used, so no media passes through any server |

### 2.4 A malicious contact (or anyone you connect to)

| Can | Cannot | Mitigation |
|---|---|---|
| See your IP address (needed for a direct link) | Pretend to be another of your contacts | Each contact is tied to its key; the P2P ID and emoji code are calculated from it |
| Keep, copy, screenshot or forward what you send them | Make you accept a message from a different identity | The lock includes both identity keys |
| Send a lot of messages, or call repeatedly | Message you before you accept them (invites, later ID requests) | Accept / Block on invite requests; contact requests and "who can send me requests" are **planned** (plan §7.5) |
| Share your public key, ID or invite link | Use your invite twice, or after it expires | Invites and QR cards are single use and expire |
| Send very large texts | Crash the app with them | Received text is cut to 20,000 characters; relay frames over 200,000 characters are dropped |
| Learn when you are online (heartbeat) while connected | — | Online status settings are **planned** (plan §8.1) |
| Post a link anywhere (`#c=…`) hoping you tap it | Connect to you, or learn your address, by the tap alone | A link opened while signed in asks first: "Connect with Ravi?" with the 24-digit ID and safety pictures, read locally; nothing is sent before Connect (review H-1) |
| Send you files | Fill your device without asking | Until you have written to them or accepted their call ("new contact"), every file asks Accept / Decline; later, files of 100 MB and more still ask |
| Flood you with requests | Bury your list | At most 20 requests per invite or ID box per hour and 50 waiting; group invites from blocked people are declined |
| Use the same 24-digit ID with a different key (it would take about 2^76 tries) | Replace a contact quietly | Keys are compared in full; a changed key shows "Safety code changed" with both safety codes, and nothing changes until you accept |
| See which of your devices they talk to (device name) | Pretend to be another of your devices | The device certificate is signed by your identity key and the device proves its key on each connection |

### 2.5 A phone thief (or anyone with the unlocked device)

| Can | Cannot | Mitigation |
|---|---|---|
| **Phase 0:** read the chat history and copy the identity key from browser storage, if the browser profile is open | Get the 24 words from the app (they are not stored) | — |
| Use the app as you while they hold the device | — | "Remove my account from this device" deletes all local data |
| Copy of the device / database | Locked chats' messages | **Built 23 Oct 2026:** chat lock (plan §8.7, PROTOCOL §14.5): messages sealed to a key that only the secret code opens (Argon2id 64 MiB, t = 3 + a device secret). Files in the private file area / app folder are not re-encrypted yet |
| — | — | **Planned:** keys sealed by the secure chip or a non-extractable key; app lock; panic wipe; device keys you can remove from another device (plan §5.2) |

You keep your identity after a theft: type the 24 words on a new device to get the same key and ID.
Every device has its own device key and certificate, so contacts see which device connects, but
there is no way yet to **revoke** a lost device's certificate: the thief's copy holds the identity
key itself, so it can connect as you until you move to a new account (linked-device management and
revocation are **planned**).

### 2.6 Malware on the device

| Can | Cannot | Mitigation |
|---|---|---|
| Everything the user can: read the screen, keys, chats; record calls; steal the phrase as it is typed | — | **Out of scope.** No app can defend against a fully compromised device. The store apps will use the secure chip and screenshot blocking (plan §8.9), which raise the bar a little |

### 2.7 A forger of the app (fake copies, changed builds, a hijacked web page)

| Can | Cannot | Mitigation |
|---|---|---|
| Publish a look-alike app or web page that steals phrases and keys | Change a genuine copy already on someone's device | The one file runs from the user's own copy; the PWA updates only when the user taps Update (planned) |
| Use the name "P2P Talk" (it is not a registered trademark) | Sign as Vilnek | **Planned:** releases signed with Vilnek's release key, the key fingerprint published in the repository and on p2p.vilnek.in, reproducible builds (plan §9, §12, §19) |
| Add outside scripts or trackers to a changed copy | Do that to the genuine page | The page's content policy allows no outside scripts and connects only to the 5 built-in relays; `npm run check:urls` checks the built file |

---

## 3. Who sees what

From plan §10, with Phase 0 notes.

| Who | Can see | Never sees |
|---|---|---|
| **Vilnek** | Nothing. There is no server of ours in the core (the optional meeting point and wake ping are off by default, and not built) | Everything |
| Public Nostr relays | Your public card (if findable is on; **planned**); locked hello notes and short-code steps; the IP address of the device talking to them. *Phase 0 note:* also the timing of locked one-scan, invite and reconnect messages, and which tag a device posts on when it reconnects to a contact (§2.2) | Content, contacts, who a locked note is for |
| STUN server (public) | Your device's IP address for a moment | Anything else |
| The other person in a call or chat | Your IP address (needed for a direct link) | — (they are your contact) |
| Mobile company / Wi-Fi owner | That your device talks to some addresses, and how much | Any content |
| Apple / Google (store apps, **planned**) | That the app is installed; with the wake ping: "wake this phone" | Content, contacts |

---

## 4. Security properties (Phase 0)

| Property | Status |
|---|---|
| Content locked end to end (DTLS + app lock) | Yes |
| Middleman on the first connection detected | Yes, if the code or card came from the real person (QR in person, or a trusted channel). Compare the emoji code or ID when it matters |
| Replayed or changed frames rejected | Yes (counter + AES-GCM) |
| A new key for every message (forward secrecy within a session) | **No.** One key set per connection. Double Ratchet is **planned** |
| Forward secrecy between connections | Yes for chat frames: each connection uses fresh one-time keys, wiped after use, so a stolen identity key does not open past connections. Not for reconnect offers on relays (§5, item 4) |
| Keys sealed on the device | **No** (planned) |
| Chat history locked at rest | **No** (planned) |
| IP address hidden from contacts and relays | **No** (Hide my address is planned; not for calls) |
| Screenshot blocking | **No** in browsers (no browser allows it). Store apps: planned |

---

## 5. Known weaknesses and open issues

1. **Unsealed keys and history** (Phase 0). Anyone with access to the browser profile can copy the
   identity key and read chats.
2. **Static per-connection keys.** No per-message forward secrecy until the Double Ratchet lands.
3. **One key pair for signing and key agreement.** The X25519 key is the Ed25519 key converted
   (PROTOCOL §2.2). This is a common pattern and no practical attack is known, but separate derived
   keys would be cleaner.
4. **Stable reconnect tag.** `offerTag(pairId)` does not change, so a relay can count how often a
   pair reconnects, and anyone knowing both public keys can spot it. The reconnect offer is also
   locked to the recipient's long-term identity key: if that key is stolen later, recorded offers
   (which contain IP addresses in the SDP) can be opened.
5. **Reconnect offers carry no time.** A recorded offer can be resent to make the recipient start
   a connection that never completes (nuisance only).
6. **QR photo race.** Anyone who sees a QR card (for example in a photo) can use it first. They
   connect as **themselves**, not as someone else, and the card is spent. The user sees their ID
   and emoji code.
7. **Short emoji code.** 4 emoji = 32 bits. Good for a quick check, not proof.
8. **The 24 words are the master key.** Anyone who sees them can be you. Losing them and every
   device means a new account.
9. **Relay events are not stored reliably.** Relays may drop, hide or keep events. Messages that
   wait for someone offline last at most 24 h on the relays.
10. **Block does not delete.** Blocking someone on an invite does not remove their stored event
    from relays.
11. **Camera or microphone errors look like network errors** on the call screen, and a callee whose
    camera fails shows as "declined" (PROTOCOL §8.3). Not a security issue, but it can mislead.
12. **Content policy allows inline scripts** (`script-src 'unsafe-inline'`), needed for a one-file
    app. A hash-based policy would be stronger (being changed after the review).
13. **Multi-device, before linked devices.** The same 24 words on several devices: a contact's
    reconnect is answered by every one of my devices that is open; the first to connect wins and the
    contact posts a locked "taken" note (pair-secret lock) so the others stop quietly. Chats are not
    copied between my devices, and only the connected device rings. A device's name is visible to
    every contact it connects to.
14. **Device certificates can't be revoked** (see §2.5). A certificate only says "this device key
    belongs to this identity"; anyone with the identity key can make one.
15. **Instant join keeps the 24 words on the device** until the person confirms they wrote them
    down (sealed like the key, review M-1, so a copy of the files doesn't give them away; a script
    running in the app's origin could still ask the browser to open them).
16. **Findable by my ID** publishes a public card (key, request box, relays) for 24 h at a time,
    renewed while the app is open. Anyone with the ID can send a request; anyone can see that the
    card exists. Turning it off asks relays to delete it (NIP-09), which relays may ignore.
17. **The embedded mode** (Vilnek OS) holds the identity in memory only unless the host asks to
    keep it; the host app sees everything the page sees (it drives it).
18. **Test switches** (`?relays=`, `?breakIce=`, …) only work on a page served from
    `http://127.0.0.1` or `http://localhost`; the real page and the apps ignore them.

---

## 6. Out of scope (honest limits)

- Spyware or malware on a device (§2.6).
- A camera pointed at the screen, or photos of the screen.
- What the other person chooses to do with what you send.
- A user who gives away their 24 words.
- Hiding that two IP addresses talk to each other: a direct link needs both addresses. (Hide my
  address via Tor is planned for messages only.)
- Denial of service by the network or by every relay at once. Two-step codes still work on a local
  network with no internet.
- Weaknesses in browsers, operating systems or audited libraries (`@noble/curves`, `@noble/hashes`,
  `@scure/bip39`) themselves. Report those upstream; tell us too if they affect P2P Talk.
- Legal orders that block the website or stores. Copies, mirrors and the one file keep working
  (plan §15).
