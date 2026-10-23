import UIKit
import WebKit
import Capacitor

/// The P2P Talk screen: Capacitor's web view plus the local PrivacyShield plugin.
class MainViewController: CAPBridgeViewController {
    private let privacyShield = PrivacyShieldPlugin()

    /// Same look as LaunchScreen.storyboard (navy + the mark), kept until the web page has loaded,
    /// then faded out (~200 ms) into the web start animation, which draws the same mark.
    private var launchCover: UIView?
    private var loadingObservation: NSKeyValueObservation?
    private static let maxLaunchCoverSeconds: TimeInterval = 4
    private static let markOffsetY: CGFloat = -70 // keep equal to LaunchScreen.storyboard
    private static let navy = UIColor(red: 7 / 255, green: 11 / 255, blue: 20 / 255, alpha: 1) // #070B14

    /// iOS leaves the inside of a password field's canvas out of every screenshot, screen recording and
    /// mirror. The web view is moved into such a canvas, so P2P Talk comes out blank in all of them.
    private let secureField = UITextField()

    override func viewDidLoad() {
        super.viewDidLoad()
        makeCaptureProof()
        view.backgroundColor = Self.navy
        showLaunchCover()
    }

    private func makeCaptureProof() {
        guard let web = webView else { return }
        secureField.isSecureTextEntry = true
        let canvas = secureField.subviews.first { String(describing: type(of: $0)).contains("Canvas") }
            ?? secureField.subviews.first
        guard let secure = canvas else { return } // an iOS without the canvas: the app works, screenshots aren't blank
        secure.subviews.forEach { $0.removeFromSuperview() }
        secure.isUserInteractionEnabled = true
        let wrapper = UIView(frame: web.frame)
        wrapper.backgroundColor = Self.navy
        view = wrapper
        for (child, parent) in [(secure, wrapper), (web as UIView, secure)] {
            child.translatesAutoresizingMaskIntoConstraints = false
            parent.addSubview(child)
            NSLayoutConstraint.activate([
                child.topAnchor.constraint(equalTo: parent.topAnchor),
                child.bottomAnchor.constraint(equalTo: parent.bottomAnchor),
                child.leadingAnchor.constraint(equalTo: parent.leadingAnchor),
                child.trailingAnchor.constraint(equalTo: parent.trailingAnchor)
            ])
        }
        PrivacyShieldPlugin.screenshotsBlocked = true
    }

    private func showLaunchCover() {
        let cover = UIView(frame: view.bounds)
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.backgroundColor = Self.navy
        let mark = UIImageView(image: UIImage(named: "SplashMark"))
        mark.contentMode = .scaleAspectFit
        mark.translatesAutoresizingMaskIntoConstraints = false
        cover.addSubview(mark)
        NSLayoutConstraint.activate([
            mark.widthAnchor.constraint(equalToConstant: 320),
            mark.heightAnchor.constraint(equalToConstant: 320),
            mark.centerXAnchor.constraint(equalTo: cover.centerXAnchor),
            // 70 pt above centre: where the web start animation draws the same mark (it has the name below it).
            mark.centerYAnchor.constraint(equalTo: cover.centerYAnchor, constant: Self.markOffsetY)
        ])
        view.addSubview(cover)
        launchCover = cover

        #if DEBUG
        if UserDefaults.standard.bool(forKey: "P2PHoldLaunch") { return } // to screenshot the launch look
        #endif

        loadingObservation = webView?.observe(\.isLoading, options: [.new]) { [weak self] webView, _ in
            if !webView.isLoading { DispatchQueue.main.async { self?.hideLaunchCover() } }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.maxLaunchCoverSeconds) { [weak self] in
            self?.hideLaunchCover()
        }
    }

    private func hideLaunchCover() {
        guard let cover = launchCover else { return }
        launchCover = nil
        loadingObservation?.invalidate()
        loadingObservation = nil
        UIView.animate(withDuration: 0.2, animations: { cover.alpha = 0 }, completion: { _ in cover.removeFromSuperview() })
    }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(privacyShield)
        // Photos, videos and files sent as originals; Save to Photos / Files, Share (NativeFilesPlugin.swift).
        bridge?.registerPluginInstance(NativeFilesPlugin())
        // Share the iPhone's screen in a call (ScreenCapturePlugin.swift + the ScreenShare extension).
        bridge?.registerPluginInstance(ScreenCapturePlugin())

