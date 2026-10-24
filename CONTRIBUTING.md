# Contributing to P2P Talk

**Project Director and Writer:** [Dr Vijaykumar](https://vijaykumar.vilnek.in)

Thank you for helping. P2P Talk is an open-source, serverless, peer-to-peer messenger by Vilnek.
Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

Security bugs: **do not** open a public issue. See [SECURITY.md](SECURITY.md).

## Before you start

- For a small fix, open a pull request.
- For a new feature, or any change to the protocol or cryptography, open an issue first and
  describe the idea.
- Read [`docs/PROTOCOL.md`](docs/PROTOCOL.md) and [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)
  before touching `src/core/` or `src/net/`.

## Build and test

You need **Node 20 or newer** (tested on 20.11) and **Google Chrome** for the end-to-end tests.

```sh
npm install
npm run build          # type-check, then build dist/p2p.html (one file, about 240 KB)
npm run check:urls     # the built file may contact only the allow-listed addresses
npm test               # unit tests (Vitest)
npm run test:e2e       # two browsers talk to each other (Playwright, installed Chrome, port 4318)
npm run preview        # serves dist/ at http://127.0.0.1:4317/p2p.html
npm run dev            # development server with live reload
```

| Script | What it runs |
|---|---|
| `dev` | `vite` |
| `build` | `tsc --noEmit && vite build` |
| `preview` | `vite preview --port 4317 --strictPort` |
| `test` | `vitest run` (files in `tests/unit/`) |
| `test:e2e` | `playwright test` (files in `tests/e2e/`) |
| `check:urls` | `node scripts/check-urls.mjs` (needs a build first) |

To use Playwright's own browser instead of Chrome:
`npx playwright install chromium`, then `PW_CHANNEL=chromium npm run test:e2e`.

Test-only switches in the page address: `?ring=3000` shortens the ring time;
`?relays=ws://127.0.0.1:PORT` replaces the built-in relays. End-to-end tests run their own small
relay (`tests/e2e/mock-relay.ts`) and **must never contact the public relays**.

Before you send a pull request, all of these must pass:

```sh
npm run build && npm run check:urls && npm test && npm run test:e2e
```

## Where code goes

| Folder | What lives there |
|---|---|
| `src/core/` | Pure logic: identity, ID, emoji code, codes and cards, the lock, path, storage. No screens. Easy to unit-test. |
| `src/net/` | Connections: WebRTC (`peer.ts`), relays (`relay.ts`), one-scan connect, invites and reconnects. |
| `src/ui/` | Small screen helpers (QR). |
| `src/main.ts`, `src/style.css` | Screens. |
| `tests/unit/` | Vitest tests, one file per area. |
| `tests/e2e/` | Playwright tests with two browser profiles. |
| `docs/` | Protocol and threat model. |

## Code style

- **TypeScript, strict mode.** `npm run build` must pass with no errors (`strict`,
  `noUnusedLocals`, `noUnusedParameters`).
- Follow the style of the file you are editing: 2-space indent, single quotes, semicolons.
- Small functions with a short comment that says **why**, in plain English.
- **No new dependencies** without an issue first. Every dependency needs a permissive licence
  (MIT, Apache-2.0, BSD, ISC), an **exact** version in `package.json`, and a line in the README's
  library table.
- **No outside scripts, styles, fonts, analytics, ads or trackers.** The page is one self-contained
  file. Any new network address must be added to the content policy in `p2p.html`, to
  `scripts/check-urls.mjs`, and explained in the pull request.
- Do not log keys, phrases, codes or message text.

## Screens use plain words

P2P Talk is for everyone, not only technical people (plan §3, principle 6).

- Write what a person would say: "Connecting to Ravi…", "Ravi is offline", "This code has expired.
  Ask them to show a new one."
- **No technical terms on screens:** no WebRTC, SDP, ICE, DTLS, STUN, TURN, Nostr, NAT, HKDF,
  encryption algorithm names, and no library, vendor or tool names. Say "locked", "public relays",
  "your internet address".
- An error says what happened **and** what to do next.
- Be honest: say plainly when something is waiting, or can't connect directly.
- Brand names as they are: **P2P Talk**, **Vilnek**.

## Cryptography and protocol changes

Changes to anything in `docs/PROTOCOL.md`, or to `src/core/identity.ts`, `damm.ts`, `emoji.ts`,
`signal.ts`, `lock.ts`, `card.ts`, or the relay and connection code in `src/net/`:

1. **Need tests.** Add tests for the normal case **and** for attacks: a changed byte, a wrong key,
   a replay, an expired or reused code. Look at `tests/unit/signal.test.ts` and `lock.test.ts`.
2. **Need review.** At least one maintainer who did not write the change must review it. Larger
   changes may wait for an outside security review.
3. **Update the docs.** Update `docs/PROTOCOL.md` (and its test vectors) and, if the risks change,
   `docs/THREAT_MODEL.md`, in the same pull request.
4. **Never silently change** a derivation label (`p2ptalk-…-v1`), the P2P ID steps, the Damm table
   or the 256-emoji list. Changing any of them changes every user's ID or emoji code. The recorded
   test vector in `tests/unit/identity.test.ts` must stay the same. A real change needs a new
   version label and a migration plan, agreed in an issue first.
5. **Use audited libraries** (`@noble/curves`, `@noble/hashes`, `@scure/bip39`, WebCrypto). Do not
   write your own primitives.

## Commits and pull requests

- One topic per pull request. Explain what changed and why, and how you tested it.
- Short commit messages in the form `area: what changed` (for example `lock: reject frames shorter than 24 bytes`).
- Keep `README.md` in step with what the app does.

## Licence

P2P Talk is licensed under the [Apache License 2.0](LICENSE). By sending a contribution, you agree
that it is licensed under Apache-2.0, as section 5 of the licence describes, and that you have the
right to submit it.
