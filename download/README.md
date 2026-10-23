# Download P2P Talk

| Device | How to get it |
|---|---|
| **Any phone or computer** | Open **<https://p2p.vilnek.in>**. On a phone: Share → **Add to Home Screen** (iPhone) or ⋮ → **Install app** (Android) |
| **Android** | Download the APK from the **[latest release](https://github.com/vilnek/p2p/releases/latest)** (file `P2P-Talk-<version>.apk`) |
| **iPhone / iPad** | Use the web app above for now. The App Store version comes after testing |
| **Play Store / App Store** | Coming after testing |

## Install the Android APK
1. Download `P2P-Talk-<version>.apk` from the [latest release](https://github.com/vilnek/p2p/releases/latest) on your phone.
2. Tap it. If Android asks, allow **Install unknown apps** for your browser or Files app (once).
3. Tap **Install**, then open **P2P Talk**.

**Check it's the real file:**
- Every release lists the APK's **SHA-256** fingerprint.
- Official builds are always signed with the same Vilnek key, whose certificate SHA-256 is:

```
DF:17:79:E3:58:65:29:B7:79:0F:28:90:0A:4B:AF:EC:08:55:94:E6:56:F6:A4:25:3B:10:F3:1A:B9:22:A1:5C
```

- Check it with `apksigner verify --print-certs P2P-Talk-<version>.apk`.
- Android refuses any update signed by a different key.

## Is it safe?
- The code is open: read it in this repository.
- The app has no account server; your chats and calls go directly between devices, locked end to end.
- How it works, with diagrams: [docs/OVERVIEW.md](../docs/OVERVIEW.md).
- Found a security problem? See [SECURITY.md](../SECURITY.md).
