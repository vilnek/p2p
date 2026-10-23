# P2P Talk: how it works

**Chats, voice and video calls, files, screen sharing and groups, straight from your device to theirs.**
No phone number, no email, no account server, and nobody in the middle who can read anything.
Open source (Apache-2.0), by [Vilnek](https://vilnek.in).

- **Use it now:** <https://p2p.vilnek.in> (any phone or computer; add it to your home screen)
- **Android app:** see [downloads](../download/README.md)
- **iPhone:** use the web app for now. The App Store and Play Store versions come after testing.

---

## 1. The big picture

```mermaid
flowchart LR
    A["📱 Your device<br/>keys made here<br/>chats stored here"]
    B["💻 Their device<br/>keys made there<br/>chats stored there"]
    R[("🌐 Public relays<br/>(many, run by different people)<br/>carry only a locked 'hello'")]
    S["STUN<br/>tells a device its own<br/>internet address"]

    A -- "1. locked hello" --> R
    R -- "locked hello" --> B
    A -. "2. what is my address?" .-> S
    B -. "what is my address?" .-> S
    A <== "3. DIRECT, locked end to end<br/>chat · calls · files · screen" ==> B
```

- The relays never see what you say, who it's for, or your files.
- After the hello, everything goes **directly** between the two devices.
- Vilnek runs **no server** that your chats or calls pass through.

## 2. Your account is 24 words

```mermaid
flowchart TD
    W["🔑 24 secret words<br/>(made on your device, written on paper)"] --> K["Your keys<br/>(signing + locking)"]
    K --> ID["Your 24-digit P2P ID<br/>e.g. 4821 0937 6612 3390 7745 1208<br/>a fingerprint of your key"]
    K --> E["Safety pictures<br/>e.g. 🦁🌙🌿🐬<br/>to compare with a friend"]
    W -. "lost phone? type the 24 words" .-> K
```

- **Same 24 words on another device → same account, same ID.** Each device also has its own name ("iPhone", "Mac").
- **The ID can't be faked:** a different key always gives a different number.
- **Nobody can recover your words for you.** Keep them on paper.

## 3. Adding someone

```mermaid
flowchart LR
    Q["📷 Scan their code<br/>(in person, safest)"] --> C{"Connected<br/>directly"}
    L["🔗 Invite link<br/>(WhatsApp, SMS, email)"] --> C
    T["🔢 Type their 24-digit ID"] --> RQ["They see a request<br/>Accept / Block"] --> C
    O["🗝️ One-time code<br/>e.g. 48-tiger-moon"] --> C
```

### One scan is enough

```mermaid
sequenceDiagram
    participant A as Asha (shows code)
    participant R as Public relays
    participant B as Ravi (scans)
    A->>A: Make a small signed code with a one-time reply box (10 min, single use)
    A->>R: Listen on the reply box
    B->>B: Scan the code, check Asha's signature
    B->>R: Locked offer, only Asha can open it
    R->>A: Locked offer
    A->>R: Locked answer, only Ravi can open it
    R->>B: Locked answer
    A-->>B: Direct connection (both check each other's key)
    Note over A,B: From now on: saved contacts, chat directly anytime
```

### An invite link while you're offline

```mermaid
sequenceDiagram
    participant A as You (sent the link, now offline)
    participant R as Public relays
    participant B as Friend
    B->>B: Open the link → name → Join (account made instantly)
    B->>R: Locked request (waits up to 24 h, then deleted)
    B->>B: "Request sent. You'll connect when they're online."
    A->>R: You open P2P Talk later
    R->>A: Locked request
    alt Friend still online
        A-->>B: Connect straight away
    else Friend offline too
        A->>A: Accept / Block (only this once)
        A->>R: Locked acceptance
        R->>B: When the friend comes back
        B-->>A: Connect
    end
```

## 4. How a connection gets through

```mermaid
flowchart TD
    S([Start]) --> SW{"Same Wi-Fi?"}
    SW -- yes --> L["🛜 Local network, direct"]
    SW -- no --> V6{"IPv6 on both?"}
    V6 -- yes --> D["🌐 Internet, direct"]
    V6 -- no --> HP{"Hole punching works?"}
    HP -- yes --> D
    HP -- no --> OR{"Your own relay on?<br/>(your Mac / spare phone at home)"}
    OR -- yes --> H["🏠 Through your own device, still locked"]
    OR -- no --> MSG["Clear message:<br/>'Can't connect directly right now'<br/>Try again · Send a message"]
```

The iPhone app needs **Local Network** permission for same-Wi-Fi connections: it asks once at first launch.

## 5. Calls

```mermaid
stateDiagram-v2
    [*] --> Reaching: tap call
    Reaching --> Ringing: their device confirms
    Reaching --> Failed: offline
    Ringing --> Connecting: they answer
    Ringing --> Failed: declined / no answer / busy
    Connecting --> Connected: audio + video flowing
    Connecting --> Failed: can't connect directly
    Connected --> Ended: hang up
    Failed --> [*]
    Ended --> [*]
```

- Voice and video, **directly between devices**.
- **Screen sharing** on computers (and in the phone apps later).
- Small group calls: up to about 4–6 people on video, 8 on voice.
- The call screen shows the same safety pictures on both sides: if they match, nobody is in the middle.

## 6. Files of any size

```mermaid
sequenceDiagram
    participant A as Sender
    participant B as Receiver
    A->>B: Offer: name, size, type (locked chat)
    B->>A: Accept (asked for files over 100 MB)
    A->>B: A new direct channel just for this file
    loop 256 KB pieces, each locked with the file's own key and checked
        A->>B: piece n
        B->>B: write straight to storage (never all in memory)
    end
    Note over A,B: Network drops? It resumes from the last piece received
    B->>A: Done, whole-file check matches ✓
```

## 7. Groups

```mermaid
flowchart LR
    AD["👑 Admin"] -- "signed member list" --> M1["Member"]
    AD -- "group key (locked 1:1)" --> M2["Member"]
    M1 <-- "group messages, locked with the group key" --> M2
    M1 -- "passes on to members<br/>the sender can't reach" --> M3["Member"]
    X["Removed member"] -. "new key: can't read new messages" .-x M2
```

## 8. Who can see what

| Who | Can see | Never sees |
|---|---|---|
| **Vilnek** | Nothing. No server of ours in the path | Everything |
| Public relays | A locked hello, a random label, the address of the device talking to them | Your messages, files, calls, contacts |
| STUN servers | Your device's internet address for a moment | Anything else |
| The person you talk to | Your internet address (needed for a direct link) | — |
| Your mobile company / Wi-Fi | That your device talks to some addresses | Any content |

**No app can stop:** spyware on a phone, a camera pointed at the screen, or what the other person chooses to do. The phone apps block screenshots and screen recording where the system allows it.

## 9. Built with
TypeScript, WebRTC, audited open-source crypto (`@noble/curves`, `@noble/hashes`, `@scure/bip39`), the Nostr relay protocol for the hello, Capacitor for the phone apps. Full details: [PROTOCOL.md](PROTOCOL.md) · [THREAT_MODEL.md](THREAT_MODEL.md) · [SECURITY.md](../SECURITY.md) · [CONTRIBUTING.md](../CONTRIBUTING.md).

## 10. Roadmap

```mermaid
flowchart LR
    P0["✅ One-file app<br/>24 words · ID · QR<br/>chat · calls"] --> P1["✅ Live web app<br/>one-scan · invites<br/>online status"]
    P1 --> P2["🛠 Files · screen share<br/>groups · multi-device"]
    P2 --> P3["Android app"] --> P4["iPhone app"]
    P4 --> P5["Open-source launch"] --> P6["Play Store<br/>App Store"]
```
