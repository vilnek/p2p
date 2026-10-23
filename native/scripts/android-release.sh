#!/usr/bin/env bash
# Builds the signed release APK of P2P Talk for public download (GitHub Releases).
# The release key stays outside the repository (~/.vilnek/keys/p2ptalk-release.jks); its password is
# read from the macOS Keychain ("P2P Talk Android release key") only for this build and never printed
# or written to disk. Backup and restore are handled privately by Vilnek.
# Version rule: name YY.MM.N (year, month, release in that month); code YY*10000 + MM*100 + N.
#   scripts/android-release.sh 26.10.1 261001      -> P2P-Talk-26.10.1.apk
#   scripts/android-release.sh 26.10.1 261001 aab  -> P2P-Talk-26.10.1.aab (the Play Store bundle, same key)
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:?version name, e.g. 1.0.0}"; CODE="${2:?version code, e.g. 1}"; KIND="${3:-apk}"
export JAVA_HOME="${JAVA_HOME:-$HOME/Library/Java/JavaVirtualMachines/jdk-21.0.13+9/Contents/Home}"
export P2P_KEYSTORE_PATH="$HOME/.vilnek/keys/p2ptalk-release.jks"
[ -f "$P2P_KEYSTORE_PATH" ] || { echo "release key not found: $P2P_KEYSTORE_PATH" >&2; exit 1; }
P2P_KEYSTORE_PASSWORD="$(security find-generic-password -s 'P2P Talk Android release key' -a 'p2ptalk-release' -w)" \
  || { echo "release key password not in the Keychain" >&2; exit 1; }
export P2P_KEYSTORE_PASSWORD
npm run sync
if [ "$KIND" = "aab" ]; then
  ( cd android && ./gradlew -q bundleRelease -PversionName="$VERSION" -PversionCode="$CODE" )
  mkdir -p release && cp android/app/build/outputs/bundle/release/app-release.aab "release/P2P-Talk-$VERSION.aab"
  keytool -printcert -jarfile "release/P2P-Talk-$VERSION.aab" | grep -E "SHA256:" | head -1
  shasum -a 256 "release/P2P-Talk-$VERSION.aab" | tee "release/P2P-Talk-$VERSION.aab.sha256"
  echo "Built release/P2P-Talk-$VERSION.aab for Google Play (not uploaded)."
  exit 0
fi
( cd android && ./gradlew -q assembleRelease -PversionName="$VERSION" -PversionCode="$CODE" )
OUT="android/app/build/outputs/apk/release/app-release.apk"
mkdir -p release && cp "$OUT" "release/P2P-Talk-$VERSION.apk"
"$(ls -d "$HOME"/Library/Android/sdk/build-tools/* | sort -V | tail -1)/apksigner" verify --print-certs "release/P2P-Talk-$VERSION.apk" | grep -E "SHA-256 digest" | head -1
shasum -a 256 "release/P2P-Talk-$VERSION.apk" | tee "release/P2P-Talk-$VERSION.apk.sha256"
echo "Built release/P2P-Talk-$VERSION.apk (not published)."
