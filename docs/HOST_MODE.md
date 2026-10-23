# Host mode: P2P Talk's own screens inside another app

**Status:** built 23 Oct 2026 (`src/hostui.ts`, the "host mode" section of `src/main.ts`). Not deployed yet.
Design **CN2** (Dr Vijay, 23 Oct 2026): Vilnek OS on the Mac shows P2P Talk's own full screens in its Connect page,
under a thin Vilnek bar.

Host mode is embed mode (`EMBEDDING.md`) **plus the full screens**. Everything in `EMBEDDING.md` still applies
(approved page, WebKit bridge, data shapes), with the differences below.

## 1. Loading

```
https://p2p.vilnek.in/?embed=1&ui=1
```

- `version().features` includes **`"hostui"`** only in this mode. A page without host mode ignores `ui=1` and
  stays headless, so the host switches only when it sees `"hostui"` (in the `loaded` event or `version()`).
- `?embed=1` without `ui=1` is headless exactly as before (no screens, no `"hostui"`, no `P2PTalk.ui`).
- Until `start()` the page shows one card: "Waiting for Vilnek OS…". The home page, create account, restore,
  join-by-link and the 24-words screens never show in this mode.
- Layout: the page fills the web view. 900 px and wider: rail · list · chat; 1200 px and wider: also the details
  panel. Narrower: the phone layout (tabs at the bottom). No top inset is added (the host's bar is outside the view).

## 2. Identity (from the host only)

```js
await P2PTalk.start({ words, name, deviceName })   // → Me (kept: false)
P2PTalk.stop()                                    // closes everything; back to "Waiting for Vilnek OS…"
```

- `words` is required. `keep` and `resume` are refused ("This page never keeps the identity").
- The identity is held in memory only. The 24 words and the identity key are never written to the page's
  storage by host mode. A reload shows the waiting card again until the host calls `start()`.
- **Which database** (the chats, contacts, groups, settings and this device's key):
  1. If the normal app's database on this origin (`p2ptalk`, P2P Talk opened normally, e.g. in Vilnek OS's own
     browser, which shares the web view's data store) holds **the same identity** (same public key), host mode
     **uses it directly**: one set of chats for both, nothing copied, nothing deleted (its stored account stays
     as the normal app left it). The chats headless embed mode kept for this identity (contacts and messages;
     it has no groups or locks) are added to it **once** (flag `flag:carried:<embedded db>`; the embedded
     database is left as it is).
  2. Otherwise the database headless embed mode uses for those words (`p2ptalk-embed-<hash of the public key>`),
     so a host that used headless embed before keeps its chats.
  Another identity's database is never opened for use. Both pages open at once with the same identity act like
  two tabs of the same account (the host should keep the normal page closed while host mode runs).
- Me shows **"Account managed by Vilnek OS"** instead of "My 24 words" and "Delete my account and data".
  My devices, chat lock, privacy, network and the profile photo are as in the normal app.

## 3. Methods

All of embed mode's methods work, on the screens' own state: `version`, `newWords`, `start`, `stop`, `me`,
`setName`, `setDeviceName`, `myDevices`, `contacts`, `history`, `markRead`, `makeInvite`, `requests`, `accept`,
`block`, `blockContact`, `connect`, `send`, `call`, `acceptCall`, `declineCall`, `hangUp`, `setMicOn`,
`setCameraOn`, `replaceVideoTrack`, `startScreenShare`, `stopScreenShare`, `setScreenSound`, `getLocalStream`,
`getRemoteStream`, `setRecording`, `connectionDetails`, `on`, `off`. Differences:

| Method | In host mode |
|---|---|
| `openLink(link)` | Shows the screens' "Connect?" card (nothing is sent before the person taps Connect). Resolves `{state: 'asking', contactId}` |
| `connect(id)` | As before; the chat does **not** open on screen by itself (for the host's online-dot checks) |
| `send(id, text)` | As before; the message also shows in the chat if it is open |
| `call(id, {video})` | Opens the chat and P2P Talk's own call screen. Offline with no earlier connection: a `call` event with `state: 'failed', reason: 'offline'` |
| `history(id)` | A locked chat returns `[]` |
| `setRecording(on)` | The other side sees "● Dr Vijay is recording"; this call screen shows **"● Recording"** while on (1:1 calls) |
| files | `sendFile`, `acceptFile`… are not in host mode: files are sent and accepted in the screens (`file` events still come) |
| `groups()` | New: my groups, as `Group` below |

Screens, new in host mode (each needs `start()` first):

```js
await P2PTalk.ui.open(contactId)   // → true, or false if not a contact ("g:<gid>" opens a group). A locked chat asks for its code.
await P2PTalk.ui.openGroup(gid)    // → true, or false if no such group
P2PTalk.ui.show('chats' | 'groups' | 'calls' | 'add' | 'me')   // → true; anything else throws
```

## 4. Events

As in embed mode: `loaded`, `ready`, `contact`, `request`, `message`, `message-status`, `call`, `stream`,
`recording`, `screen`, `invite`, `devices`, `file`. In-page listeners (`P2PTalk.on`) get full data (MediaStreams,
the received file's Blob); the host's `webkit.messageHandlers.p2ptalk` gets plain data (track kinds instead of
streams). Differences and additions:

| Event | Data (to the host) |
|---|---|
| `message` | Also for messages **typed in the screens**: `{contactId, from: 'me', mid, text, ts, status: 'sent' \| 'waiting'}`. Their messages: `{contactId, from: 'them', mid, text, ts}`. **A locked chat:** `text: ''` and `locked: true` (its text never leaves the page) |
| `message-status` | `{contactId, mid, status: 'sent' \| 'delivered' \| 'read'}` for my 1:1 messages (`sent`: a waiting message went out) |
| `contact` | Also `locked: boolean` |
| `share` | **New.** An invite link was copied or shared in the screens (Add › Send an invite link › Copy / Share, or Show my code › Share link): `{link, name, kind: 'invite' \| 'card', expires}`. `name` is my name (as in the link). The host shares it its own way (the page's browser share is not used) |
| `group` | **New.** A group was made, joined, changed, left or I was removed: `Group` = `{groupId, name, status: 'invited' \| 'joined' \| 'left' \| 'removed', iAmAdmin, admins: [id], members: [{id, name}], locked}` |
| `groupMessage` | **New.** `{groupId, groupName, from: 'me' \| 'them', senderId, senderName, mid, text, ts}` (mine typed in the screens, and others'). A locked group: `text: ''`, `locked: true` |
| `call` | Also for **group calls**: `{contactId: 'g:<groupId>', group: true, groupId, groupName, callId, state, video, outgoing, reason, connectedAt}` with `state` `incoming` · `connected` (I joined) · `missed` · `ended` (also after declining, `reason: 'declined'`); `connectedAt` is when I joined. `ui.open('g:<groupId>')` opens that group |
| `groupCall` | **New.** `{groupId, groupName, callId, state: 'incoming' \| 'joined' \| 'missed' \| 'declined' \| 'ended', video, by, byName, reason, canJoin}` |

Group calls have no `stream` events, and `setRecording` / `getLocalStream` / `getRemoteStream` cover 1:1 calls only
(`setRecording` during a group call throws "No call."; the other members are not told about any recording).

## 5. Calls and screen share

- P2P Talk's own call screen is used (incoming: Answer / Decline; live: mute, camera, share screen, devices, chat,
  hang up). The host should not draw its own video over it; it can still record from `stream` events and
  `getLocalStream()` / `getRemoteStream()`.
- Share screen uses the browser's screen capture (`getDisplayMedia`). Where the web view has none, the button
  still shows and says **"This window can’t share the screen."** (1:1 and group calls).

## 6. Tests

`tests/e2e/host-mode.spec.ts` (fake WebKit handler, local relay only), `tests/unit/hostui.test.ts`.