        if #available(iOS 17.0, *) {
            registerForTraitChanges([UITraitSceneCaptureState.self]) { (controller: MainViewController, _) in
                controller.privacyShield.sceneCaptureStateChanged()
            }
        }

        #if DEBUG
        DebugProbe.startIfAsked(webView: webView, shield: privacyShield)
        BackgroundProbe.startIfAsked(webView: webView)
        CallProbe.startIfAsked(webView: webView)
        #endif
    }
}

#if DEBUG
/// Debug builds only. Launch with `-P2PProbe YES` to check, inside the real app shell, that WebRTC,
/// the microphone and the camera load, and that the `screenshot-taken` event reaches the page.
/// Launch with `-P2PForceCover YES` to show the recording cover (to check how it looks).
/// Results are printed to the console as one line starting with "P2P_PROBE".
enum DebugProbe {
    static func startIfAsked(webView: WKWebView?, shield: PrivacyShieldPlugin) {
        let defaults = UserDefaults.standard
        if defaults.bool(forKey: "P2PForceCover") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { shield.debugForceCaptured() }
        }
        guard defaults.bool(forKey: "P2PProbe"), let webView = webView else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
            // Simulates the OS screenshot notification to check the event path end to end.
            webView.callAsyncJavaScript(probeScript, arguments: [:], in: nil, in: .page) { result in
                switch result {
                case .success(let value): print("P2P_PROBE \(value)"); NSLog("P2P_PROBE %@", "\(value)")
                case .failure(let error): print("P2P_PROBE_ERROR \(error)"); NSLog("P2P_PROBE_ERROR %@", "\(error)")
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                NotificationCenter.default.post(name: UIApplication.userDidTakeScreenshotNotification, object: nil)
            }
        }
    }

    static let probeScript = """
    const r = {};
    const timeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);
    let shot = null;
    window.addEventListener('screenshot-taken', (e) => { shot = { at: e.at || null }; });
    r.origin = location.origin;
    r.secureContext = window.isSecureContext;
    r.title = document.title;
    r.capacitor = !!window.Capacitor;
    r.nativePlatform = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    r.platform = window.Capacitor && window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : null;
    r.shieldPlugin = !!(window.Capacitor && window.Capacitor.isPluginAvailable && window.Capacitor.isPluginAvailable('PrivacyShield'));
    r.RTCPeerConnection = typeof RTCPeerConnection;
    r.getUserMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel('probe');
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((ok) => setTimeout(ok, 1500));
      r.rtcOffer = true;
      r.rtcHostCandidates = (pc.localDescription.sdp.match(/a=candidate/g) || []).length;
      pc.close();
    } catch (e) { r.rtcError = String(e); }
    try {
      const s = await timeout(navigator.mediaDevices.getUserMedia({ audio: true }), 8000);
      r.microphoneTracks = s.getAudioTracks().length; s.getTracks().forEach((t) => t.stop());
    } catch (e) { r.microphoneError = (e.name || '') + ': ' + e.message; }
    try {
      const s = await timeout(navigator.mediaDevices.getUserMedia({ video: true }), 8000);
      r.cameraTracks = s.getVideoTracks().length; s.getTracks().forEach((t) => t.stop());
    } catch (e) { r.cameraError = (e.name || '') + ': ' + e.message; }
    try { r.devices = (await navigator.mediaDevices.enumerateDevices()).map((d) => d.kind); } catch (e) { r.devicesError = String(e); }
    await new Promise((ok) => setTimeout(ok, 1500));
    r.screenshotEvent = shot;
    try { r.shieldState = await window.Capacitor.Plugins.PrivacyShield.getState(); } catch (e) { r.shieldStateError = String(e); }
    return JSON.stringify(r);
    """
}
#endif
