import UIKit
import ReplayKit
import Capacitor

extension Notification.Name {
    /// ScreenCapturePlugin.active changed (PrivacyShieldPlugin listens).
    static let p2pScreenShareChanged = Notification.Name("P2PScreenShareChanged")
}

/// Screen sharing in the iPhone app: the same "ScreenCapture" plugin the Android app has, so the web
/// app's getDisplayMedia (p2p/src/native/androidScreen.ts) works the same on both.
///
///   start({ maxWidth, maxHeight, fps, audio }) -> { width, height, channels }
///       Opens iOS's own Start Broadcast sheet for the "P2P Talk Screen Share" extension
///       (ScreenShare/SampleHandler.swift). Resolves when the broadcast has started; rejected with
///       code "cancelled" when the person closes the sheet without starting.
///   stop()   ends the broadcast (iOS then shows its own short "stopped" note).
///   events   "frame" { data: base64 JPEG }, "audio" { data: base64 48 kHz 16-bit PCM, channels: 2 },
///            "stopped" { reason } (Stop in iOS's red status pill or Control Center, the extension ended,
///            or P2P Talk stopped it).
///
/// While sharing, the call goes on with P2P Talk in the background (UIBackgroundModes audio, Info.plist).
@objc(ScreenCapturePlugin)
public class ScreenCapturePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScreenCapturePlugin"
    public let jsName = "ScreenCapture"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    /// A share is starting or running (PrivacyShieldPlugin: no recording cover over our own share,
    /// the web view is capture-proof anyway, so the broadcast shows P2P Talk blank).
    static private(set) var active = false
    /// Debug builds: what happened while starting (CallProbe writes it to its log).
    static var debugLines: [String] = []
    private static func note(_ s: @autoclosure () -> String) {
        #if DEBUG
        let line = "\(Date().timeIntervalSince1970) \(s())"
        debugLines.append(line)
        // Also kept in Library/Caches/share.log, so a test run without the debug probe can be read back.
        let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("share.log")
        if !FileManager.default.fileExists(atPath: url.path) { try? Data().write(to: url) }
        if let h = try? FileHandle(forWritingTo: url), let d = (line + "\n").data(using: .utf8) { h.seekToEndOfFile(); h.write(d); try? h.close() }
        #endif
    }

    private enum State { case idle, starting, sharing }
    private var state = State.idle {
        didSet {
            let now = state != .idle
            if now != Self.active {
                Self.active = now
                NotificationCenter.default.post(name: .p2pScreenShareChanged, object: nil)
            }
        }
    }
    private var pending: CAPPluginCall?
    private var request = ScreenShareLink.Request(at: 0, fps: 10, maxWidth: 1280, maxHeight: 1280, audio: false)
    private let signals = DarwinSignals()
    private var picker: RPSystemBroadcastPickerView?
    private var sheetWatch: Timer?
    private var heartbeat: Timer?
    private var lastExtensionAlive: Double = 0
    private var ring: AudioRing?
    private var audioTimer: DispatchSourceTimer?
    private let readQueue = DispatchQueue(label: "p2p.screen.read", qos: .userInteractive)
    private var frameBusy = false
    private var generation = 0

    override public func load() {
        signals.on(ScreenShareLink.started) { [weak self] in self?.extensionStarted() }
        signals.on(ScreenShareLink.frame) { [weak self] in self?.frameReady() }
        signals.on(ScreenShareLink.alive) { [weak self] in self?.lastExtensionAlive = ScreenShareLink.now() }
        signals.on(ScreenShareLink.stopped) { [weak self] in self?.extensionStopped() }
        signals.on(ScreenShareLink.refused) { [weak self] in Self.note("extension refused: no request (state \(String(describing: self?.state)))") }
        // A broadcast left from before the app (re)started: end it.
        ScreenShareLink.clearRequest()
        ScreenShareLink.post(ScreenShareLink.stop)
    }

    // MARK: - Methods for the web app

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.begin(call) }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            Self.note("stop asked (state \(self.state))")
            if self.state == .starting { self.pending?.reject("Screen sharing was cancelled.", "cancelled") }
            self.pending = nil
            if self.state != .idle { ScreenShareLink.post(ScreenShareLink.stop) }
            self.finish(reason: "app", notify: false)
            call.resolve()
        }
    }

    // MARK: - Starting

    private func begin(_ call: CAPPluginCall) {
        Self.note("start asked (state \(state))")
        if state == .sharing {
            call.reject("Screen sharing is already on.", "busy")
            return
        }
        if state == .starting {
            // Share screen tapped again while iOS's sheet is opening or open: this tap takes over (the
            // earlier one is answered "busy", which never stops anything), and the sheet is opened again.
            pending?.reject("Screen sharing is already starting.", "busy")
            pending = call
            request.at = ScreenShareLink.now()
            ScreenShareLink.writeRequest(request)
            if let p = picker, let button = p.subviews.compactMap({ $0 as? UIButton }).first ?? findButton(in: p) {
                button.sendActions(for: .touchUpInside)
            }
            watchSheet(generation)
            return
        }
        guard ScreenShareLink.folder != nil, let host = bridge?.viewController?.view else {
            call.reject("This phone can't share its screen.", "unavailable")
            return
        }
        request = ScreenShareLink.Request(
            at: ScreenShareLink.now(),
            fps: clamp(call.getInt("fps") ?? 10, 1, 30),
            maxWidth: clamp(call.getInt("maxWidth") ?? 1280, 160, 1920),
            maxHeight: clamp(call.getInt("maxHeight") ?? 1280, 160, 1920),
            audio: call.getBool("audio") ?? false)
        ScreenShareLink.writeRequest(request)
        Self.note("request written: \(ScreenShareLink.readRequest() != nil) at \(ScreenShareLink.requestURL?.path ?? "nil")")
        pending = call
        state = .starting
        generation += 1

        // iOS's Start Broadcast sheet, for our extension only. The picker's own button is what opens
        // the sheet; the web app's Share screen button presses it.
        let p = picker ?? RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
        p.preferredExtension = ScreenShareLink.extensionBundleId
        p.showsMicrophoneButton = false
        p.alpha = 0.011
        p.isUserInteractionEnabled = false
        if p.superview == nil { host.addSubview(p) }
        picker = p
        guard let button = p.subviews.compactMap({ $0 as? UIButton }).first ?? findButton(in: p) else {
            failStart("This phone can't share its screen.", "unavailable")
            return
        }
        Self.note("picker pressed (in window: \(p.window != nil))")
        button.sendActions(for: .touchUpInside)
        watchSheet(generation)
    }

    private func findButton(in view: UIView) -> UIButton? {
        for v in view.subviews {
            if let b = v as? UIButton { return b }
            if let b = findButton(in: v) { return b }
        }
        return nil
    }

    /// The sheet closed without a start (the person tapped outside it or Cancel): reject as cancelled.
    /// Starting takes a 3-second countdown, so wait a little after the sheet goes.
    private func watchSheet(_ gen: Int) {
        sheetWatch?.invalidate()
        var sawSheet = false
        var lastShown = false
        var goneAt: Double = 0
        let startedAt = ScreenShareLink.now()
        sheetWatch = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] t in
            guard let self = self, self.generation == gen, self.state == .starting else { t.invalidate(); return }
            // iOS shows the sheet over the app (the app is then inactive); some versions present it in the app.
            let shown = self.bridge?.viewController?.presentedViewController != nil
                || UIApplication.shared.applicationState != .active
            if shown != lastShown { Self.note("sheet \(shown ? "shown" : "gone")"); lastShown = shown }
            let now = ScreenShareLink.now()
            if shown {
                sawSheet = true
                goneAt = 0
            } else if sawSheet && goneAt == 0 {
                goneAt = now
            }
            let gaveUp = (sawSheet && goneAt > 0 && now - goneAt > 6) || (!sawSheet && now - startedAt > 90)
            if gaveUp {
                t.invalidate()
                self.failStart("Screen sharing was cancelled.", "cancelled")
            }
        }
    }

    private func failStart(_ message: String, _ code: String) {
        Self.note("start failed: \(code)")
        pending?.reject(message, code)
        pending = nil
        ScreenShareLink.clearRequest()
        state = .idle
    }

    private func extensionStarted() {
        Self.note("extension started (state \(state))")
        guard state == .starting, let call = pending else {
            // Started from Control Center, or after the app gave up waiting: nobody asked for it.
            if state == .idle { ScreenShareLink.post(ScreenShareLink.stop) }
            return
        }
        pending = nil
        sheetWatch?.invalidate()
        state = .sharing
        lastExtensionAlive = ScreenShareLink.now()
        startHeartbeat()
        let channels = request.audio ? AudioRing.channels : 0
        if request.audio { startAudio() }
        call.resolve(["width": request.maxWidth, "height": request.maxHeight, "channels": channels])
    }

    // MARK: - While sharing

    /// Once a second: tell the extension the app is still here; notice when the extension has gone
    /// without saying so (iOS ended it, for example for memory).
    private func startHeartbeat() {
        heartbeat?.invalidate()
        ScreenShareLink.post(ScreenShareLink.appAlive)
        let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            guard let self = self, self.state == .sharing else { return }
            ScreenShareLink.post(ScreenShareLink.appAlive)
            if ScreenShareLink.now() - self.lastExtensionAlive > 6 { self.finish(reason: "gone", notify: true) }
        }
        RunLoop.main.add(t, forMode: .common)
        heartbeat = t
    }

    private func frameReady() {
        guard state == .sharing, !frameBusy, let url = ScreenShareLink.frameURL else { return }
        lastExtensionAlive = ScreenShareLink.now()
        frameBusy = true
        readQueue.async { [weak self] in
            let data = try? Data(contentsOf: url)
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.frameBusy = false
                guard self.state == .sharing, let jpeg = data, !jpeg.isEmpty else { return }
                self.notifyListeners("frame", data: ["data": jpeg.base64EncodedString()])
            }
        }
    }

    /// The phone's sound: every 40 ms, whatever arrived (the web page keeps a small buffer).
    private func startAudio() {
        guard let url = ScreenShareLink.audioURL else { return }
        ring = AudioRing(url: url, create: false)
        let t = DispatchSource.makeTimerSource(queue: readQueue)
        t.schedule(deadline: .now() + 0.04, repeating: 0.04, leeway: .milliseconds(5))
        t.setEventHandler { [weak self] in
            guard let self = self, let pcm = self.ring?.read() else { return }
            let b64 = pcm.base64EncodedString()
            DispatchQueue.main.async {
                guard self.state == .sharing else { return }
                self.notifyListeners("audio", data: ["data": b64, "channels": AudioRing.channels])
            }
        }
        t.resume()
        audioTimer = t
    }

    private func extensionStopped() {
        Self.note("extension stopped (state \(state))")
        switch state {
        case .starting: failStart("Screen sharing was cancelled.", "cancelled")
        case .sharing: finish(reason: "stopped", notify: true)
        case .idle: break
        }
    }

    private func finish(reason: String, notify: Bool) {
        let wasSharing = state == .sharing
        Self.note("finish \(reason) (state \(state))")
        sheetWatch?.invalidate()
        heartbeat?.invalidate()
        heartbeat = nil
        if let t = audioTimer {
            audioTimer = nil
            t.cancel()
            readQueue.async { [weak self] in self?.ring = nil }
        }
        ScreenShareLink.clearRequest()
        state = .idle
        if notify && wasSharing { notifyListeners("stopped", data: ["reason": reason]) }
    }

    private func clamp(_ x: Int, _ lo: Int, _ hi: Int) -> Int { min(hi, max(lo, x)) }
}
