#!/usr/bin/env bash
# Builds the files for p2p.vilnek.in into ./out (does NOT deploy).
set -euo pipefail
cd "$(dirname "$0")"
( cd .. && npm run build && npm run check:urls )
rm -rf out && mkdir -p out/icons
cp -R static/. out/
rm -rf out/.well-known  # app-link files go live in Phase 3/4, when the apps are release-signed
node make-index.mjs
cp ../brand/icon-192.png ../brand/icon-512.png ../brand/icon-maskable-512.png ../brand/apple-touch-icon-180.png out/icons/
cp ../brand/favicon-32.png out/favicon.png
shasum -a 256 out/index.html | tee out/index.html.sha256
echo "Built into $(pwd)/out — not deployed."
