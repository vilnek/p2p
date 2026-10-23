## What this changes

<!-- In plain words: what and why. Link the issue, e.g. "Fixes #12". -->

## How I checked it

- [ ] `npm run build && npm run check:urls`
- [ ] `npm test`
- [ ] `npm run test:e2e` (or `PW_CHANNEL=chromium npm run test:e2e`)
- [ ] New or changed behaviour has a test
- [ ] Tried it by hand in two browsers (for screen changes: screenshots below)

## Safety check

- [ ] No new server, address or outside file (scripts, fonts, images): the app stays one self-contained file
- [ ] No change to the protocol or cryptography, or it was discussed in an issue first and `docs/PROTOCOL.md` is updated
- [ ] No secrets, personal data, or local paths in the code, tests or docs
- [ ] End-to-end tests still use only the local test relay

## Screenshots

<!-- For screen changes: before / after. -->

By sending this pull request, I agree that my contribution is licensed under the Apache License 2.0.
