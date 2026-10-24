# p2p.vilnek.in: hosting files for P2P Talk

**Project Director and Writer:** [Dr Vijaykumar](https://vijaykumar.vilnek.in)

Static hosting only: no server code, no database, no logs of ours. Cloudflare Pages (free), project `p2p-talk`, custom domain `p2p.vilnek.in`.

| File | What |
|---|---|
| `build.sh` | Builds the web app (`..`, the repository root) and puts `index.html` + icons + headers into `out/` (no deploy) |
| `deploy.sh` | Uploads `out/` to Cloudflare Pages. **Only after Dr Vijay's yes** |
| `static/_headers` | Security headers: HTTPS only, no framing, camera/mic/screen only for this site |
| `static/manifest.webmanifest` | Makes it installable (home-screen icon). The page still needs `<link rel="manifest">` and an offline helper; that's added in the app code (Phase 1) |
| `static/.well-known/*` | Lets links open the installed apps (filled in Phase 3/4, when the apps are signed) |

Steps for the first deploy:
1. `./build.sh`
2. `npx wrangler@3 login` (once)
3. `./deploy.sh`
4. In Cloudflare: Pages › p2p-talk › Custom domains › add `p2p.vilnek.in`

The fingerprint of `index.html` is written to `out/index.html.sha256`, so anyone can check they got the official file.
