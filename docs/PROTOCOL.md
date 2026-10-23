# P2P Talk protocol v0 (draft)

**Status:** draft, 23 Oct 2026. Describes the code in `src/core/` and `src/net/`.
**Goal:** enough detail for someone else to build an app that talks to P2P Talk.

Each section has one of these labels:

| Label | Meaning |
|---|---|
| **Built** | In the code and covered by unit or end-to-end tests. |
| **In progress** | In the code, but still being changed (one-scan connect, invite links, reconnecting to contacts). Expect changes. |
| **Planned** | In the project plan, not in the code. Nothing here is final. |

Version 0 means: no compatibility promise yet. Every format below carries a version number or a
`-v1` label, so later versions can change them without confusion.

---

## Contents

1. [Conventions](#1-conventions)
2. [Identity: 24 words to keys](#2-identity-24-words-to-keys) (Built)
3. [The 24-digit P2P ID](#3-the-24-digit-p2p-id) (Built)
4. [The emoji code](#4-the-emoji-code) (Built)
5. [The two-step connect code](#5-the-two-step-connect-code) (Built)
6. [The app-level lock](#6-the-app-level-lock) (Built)
7. [Messages on the data channel](#7-messages-on-the-data-channel) (Built)
8. [Calls](#8-calls) (Built)
9. [Connection path](#9-connection-path) (Built)
10. [Nostr relay transport](#10-nostr-relay-transport) (In progress)
11. [One-scan connect card](#11-one-scan-connect-card) (In progress)
12. [Invite links](#12-invite-links) (In progress)
13. [Reconnecting to a contact](#13-reconnecting-to-a-contact) (In progress)
14. [Planned parts](#14-planned-parts) (Planned)
15. [All labels and constants](#15-all-labels-and-constants)
16. [Test vectors](#16-test-vectors)
17. [Find by P2P ID: the ID card](#17-find-by-p2p-id-the-id-card) (Built)
18. [Several devices, one account](#18-several-devices-one-account) (Built)
19. [Files with no size limit](#19-files-with-no-size-limit) (Built)
20. [Groups](#20-groups) (Built; parts planned)

---

## 1. Conventions

| Term | Meaning |
|---|---|
| `‖` | Byte concatenation. |
| `utf8(s)` | The UTF-8 bytes of string `s`, with no length prefix and no terminator. |
| `b64url(x)` | Base64url (RFC 4648 §5), **no padding**. Decoders also accept whitespace, and ignore it. |
| `hex(x)` | Lower-case hexadecimal. |
| `u64be(n)` | 8-byte big-endian unsigned integer. |
| `SHA-256` | FIPS 180-4. |
| `HKDF(ikm, salt, info, L)` | HKDF with HMAC-SHA-256 (RFC 5869). An absent salt means 32 zero bytes (the RFC default). |
| `AES-256-GCM` | 12-byte nonce, 16-byte tag appended to the ciphertext. |
| `Ed25519` | RFC 8032 (pure Ed25519, no context). |
| `X25519` | RFC 7748. An all-zero shared secret is rejected. |
| `JSON(x)` | `JSON.stringify(x)` as in JavaScript: no spaces, keys in the order shown, non-ASCII kept as UTF-8. Where JSON is **signed**, a compatible app must produce the exact same bytes. |

All public keys are 32 bytes. All times are milliseconds since 1970 (UTC) unless stated.

---

## 2. Identity: 24 words to keys

**Built.** Code: `src/core/identity.ts`.

### 2.1 Steps

1. **Recovery phrase.** 24 English words from the BIP-39 word list, made from 256 bits of strong
   randomness (`generateMnemonic(wordlist, 256)`).
2. **Tidy what was typed.** Lower case, trim, and turn any run of white space into one space. The
   phrase is valid only if it has exactly 24 words and the BIP-39 checksum is correct.
3. **Seed.** The standard BIP-39 seed: PBKDF2-HMAC-SHA-512, 2048 rounds, password = the phrase
   (NFKD), salt = `"mnemonic"` with an **empty passphrase**. Output: 64 bytes.
4. **Identity secret key.**
   `identitySecret = HKDF(ikm = seed, salt = none, info = utf8("p2ptalk-identity-v1"), L = 32)`
5. **Identity public key.** `identityPublic = Ed25519.publicKey(identitySecret)`. This 32-byte
   key is the user's real identity. Everything else (ID, emoji code) is calculated from it.

### 2.2 The X25519 form of the identity key

Key agreement uses the X25519 form of the same Ed25519 key pair, by the standard birational map
(as in libsodium `crypto_sign_ed25519_*_to_curve25519`):

| | How |
|---|---|
| X25519 secret | `SHA-512(identitySecret)[0..32]`, clamped as X25519 requires |
| X25519 public | Montgomery `u = (1 + y) / (1 − y) mod p`, from the Edwards `y` of `identityPublic` |

No separate X25519 key is derived from the seed. The same key pair is used for signatures and for
key agreement.

### 2.3 What is stored

Only `identitySecret`, `identityPublic`, the name and a creation time are stored, in the browser's
IndexedDB (database `p2ptalk`, store `kv`, key `me`). The words are shown once and not stored.

> **Phase 0 limit:** the key is stored as plain bytes. Sealing it (non-extractable WebCrypto key,
> or the phone's secure chip) is **planned** (plan §5.2 step 3).

### 2.4 Planned keys (not in the code)

| Key | Plan | Status |
|---|---|---|
| Card-signing key | Signs the public relay card (§14.1) | Planned |
| Backup key | Locks the optional backup file | Planned |
| Device key | One per device, signed by the identity key, so a lost device can be removed | Planned |

Their derivation labels are not fixed yet. They will use new HKDF `info` labels, so the identity
key and ID never change.

---

## 3. The 24-digit P2P ID

**Built.** Code: `p2pId()`, `formatId()`, `idIsValid()` in `src/core/identity.ts`; `src/core/damm.ts`.

### 3.1 Steps

1. `h = SHA-256(utf8("p2ptalk-id-v1") ‖ identityPublic)` (32 bytes).
2. Read the **first 10 bytes** of `h` as one **big-endian** unsigned integer `N` (80 bits).
3. `body = N mod 10^23`, written in decimal and left-padded with zeros to **23 digits**.
4. `check = Damm(body)`, one digit (§3.2).
5. `ID = body ‖ check` (24 digits).

### 3.2 The Damm check digit

Start with `interim = 0`. For each digit `d` of the input, from left to right:
`interim = TABLE[interim][d]`. The check digit is the final `interim`.
A string with its check digit is valid when running the same loop over **all** its digits ends at 0.

The table is the standard weakly totally anti-symmetric quasigroup of order 10 (H. Michael Damm, 2004).
Row = current interim, column = next digit:

| | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|---|
| **0** | 0 | 3 | 1 | 7 | 5 | 9 | 8 | 6 | 4 | 2 |
| **1** | 7 | 0 | 9 | 2 | 1 | 5 | 4 | 8 | 6 | 3 |
| **2** | 4 | 2 | 0 | 6 | 8 | 7 | 1 | 3 | 5 | 9 |
| **3** | 1 | 7 | 5 | 0 | 9 | 8 | 3 | 4 | 2 | 6 |
| **4** | 6 | 1 | 2 | 3 | 0 | 4 | 5 | 9 | 7 | 8 |
| **5** | 3 | 6 | 7 | 4 | 2 | 0 | 9 | 5 | 8 | 1 |
| **6** | 5 | 8 | 6 | 9 | 7 | 2 | 0 | 1 | 3 | 4 |
| **7** | 8 | 9 | 4 | 5 | 3 | 6 | 2 | 0 | 1 | 7 |
| **8** | 9 | 4 | 3 | 8 | 6 | 1 | 7 | 2 | 0 | 5 |
| **9** | 2 | 5 | 8 | 1 | 4 | 3 | 6 | 7 | 9 | 0 |

It catches every single wrong digit and every swap of two neighbouring digits.
Published example: `572` → check digit `4` (`5724` is valid).

### 3.3 Display and input

| | Rule |
|---|---|
| Display | 6 groups of 4 digits, separated by one space: `3950 6415 5608 8996 4435 5146` |
| Input | Spaces and `-` are removed. Valid when exactly 24 digits remain and the Damm check passes. |
| Comparison | The 24 digits as a string. |

### 3.4 Strength

- About 76.4 bits (`log2(10^23)`). Faking someone's ID means finding a key whose ID matches: about
  2^76 tries on average.
- `2^80` is about `12.09 × 10^23`, so the mod step gives values below `8.93 × 10^21` a slightly
  higher chance (13 in about 12.09, instead of 12). This costs well under 1 bit and does not matter
  in practice.
- The ID is one-way: it can't be turned back into the key. To talk to someone you need their full
  public key (from a QR, link, code or, later, a relay card).

---

## 4. The emoji code

**Built.** Code: `emojiCode()` in `src/core/identity.ts`; list in `src/core/emoji.ts`.

1. `e = SHA-256(utf8("p2ptalk-emoji-v1") ‖ identityPublic)`.
2. Take the first **4 bytes** of `e`. Each byte `b` (0–255) picks `EMOJI_256[b]`.
3. Join the 4 emoji with nothing in between.

The emoji code is 32 bits. It is a quick check to compare on a call or in person, not proof. The
24-digit ID and the full key in the QR are the strong checks.

### 4.1 The 256-emoji list (version 1)

The list in `src/core/emoji.ts` is fixed. It must **never** be reordered or changed, or everyone's
emoji code changes. Each entry is exactly one Unicode code point, with no variation selector.
SHA-256 of the 256 entries joined as UTF-8 with nothing between them:
`9fc8c70e723dc82509f3192a12dbb938b3099db5fceb129bcfa95577ec5204ba`.

Row = high hex digit of the byte, column = low hex digit.

| | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | A | B | C | D | E | F |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **0_** | 🐶 | 🐱 | 🐭 | 🐹 | 🐰 | 🦊 | 🐻 | 🐼 | 🐨 | 🐯 | 🦁 | 🐮 | 🐸 | 🐵 | 🐔 | 🐧 |
| **1_** | 🐦 | 🐤 | 🦆 | 🦅 | 🦉 | 🐺 | 🐴 | 🦄 | 🐝 | 🐛 | 🦋 | 🐌 | 🐞 | 🐜 | 🦗 | 🐢 |
| **2_** | 🦎 | 🦖 | 🦕 | 🐙 | 🦑 | 🦐 | 🦞 | 🦀 | 🐡 | 🐠 | 🐟 | 🐬 | 🐳 | 🐋 | 🦈 | 🐊 |
| **3_** | 🐅 | 🐆 | 🦓 | 🦍 | 🦧 | 🐘 | 🦛 | 🦏 | 🐪 | 🐫 | 🦒 | 🦘 | 🐃 | 🐂 | 🐄 | 🐎 |
| **4_** | 🐏 | 🐑 | 🦙 | 🐐 | 🦌 | 🐕 | 🐩 | 🐈 | 🐓 | 🦃 | 🦚 | 🦜 | 🦢 | 🦩 | 🐇 | 🦝 |
| **5_** | 🦨 | 🦡 | 🦦 | 🦥 | 🐁 | 🐀 | 🦔 | 🌵 | 🎄 | 🌲 | 🌳 | 🌴 | 🌱 | 🌿 | 🍀 | 🎍 |
| **6_** | 🎋 | 🍃 | 🍂 | 🍁 | 🍄 | 🌾 | 💐 | 🌷 | 🌹 | 🥀 | 🌺 | 🌸 | 🌼 | 🌻 | 🌞 | 🌕 |
| **7_** | 🌙 | 🌎 | 🪐 | 💫 | ⭐ | 🌟 | ⚡ | 🔥 | 💥 | 🌈 | 🌊 | 💧 | 🍏 | 🍎 | 🍐 | 🍊 |
| **8_** | 🍋 | 🍌 | 🍉 | 🍇 | 🍓 | 🍈 | 🍒 | 🥭 | 🍍 | 🥥 | 🥝 | 🍅 | 🥑 | 🥦 | 🥬 | 🥒 |
| **9_** | 🌽 | 🥕 | 🥔 | 🍠 | 🥐 | 🥯 | 🍞 | 🥖 | 🥨 | 🧀 | 🥚 | 🍳 | 🥞 | 🍟 | 🍕 | 🥪 |
| **A_** | 🌮 | 🌯 | 🥗 | 🍝 | 🍜 | 🍲 | 🍛 | 🍣 | 🍱 | 🥟 | 🍤 | 🍙 | 🍚 | 🍘 | 🍥 | 🥮 |
| **B_** | 🍢 | 🍡 | 🍧 | 🍨 | 🍦 | 🥧 | 🧁 | 🍰 | 🎂 | 🍮 | 🍭 | 🍬 | 🍫 | 🍿 | 🍩 | 🍪 |
| **C_** | 🌰 | 🥜 | 🍯 | 🥛 | 🍼 | ☕ | 🍵 | 🥤 | ⚽ | 🏀 | 🏈 | ⚾ | 🥎 | 🎾 | 🏐 | 🏉 |
| **D_** | 🥏 | 🎱 | 🏓 | 🏸 | 🏒 | 🥍 | 🏏 | 🥅 | ⛳ | 🏹 | 🎣 | 🥊 | 🥋 | 🎽 | 🛹 | 🛷 |
| **E_** | 🥌 | 🎿 | 🏆 | 🥇 | 🎪 | 🎨 | 🎬 | 🎤 | 🎧 | 🎼 | 🎹 | 🥁 | 🎷 | 🎺 | 🎸 | 🎻 |
| **F_** | 🎲 | 🎯 | 🎳 | 🎮 | 🧩 | 🚗 | 🚕 | 🚙 | 🚌 | 🚎 | 🚓 | 🚑 | 🚒 | 🚐 | 🚚 | 🚛 |

The same list as Unicode code points (hex), one row per high digit:

```
0_  1F436 1F431 1F42D 1F439 1F430 1F98A 1F43B 1F43C 1F428 1F42F 1F981 1F42E 1F438 1F435 1F414 1F427
1_  1F426 1F424 1F986 1F985 1F989 1F43A 1F434 1F984 1F41D 1F41B 1F98B 1F40C 1F41E 1F41C 1F997 1F422
2_  1F98E 1F996 1F995 1F419 1F991 1F990 1F99E 1F980 1F421 1F420 1F41F 1F42C 1F433 1F40B 1F988 1F40A
3_  1F405 1F406 1F993 1F98D 1F9A7 1F418 1F99B 1F98F 1F42A 1F42B 1F992 1F998 1F403 1F402 1F404 1F40E
4_  1F40F 1F411 1F999 1F410 1F98C 1F415 1F429 1F408 1F413 1F983 1F99A 1F99C 1F9A2 1F9A9 1F407 1F99D
5_  1F9A8 1F9A1 1F9A6 1F9A5 1F401 1F400 1F994 1F335 1F384 1F332 1F333 1F334 1F331 1F33F 1F340 1F38D
6_  1F38B 1F343 1F342 1F341 1F344 1F33E 1F490 1F337 1F339 1F940 1F33A 1F338 1F33C 1F33B 1F31E 1F315
7_  1F319 1F30E 1FA90 1F4AB 2B50  1F31F 26A1  1F525 1F4A5 1F308 1F30A 1F4A7 1F34F 1F34E 1F350 1F34A
8_  1F34B 1F34C 1F349 1F347 1F353 1F348 1F352 1F96D 1F34D 1F965 1F95D 1F345 1F951 1F966 1F96C 1F952
9_  1F33D 1F955 1F954 1F360 1F950 1F96F 1F35E 1F956 1F968 1F9C0 1F95A 1F373 1F95E 1F35F 1F355 1F96A
A_  1F32E 1F32F 1F957 1F35D 1F35C 1F372 1F35B 1F363 1F371 1F95F 1F364 1F359 1F35A 1F358 1F365 1F96E
B_  1F362 1F361 1F367 1F368 1F366 1F967 1F9C1 1F370 1F382 1F36E 1F36D 1F36C 1F36B 1F37F 1F369 1F36A
C_  1F330 1F95C 1F36F 1F95B 1F37C 2615  1F375 1F964 26BD  1F3C0 1F3C8 26BE  1F94E 1F3BE 1F3D0 1F3C9
D_  1F94F 1F3B1 1F3D3 1F3F8 1F3D2 1F94D 1F3CF 1F945 26F3  1F3F9 1F3A3 1F94A 1F94B 1F3BD 1F6F9 1F6F7
E_  1F94C 1F3BF 1F3C6 1F947 1F3AA 1F3A8 1F3AC 1F3A4 1F3A7 1F3BC 1F3B9 1F941 1F3B7 1F3BA 1F3B8 1F3BB
F_  1F3B2 1F3AF 1F3B3 1F3AE 1F9E9 1F697 1F695 1F699 1F68C 1F68E 1F693 1F691 1F692 1F690 1F69A 1F69B
```

---

## 5. The two-step connect code

**Built.** Code: `src/core/signal.ts`; used by `Peer.start()`, `Peer.reply()`, `Peer.finish()` in `src/net/peer.ts`.

Two devices connect with no server by swapping two codes (QR or text). Device A makes an **offer**
code; device B reads it and makes an **answer** code; A reads the answer. The same offer and answer
codes are also carried, locked, inside one-scan connect (§11), invites (§12) and reconnects (§13).

### 5.1 WebRTC set-up before a code is made

| Setting | Value |
|---|---|
| ICE servers | `stun:stun.l.google.com:19302`, `stun:stun.cloudflare.com:3478`. No TURN. |
| Bundle policy | `max-bundle` |
| Data channel | Made by the offerer: label `p2ptalk`, `ordered: true` (reliable). Binary frames. |
| ICE gathering | No trickle in the code. Wait until gathering is `complete`, or **6 s**, then use the local description as it is. |
| DTLS fingerprint | The SDP must hold exactly one distinct `a=fingerprint:` value, and it must be `sha-256`. |

The fingerprint string used everywhere below is the algorithm in lower case, one space, then the
hex in upper case with colons: `sha-256 AB:CD:…` (from `a=fingerprint:(\S+) ([0-9A-Fa-f:]+)`).

### 5.2 Payload: JSON fields

| Field | Type | Meaning |
|---|---|---|
| `v` | number | Always `1`. |
| `t` | `"o"` or `"a"` | Offer or answer. |
| `s` | string | The full SDP text. |
| `k` | string | `b64url(identityPublic)` of the sender (32 bytes). |
| `e` | string | `b64url` of a fresh X25519 public key for this connection (32 bytes). |
| `n` | string | Display name, at most 40 UTF-16 code units; may be `""`. |
| `g` | string | `b64url` of the Ed25519 signature (64 bytes), see §5.3. |

Fields are written in the order `v, t, s, k, e, n, g`.

### 5.3 The fingerprint signature

The sender signs, with its identity key:

```
signed = utf8(JSON(["p2ptalk-sig-v1", t, fingerprint, k, e, n, bind]))
g      = Ed25519.sign(identitySecret, signed)
```

- `fingerprint`: the sender's own DTLS fingerprint string from its SDP (§5.1).
- `k`, `e`, `n`: exactly the strings in the payload (base64url text, not raw bytes).
- `bind`:

| Code | `bind` |
|---|---|
| Two-step offer | `""` |
| Offer inside one-scan connect or an invite | `"box:" ‖ hex(boxId)` (§11) |
| Offer inside a contact reconnect | `"pair:" ‖ hex(pairId)` (§13) |
| Any answer | The **offer's** fingerprint string. An old answer can't be replayed into a new connection. |

This signature ties the DTLS certificate to the identity key. A middleman who swaps the SDP must
also swap the fingerprint, and then the signature fails.

### 5.4 Text encoding

```
code = "P2P1." ‖ b64url( zlib-deflate( utf8( JSON(payload) ) ) )
```

- The compression is **zlib format** (RFC 1950, as `CompressionStream("deflate")`), not raw deflate.
- Typical length: about 900 to 1,100 characters (QR around version 23, error correction L).
- Decoders also accept a link: if the text has a `#`, everything after the first `#` is used.

### 5.5 Checks on receipt (all must pass, or the connection is refused)

1. Starts with `P2P1.`, inflates, and parses as JSON.
2. `v == 1`, and `t` is the kind expected (offer first, then answer).
3. The SDP holds a single `sha-256` fingerprint.
4. `k` and `e` decode to 32 bytes each.
5. The signature verifies over §5.3 with the expected `bind`.
6. The identity is not the device's own.
7. On an answer, when the caller knows who it expects (one-scan, invite, reconnect), the answer's
   identity must have the same P2P ID as the expected key.

Then A sets the answer as its remote description, and both sides make the lock (§6).

---

## 6. The app-level lock

**Built.** Code: `src/core/lock.ts`. Runs on top of WebRTC's own DTLS lock.

### 6.1 Roles

The **offerer** is the side that made the WebRTC offer code; the **answerer** made the answer.
(In one-scan connect, the person who **scans** is the offerer, see §11.4.)

### 6.2 Key exchange and KDF

Inputs on each side: own identity key pair, own one-time X25519 key pair (the `e` in its code),
the peer's identity public key and one-time public key, and both DTLS fingerprint strings.

```
ikm  = X25519(myOneTimeSecret, peerOneTimePublic)
     ‖ X25519(myIdentityX25519Secret, peerIdentityX25519Public)        (§2.2)

salt = SHA-256( utf8("p2ptalk-lock-v1")
              ‖ offererIdentityPublic ‖ answererIdentityPublic
              ‖ offererOneTimePublic  ‖ answererOneTimePublic
              ‖ utf8(offerFingerprint) ‖ utf8(answerFingerprint) )

kO2A = HKDF(ikm, salt, utf8("p2ptalk-lock-v1 offerer->answerer"), 32)
kA2O = HKDF(ikm, salt, utf8("p2ptalk-lock-v1 answerer->offerer"), 32)
```

The offerer sends with `kO2A` and receives with `kA2O`; the answerer the other way round.
Either X25519 result being all zeros is an error. After the lock is made, the one-time secret is
wiped.

### 6.3 One frame

```
counter = previous counter + 1        (the first frame each way has counter 1)
nonce   = 00 00 00 00 ‖ u64be(counter)                           (12 bytes)
aad     = utf8("p2ptalk-msg-v1") ‖ senderIdentityPublic ‖ receiverIdentityPublic ‖ u64be(counter)
frame   = u64be(counter) ‖ AES-256-GCM(sendKey, nonce, aad, plaintext)
```

Each data channel message is one binary frame. The plaintext is `utf8(JSON(message))` (§7).

### 6.4 Replay and error rules

| Rule | Detail |
|---|---|
| Minimum size | A frame shorter than 24 bytes (8 + 16) is rejected. |
| Counter | Must be **greater than** the last accepted counter. Equal or lower: rejected as a replay. Gaps are allowed. |
| Order | Frames are opened one at a time, in arrival order. |
| Any failure | Any frame that fails to open, or is not valid JSON, **closes the connection** at once. |
| Nonce reuse | Can't happen: the counter only goes up, and each direction has its own key. |

### 6.5 What this gives, and what it does not (Phase 0)

- Only the two identities that made the connection can open the frames (the identity DH is in the
  secret, and both identity keys are in the salt and in every frame's associated data).
- The DTLS fingerprints are in the salt, so the lock is bound to this exact WebRTC link.
- One set of keys lasts the whole connection. There is **no new key per message**. If the one-time
  secret leaks during a connection, that connection's messages can be read. Replacing this with the
  Double Ratchet is **planned** (§14.3).

---

## 7. Messages on the data channel

**Built.** Code: `src/net/peer.ts` (`type Wire`).

Every message is a JSON object with a kind field `k`, sent as one locked frame (§6.3).

### 7.1 Message kinds

| `k` | Fields | Sent by | Meaning |
|---|---|---|---|
| `hello` | `id`: sender's 24-digit P2P ID; `v`, `f`, `dc`, `dp` (§7.2) | Both, as soon as the channel opens | Must be the **first** frame. Confirms both sides made the same keys. |
| `msg` | `mid`: string, `text`: string, `ts`: number | Either | A chat message. `ts` is the sender's clock. |
| `ping` | — | Either, every 5 s | Heartbeat. |
| `pong` | — | Reply to `ping` | Heartbeat reply. |
| `bye` | — | Either, when its page is hidden or closed (not during a call) | "Away": the other side shows **offline at once** (§7.4). Added 23 Oct 2026; older builds ignore it. |
| `back` | — | Either, when its page is in front again | Ends "away". A `msg` also ends it. |
| `sdp` | `d`: `{type, sdp}` (RTCSessionDescriptionInit) | Either | Renegotiation (calls). |
| `ice` | `c`: RTCIceCandidateInit, or `null` for end of candidates | Either | New ICE candidates after the first connection. |
| `call` | `cid`: string, `video`: boolean | Caller | Call offer (§8). |
| `ring` | `cid` | Callee | Ring-ack: the incoming call is on screen. |
| `accept` | `cid` | Callee | Call accepted. |
| `decline` | `cid` | Callee | Call declined. |
| `busy` | `cid` | Callee | Already in another call. |
| `hangup` | `cid` | Either | End or cancel the call. |
| `media-failed` | `cid` | Callee | Accepted, but its camera or microphone could not open (§8.3). |
| `rec` | `cid`, `on`: boolean | Either, in a call | "I am recording this call" on / off (§8.4). |
| `screen` | `cid`, `on`: boolean | Either, in a call | "I am sharing my screen" on / off (§8.4). |
| `devs` | `l`: `[{c: device certificate, s: seen}]`, at most 20 | Either, after `hello` | The receiver's **own** other devices the sender has seen (§18.4). |
| `file`, `chunk`, `file-end`, `file-cancel` | §7.6 | Either | In-memory file transfer (feature `file`). |
| `file-offer` … `file-done` | §19 | Either | Files with no size limit (feature `files2`). |
| `g-rec` … `g-req` | §20 | Either | Groups (feature `groups1`). |

Examples:

```json
{"k":"hello","id":"395064155608899644355146"}
{"k":"msg","mid":"q3Xv0B1kZ2mT","text":"Namaste","ts":1792656000000}
{"k":"ping"}
{"k":"call","cid":"Hk2aP0x9Qe1L","video":true}
{"k":"ring","cid":"Hk2aP0x9Qe1L"}
```

`mid` and `cid` are `b64url` of 9 random bytes (12 characters). Unknown kinds are ignored, never
fatal. A side sends feature frames only to a peer whose `hello` listed that feature.

### 7.2 Start of a connection

1. When the data channel opens, each side sends `hello` with its own ID.
2. Before it is "ready", a side accepts only one thing: a `hello` whose `id` equals the P2P ID of the
   identity key in the peer's verified code. Anything else closes the connection.
3. After that, the connection is ready: heartbeats and chat start.

**Hello fields** (all but `id` optional; a receiver treats a missing `v` as `0` and missing `f` as `[]`):

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Sender's 24-digit P2P ID |
| `v` | number | Data-channel protocol version. Now `1`. |
| `f` | string[] | Features the sender understands (at most 64 are read) |
| `dc` | object | The sender's **device certificate** (§18.1), when it has a device key |
| `dp` | string | **Device proof** for this connection (§18.2), sent with `dc` |

```json
{"k":"hello","id":"395064155608899644355146","v":1,
 "f":["chat","call","media-failed","rec","device","devs","taken","file","screen","files2","groups1"],
 "dc":{"dk":"<b64url>","dn":"iPhone","ts":1792656000000,"g":"<b64url>"},"dp":"<b64url>"}
```

| Feature | Meaning |
|---|---|
| `chat` | `msg` frames |
| `call` | Calls (§8) |
| `media-failed` | Understands `media-failed` (§8.3) |
| `rec` | Understands `rec` (§8.4) |
| `device` | Sends and checks `dc` / `dp` (§18) |
| `devs` | Understands `devs` (§18.4) |
| `taken` | Its other devices step back after a "taken" note (§13.3) |
| `file` | In-memory file transfer (§7.6) |
| `screen` | Understands `screen` (§8.4) |
| `files2` | Files with no size limit (§19) |
| `groups1` | Groups (§20) |

An invalid `dc` or `dp` is left out quietly (the contact is shown with no device name); it never
stops the connection.

**Watchdog (app behaviour).** A side that starts a connection waits up to **20 s** for the data
channel to open and both hellos to arrive (`CONNECT_WAIT_MS`). If it fails or times out, the app
makes **one** automatic retry with a fresh offer the same way, then reports the failure.

### 7.3 Limits

| Item | Limit |
|---|---|
| Chat text, receiving | Cut to 20,000 characters. |
| Chat text, sending (app input) | 4,000 characters. |
| Display name in a code | 40 characters (§5.2). |

### 7.4 Heartbeat and online status

| Constant | Value |
|---|---|
| `ping` interval | 5 s |
| Online window | A side shows the other as **online** while the channel is open, the connection is ready, and **any** valid frame arrived in the last **12 s**. Otherwise: offline, "last seen" = time of the last valid frame. |
| Status check | Every 1 s. |
| Away (`bye`) | After a `bye`, the other side is **offline** at once, even though pings may still arrive (a hidden desktop tab keeps its connection), until `back`, a `msg`, or a new connection. The 12 s window stays as the fallback when no `bye` gets out (a crash, a lost network, or the page closing before the frame is sent). |

### 7.5 Renegotiation (after the first connection)

- Uses the "perfect negotiation" pattern. The **answerer** of the first connection is the polite
  side; the offerer is impolite and ignores a colliding offer.
- On `negotiationneeded`, a side sets its local description and sends it as `sdp`.
- ICE candidates are sent as `ice` messages.
- **Fingerprint rule:** every `sdp` received must carry the **same** DTLS fingerprint the peer
  signed in its first code. If not, the connection is closed.

### 7.5.1 Network stalls: ICE restart (BUG-8, 23 Oct 2026)

**Built.** Code: `src/net/peer.ts` (`LinkWatch`, `restartIce`), `src/net/hub.ts` (relay path).
Once a connection is ready, an ICE failure is not the end of it:

| ICE state | What happens |
|---|---|
| `disconnected` | The connection is **reconnecting** (a call shows "Reconnecting…", state `reconnecting`, §8.1). If it is still not back after **5 s**: ICE restart. |
| `failed` | ICE restart at once. |
| ICE restart | `pc.restartIce()` → a new offer (new ICE username / password, same DTLS certificate) sent as `sdp` on the locked chat channel (perfect negotiation, as above), **and** through the relays (§13.4), because the chat channel rides the same broken path. Repeated every **5 s**. |
| `connected` / `completed` again | Up. The DTLS certificate in use (`getStats`: transport → remote certificate) must still have the fingerprint their identity key signed; if not, the connection is closed. A call goes back to `connected` (same start time). |
| Not back **20 s** after the first restart | The connection closes; a call ends (`ended`, as when the link drops). |

Frames sent while reconnecting stay queued on the data channel and go out when the path is back.
A connection that closes by itself (not by the app) is made again quietly (§13.4).

### 7.6 In-memory file transfer (feature `file`)

**Built.** Code: `src/net/peer.ts` (`sendFile`). The first file transfer, kept so older builds
still work; new builds send with `files2` (§19) when the peer supports it. The whole file is held in
memory, so it is limited to **200 MB**.

| `k` | Fields | Meaning |
|---|---|---|
| `file` | `fid`, `name` (≤ 200 chars), `size`, `type` (MIME, ≤ 100 chars) | A file starts. `fid` = `b64url` of 9 random bytes. |
| `chunk` | `fid`, `i` (0, 1, 2 …), `d` = `b64url` of at most 48 KB | One piece, in order. |
| `file-end` | `fid`, `h` = hex SHA-256 of the whole file | The last piece was sent. |
| `file-cancel` | `fid` | Stop (also the receiver's answer to a `file` over 200 MB). |

Each frame is locked like any other (§6.3). The receiver takes at most 5 files at once, fails a
transfer on a piece out of order or more bytes than `size`, and accepts it only if the size and
the SHA-256 match. The sender pauses while more than 2 MB is queued on the channel.

---

## 8. Calls

**Built.** Code: `src/net/peer.ts`. 1:1 voice or video, over the same WebRTC connection, set up
with messages on the locked data channel (no second QR).

### 8.1 States

| State | Side | Meaning |
|---|---|---|
| `idle` | Both | No call. |
| `reaching` | Caller | `call` sent, no `ring` yet. Screen: "Reaching Ravi…" |
| `ringing` | Caller | `ring` received. Screen: "Ringing…" |
| `incoming` | Callee | Accept / Decline shown. |
| `connecting` | Both | Accepted; media being set up. |
| `connected` | Both | ICE is `connected`/`completed` **and** at least one remote track is unmuted. |
| `reconnecting` | Both | The network stalled mid-call (`connected` or `connecting` before): ICE restart running (§7.5.1). Screen: "Reconnecting…". Goes back to `connected` (the call time runs on), or the call ends after 20 s of trying. |
| `ended` | Both | Normal end. |
| `missed` | Callee | The caller gave up, or the ring time ran out. |
| `failed` | Caller (mostly) | With a reason, see §8.3. |

### 8.2 Message flow

```
Caller                                   Callee
  | call {cid, video}  ───────────────►   |  (if already in a call: reply busy {cid})
  |                    ◄───────────────   |  ring {cid}           (sent at once)
  |                    ◄───────────────   |  accept {cid} | decline {cid}
  |   (callee adds its tracks → negotiationneeded → callee sends sdp offer)
  |                    ◄───────────────   |  sdp {offer}
  |  sdp {answer}      ───────────────►   |  (caller adds its tracks first)
  |   ice ... both ways ...                |
  | hangup {cid}       ◄──────────────►   |  either side, at any time
```

On hang-up, a side stops its transceivers; the resulting renegotiation is sent as `sdp`.
Messages with a `cid` that is not the current call are ignored.

### 8.3 Timeouts and failure reasons

| Constant | Value | What happens |
|---|---|---|
| Reach timeout | 8 s | Caller still `reaching` → `failed: offline`, and sends `hangup`. |
| Ring timeout | 45 s (`?ring=` test switch can shorten it) | Caller still `ringing` → `failed: no-answer`, and sends `hangup`. |
| Callee ring limit | ring timeout + 5 s (50 s) | Callee still `incoming` → `missed`. |
| Media timeout | 25 s | Still `connecting` → sends `hangup`, `failed: media`. |

| Failure | Cause | Screen text |
|---|---|---|
| `offline` | Not connected when the call starts, no `ring` in 8 s, or the link drops while reaching/ringing | "Ravi is offline" |
| `no-answer` | Rang for 45 s | "Ravi didn't answer" |
| `declined` | `decline` received | "Ravi declined" |
| `busy` | `busy` received | "Ravi is on another call" |
| `media` | No media within 25 s | "Can't connect directly right now" |
| `my-media` | My own camera or microphone could not be opened | (the app explains which) |
| `their-media` | `media-failed` received: their camera or microphone could not be opened after Accept | (the app explains) |

Notes on the current code:
- If the **callee's** camera or microphone can't be opened after Accept, the callee sends
  `media-failed` and ends with `my-media`; the caller ends with `their-media`.
- Several chats can be open at once, but one call at a time: a `call` while this **device** is in
  another call is answered with `busy`. Another device of the same account being in a call does
  not count.

### 8.4 Screen sharing and recording notes

**Built.**

- **Screen.** The sharer replaces the camera track on its existing video sender with the screen
  track (no renegotiation when a video sender exists) and sends `{"k":"screen","cid":…,"on":true}`;
  when it stops, it puts the camera back and sends `on:false`. Where the browser gives the device's
  sound with the screen, it is mixed with the microphone into the same audio track.
- **Recording.** `{"k":"rec","cid":…,"on":true|false}` tells the other side "I am recording this
  call", so it can show "● name is recording". Nothing is recorded by the protocol.
- Both are ignored outside a call or with another `cid`.

---

## 9. Connection path

**Built.** Code: `src/core/path.ts`. Read from `RTCPeerConnection.getStats()` every 3 s while online.

### 9.1 Finding the pair in use

1. Use the `transport` stat's `selectedCandidatePairId`, if present.
2. Otherwise, a `candidate-pair` stat with `selected == true`, or with `nominated == true` and
   `state == "succeeded"`.
3. None: `offline`.

### 9.2 Classifying it

Let `lt`, `rt` be the `candidateType` of the local and remote candidates.

| Order | Condition | Path |
|---|---|---|
| 1 | No local or remote candidate | `offline` |
| 2 | `lt` or `rt` is `relay` | `relay` |
| 3 | `lt == host` and `rt == host` | `local` |
| 4 | `lt == host`, `rt == prflx`, and the remote address is local | `local` |
| 5 | `lt == prflx`, `rt == host`, and the local address is local | `local` |
| 6 | Anything else | `internet` |

A "local" address is: ending in `.local` (mDNS); IPv4 `10.*`, `127.*`, `192.168.*`, `169.254.*`,
`172.16.*`–`172.31.*`; IPv6 `::1`, `fe80:*`, `fc*`, `fd*`.

### 9.3 Icons (as in the code)

| Kind | Icon | Label | Status |
|---|---|---|---|
| `local` | 🛜 | Same Wi-Fi / local network | Built |
| `internet` | 🌐 | Internet, direct | Built |
| `relay` | ⚠️ | Relay | Built (should not occur: no TURN is configured) |
| `bluetooth` | 🔵 | Bluetooth | Name reserved; native apps, planned |
| `wifi-direct` | 📶 | Wi-Fi Direct | Name reserved; native apps, planned |
| `offline` | ✕ | Offline | Built |
| Your postbox (📮), your own relay (🏠) | — | — | Planned (plan §8.8, §8.10); not in the code |

The path is local information only. It is never sent to the other side.

---

## 10. Nostr relay transport

**In progress.** Code: `src/net/relay.ts`. Used only to pass small locked messages for one-scan
connect (§11), invites (§12) and reconnects (§13). Chats and calls never go through relays.

### 10.1 Built-in relays

Index order matters (it is used by the card's relay bit mask, §11.2):

| Index | Relay |
|---|---|
| 0 | `wss://relay.damus.io` |
| 1 | `wss://nos.lol` |
| 2 | `wss://relay.primal.net` |
| 3 | `wss://offchain.pub` |
| 4 | `wss://nostr.mom` |

The page's content security policy allows WebSocket connections only to these five (plus
`ws://127.0.0.1:*` and `ws://localhost:*` for tests). A unit test checks the two lists match.

### 10.2 Events

Standard NIP-01 events, signed with BIP-340 Schnorr over secp256k1:
`id = hex(SHA-256(utf8(JSON([0, pubkey, created_at, kind, tags, content]))))`.

| Use | `kind` | Tags | Stored by relays? |
|---|---|---|---|
| Live messages | `25050` (ephemeral range 20000–29999) | `[["t", tag]]` | No. Relays pass them on only. |
| Messages that wait for someone offline | `30078` (NIP-78 app data) | `[["t", tag], ["d", hex(8 random bytes)], ["expiration", unixSeconds]]` | Yes, until the NIP-40 expiry. Expiry is at most **24 h** after sending. |

- `content` is `b64url` of a locked blob (§11.3, §13), except the public ID card (§17), whose
  `content` is the signed card as JSON. `tag` is a 64-character hex string.
- Each relay pool signs with a **throwaway** Nostr key, made fresh in memory and not linked to the
  user's identity key or P2P ID.

### 10.3 Client behaviour

| Item | Behaviour |
|---|---|
| Connecting | Open all relays at once. Continue 1.5 s after the first one opens, or after 6 s at most. |
| Subscribe | `["REQ", subId, {"kinds": [...], "#t": [tags], "since": s?}]`; `subId` = hex of 8 random bytes. End with `["CLOSE", subId]`. |
| Send | `["EVENT", event]` to every open relay; count `["OK", id, true]` replies. |
| Live resend | The same live event content is posted every **3 s** until stopped or a time limit (§11, §13). |
| Stored send | Retry every 3 s until at least `min(2, relays open)` relays accept, or give up after 60 s. |
| Receive | Drop frames over 200,000 characters, wrong kinds or tags, or a passed `expiration`. Drop a `content` already seen (the same message from several relays). |
| Nostr signatures | **Not checked.** The content is locked and authenticated by P2P Talk's own keys. |

### 10.4 Deleting stored events (NIP-09)

**Built.** Code: `src/net/relay.ts` (`deletionEvent`), `src/core/wipe.ts`.

The app remembers each stored event it put on the relays (kind 30078): the throwaway key that
signed it, its `id`, `d`, relays, expiry, and what it was (`card`, `request` or `reply`). To delete
one, it sends a NIP-09 deletion request **signed by that same throwaway key** (relays ignore a
deletion from any other key):

```
{"kind":5, "content":"",
 "tags":[["e", <event id>], ["a", "30078:<pubkey>:<d>"], ["k", "30078"]], …}
```

| When | What is deleted |
|---|---|
| "Findable by my ID" turned off | The ID cards (§17) |
| **Delete my account and data** (Me › Settings) | Every stored event still alive: ID cards, contact requests, replies. All are sent at once; the app waits at most about 3 s for OKs, then erases everything on the device (all its databases, received files, settings). Other devices with the same 24 words keep their copy. |

Events past their NIP-40 expiry are skipped (relays dropped them already). Deletion is a request:
a relay may keep a copy, but every stored event expires within 24 h anyway.

---

## 11. One-scan connect card

**In progress.** Code: `src/core/card.ts`, `src/net/oneScan.ts`. Plan §7.1b.

Device A shows a small **connect card** (QR or link). Device B scans it once. The two connection
codes (§5) then pass, locked, through public relays, and both devices connect directly.

### 11.1 Where the card appears

| Form | Text |
|---|---|
| QR | The card text (about 199 characters with the built-in relays; QR version 9). |
| Link | `https://p2p.vilnek.in/#c=` ‖ card text. The part after `#` is never sent to the web server. |
| Detection | `[#&?]c=([A-Za-z0-9_-]+)` in a link, or bare text of 150–600 base64url characters. |

### 11.2 Binary layout (then `b64url`)

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | High 4 bits: version = `1`. Low 4 bits: flags. Bit 0: custom relays follow. Bit 1: this is an invite (§12). Bit 2: a short name follows. |
| 1 | 1 | Relay mask: bit `i` set = built-in relay `i` (§10.1). |
| 2 | 32 | A's identity public key (Ed25519). |
| 34 | 32 | Reply-box public key (X25519, fresh for this card). |
| 66 | 16 | Box ID (16 random bytes). |
| 82 | 3 | Expiry: whole minutes since `2026-01-01T00:00:00Z`, 24-bit big-endian (rounded up). |
| 85 | … | If flag bit 0: count (1 byte, at most 8), then for each relay: length (1 byte, at most 255) and the UTF-8 address. |
| … | … | If flag bit 2: length (1 byte, at most 16) and a UTF-8 short name (cut on a character boundary). |
| end − 64 | 64 | Ed25519 signature by the identity key over `utf8("p2ptalk-card-v1") ‖ all bytes above`. |

With only built-in relays and no name, the card is 149 bytes (199 characters).

**Checks on receipt:** at least 149 bytes; version is 1; the signature verifies with the key in the
card; not expired (a 60 s grace is allowed after the expiry minute); not the device's own key.
B only uses relays from the card that are also on its own allowed list.

**Lifetime:** a QR card lasts **10 minutes**. The box secret stays in memory only.

### 11.3 The reply box (locking messages through relays)

**Tags** (what relays see):

```
offerTag(boxId) = hex(SHA-256(boxId))
replyTag(boxId) = hex(SHA-256(boxId ‖ utf8("reply")))
```

**B to A ("offer" direction).** B makes a fresh X25519 key pair (`sealSecret`, `sealPub`):

```
shared = X25519(sealSecret, boxPub)
key    = HKDF(shared, salt = boxId, info = utf8("p2ptalk-box-v1 offer") ‖ boxPub ‖ sealPub, 32)
aad    = utf8("p2ptalk-box-v1 offer") ‖ boxId ‖ boxPub ‖ sealPub
blob   = sealPub (32) ‖ nonce (12 random bytes) ‖ AES-256-GCM(key, nonce, aad, plaintext)
```

**A to B ("reply" direction).** A uses the same `shared` (from `boxSecret` and B's `sealPub`):

```
key  = HKDF(shared, salt = boxId, info = utf8("p2ptalk-box-v1 reply") ‖ boxPub ‖ sealPub, 32)
aad  = utf8("p2ptalk-box-v1 reply") ‖ boxId ‖ boxPub ‖ sealPub
blob = nonce (12 random bytes) ‖ AES-256-GCM(key, nonce, aad, plaintext)
```

Event `content` = `b64url(blob)`. An all-zero `shared` is rejected.

### 11.4 Flow

1. **A** opens the relays (up to 6 s). If none opens, A falls back to two-step codes (§5).
   A makes the card from the relays that opened, shows it, and subscribes to `offerTag(boxId)`
   (kind 25050).
2. **B** checks the card, makes a WebRTC **offer** code with `bind = "box:" ‖ hex(boxId)` (B is the
   offerer), locks it to A's box, and posts it (kind 25050) every 3 s for up to 120 s. B subscribes
   to `replyTag(boxId)`.
3. **A** opens the blob, checks the offer code with the same `bind`, and makes the answer.
   A locks a reply to B's `sealPub` and posts it on `replyTag(boxId)` every 3 s for up to 120 s,
   or until the connection is ready.
4. **B** opens the reply, checks that the answer comes from the identity in the card (same P2P ID),
   and finishes. Both connect directly.

**Reply plaintext** (`utf8(JSON(...))`):

```json
{"ok":true,"code":"P2P1.…answer…"}
{"ok":false,"why":"used"}
```

`why` may also be `"expired"` in the format, but the current code does not send it (A ignores
offers after expiry).

### 11.5 Single use

- A accepts only the **first** valid offer. Any later offer from a different `sealPub` gets
  `{"ok":false,"why":"used"}`, resent for 15 s.
- **Same person again:** a later offer whose identity key is the one A already accepted (an
  automatic retry after the 20 s watchdog, §7.2, or a page reload) is answered again as a new
  connection, not refused. The same rule applies to invite links (§12): a used invite still answers
  the identity that used it.
- B remembers the box IDs it has used (until 1 hour after their expiry) and refuses to use one again.
- A closes the relays at the card's expiry.

---

## 12. Invite links

**In progress.** Code: `src/core/card.ts`, `src/net/hub.ts`. Plan §7.2b.

An invite is a connect card (§11.2) with **flag bit 1** set, usually with a short name (flag bit 2),
for example "Connecting to Dr Vijay…". It works once, and also while the sender is offline.

| Item | Value |
|---|---|
| Lifetime | 1 hour, 24 hours (default) or 7 days |
| Box secret | Kept on the sender's device (IndexedDB store `invites`) until the invite ends |
| Statuses | `waiting`, `used`, `cancelled` (expired is worked out from the time) |
| Expired or used text | "This invite has expired or was already used. Ask for a new one." |

### 12.1 What the person opening the link (B) sends

B does **both** of these, locked to the invite box (§11.3), tagged `offerTag(boxId)`:

1. **Live offer** (kind 25050), as in §11.4 step 2, every 3 s for up to 120 s. If the sender is
   online, they connect within seconds.
2. **Contact request** (kind 30078, stored until the invite's expiry, at most 24 h).

B also makes a fresh X25519 **reply box** (`rbSecret`, `rbPub`) where the answer will wait.

**Contact request** plaintext:

```json
{"t":"req","k":"<b64url B identity key>","n":"<B name>","note":"<up to 140 chars>",
 "rb":"<b64url rbPub>","rr":["<relay>",...],"ts":1792656000000,"g":"<b64url signature>"}
```

```
g = Ed25519.sign(B identity, utf8(JSON(["p2ptalk-req-v1", inviteId, k, n, note, rb, rr, ts])))
inviteId = hex(boxId)
```

The sender tells the two apart by the plaintext: text starting with `P2P1.` is a live offer;
anything else is parsed as a contact request.

### 12.2 What the sender (A) replies

Replies to a contact request wait on the relays (kind 30078) for B:

```
tag   = hex(SHA-256(utf8("p2ptalk-replybox-v1") ‖ rbPub))
blob  = locked to (boxKey = rbPub, boxId = boxId), "offer" direction (§11.3)
```

| Reply plaintext | When |
|---|---|
| `{"t":"accept","k":"<A key>","n":"<A name>","rr":[...],"g":"<sig>"}` | A tapped **Accept** |
| `{"t":"used"}` | The invite was already used, cancelled or expired |

```
acceptance g = Ed25519.sign(A identity, utf8(JSON(["p2ptalk-accept-v1", inviteId, k, n, rr, rb])))
```

B checks that `k` equals the identity key in the invite and that the signature verifies (with
B's own `rb`). Then both add each other as contacts; they connect with §13.

If A is online when B opens the link, A answers the **live** offer instead (as §11.4 step 3), marks
the invite used, and both connect at once.

**Block:** A ignores that identity key for that invite (and, after Report or Block contact, on
every invite). A can't delete B's stored request from the relays (only B's throwaway key can, §10.4).

**Requests by ID** (§17) use exactly this request format, locked to the ID card's request box
(`rb`, `bid`). They are never answered live: they always wait for Accept or Block.

B keeps listening for a reply until 24 h after the invite's expiry.

---

## 13. Reconnecting to a contact

**In progress.** Code: `src/core/pair.ts`, `src/net/hub.ts`. Once two people are contacts, either
can press **Connect**. The hello goes through the relays, locked with a secret only the two of them
can compute.

### 13.1 The pair secret and hourly tags

```
shared     = X25519(my identity (X25519 form, §2.2), their identity (X25519 form))   (all-zero rejected)
lowKey, highKey = the two Ed25519 identity keys, ordered by their lower-case hex
pairSecret = HKDF(shared, salt = lowKey ‖ highKey, info = utf8("p2ptalk-pair-v2"), 32)
pairId     = HKDF(pairSecret, no salt, info = utf8("p2ptalk-pair-v2 id"), 16)
hour       = floor(ms / 3,600,000)
inbox(K)   = HKDF(pairSecret, no salt, info = utf8("p2ptalk-pair-v3 inbox ") ‖ K, 32)   K = the RECEIVER's Ed25519 identity key
tag(key, dir, hour) = hex(HKDF(key, no salt, info = utf8("p2ptalk-pair-v2 tag " ‖ dir ‖ " " ‖ hour), 32))
                     dir = "offer" | "reply" | "taken"
pairTag(to K, dir, hour) = tag(inbox(K), dir, hour)
```

Tags are **per direction** (security review H-3): everything sent to me (offers, replies to my
offers, "taken" notes) is on tags made from `inbox(my key)`, and I post on tags made from
`inbox(their key)`. I only ever subscribe to my own inbox tags, so two contacts never subscribe to the
same filter, and a relay that logs `REQ` filters can't pair them up; it can link them only at the
moment one of them posts. Tags change every hour, so outsiders can't compute them or link two hours.
A side listens on `hour − 1`, `hour` and `hour + 1` (for clocks that differ a little). All use kind
25050 (live, never stored).

**Transition (until 1 Nov 2026, `LEGACY_PAIR_TAGS_UNTIL`):** offers and "taken" notes are also posted on
the old shared tags `tag(pairSecret, dir, hour)`, and while my own offer is out I also read replies
there, so contacts on an older version still connect. The old shared **offer** tags are never
subscribed to. After that date only the per-direction tags are used. The ID card (§16) is published on
its own relay connection with its own throwaway Nostr key, never on the pool that carries these
subscriptions.

### 13.2 Offer and answer

| Step | Detail |
|---|---|
| Offer | WebRTC **offer** code with `bind = "pair:" ‖ hex(pairId)`. Fresh X25519 key `e`; `key = HKDF(X25519(e, theirX) ‖ pairSecret, salt = pairId, info = utf8("p2ptalk-pair-v2 offer") ‖ ePub ‖ theirX, 32)`; `blob = ePub ‖ nonce(12) ‖ AES-256-GCM(key, nonce, aad = utf8("offer") ‖ pairId ‖ ePub, code)`. Posted on `pairTag(to them, "offer")` every 3 s for up to **8 s**. |
| Answer | `{"ok":true,"code":"P2P1.…answer…"}`. Fresh X25519 key `f`; `key = HKDF(X25519(f, ePub) ‖ pairSecret, salt = pairId, info = utf8("p2ptalk-pair-v2 reply") ‖ fPub ‖ ePub, 32)`; `blob = fPub ‖ nonce(12) ‖ AES-256-GCM(key, nonce, aad = utf8("reply") ‖ pairId ‖ ePub, plaintext)`. Posted on `pairTag(to the offerer, "reply")` every 3 s for up to **30 s**. |
| Checks | The offer's identity must be that contact; the answer's identity must be that contact. A blocked key is ignored. |
| Both press Connect at once | The side whose P2P ID is lower (as a string) keeps its own attempt and ignores the other's offer. |
| Busy | A device in a call with this contact ignores their offer (any number of chats may be open at once). |
| No answer in 8 s | "Ravi is offline · try again later" |

The fresh keys are thrown away after use, so a later leak of an identity key doesn't open old
offers and answers (which carry network addresses).

### 13.3 Several devices answer: the "taken" note

With several devices on one account (§18), each of them may answer the same offer. The offering
side takes the **first** answer that connects and ignores the rest. Once connected, it posts a
locked note so the other devices stop quietly:

```
noteKey = HKDF(pairSecret, salt = pairId, info = utf8("p2ptalk-pair-v2 note"), 32)
blob    = nonce(12) ‖ AES-256-GCM(noteKey, nonce, aad = utf8("note") ‖ pairId, plaintext)
plaintext = {"t":"taken","a":"<b64url ePub of the offer>","d":"<b64url device key of the device that won, or empty>"}
```

It is posted on `pairTag(to the answering contact, "taken")` every 3 s for **12 s**. A device that answered offer `a` and is
not device `d` closes its attempt with no error. An answer that never connects ends after **35 s**.
Any device holding either identity key can open the note; it carries no network address.

The app re-reads invites, pending requests and contacts, and renews its relay subscriptions, every
30 s while open.

---

### 13.4 ICE restart and quiet reconnect through the relays (BUG-8, 23 Oct 2026)

**Built.** Code: `src/net/hub.ts` (`sendRescue`, `onRescue`, `reconnectLost`).

**ICE restart offer.** While a connection is reconnecting (§7.5.1), its restart offer (with its
candidates; gathering waits up to 6 s) is also posted on `pairTag(to them, "offer")`, sealed exactly
like a reconnect offer (§13.2, fresh X25519 key + pair secret), every 3 s for up to 18 s. Plaintext:

```json
{"t":"ice","to":"<their link fingerprint>","from":"<my link fingerprint>","d":{"type":"offer","sdp":"…"}}
```

The receiver opens it like a reconnect offer (a JSON plaintext instead of a `P2P1.` code; older
builds ignore it), finds its **open** connection with exactly these two fingerprints (both were
signed in the first codes) to that contact, checks the offer's fingerprint is the one their identity
signed (§7.5), and answers with perfect-negotiation rules (the impolite side keeps its own restart
offer). The answer goes back like a reconnect answer (§13.2) on `pairTag(to the offerer, "reply")`:
`{"t":"ice","d":{"type":"answer","sdp":"…"}}`, every 3 s for up to 18 s or until the link is up.
It is taken even during a call with that contact (the "busy" rule of §13.2 is for new connections).
The same offer arriving on both paths is applied once.

**Quiet reconnect.** A ready connection to a contact that closes **by itself** (the data channel
closed, or reconnecting gave up), not by the app, is made again with the normal reconnect (§13.2)
after 1.5 s, 5 s and 15 s, unless a connection to them is open by then. Nothing is shown; the file
and group engines resume on the new connection.

### 13.5 Group members who are not contacts (23 Oct 2026)

**Built.** Code: `src/core/pair.ts` (`memberPairKeys`), `src/net/hub.ts` (`memberLinks`, `connectTo`).
Two members of a group connect exactly like contacts (§13.1–13.4), with a pair secret bound to the group:

```
memberShared = HKDF(X25519(my identity, their identity), salt = lowKey ‖ highKey, info = utf8("p2ptalk-member-v1 " ‖ gid), 32)
memberId     = HKDF(memberShared, no salt, info = utf8("p2ptalk-member-v1 id"), 16)
inbox(K), tags, offer / reply / note locks: as §13.1–13.3, from memberShared and memberId
bind (in the offer code) = "member:" ‖ hex(memberId)        (a contact offer is bound to "pair:…")
```

| Rule | Detail |
|---|---|
| Who | Only while **both** are in the group's **current** signed record (§20.1), with the identity key it lists; checked when subscribing, when posting and again when an offer arrives. A removed member's offers are ignored. |
| Tags | Per direction only (H-3); no old shared tags. Each side listens on its own inbox tags for every other member of every group it is in (at most 300 at once), on the built-in relays (group records carry none). |
| Which path | A contact: the contact pair (§13.2); if that fails and we share a group, the member pair (one of us may have deleted the other). Not a contact: the member pair of the first shared group (by id). |
| When | On demand only: a group frame waits for them (at most 8 members per message, once a minute each), or a group call. |
| What it is | A "group member" link: groups, group calls and files (which ask first: the "new contact" rule). It shows no chat in Chats and adds no contact unless they add each other. ICE restarts (§13.4) use the member pair. |

## 14. Planned parts

**Planned.** None of this is in the code. Formats are not fixed. Plan sections are given.

### 14.1 Relay cards: find someone by P2P ID (plan §6)

> **Built in a simpler form: see §17.** Still planned: a separate card-signing key, a photo, and
> contacts keeping a copy of the card.

- A small signed note: P2P ID, identity public key, how to say hello, and (only if chosen) a name
  and photo. Signed by the **card-signing key and** the identity key.
- Published on several public Nostr relays (6 by default in the plan) when "Findable by my ID" is on;
  contacts keep a copy too.
- Lookup: ask relays for cards with that ID, and keep **only** a card whose key produces exactly
  those 24 digits (§3) and whose signatures verify. A relay can hide a card, but can't fake one.
- After lookup, the app sends a contact request (plan §7.5). Nobody can message or call until it is
  accepted.

### 14.2 One-time short codes (plan §7.4)

- A code like `48-tiger-moon`, valid for 10 minutes and one use.
- A password key exchange (**SPAKE2**, as in magic-wormhole) over public relays. One wrong guess ends
  it. Afterwards both sides hold each other's full keys and compare the emoji code.

### 14.3 Double Ratchet for 1:1 messages (plan §8.1, §9)

- Replaces §6 with **vodozemac** (Matrix's audited Double Ratchet, WebAssembly): a new key for every
  message, and forward secrecy within a session.
- Phase 1 in the code comments; the plan's phase table does not name a phase for it.

### 14.4 MLS for groups (plan §8.6)

- Group messages locked with **MLS** (OpenMLS, WebAssembly) or the vodozemac group method.
- Groups are built now with **sender keys** (§20); MLS stays planned until there is a serverless
  order for commits.

### 14.5 Chat lock with a secret code (plan §8.7) — built 23 Oct 2026 (on this device only)

Nothing goes on the wire: the lock is personal and local (`src/core/chatlock.ts`, `src/core/locks.ts`).

- A lock for any chat or group (`<P2P ID>` or `g:<group id>`); one secret code per device: at least
  4 digits, or a passphrase of 6+ characters (NFC-normalised UTF-8).
- `wrap = HKDF-SHA256(ikm = Argon2id(code, salt16; m = 64 MiB, t = 3, p = 1, 32 bytes) ‖ device secret
  (32 random bytes, vault-sealed), salt = salt16, info = "p2ptalk-chatlock-v1 wrap")` → AES-256-GCM.
- A P-256 key pair is made when the code is set. Its private key (PKCS #8) is stored sealed with
  `wrap` (aad `p2ptalk-chatlock-v1 key`); the public key is stored plain. A wrong code fails to open it.
- Each stored message of a locked chat is sealed **to the public key** (so messages that arrive while
  locked are sealed at once): fresh P-256 key `E`; `k = HKDF-SHA256(ECDH(E, lock), salt = E_pub ‖ lock_pub,
  info = "p2ptalk-chatlock-v1 msg")`; AES-256-GCM with a random 96-bit nonce and aad
  `"p2ptalk-chatlock-v1 " + chat id`. Inside: text, sender name, file details, preview, and the key of
  file bytes kept in the database (sealed separately with AES-256-GCM). Stored plain: chat id, `from`,
  time, message id (for order and unread counts).
- Changing the code makes a new key pair and re-seals every locked message in one transaction.
- Wrong codes: waits of 1, 2, 5, 10, 30, 60 s, then 5 minutes (kept across reloads). No wipe.
- Forgot code: the only way out deletes the locked chats' messages on this device.
- Not yet: files kept in the browser's private file area or the app's folder are not re-encrypted (their
  names and previews are); Face ID / fingerprint unlock (no native plugin yet); the device secret in the
  Keystore / Keychain.

### 14.6 Other planned parts

| Part | Plan |
|---|---|
| Files with no size limit: **built**, see §19 (resume after the app is closed is planned) | §8.3 |
| Screen sharing: **built** for 1:1 calls, see §8.4 | §8.5 |
| Device keys signed by the identity key: **built**, see §18. Linking a new device by QR: planned (today: type the 24 words) | §5.2, §5.5 |
| Group calls (small full mesh) | §8.4 |
| Locked backup file (key from the phrase) | §5.5 |
| Your own relay (TURN on your own device, passes signed by your key) | §8.10 |
| Signed releases with Vilnek's release key | §9, §12 |

---

## 15. All labels and constants

### 15.1 Domain-separation labels

| Label | Where |
|---|---|
| `p2ptalk-identity-v1` | HKDF info for the identity key (§2) |
| `p2ptalk-id-v1` | P2P ID hash prefix (§3) |
| `p2ptalk-emoji-v1` | Emoji code hash prefix (§4) |
| `p2ptalk-sig-v1` | First item of the signed JSON in a connect code (§5.3) |
| `P2P1.` | Text prefix of a connect code (§5.4) |
| `box:` / `pair:` | `bind` prefixes (§5.3) |
| `p2ptalk-lock-v1` | Salt prefix of the app-level lock (§6.2) |
| `p2ptalk-chatlock-v1 wrap` / `… key` / `… msg` / `p2ptalk-chatlock-v1 <chat id>` | Chat lock: wrap-key HKDF info, private-key aad, message HKDF info, message aad (§14.5) |
| `p2ptalk-lock-v1 offerer->answerer` / `p2ptalk-lock-v1 answerer->offerer` | HKDF info per direction (§6.2) |
| `p2ptalk-msg-v1` | Frame associated-data prefix (§6.3) |
| `p2ptalk` | Data channel label (§5.1) |
| `p2ptalk-card-v1` | Card signature prefix (§11.2) |
| `p2ptalk-box-v1 offer` / `p2ptalk-box-v1 reply` | Reply-box HKDF info and associated data (§11.3) |
| `reply` | Suffix for the reply tag (§11.3) |
| `p2ptalk-req-v1` | Contact request signature (§12.1) |
| `p2ptalk-accept-v1` | Acceptance signature (§12.2) |
| `p2ptalk-replybox-v1` | Reply-box tag prefix (§12.2) |
| `p2ptalk-pair-v2`, `p2ptalk-pair-v2 id`, `p2ptalk-pair-v3 inbox ` ‖ key, `p2ptalk-pair-v2 tag <dir> <hour>` | Pair secret, pair ID, per-direction inbox keys and hourly tags (§13.1) |
| `p2ptalk-pair-v2 offer` / `p2ptalk-pair-v2 reply` / `p2ptalk-pair-v2 note`; aad `offer` / `reply` / `note` | Reconnect locks and the "taken" note (§13.2, §13.3) |
| `p2ptalk-idcard-v1` | ID card tag prefix and signature (§17) |
| `p2ptalk-device-v1` | Device certificate signature (§18.1) |
| `p2ptalk-device-hello-v1` | Device proof (§18.2) |
| `p2ptalk-device-code-v1` | Device short code (§18.3) |
| `file:` | Data channel label prefix for one file (§19) |
| `p2ptalk-file-v1` | File chunk associated data (§19) |
| `p2ptalk-group-v1` | Group record signature (§20) |
| `p2ptalk-gkey-v1` | Sender-key label (§20) |
| `p2ptalk-gmsg-v1` | Group message associated data and signature (§20) |
| `p2ptalk-gleave-v1` | Leave signature (§20) |

### 15.2 Times

| Constant | Value |
|---|---|
| ICE gathering limit | 6 s |
| Heartbeat | 5 s; online window 12 s |
| Call: reach / ring / media | 8 s / 45 s / 25 s; callee gives up after 50 s |
| Relay connect | up to 6 s (1.5 s after the first opens) |
| Live resend | every 3 s; offers up to 120 s; refusals 15 s; contact reconnect 8 s (answers 30 s) |
| QR card | 10 minutes (+60 s grace) |
| Invite | 1 h, 24 h (default) or 7 days; stored relay events at most 24 h |
| App refresh of relay subscriptions | 30 s |
| Connection watchdog | 20 s, then one automatic retry (§7.2) |
| Reconnect: offer / answer / "taken" note / answer gives up | 8 s / 30 s / 12 s / 35 s (§13) |
| ID card | republished every 12 h while open; stored 24 h; finders ignore cards older than 48 h; lookup waits up to 8 s (§17) |
| Delete my account: wait for relay OKs | about 3 s (§10.4) |
| Files: stall check | 15 s (§19) |
| Groups: kept frames / old-epoch grace | 7 days (≤ 500 per group, 5000 in all) / 5 min (§20) |
| ICE restart (§7.5) | after 5 s "disconnected" or at once on "failed"; again every 5 s; gives up 20 s after the first restart |
| Quiet reconnect after a lost connection (§13.4) | after 1.5 s, 5 s, 15 s |

---

## 16. Test vectors

Calculated from the code on 22 Oct 2026. The first P2P ID is also recorded in
`tests/unit/identity.test.ts`. All values are hex unless stated.

### 16.1 Identity, ID and emoji code

**Vector 1.** Phrase: `abandon` × 23 then `art` (the standard BIP-39 test phrase).

| Value | |
|---|---|
| BIP-39 seed | `408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf705489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840` |
| Identity secret | `14180ab636232d762b9bcbc5f90553288dba6ee891c5304084e87768f0362d83` |
| Identity public (Ed25519) | `70944aff45df0ea0e35366694e017d17ab7bff3d863c07bc40d053ab812e37bd` |
| Identity public (X25519 form) | `2ede721659ea7d8f50a114bc95c0eabf57655c5b8c51d3f1f8695f8dde2e825b` |
| SHA-256(`p2ptalk-id-v1` ‖ key) | `723eb38e5d221368183a4c435c2e91fb14e7f42a5f49f8632770c4ed061955f6` |
| First 10 bytes | `723eb38e5d221368183a` |
| N (decimal) | `539506415560889964435514` |
| 23-digit body | `39506415560889964435514` |
| Damm check digit | `6` |
| **P2P ID** | `395064155608899644355146` (shown as `3950 6415 5608 8996 4435 5146`) |
| Emoji bytes | `1e 26 96 9c` (indexes 30, 38, 150, 156) |
| **Emoji code** | 🦗🦞🍞🥞 |

**Vector 2.** Phrase: `zoo` × 23 then `vote`.

| Value | |
|---|---|
| BIP-39 seed | `e28a37058c7f5112ec9e16a3437cf363a2572d70b6ceb3b6965447623d620f14d06bb321a26b33ec15fcd84a3b5ddfd5520e230c924c87aaa0d559749e044fef` |
| Identity secret | `c2bbcef10948d60d36211c56a13439b9a5e71ab8f23b05d7eabcf34d7c2b6edd` |
| Identity public (Ed25519) | `aaf977b2f37bb646aa1789c46bd13b82bba87d52692577e6cdd6054f443a5181` |
| Identity public (X25519 form) | `a161260180b3f8e40f08c7423c7d76114491c91e64ebae0db9c33c520c0b1873` |
| SHA-256(`p2ptalk-id-v1` ‖ key) | `29e1ca59eb70d4e2e1aeef701fe718e046ba963a6bd7aecbac2ded91f04a6a33` |
| N (decimal) | `197782124158378532069806` |
| **P2P ID** | `977821241583785320698063` |
| **Emoji code** | 🍌🍅🐬🐋 (bytes `81 8b 2b 2d`) |

**Damm:** `572` → `4`.

### 16.2 App-level lock

Offerer = vector 1 identity, answerer = vector 2 identity.
One-time X25519 secrets: offerer = 32 bytes of `01`, answerer = 32 bytes of `02`.
Offer fingerprint = `sha-256 ` followed by `AA` 32 times joined by `:`; answer fingerprint the same with `BB`.

| Value | |
|---|---|
| Offerer one-time public | `a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209` |
| Answerer one-time public | `ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59` |
| X25519(one-time keys) | `2ed76ab549b1e73c031eb49c9448f0798aea81b698279a0c3dc3e49fbfc4b953` |
| X25519(identity keys) | `c93db81293ef48e83c3dea017c53175d7447f30fdc8582000c4ba5ff30dec900` |
| salt | `e48e5467964182379c6d0ee9942aba084200a39920a73d866cdfa5a6248bf62f` |
| kO2A | `8b97bb733ccd31d7059644ac775adf5bd21b01add2da17de2988aaa78df8931d` |
| kA2O | `92ff653e3c242b336555d02c0217fcfa70b3a6a80497169719b37026d46ab1ed` |
| First frame, offerer → answerer, plaintext `{"k":"hello","id":"395064155608899644355146"}` | `0000000000000001d50d83d4183ab4c2e20c4cfd89b89f5341341c5953d71e4f8a67dbee853d5f967485859192022f2f587843c65cd2deccc5c4c35308e7af5eb8f4c2a190` |

---

## 17. Find by P2P ID: the ID card

**Built.** Code: `src/core/idcard.ts`, `src/net/hub.ts`. A simpler form of plan §6 (§14.1).

"Findable by my ID" is turned on when the person copies or shares their ID, and off in
Me › Privacy. While on, the app keeps a **request box** (like an invite that never expires and is
never shown under My invites) and publishes a small public **ID card** for it.

```
tag  = hex(SHA-256(utf8("p2ptalk-idcard-v1") ‖ utf8(the 24 digits)))
card = {"v":1,"k":"<b64url identity key>","n":"<name, ≤ 40 chars>","rb":"<b64url X25519 request box key>",
        "bid":"<hex, 16 bytes>","rr":["<relay>",… ≤ 8],"ts":1792656000000,"g":"<b64url signature>"}
g    = Ed25519.sign(identity, utf8(JSON(["p2ptalk-idcard-v1", k, n, rb, bid, rr, ts])))
```

| Item | Rule |
|---|---|
| Publishing | Kind 30078, tag as above, `content` = `JSON(card)` (not locked: it is public by design), stored 24 h, republished every 12 h while the app is open. |
| Lookup | Ask the relays for that tag for up to 8 s (0.8 s more after the first good card); keep the newest card that passes the checks. |
| Checks | `v` is 1; `k` and `rb` are 32 bytes; `bid` is 32 hex characters; **the key in `k` gives exactly those 24 digits** (§3); `ts` not more than 10 minutes ahead and not older than 48 h; the signature verifies. A relay can hide a card, but can't fake one. |
| Request | A contact request exactly as for an invite (§12.1), locked to the card's request box (`boxKey = rb`, `boxId = bid`). It always waits for **Accept** or **Block**; live offers to this box are ignored. |
| Turning it off | The request box is cancelled and the card is deleted from the relays (§10.4). |

---

## 18. Several devices, one account

**Built.** Code: `src/core/device.ts`, `src/net/session.ts`, `src/net/peer.ts`.

The same 24 words give the same identity key, P2P ID and emoji code on every device. Each device
also makes its own random Ed25519 **device key**, which never leaves it.

### 18.1 Device certificate

```
cert = {"dk":"<b64url device public key>","dn":"<device name, ≤ 32 chars>","ts":<created, ms>,"g":"<b64url>"}
g    = Ed25519.sign(identity, utf8(JSON(["p2ptalk-device-v1", b64url(identity public key), dk, dn, ts])))
```

Renaming a device keeps its key and signs a new certificate.

### 18.2 Device proof (in `hello`)

On every connection the device proves it holds the device key, bound to that connection:

```
dp = b64url(Ed25519.sign(device key, utf8(JSON(["p2ptalk-device-hello-v1", senderFingerprint, receiverFingerprint]))))
```

The fingerprints are the two DTLS fingerprints from the verified codes (§5.3). The receiver checks
`dc` against the sender's identity key and `dp` against `dk` with its own and the sender's
fingerprints; if both pass, it shows "Dr Vijay · on iPhone". If not, the device part is ignored.

### 18.3 Device code

A short code to tell devices apart in Settings:
`upper(hex(SHA-256(utf8("p2ptalk-device-code-v1") ‖ device public key)[0..4]))`, shown as two groups
of four, for example `A1B2 C3D4`.

### 18.4 Learning about my other devices (`devs`)

A contact remembers up to 8 devices it has seen for me. When connected to me (and my `hello`
listed `devs`), it sends `{"k":"devs","l":[{"c":<cert>,"s":<last seen, ms>},…]}` with my **other**
devices it saw in the last 30 days (not the one on this connection), at most 20. I keep only
certificates signed by my own identity key (at most 10), so a contact can't add a device to my
list.

### 18.5 Reconnects with several devices

All my devices listen for my contacts' offers and may all answer; the "taken" note (§13.3) makes
the losing devices step back quietly. Planned: linking a new device by QR, and moving chat history
between devices.

---

## 19. Files with no size limit

**Built** (feature `files2`). Code: `src/net/files.ts`, `src/core/channel.ts`, `src/core/sinks.ts`.
Sent only to a peer whose `hello` lists `files2`; otherwise the in-memory transfer (§7.6) is used.

### 19.1 Control frames (JSON, on the locked chat channel)

| `k` | Fields | From | Meaning |
|---|---|---|---|
| `file-offer` | `v:1, id, name, size, mime, sha256?, chunk, key, ts` | sender | `id` = `b64url(9 random bytes)`; `chunk` = 262144 by default; `key` = `b64url` of a 32-byte AES-256-GCM key for this file only; `sha256` optional (hex) |
| `file-accept` | `id, from` | receiver | "Send from chunk `from`". Used for Accept, for resume after a reconnect, and to ask again after a bad or missing chunk |
| `file-decline` | `id` | receiver | No |
| `file-stop` | `id, why?` | either | Cancel. `why`: `unknown`, `busy`, `corrupt`, `error` |
| `file-pause` / `file-resume` | `id` | either | Pause / go on (after `file-resume` the receiver answers with `file-accept`) |
| `file-ack` | `id, have` | receiver | Chunks `0 … have−1` are written (sent every 8 chunks and at the end) |
| `file-hash` | `id, sha256` | sender | Whole-file SHA-256 (hex), after the last chunk |
| `file-done` | `id, ok` | receiver | The whole file matched (`ok:true`) or not |

The key travels inside `file-offer`, which is itself locked (§6), so a file keeps the same two
locks as a chat message (DTLS and the app lock).

### 19.2 Data frames (binary, one data channel per file)

The sender opens a new **ordered, reliable** data channel labelled `file:<id>` on the existing
connection (no renegotiation). Chunk `i` of the file:

```
sealed = nonce(12) ‖ AES-256-GCM(fileKey, nonce, aad, SHA-256(data) ‖ data)
aad    = utf8("p2ptalk-file-v1") ‖ id (9 bytes) ‖ u32be(i)
frame  = 0x01 ‖ id (9 bytes) ‖ u32be(i) ‖ u16be(part) ‖ u16be(parts) ‖ piece of sealed
```

`sealed` is cut into parts so each frame is at most the connection's message size (64 KB by
default; up to 256 KB where the connection allows). The receiver checks each chunk's own SHA-256,
writes it straight to storage (never the whole file in memory), keeps a running SHA-256, and
compares it with `file-hash`.

### 19.3 Limits and flow

| Item | Value |
|---|---|
| Size | up to 2^50 bytes |
| Chunk | 16 KB – 1 MB (default 256 KB) |
| Ask first | Files over 100 MB wait for Accept; smaller ones start at once |
| Incoming at once | 8 transfers (more get `file-stop` `busy`) |
| Outgoing at once | at most 8 offers / transfers in flight per contact; the rest wait in order (state `queued`, "Waiting…"). A `file-stop` with `why: "busy"` is **not** a cancel: the file goes back to the queue, is offered again (after 1 s × tries, at most 10 s, and only when a place is free), and the sender sends no more at once than the receiver had taken (BUG-9, 23 Oct 2026) |
| Sender window | at most 32 chunks beyond the last `file-ack` |
| Back-pressure | stop sending at 4 MB queued, go on at 1 MB |
| Bad chunk | asked again up to 3 times, then `file-stop` `corrupt` |
| Stall check | 15 s with no progress |

Resume works across reconnects while the app stays open. **Planned:** resume after the app was
closed.

---

## 20. Groups

**Built** (feature `groups1`) for up to **50** people, with **sender keys**. Code: `src/net/groups.ts`.
All group frames are JSON on the locked 1:1 chat channels between members (§6), sent only to
peers whose `hello` lists `groups1`.

### 20.1 The group record

```
record = {"v":1,"id":"<gid, see genesis>","name":"…","createdBy":"<P2P ID>","admins":[…],
          "members":[{"p2pId":"…","identityKey":"<b64url>","name":"…"},…],
          "epoch":0,"prev":"<genesis: b64url 16-byte nonce; later: rh of the previous record>","ts":…,
          "by":"<P2P ID of the signing admin>","sig":"<b64url>"}
signed bytes = utf8(JSON(["p2ptalk-group-v1", id, name, createdBy, admins sorted,
               members sorted by p2pId as [p2pId, identityKey, name], epoch, prev, ts, by]))
sig  = Ed25519 by `by`
rh   = b64url(SHA-256(signed bytes ‖ sig))      (the record hash)
gid  = b64url(SHA-256(utf8(JSON(["p2ptalk-gid-v1", createdBy, creator's identityKey, name, admins sorted,
               members sorted as above, 0, nonce, ts])))[0..16])    (the genesis, epoch 0, binds the id)
```

| Rule | Detail |
|---|---|
| Shape | 1–50 members, each `p2pId` must match its key (§3); at least 1 admin; every admin is a member. |
| A change | `epoch` = current + 1, `prev` = `rh` of the current record, `createdBy` unchanged, `by` is an admin of the **current** record and the signature checks with that admin's key from the current record. Anything else is refused. |
| Genesis | Epoch 0, `by` = `createdBy` (an admin), `prev` = a 16-byte nonce, and `id` = `gid` above. Only the creator can make a genesis for an id (security review M-5). |
| First sight | `g-invite {gid, rec, gen}` from a contact who is a member of `rec`, and I am too: `gen` must be a valid genesis for `gid`. If `rec` is past epoch 0, I send `g-sync {epoch: 0}` and check every record from the genesis with the "A change" rule before the invite is shown (frames for the group wait meanwhile, for up to 10 min). An invite without a valid genesis is ignored, so groups made before ids were bound can't take new members. Records are kept from the genesis (up to 1,000). |
| Two admins at once | Same epoch and `prev`, both valid: everyone keeps the same record, by an order the signer can't grind (H-2): (1) a record that removes or demotes the other record's signer wins, unless both do that to each other; (2) a record that removes a member or an admin role wins over one that doesn't; (3) the more senior signer wins: `createdBy`, then the admin since the earlier epoch, then the lower P2P ID; (4) only two records by the same signer go by the lower `rh`. |
| Records ahead | A record more than one epoch ahead waits; the member asks with `g-sync`. |

### 20.2 Sender keys

On every new epoch each member makes a random 32-byte key and sends it to each other member:

```
g-key {gid, epoch, rh, owner, to, eph, ct, sig, hop?, want?}
label = JSON(["p2ptalk-gkey-v1", gid, epoch, rh, owner, to])
kek   = HKDF(X25519(eph, to's identity in X25519 form), salt = ephPub ‖ toX, info = utf8(label), 32)
ct    = b64url(iv(12) ‖ AES-256-GCM(kek, iv, aad = utf8(label), senderKey))
sig   = Ed25519 by `owner` over utf8(JSON([label, eph, ct]))
```

It is sealed to `to`, so other members may carry it. A new epoch means new keys from everyone, so a
removed member can't read later messages and a new member can't read earlier ones.

### 20.3 Messages and fan-out

```
g-msg {gid, epoch, mid, from, ts, ct, sig, hop, want}
ct  = b64url(iv(12) ‖ AES-256-GCM(senderKey(from, epoch), iv,
            aad = utf8(JSON(["p2ptalk-gmsg-v1", gid, epoch, from, mid])), utf8(JSON(body))))
sig = Ed25519 by `from` over utf8(JSON(["p2ptalk-gmsg-v1", gid, epoch, mid, from, ts, ct]))
```

| Item | Rule |
|---|---|
| Body | At most 60,000 characters of JSON. |
| Fan-out | The sender sends to every member it reaches; up to 4 of them also get `want` = the members it couldn't reach. A receiver passes the frame on to `want` members it reaches (`hop + 1`), at most **2 hops**, and keeps it for the others. Duplicates are dropped by `mid`. |
| Kept frames | The sender keeps each message for **every** other member, and a carrier for every member it was asked to pass it to, until that member answers `g-ack` (BUG-6: a connection that still looks open may already be dead, e.g. a member who just closed the app). Kept **7 days**, at most **500 per group** (5000 in all; the oldest go first), and saved with the group state, so they survive a restart of the keeper. On every connection, and on every `g-sync` received: `g-inv {ids}` → `g-req {ids, ack:1}` → the frames → `g-ack {ids}`; ids offered that the member already has are answered with `g-ack` at once. Usually one copy arrives. |
| Old epochs | A message for an epoch that has ended opens only if it arrives within **5 minutes** of that epoch ending (on this device), is dated no later than the next record's `ts` + 2 min, and its sender is still a member of the current record (security review M-4). Old keys are dropped 3 epochs later. |

### 20.4 Other frames

| `k` | Fields | Meaning |
|---|---|---|
| `g-invite` | `gid, rec, gen` | You were added (first sight of the group); `gen` = the genesis record. |
| `g-rec` | `gid, recs[]` | New or missing records (batches of 8). |
| `g-sync` | `gid, epoch, rh` | Sent on every connection for each shared group; the side that is ahead sends the missing records, and each side re-sends its current sender key and offers its kept frames. **`epoch: -1, rh: `** (23 Oct 2026, BUG-10) = "I don't have this group" (my app closed before the group was saved): sent at most once a minute per member and group in answer to a `g-sync` for an unknown group; a joined member who has it answers with the invite again (`g-invite` with the genesis), only if the asker is in the current record. Older builds answer it with the records from epoch 0, which a newer build ignores. |
| `g-leave` | `gid, from, epoch, ts, sig` | `sig` = Ed25519 by `from` over `utf8(JSON(["p2ptalk-gleave-v1", gid, from, epoch, ts]))`. An admin who gets it removes the member. |
| `g-inv` / `g-req` | `ids[]`; `g-req` also `ack: 1` | Inventory and request of kept frames (up to 200 ids per frame). `ack: 1`: the asker sends `g-ack`; a `g-req` without it (older builds) counts as delivered. |
| `g-ack` | `ids[]` (≤ 500) | "I have these" (opened, or already had them): the keeper stops keeping them for me. Sent to the member the frame came from, batched (50 ms). Older builds ignore it. |
| (state) | | Ids already read (7 days, the last 5000) are saved with the group state, so a frame offered again after a restart is not shown twice. A member whose saved groups load after its first connection greets again (`g-sync`, key, inventory) once they are loaded. |

### 20.5 Planned

- Locked notes on the relays for offline members (keys, records, invites). Members who are not
  contacts are reached directly since 23 Oct 2026 (§13.5), and other members carry frames for them.
- Group calls (a small full mesh), MLS (§14.4), and rotating sender keys without a group change.


---

## 21. Profile and group pictures (23 Oct 2026; feature `pic1`)

Code: `src/core/photo.ts` (rules), `src/net/photos.ts` (frames), `src/ui/photo.ts` (crop, encode, show).
Pictures go **only directly over the locked chat channel** to connected contacts and group members:
never to the relays, never in the public ID card (security review M-6).

**A picture.** Chosen on the device, cropped to a circle, drawn on a 256×256 canvas and exported
again (WebP; JPEG where a browser can't make WebP), aiming for ≤ 30 KB. Drawing it again drops every
byte of the original file: no EXIF, no GPS, no camera details. Its id is `h = hex(SHA-256(bytes))`.

| `k` | Fields | Meaning |
|---|---|---|
| `pic` | `h`: 64 hex, or `''` | "My picture is `h`". `''`: no picture, or this contact may not see it (Me › Privacy › Who can see my photo: *My contacts* / *Nobody*); the other side deletes its copy. Sent when a connection opens and when the picture or its visibility changes. |
| `pic-get` | `h`, `g?` (group id) | "Send me picture `h`". Without `g`: the sender's own picture. With `g`: that group's picture; answered only to a member of the group. Sent only when the stored copy's hash differs. |
| `pic-data` | `h`, `g?`, `t` (`image/webp` / `image/jpeg` / `image/png`), `i`, `n`, `d` (base64url) | Piece `i` of `n` (≤ 24 KB each, so a frame stays well under 64 KB). Only in reply to `pic-get`. |

**Checks on receipt.** Pieces are accepted only for a picture this side asked for; at most
`ceil(64 KB / 24 KB) = 3` pieces and 64 KB in all; the joined bytes must hash to `h`, have an allowed
type, and start with that type's magic bytes. The screens then decode them with `createImageBitmap`
and draw them again on a 256×256 canvas; only that new image is shown (a `blob:` URL in an `<img>`).

**Group pictures.** The signed group record (§20.1) has an optional field `pic`: the picture's hash
(64 hex), set or removed by an admin (`setPicture`); never the bytes. Members fetch the bytes from any
connected member with `pic-get {h, g}` and keep them only if `h` is what the current record names.
Note: a member on a build from before this field can't verify a record that has `pic`, so it stays on
the previous record version (fine while no older build is released).

**Trust.** A picture is chosen by its owner and proves nothing. The info sheet says so next to it and
keeps the safety pictures (§4) as the real check. When a contact's picture changes, the chat shows a
note ("Ravi changed their photo").

**Embedded mode** receives pictures and gives them to the host as `photo` (a `data:` URL) on
`Contact`; it sends none of its own.

---

## 22. Message ticks (23 Oct 2026; feature `rcpt1`)

Code: `src/net/receipts.ts` (rules, outbox), `src/main.ts` (when to send, ticks on screen).

| Tick on my message | Meaning |
|---|---|
| clock | **Waiting**: not sent. Not connected, or they said `bye` (§7.4). Sent by itself, in order, when the link opens or they come back. |
| one grey | **Sent**: it left this device over the locked link. |
| two grey | **Delivered**: their device received and stored it. |
| two blue (cyan `#4FD1E8`) | **Read**: it was on their screen (chat open, page visible) and they have read receipts on. |

**Frame.** `{ "k": "rcpt", "mids": [mid…] (1–200 ids, ≤ 64 chars each), "st": "d" | "r", "g"?: group id }`
over the locked chat channel to the message's sender. Batched (about 150 ms); kept on the device
(`kv: rcptOut`) while the sender is offline, and sent when the link opens again.

**Accepted only** from the other side of that chat, or (with `g`) from a member of that group, and
only for **my** messages in that chat; unknown message ids are ignored. Statuses only go forward
(wait → sent → delivered → read).

**Groups.** Each member sends its own receipts to the message's sender. Two ticks when every other
member has it; blue when every one has read it. Message info (hold or right-click my message) lists
each member: Not yet / Delivered / Read.

**Read receipts off** (Me › Privacy, default on): this device sends no `r` receipts and shows others'
read as delivered. Delivered receipts always go.

**Lost links.** A message marked sent whose link died before it arrived is sent again (same `mid`)
on the next connection, for a day, to builds that send receipts; the receiver keeps the first copy
of a `mid` only and answers `d` again.

**Stored** with the message (`st`; groups: `rc` per member), outside the chat-lock seal (it says
nothing about the content). Embedded mode: event `message-status`, method `markRead` (EMBEDDING.md).
