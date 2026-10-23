#!/bin/sh
# Rebuilds the app icons and launch mark from ../brand using only macOS tools (sips + Swift),
# so no image library with a non-permissive licence is needed.
#   iOS:     AppIcon (icon-1024.png), SplashMark (icon-foreground-1024.png)
#   Mac:     AppIcon, 16-1024 px on the macOS icon grid (icon-1024.png in a rounded square, macos/P2PTalk)
#   Android: ic_launcher / ic_launcher_round (icon-1024.png), adaptive foreground (icon-foreground-1024.png,
#            background colour #070B14 in values/ic_launcher_background.xml), splash_mark (Android 12+ launch)
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BRAND="$ROOT/../brand"
RES="$ROOT/android/app/src/main/res"
XC="$ROOT/ios/App/App/Assets.xcassets"
for f in icon-1024.png icon-foreground-1024.png; do
  [ -f "$BRAND/$f" ] || { echo "Missing $BRAND/$f"; exit 1; }
done
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
swiftc -O -o "$TMP/round-icon" "$ROOT/scripts/tools/round-icon.swift"
swiftc -O -o "$TMP/mac-icon" "$ROOT/scripts/tools/mac-icon.swift"

for pair in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  d=${pair%%:*}; n=${pair##*:}; fg=$((n * 108 / 48))
  mkdir -p "$RES/mipmap-$d"
  sips -s format png -z "$n" "$n" "$BRAND/icon-1024.png" --out "$RES/mipmap-$d/ic_launcher.png" >/dev/null
  "$TMP/round-icon" "$BRAND/icon-1024.png" "$RES/mipmap-$d/ic_launcher_round.png" "$n"
  sips -s format png -z "$fg" "$fg" "$BRAND/icon-foreground-1024.png" --out "$RES/mipmap-$d/ic_launcher_foreground.png" >/dev/null
done
mkdir -p "$RES/drawable-nodpi"
sips -s format png -z 960 960 "$BRAND/icon-foreground-1024.png" --out "$RES/drawable-nodpi/splash_mark.png" >/dev/null

cp "$BRAND/icon-1024.png" "$XC/AppIcon.appiconset/AppIcon-512@2x.png"
mkdir -p "$XC/SplashMark.imageset"
cp "$BRAND/icon-foreground-1024.png" "$XC/SplashMark.imageset/splash-mark.png"
MAC="$ROOT/macos/P2PTalk/Assets.xcassets/AppIcon.appiconset"
mkdir -p "$MAC"
for sz in 16 32 128 256 512; do
  for sc in 1 2; do "$TMP/mac-icon" "$BRAND/icon-1024.png" "$MAC/icon-${sz}@${sc}x.png" $((sz * sc)); done
done
echo "Icons updated from $BRAND"
