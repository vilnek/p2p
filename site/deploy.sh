#!/usr/bin/env bash
# Deploys ./out to Cloudflare (Workers static assets) at https://p2p.vilnek.in.
# Run ONLY with Dr Vijay's yes. First time on a Mac: npx wrangler login
set -euo pipefail
cd "$(dirname "$0")"
[ -f out/index.html ] || { echo "Run ./build.sh first"; exit 1; }
npx --yes wrangler@3 deploy   # wrangler 4 needs Node 22; this Mac has Node 20
