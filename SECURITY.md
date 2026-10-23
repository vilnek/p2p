# Security policy

P2P Talk is a peer-to-peer messenger. People trust it with private chats and calls, so we take
security reports seriously. Thank you for helping.

## Report a security bug privately

**Do not open a public issue, pull request or discussion for a security bug.**

Email: **security@vilnek.in** (to be confirmed)

Please include:

- what the problem is, and what an attacker could do with it;
- the steps, code or test to show it (a failing unit test is ideal);
- the version or commit you tested, and the browser or device;
- whether you want to be credited, and under what name.

Plain text is fine. If you need to send something sensitive, ask in your first email and we will
agree a locked way to send it.

## What happens next

| When | What we do |
|---|---|
| Within 3 working days | Confirm we received your report. |
| Within 10 working days | Tell you whether we can reproduce it, and how serious we think it is. |
| Until it is fixed | Keep you updated at least every 2 weeks. |
| When the fix ships | Credit you in the release notes (if you want), and publish an advisory. |

## Disclosure: 90 days

- We ask you to keep the bug private for **90 days** from your report, or until a fix is released,
  whichever comes first.
- If a fix is nearly ready at 90 days, we may ask for a short extension. You may say no.
- If the bug is already being used against people, we will move faster, and may publish sooner
  with you.
- We will not take legal action against anyone who reports in good faith and follows this policy:
  test only on your own devices and accounts, do not read other people's data, and do not disrupt
  others.

## Supported versions

P2P Talk is in **Phase 0** (a one-file prototype, version 0.0.x). There are no stable releases yet.

| Version | Supported |
|---|---|
| Latest commit on `main` | Yes |
| Anything older | No: please update and test again |

When signed releases start (plan Phase 5), this table will list which releases get security fixes.
Official builds will be signed with Vilnek's release key; its fingerprint will be published in this
repository and on p2p.vilnek.in.

## What counts as a security bug

Yes, please report these privately:

- reading or changing chats, calls, files or connection messages without being one of the two
  people talking;
- pretending to be someone else: a forged connect code, card, invite, contact request or acceptance
  that the app accepts; a P2P ID or emoji code that can be made to match a different key;
- a middleman on the connection that the app does not detect;
- replaying old messages, or getting a used or expired code or invite accepted;
- getting the identity key, the 24 words, or chat history out of the app without access to the
  unlocked device;
- the app contacting any address not on its allow-list (`npm run check:urls`), loading outside
  code, or leaking data to a relay, STUN server or website beyond what
  [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) says they can see;
- a crash or freeze that someone can cause from far away (for example with a crafted code, relay
  event or data channel message);
- any place where the code does not do what [`docs/PROTOCOL.md`](docs/PROTOCOL.md) says, in a way
  that weakens a check;
- weaknesses in how we use cryptography (wrong nonce handling, missing checks, weak randomness).

Not security bugs (please use a normal issue instead):

- the limits listed as out of scope or known in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md),
  such as malware on the device, photos of the screen, or Phase 0 keys being stored unsealed
  (already known; better ideas are welcome as normal issues);
- a connection that fails on a strict network;
- spelling, layout or wording problems;
- bugs in a browser or library that do not affect P2P Talk (report those upstream).

If you are not sure, report it privately. We would rather hear about it.
