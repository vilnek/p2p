# P2P Talk: phone apps (Android and iPhone)

The P2P Talk web app (the repository root, `..`) wrapped as native Android and iPhone apps with
[Capacitor](https://capacitorjs.com) (MIT), plus small native parts for privacy.

| | |
|---|---|
| App name | P2P Talk |
| App id (bundle id / applicationId) | `com.vilnek.p2p` |
| Capacitor | 7.6.9, pinned. It is the newest line that runs on Node 20 (Capacitor 8 needs Node 22) |
| Web app | `www/index.html`, copied from `../dist/p2p.html` (one file, works offline) |
| iPhone | iOS 15+, Swift Package Manager (no CocoaPods), scene lifecycle (required by iOS 27) |
| Android | minSdk 23, target/compile SDK 35, JDK 21 |

Nothing here is signed with a developer team, uploaded to a store or sent to TestFlight.

## Folder map
```
capacitor.config.json      app id, name, webDir=www, navy background (#070B14)
scripts/sync-web.mjs       copies ../dist/p2p.html -> www/index.html
scripts/make-icons.sh      icons + launch mark from ../brand (macOS sips + Swift only)
ios/App/App/
  PrivacyShieldPlugin.swift  recording cover, app-switcher cover, screenshot event (public APIs only)
  MainViewController.swift   registers the plugin; keeps the launch look until the page loads; debug probe
  SceneDelegate.swift        scene lifecycle; forwards opened links (invite links) to Capacitor
  Info.plist                 camera / microphone / local network reasons, light status bar
  Base.lproj/LaunchScreen.storyboard   navy + mark
android/app/src/main/
  java/com/vilnek/p2p/MainActivity.java   FLAG_SECURE, launch screen until page loaded, media autoplay
  AndroidManifest.xml        permissions; no cloud backup of keys or chats
  res/values/styles.xml      navy launch screen (Android 12+ splash API), navy bars with light icons
docs/                       simulator screenshots
```

## 1. Bring in the web app
```sh
(cd .. && npm run build)   # makes ../dist/p2p.html
npm install                    # first time only
npm run sync                   # = npm run sync-web (copy into www/) + npx cap sync (copy into ios/ and android/)
```
Run `npm run sync` after every web build; the phone apps only see what was synced.

## 2. iPhone: build and run in the iOS Simulator (no signing)
```sh
npm run ios:build-sim
# = npm run sync && xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
#     -sdk iphonesimulator -derivedDataPath ios/build CODE_SIGNING_ALLOWED=NO build

D="iPhone 18 Pro"                                   # any simulator from: xcrun simctl list devices
xcrun simctl boot "$D"; xcrun simctl bootstatus "$D" -b
xcrun simctl install "$D" ios/build/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch "$D" com.vilnek.p2p
xcrun simctl io "$D" screenshot docs/ios-simulator-first-screen.png
```
Or open `ios/App/App.xcodeproj` in Xcode and press Run with a simulator selected.
A real iPhone needs a signing team; that step is done by the Vilnek team.

**Self-check inside the app shell (debug builds only).** These launch arguments print one line
starting with `P2P_PROBE` with the results:
```sh
xcrun simctl privacy "$D" grant microphone com.vilnek.p2p
xcrun simctl privacy "$D" grant camera com.vilnek.p2p
xcrun simctl launch --console-pty --terminate-running-process "$D" com.vilnek.p2p -P2PProbe YES
```
It checks WebRTC (offer + local candidates), microphone, camera and the `screenshot-taken` event. The event check
posts the system screenshot notification itself.
`-P2PForceCover YES` shows the recording cover, and `-P2PHoldLaunch YES` keeps the launch look on screen
(both are for taking screenshots).

## 3. Android: build the debug APK
Needs, once per Mac (already set up on the Vilnek build Mac):
1. **A JDK 21**, for example Temurin: `brew install --cask temurin@21`, or the one at
   `~/Library/Java/JavaVirtualMachines/jdk-21.0.13+9/Contents/Home`.
2. **The Android SDK licences accepted**:
   `~/Library/Android/sdk/cmdline-tools/latest/bin/sdkmanager --licenses`
3. The Android SDK at `~/Library/Android/sdk` (Platform 35 and Build-Tools; Gradle downloads what is missing).

```sh
export JAVA_HOME=~/Library/Java/JavaVirtualMachines/jdk-21.0.13+9/Contents/Home
export ANDROID_HOME=~/Library/Android/sdk
npm run sync
cd android && ./gradlew assembleDebug
# -> android/app/build/outputs/apk/debug/app-debug.apk
```
To try it in the emulator, an emulator system image is needed first (a large download, so ask before getting one), e.g.
`sdkmanager "system-images;android-35;google_apis;arm64-v8a"`, then make a device with `avdmanager`.
A release APK or Play bundle needs Vilnek's signing key; that is a later step.

## 4. Privacy: what the native parts do
### Android: full block
`FLAG_SECURE` is set on the main window before the first frame. Screenshots, screen recordings and casting
come out **black**, and the recent-apps preview is blank. The web app needs to do nothing.
(Phase 3: a Settings switch to turn it off through a small plugin. It stays on by default.)

### iPhone: hidden while recording, screenshots detected (not blank yet)
| Situation | What happens |
|---|---|
| Screen being recorded, mirrored (AirPlay / cable) or captured | A plain navy cover ("Hidden while the screen is recorded or shared") hides the app until it stops |
| App switcher | A plain cover with "P2P Talk" is shown as soon as the app stops being active |
| Screenshot | **Not blocked yet.** The screenshot is taken as normal and the web app gets a `screenshot-taken` event, so it can tell the other person ("Ravi took a screenshot") |

Apple gives no official way to block screenshots. Making screenshots come out blank (the protected-content layer
technique in plan §8.9) is a **later task**; it is not built here. Only public APIs are used
(`UIScreen.capturedDidChangeNotification` / `isCaptured`, the iOS 17 `sceneCaptureState` trait,
`userDidTakeScreenshotNotification`).

**For the web app (iPhone shell):**
```js
window.addEventListener('screenshot-taken', (e) => { /* e.at = time in ms */ });
window.addEventListener('screen-capture-changed', (e) => { /* e.captured = true / false */ });
// or, through the Capacitor bridge:
const shield = window.Capacitor?.Plugins?.PrivacyShield;
await shield?.getState();   // { captured, coverWhenCaptured, coverInSwitcher, screenshotsBlocked: false, screenshotsDetected: true }
await shield?.setOptions({ coverWhenCaptured: true, coverInSwitcher: true });   // Settings › Privacy
shield?.addListener('screenshot-taken', (d) => {});
```
Check `window.Capacitor?.isNativePlatform?.()` before using any of this; the same web file also runs as a plain web page.

### Every platform
No app can stop a second camera pointed at the screen.

## 5. Camera, microphone and WebRTC inside the shells
- **iPhone:** the page runs at `capacitor://localhost` (a secure context). Capacitor grants the page's camera and
  microphone requests once iOS has asked the user (reasons in `Info.plist`), and allows inline media and
  autoplay. Checked in the iOS 27 simulator: `RTCPeerConnection` makes an offer with local candidates,
  the microphone and camera each give a track, and the `screenshot-taken` event arrives.
- **Android:** Capacitor's `BridgeWebChromeClient.onPermissionRequest` asks for CAMERA / RECORD_AUDIO when the page
  calls `getUserMedia`, then grants the page. `MainActivity` also sets media playback without a user gesture.
  Manifest: CAMERA, RECORD_AUDIO, MODIFY_AUDIO_SETTINGS, INTERNET, ACCESS_NETWORK_STATE, POST_NOTIFICATIONS.
  Foreground service (always-on receiving, calls, screen share) and Bluetooth / nearby are TODO comments in the
  manifest for later phases.

## 6. Launch screen and icons
- Launch: navy `#070B14` with the P2P Talk mark (from `../brand/icon-foreground-1024.png`). It stays until the web
  page has loaded (at most 4 s) and then fades out in 200 ms into the web start animation, which draws the same mark in
  the same place. On iPhone the mark sits 70 pt above centre to line up with the web animation. Android 12+ always
  centres it (the system draws it).
- Status and navigation bars: navy with light icons.
- Icons: `npm run icons` rebuilds them from `../brand` (iOS AppIcon; Android legacy, round and adaptive
  icons with the navy background). It uses only macOS `sips` and Swift. `@capacitor/assets` was not used because it
  depends on `sharp`/libvips (LGPL).

## Licences
Shipped in the apps: Capacitor core / iOS / Android (MIT), AndroidX (Apache-2.0), the web app (Apache-2.0).
The build-time tools under `node_modules` (Capacitor CLI and its helpers) are MIT / ISC / BlueOak-1.0.0 / Unlicense / 0BSD.
All are permissive and none ship in the app.

## In this repository
This folder is `native/` inside the P2P Talk repository. The web app is the repository root (`..`), the
hosting files are in `../site/` and the icon sources in `../brand/`. So from this folder:
```sh
(cd .. && npm ci && npm run build)   # makes ../dist/p2p.html
npm ci
npm run sync                          # copies it into www/, then into ios/ and android/
```
Not in the repository (made on your machine, or kept privately by Vilnek): `node_modules/`, `www/`, the copies
inside `ios/App/App/public/` and `android/app/src/main/assets/public/`, build folders, the release signing key
and its password, and the store listing files.

### Mac app
`macos/` is P2P Talk for Mac (AppKit and the Mac's own web view; same bundle ID `com.vilnek.p2p`).
Run `npm run sync-web` first (it makes `www/index.html`, which the Mac project bundles), then
`xcodebuild -project macos/P2PTalk.xcodeproj -scheme P2PTalk -configuration Release build`.
To sign it yourself, set your own team in Xcode. `scripts/make-mac-project.rb` re-makes the project file.
