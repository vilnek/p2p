# Embedding P2P Talk in another app

**Project Director and Writer:** [Dr Vijaykumar](https://vijaykumar.vilnek.in)

**Status:** matches `src/embed.ts` as of 23 Oct 2026. Protocol version `1`.

P2P Talk can run with **no screens of its own** inside another app. The host app opens the page in a
web view, draws its own screens, and drives everything through one JavaScript object,
`window.P2PTalk`. Chats and calls still go device to device, locked end to end, exactly as in the
normal app (see `PROTOCOL.md`).

Vilnek OS uses this for Vilnek Connect: it opens the page in a hidden WebKit view on the Mac and on
iPhone.

**Host mode** (`?embed=1&ui=1`, feature `"hostui"`): the same API plus P2P Talk's own full screens inside
the host app. See `HOST_MODE.md`.

---

## 1. Loading the page

Open the same page people use, with `?embed=1`:

```
https://p2p.vilnek.in/?embed=1
```

With `embed=1` the page shows nothing (the splash screen is removed), sets `window.P2PTalk`, and
sends the `loaded` event. No account is made or loaded until the host calls `P2PTalk.start()`.

Other switches the normal page reads also work here, for example `?relays=ws://127.0.0.1:4318`
(test relays only; see `src/net/config.ts`).

### 1.1 Security: load only a page you approved

The page holds the user's keys while it runs, so the host must be sure it is the real page.

1. **Keep your own copy.** Download the page once, and load that copy with the site's address as
   its base URL (so it runs on the `https://p2p.vilnek.in` origin and its content policy and
   storage apply), instead of fetching the live site on every start.
2. **Check the fingerprint.** The site publishes the SHA-256 of the page at
   `https://p2p.vilnek.in/index.html.sha256`. The file reads `<64 hex characters>  out/index.html`;
   compare the first 64 characters with the SHA-256 of the bytes you downloaded. If they differ,
   do not use the page.
3. **Update only on purpose.** When the published fingerprint changes, download the new page,
   check it as in step 2, and switch to it only after the user agrees. If the site can't be
   reached, keep using the approved copy.
4. **Lock the web view to this page.** Allow navigation only to `https://p2p.vilnek.in` (and
   `about:blank`), refuse new windows, and grant camera and microphone only to that origin in the
   main frame. A reload should load your approved copy again, not the live site.
5. **The identity is the host's job.** By default the page keeps the identity in memory only. If
   the host passes `keep: true`, it is also stored in the web view's own storage for that origin
   (IndexedDB database `p2ptalk-embed-<16 hex>`).

The page itself fetches nothing else: it is one self-contained file. It only opens WebSocket
connections to the built-in public relays and uses the two public STUN servers listed in
`PROTOCOL.md` §10.1.

### 1.2 The host bridge (WebKit)

**Page → host.** Every event is also posted to a WebKit script message handler named `p2ptalk`,
when the host has added one:

```js
window.webkit.messageHandlers.p2ptalk.postMessage({ event, data })
```

`event` is one of the names in §4. `data` is plain JSON-safe data (see §4 for the few events where
the host gets less than in-page listeners: no `MediaStream`, no `Blob`). If there is no handler,
nothing is posted and nothing fails.

**Host → page.** Call the methods with `callAsyncJavaScript` in the page's content world. Every
method may be `await`ed; a rejected promise or a thrown error comes back to the host as an error
whose message is plain text (for example `offline`, `Not a contact.`). Return values are plain
objects, arrays, strings and numbers, so the host can `JSON.stringify` them in the page and parse
them on its side:

```swift
let body = "const r = await P2PTalk.send(id, text); return JSON.stringify(r);"
let json = try await webView.callAsyncJavaScript(body, arguments: ["id": contactId, "text": text],
                                                 in: nil, contentWorld: .page)
```

Methods that need a `MediaStream` or `MediaStreamTrack` (`getLocalStream`, `getRemoteStream`,
`replaceVideoTrack`) can only be used from a script running in the page (for example a small
script the host adds at document start).

---

## 2. Data shapes

All P2P IDs are the 24 digits with no spaces (`"395064155608899644355146"`). All times are
milliseconds since 1970 (UTC).

### 2.1 `Me`

Returned by `start`, `me`, `setName`, `setDeviceName`, and sent with `ready`.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | My 24-digit P2P ID |
| `name` | string | My name (up to 40 characters) |
| `emoji` | string | My 4-emoji safety code |
| `publicKey` | string | My identity public key, base64url |
| `deviceName` | string | This device's name |
| `deviceCode` | string | Short code for this device's key, e.g. `"A1B2 C3D4"` |
| `kept` | boolean | The identity is stored in this page's storage (`keep` or `resume`) |

### 2.2 `Contact`

Returned by `contacts` and `accept`, and sent with `contact`.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Their P2P ID |
| `name` | string | Their name |
| `emoji` | string | Their 4-emoji safety code |
| `online` | boolean | A connection is open and they were heard from in the last 12 s |
| `lastSeen` | number | Last time they were heard from |
| `path` | `{ kind, label }` | How the connection goes (below) |
| `device` | string or `null` | The device they are on, when its certificate checked (e.g. `"iPhone"`) |
| `photo` | string or `null` | Their profile picture as a `data:image/webp\|jpeg\|png;base64,…` URL: 256×256, ≤ 64 KB, received only directly from them (PROTOCOL §21), type and size checked. A new `contact` event comes when it changes. Treat it as their own choice: the `emoji` safety code is the real check. Embedded mode receives pictures but sends none. |
| `keyChanged` | `true` (only when it happened) | A connection came from a known P2P ID with a **different key**. It was refused and closed; the stored contact is unchanged. The host can show "Safety code changed". |

`path.kind` is one of `local` (same Wi-Fi / local network), `internet` (direct across the
internet), `relay` (through someone else's relay computer; not expected), `offline`, and, for later
builds, `bluetooth`, `wifi-direct`, `postbox`, `own-relay`. `path.label` is the plain-words label
for that kind (e.g. `"Same Wi-Fi / local network"`).

### 2.3 `Message`

| Field | Type | Meaning |
|---|---|---|
| `contactId` | string | Who it is from (event only) |
| `from` | `"me"` or `"them"` | Direction |
| `mid` | string | Message id (12 base64url characters) |
| `text` | string | The text (received text is cut at 20,000 characters) |
| `ts` | number | The sender's clock |

### 2.4 `Call`

Sent with the `call` event.

| Field | Type | Meaning |
|---|---|---|
| `contactId` | string | The other person |
| `state` | string | `idle`, `reaching`, `ringing`, `incoming`, `connecting`, `connected`, `reconnecting`, `ended`, `missed`, `failed` (meanings in `PROTOCOL.md` §8.1). `reconnecting` (since 23 Oct 2026): the network stalled mid-call and the connection is being restarted; show "Reconnecting…" and keep the call screen; it goes back to `connected` (same `connectedAt`) or, after about 20 s, to `ended` |
| `video` | boolean | Video call |
| `outgoing` | boolean | I called |
| `reason` | string or `null` | When `failed`: `offline`, `no-answer`, `declined`, `busy`, `media`, `my-media` (my camera or microphone could not open), `their-media` (theirs could not) |
| `connectedAt` | number or `null` | When the call connected |

### 2.5 `Request`

A contact request that arrived on one of my invites. Returned by `requests`, sent with `request`.

| Field | Type | Meaning |
|---|---|---|
| `requestId` | string | Pass this to `accept` or `block` (`"<inviteId>:<their key>"`) |
| `inviteId` | string | The invite it came through (hex) |
| `id` | string | Their P2P ID |
| `name` | string | Their name |
| `note` | string | Their short note (up to 140 characters), may be empty |

### 2.6 `Device`

Returned by `myDevices`, sent with `devices`: my **other** devices (same 24 words) that a contact
saw recently. Each certificate is checked against my identity key before it is listed.

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Device name |
| `code` | string | Short code for that device's key |
| `seen` | number | When a contact last saw it connected |

### 2.7 `File`

Sent with the `file` event, for files going out and coming in.

| Field | Type | Meaning |
|---|---|---|
| `contactId` | string | The other person |
| `fid` | string | Transfer id |
| `name` | string | File name |
| `size` | number | Bytes |
| `type` | string | MIME type, may be empty |
| `from` | `"me"` or `"them"` | Direction |
| `done` | number | Bytes the receiver has written (for an outgoing file: as the receiver confirmed) |
| `speed` | number | Bytes per second over the last few seconds |
| `eta` | number or `null` | Seconds left, when known |
| `state` | string | `offered` (out: waiting for Accept), `incoming` (in: waiting for `acceptFile` / `declineFile`), `active`, `paused`, `waiting` (not connected; goes on at the next connection), `verifying` (checking the whole-file SHA-256), `done`, `declined`, `cancelled`, `failed` |
| `blob` | `Blob` or `null` | **In-page listeners only:** the finished file, when it is kept in the page (private file area or memory). The host bridge does not get it. |

Embedded mode uses the large-file transfer (`files2`, `PROTOCOL.md` §19): originals, no size limit
set by us, one data channel per file, resume after a reconnect while the page stays open, and
**files of 100 MB and more wait for Accept**. The other side must support `files2`. A finished file
is also added to the chat history.

---

## 3. Methods

`P2PTalk.<method>(…)`. "Needs start" means it throws `Call P2PTalk.start() first.` before `start`.

### 3.1 Account

| Method | Returns | Notes |
|---|---|---|
| `version()` | `{ protocol, build, features }` | `protocol`: `1`. `build`: e.g. `"0.0.1+2026-10-23"`. `features`: what this page understands (the same list its hello sends, `PROTOCOL.md` §7.2). Works before `start`. |
| `newWords()` | string | 24 new words for a new account. The host shows them to the user; the page keeps nothing. |
| `start(options)` | `Me` | Starts with one identity (below). Throws `Already started. Call P2PTalk.stop() first.` if one is running. Sends `ready`. |
| `stop()` | — | Closes every connection and forgets the identity in memory. A kept identity stays in storage. |
| `me()` | `Me` | Needs start. |
| `setName(name)` | `Me` | Up to 40 characters. Saved if kept. Contacts see it on the next connection. |
| `setDeviceName(name)` | `Me` | Up to 32 characters; a fresh device certificate is signed. Throws `Give a device name.` if empty. |
| `myDevices()` | `Device[]` | Needs start. |

`start(options)` takes **one** of `words`, `secretKey` or `resume`:

| Option | Type | Meaning |
|---|---|---|
| `words` | string | The 24 words |
| `secretKey` | string | Or the identity secret key: 64 hex or 43 base64url characters (32 bytes) |
| `resume` | boolean | Or: the identity stored by an earlier `start({ keep: true })` on this page. Throws `Nothing kept on this page.` if there is none. |
| `name` | string | My name (default: the kept one, or empty) |
| `deviceName` | string | This device's name. The device key is made once per identity database and kept; a different name re-signs its certificate. Default: a plain platform name such as `Mac` or `iPhone`. |
| `keep` | boolean | Store the identity, contacts and history in this page's storage (default `false`: memory only, but contacts and history are still written to the per-identity database) |

With none of the three: `Give words, secretKey or resume.`

### 3.2 Contacts and invites

| Method | Returns | Notes |
|---|---|---|
| `contacts()` | `Contact[]` | Newest `lastSeen` first. |
| `history(contactId)` | `{ from, mid, text, ts }[]` | Oldest first. |
| `makeInvite({ ttl?, name? })` | `{ link, inviteId, expires }` | One-person invite link `https://p2p.vilnek.in/#c=…`. `ttl`: `"1h"`, `"24h"` (default) or `"7d"`. `name`: the name shown to the person opening it (default: mine). |
| `openLink(link)` | `{ state, contactId }` | Opens someone's invite link or connect card. `state`: `connected` (they were online), `request-sent` (stored on the relays; wait for `contact`), `refused` (used or expired), or `connecting` (a one-scan connect card). Throws `This is not a P2P Talk link.` |
| `requests()` | `Request[]` | Waiting requests on my invites. |
| `accept(requestId)` | `Contact` | Throws `No such request.` Sends `contact`, then connects. |
| `block(requestId)` | — | Ignores that person on that invite from now on. |
| `blockContact(contactId)` | — | Closes the connection, forgets the contact, ignores their reconnects and requests. |
| `connect(contactId)` | — | Reconnects through the relays; resolves when the chat is open (at once if it already is). Throws `Not a contact.`, `Not started.`, `Couldn’t reach the public relays.`, `<name> is offline · try again later` (no answer in 8 s), or `offline` (answered, but the connection didn't open within 15 s). |

### 3.3 Messages and files

| Method | Returns | Notes |
|---|---|---|
| `send(contactId, text)` | `{ k, mid, text, ts }` | Needs an open connection (`connect` first), else throws `offline`. Saved in history. |
| `sendFile(contactId, file, name?)` | `{ fid, name, size }` | `file`: a `Blob` or `File` (in-page scripts only), sent as the original. Resolves once the offer is sent; progress comes as `file` events. Throws `offline` or `Their app can’t receive files yet.` |
| `acceptFile(contactId, fid)` | — | Accept an incoming file in state `incoming` (100 MB and more). |
| `declineFile(contactId, fid)` | — | Decline it. |
| `cancelFile(contactId, fid)` | — | Stop a transfer either way. |
| `pauseFile(contactId, fid)` / `resumeFile(contactId, fid)` | — | Pause / go on (either side may). |

### 3.4 Calls

One call at a time across all contacts.

| Method | Returns | Notes |
|---|---|---|
| `call(contactId, { video? })` | — | Connects first if needed. States arrive as `call` events; if the contact can't be reached, one `call` event with `state: "failed", reason: "offline"`. Throws `Already in a call.` |
| `acceptCall()` | — | Accepts the incoming call (camera / microphone open here; if they can't, the call fails with `my-media`). |
| `declineCall()` | — | |
| `hangUp()` | — | Ends or cancels the current call. |
| `setMicOn(on)` / `setCameraOn(on)` | — | Mute / unmute; camera off / on. |
| `getLocalStream()` / `getRemoteStream()` | `MediaStream` or `null` | In-page scripts only. |
| `replaceVideoTrack(track)` | — | Sends another video track instead of the camera (for example a screen the host captured); `null` stops sending video. Throws `No call.` |
| `startScreenShare()` | — | Shares the screen with the browser's own picker (desktop browsers and WebKit with screen capture); the other side gets a `screen` event. Throws `No call.` or `This browser can’t share the screen.` |
| `stopScreenShare()` | — | Back to the camera. |
| `setScreenSound(on)` | — | While sharing: my device's sound on / off (mixed with the microphone, where the browser captured it). |
| `setRecording(on)` | — | Tells the other side this call is being recorded (they see "● name is recording"). The page records nothing itself. Throws `No call.` |

### 3.5 Support and events

| Method | Returns | Notes |
|---|---|---|
| `connectionDetails()` | string | The last connection attempt as plain text, network addresses masked, for support. |
| `on(event, fn)` | function | Adds an in-page listener; returns a function that removes it. |
| `off(event, fn)` | — | Removes it. |

---

## 4. Events

In-page listeners get `data`; the host bridge gets `{ event, data }` (§1.2).

| Event | `data` | When |
|---|---|---|
| `loaded` | `{ protocol, build, features }` | The page is ready for `start` (once). |
| `ready` | `Me` | After `start`. |
| `contact` | `Contact` | A contact was added, connected, went online or offline, or its path changed. |
| `request` | `Request` | A contact request arrived on one of my invites. |
| `message` | `Message` with `from: "them"` | A message arrived (it is already in history). |
| `call` | `Call` | Every call state change. |
| `stream` | `{ contactId, kind: "local" \| "remote", stream }` | A call's media changed. **Host bridge:** `stream` is replaced by `tracks: ["audio", "video", …]`. `stream` / `tracks` is `null` / `[]` when it ended. |
| `recording` | `{ contactId, on }` | The other side started or stopped recording the call. |
| `screen` | `{ contactId, mine, theirs, sound, soundCaptured }` | Screen sharing changed: `mine` (I share), `theirs` (they share), `sound` (my device sound is going out), `soundCaptured` (the browser gave the device sound at all). |
| `file` | `File` | A transfer started, moved on, finished or failed. **Host bridge:** no `blob`. |
| `invite` | `{ state: "refused", id }` | An invite I opened was already used or expired (`id`: the inviter's P2P ID). |
| `devices` | `Device[]` | A contact told me about my other devices. |

---

## 5. Example (in-page script)

```js
P2PTalk.on('message', (m) => console.log(`${m.contactId}: ${m.text}`));
P2PTalk.on('call', (c) => {
  if (c.state === 'incoming') P2PTalk.acceptCall();
});
P2PTalk.on('stream', ({ kind, stream }) => {
  if (kind === 'remote') document.querySelector('video').srcObject = stream;
});

const words = P2PTalk.newWords();             // show these to the user once
const me = await P2PTalk.start({ words, name: 'Dr Vijay', deviceName: 'Mac', keep: true });
const { link } = await P2PTalk.makeInvite({ ttl: '24h' });
// … send `link` to someone; when they open it, a `contact` event arrives …

const [ravi] = await P2PTalk.contacts();
await P2PTalk.connect(ravi.id);
await P2PTalk.send(ravi.id, 'Namaste');
await P2PTalk.call(ravi.id, { video: true });
```

On the next launch, `await P2PTalk.start({ resume: true })` brings back the kept identity.

---

## 6. Notes

- **Not in embedded mode (yet):** groups, "Findable by my ID", Report and Delete my account. The
  host app provides its own versions of these screens.
- **No server.** The page talks only to the other person's device and to public relays for the
  first hello. Relays see random tags and locked blobs.
- **One page per identity.** Call `stop()` before `start()` with another identity.
- Unknown events or fields may be added later; ignore what you don't know.

## Message ticks (23 Oct 2026, PROTOCOL §22)

- Event `message-status`: `{ contactId, mid, status }`, `status` `'delivered'` or `'read'`, for messages
  the host sent with `send`. Statuses only go forward.
- Embedded mode sends **delivered** receipts by itself when a message is stored. Read receipts are the
  host's decision: call `markRead(contactId, mids)` when the messages are on screen (respect the
  person's Read receipts setting). Returns `false` when they are offline or on an older build.
- `history()` items carry `status` (`'wait' | 'sent' | 'd' | 'r'`) on messages that have one.

