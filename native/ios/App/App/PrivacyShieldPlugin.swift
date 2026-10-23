import UIKit
import Capacitor

/// Privacy shield for the P2P Talk iPhone app (plan §8.9). Public iOS APIs only.
///
/// (a) While the screen is being recorded, mirrored (AirPlay / cable) or captured, the app's content is
///     hidden behind a plain cover (`UIScreen.capturedDidChangeNotification` + `isCaptured`, and the
///     iOS 17+ `sceneCaptureState` trait).
/// (b) When the app leaves the foreground, the content is covered so the app switcher shows the cover.
/// (c) When the user takes a screenshot, the web app gets a `screenshot-taken` event.
///
/// Events for the web app, two ways (use either):
///   window.addEventListener('screenshot-taken', e => ...)          // e.at = time in ms
///   window.addEventListener('screen-capture-changed', e => ...)    // e.captured = true/false
///   Capacitor.Plugins.PrivacyShield.addListener('screenshot-taken', d => ...)
///   Capacitor.Plugins.PrivacyShield.addListener('screen-capture-changed', d => ...)
/// Methods: getState(), setOptions({ coverWhenCaptured, coverInSwitcher })
///
/// (d) Screenshots and recordings come out blank: MainViewController puts the web view inside a
///     password field's canvas, which iOS leaves out of every capture (`screenshotsBlocked`).
@objc(PrivacyShieldPlugin)
public class PrivacyShieldPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PrivacyShieldPlugin"
    public let jsName = "PrivacyShield"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setOptions", returnType: CAPPluginReturnPromise)
    ]

    /// Set by MainViewController when the web view sits in the capture-proof canvas.
    static var screenshotsBlocked = false

    /// Settings › Privacy (both on by default in the phone apps).
    private var coverWhenCaptured = true
    private var coverInSwitcher = true

    private var inBackground = false
    private var captured = false
    private var coverView: UIView?
    private var coverLabel: UILabel?

    override public func load() {
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(captureChanged),
                           name: UIScreen.capturedDidChangeNotification, object: nil)
        center.addObserver(self, selector: #selector(screenshotTaken),
                           name: UIApplication.userDidTakeScreenshotNotification, object: nil)
        center.addObserver(self, selector: #selector(willResignActive),
                           name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(didBecomeActive),
                           name: UIApplication.didBecomeActiveNotification, object: nil)
        // Scene-based app (iOS 13+): the scene notifications are the precise ones for the app switcher.
        center.addObserver(self, selector: #selector(willResignActive),
                           name: UIScene.willDeactivateNotification, object: nil)
        center.addObserver(self, selector: #selector(didBecomeActive),
                           name: UIScene.didActivateNotification, object: nil)
        // Our own screen share (ScreenCapturePlugin): no recording cover, see updateCover().
        center.addObserver(self, selector: #selector(captureChanged),
                           name: .p2pScreenShareChanged, object: nil)
        DispatchQueue.main.async { self.captureChanged() }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - Methods for the web app

    @objc func getState(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve([
                "captured": self.currentlyCaptured(),
                "coverWhenCaptured": self.coverWhenCaptured,
                "coverInSwitcher": self.coverInSwitcher,
                "screenshotsBlocked": PrivacyShieldPlugin.screenshotsBlocked,
                "screenshotsDetected": true
            ])
        }
    }

    @objc func setOptions(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let value = call.getBool("coverWhenCaptured") { self.coverWhenCaptured = value }
            if let value = call.getBool("coverInSwitcher") { self.coverInSwitcher = value }
            self.updateCover()
            call.resolve()
        }
    }

    // MARK: - (a) Recording and mirroring

    /// Called by MainViewController when the iOS 17+ `sceneCaptureState` trait changes.
    func sceneCaptureStateChanged() {
        captureChanged()
    }

    @objc private func captureChanged() {
        DispatchQueue.main.async {
            let now = self.currentlyCaptured()
            let changed = now != self.captured
            self.captured = now
            self.updateCover()
            if changed {
                let data: [String: Any] = ["captured": now]
                self.notifyListeners("screen-capture-changed", data: data)
                self.bridge?.triggerWindowJSEvent(eventName: "screen-capture-changed",
                                                  data: "{ \"captured\": \(now) }")
            }
        }
    }

    private func currentlyCaptured() -> Bool {
        let window = hostWindow()
        if #available(iOS 17.0, *), let traits = window?.traitCollection, traits.sceneCaptureState == .active {
            return true
        }
        let screen = window?.windowScene?.screen ?? UIScreen.main
        return screen.isCaptured
    }

    // MARK: - (b) App switcher

    @objc private func willResignActive() {
        DispatchQueue.main.async {
            self.inBackground = true
            self.updateCover()
        }
    }

    @objc private func didBecomeActive() {
        DispatchQueue.main.async {
            self.inBackground = false
            self.captured = self.currentlyCaptured()
            self.updateCover()
        }
    }

    // MARK: - (c) Screenshots

    @objc private func screenshotTaken() {
        let at = Int(Date().timeIntervalSince1970 * 1000)
        DispatchQueue.main.async {
            self.notifyListeners("screenshot-taken", data: ["at": at])
            self.bridge?.triggerWindowJSEvent(eventName: "screenshot-taken", data: "{ \"at\": \(at) }")
        }
    }

    // MARK: - The cover

    private func hostWindow() -> UIWindow? {
        return bridge?.viewController?.view.window
    }

    /// Debug only: show the cover as if the screen were being recorded (to check how it looks).
    func debugForceCaptured() {
        captured = true
        updateCover()
    }

    private func updateCover() {
        // While the person shares their own screen from a call, iOS reports the screen as captured. The
        // web view sits in the capture-proof canvas, so the share already shows P2P Talk blank; covering
        // the app as well would hide the call (and its Stop button) from the person sharing.
        let ownShare = ScreenCapturePlugin.active && PrivacyShieldPlugin.screenshotsBlocked
        let hideForCapture = coverWhenCaptured && captured && !ownShare
        let hideForSwitcher = coverInSwitcher && inBackground
        if hideForCapture || hideForSwitcher {
            showCover(text: hideForCapture ? "Hidden while the screen is recorded or shared" : "P2P Talk")
        } else {
            hideCover()
        }
    }

    private func showCover(text: String) {
        guard let window = hostWindow() else { return }
        let cover: UIView
        if let existing = coverView {
            cover = existing
        } else {
            cover = UIView(frame: window.bounds)
            cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            // Same navy as the web app's theme colour (#0A0E1A).
            cover.backgroundColor = UIColor(red: 10 / 255, green: 14 / 255, blue: 26 / 255, alpha: 1)
            cover.isAccessibilityElement = true
            let label = UILabel()
            label.translatesAutoresizingMaskIntoConstraints = false
            label.textColor = UIColor(white: 1, alpha: 0.75)
            label.font = UIFont.preferredFont(forTextStyle: .headline)
            label.adjustsFontForContentSizeCategory = true
            label.numberOfLines = 0
            label.textAlignment = .center
            cover.addSubview(label)
            NSLayoutConstraint.activate([
                label.centerXAnchor.constraint(equalTo: cover.centerXAnchor),
                label.centerYAnchor.constraint(equalTo: cover.centerYAnchor),
                label.leadingAnchor.constraint(greaterThanOrEqualTo: cover.leadingAnchor, constant: 32),
                label.trailingAnchor.constraint(lessThanOrEqualTo: cover.trailingAnchor, constant: -32)
            ])
            coverView = cover
            coverLabel = label
        }
        coverLabel?.text = text
        cover.accessibilityLabel = text
        if cover.superview !== window {
            cover.frame = window.bounds
            window.addSubview(cover)
        }
        window.bringSubviewToFront(cover)
    }

    private func hideCover() {
        coverView?.removeFromSuperview()
    }
}
