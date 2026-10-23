import AppKit
import WebKit
import UniformTypeIdentifiers
#if DEBUG
import AVFoundation
#endif

/// The P2P Talk window: the Mac's web view showing the bundled P2P Talk web app.
///
///  - The page comes from the app itself (p2ptalk://app/, AppScheme below), never from the internet, and
///    is a secure page, so the web app's storage, encryption, calls and files all work as in Safari.
///  - Camera and microphone: macOS asks the person the first time; P2P Talk doesn't ask again on top.
///  - Screen sharing in a call: the web view's own screen sharing (macOS shows its picker).
///  - Files: picking opens the Mac's Open panel; saving goes to the Downloads folder (like Safari).
///  - Links to websites open in the person's browser; email links in their email app.
///  - Screenshots and screen recordings show the P2P Talk window blank (like the iPhone app).
final class MainWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    static let scheme = "p2ptalk"
    static let home = URL(string: "p2ptalk://app/")!
    private static let navy = NSColor(srgbRed: 7 / 255, green: 11 / 255, blue: 20 / 255, alpha: 1) // #070B14
    private static let zoomKey = "P2PPageZoom"

    let window: NSWindow
    let webView: WKWebView
    private var downloads: [WKDownload: URL] = [:]

    override init() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AppScheme(), forURLScheme: Self.scheme)
        config.websiteDataStore = .default()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        // Says "Safari on a Mac" to the page, plus the app's own name and version.
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        config.applicationNameForUserAgent = "Version/18.0 Safari/605.1.15 P2PTalkMac/\(version)"
        // Tells the web app it runs inside the P2P Talk app (no "get the app" stickers or video on the
        // start screen), like the iPhone and Android apps. The app has no native file or screen plugins:
        // the page uses the Mac web view's own files, downloads and screen sharing.
        config.userContentController.addUserScript(WKUserScript(source: """
            if (!window.Capacitor) {
              window.Capacitor = Object.freeze({
                isNativePlatform: () => true,
                getPlatform: () => 'mac',
                isPluginAvailable: () => false,
                Plugins: Object.freeze({})
              });
            }
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // The Mac web view (WebKit 26 / 27) writes the whole buffer behind a typed-array view into a
        // private-area file, not just the view: a received piece (a view after its 32-byte check) came
        // out 32 bytes too long. Hand such writes an exact copy. (Safari has the same issue.)
        config.userContentController.addUserScript(WKUserScript(source: """
            (() => {
              const W = window.FileSystemWritableFileStream;
              if (!W || !W.prototype.write) return;
              const exact = (d) => ArrayBuffer.isView(d) && (d.byteOffset !== 0 || d.byteLength !== d.buffer.byteLength)
                ? new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)) : d;
              const write = W.prototype.write;
              W.prototype.write = function (x) {
                if (x && typeof x === 'object' && !ArrayBuffer.isView(x) && !(x instanceof ArrayBuffer) && !(x instanceof Blob) && 'data' in x) {
                  x = Object.assign({}, x, { data: exact(x.data) });
                } else {
                  x = exact(x);
                }
                return write.call(this, x);
              };
            })();
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 820), configuration: config)
        webView.underPageBackgroundColor = Self.navy
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = false
        #if DEBUG
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        #endif
        let saved = UserDefaults.standard.double(forKey: Self.zoomKey)
        if saved > 0 { webView.pageZoom = saved }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        super.init()

        window.title = "P2P Talk"
        window.minSize = NSSize(width: 900, height: 600)
        window.backgroundColor = Self.navy
        window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: .darkAqua)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.contentView = webView
        window.delegate = self
        // Screenshots and screen recordings leave this window out (macOS's own setting for a window).
        window.sharingType = .none
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "P2PAllowCapture") { window.sharingType = .readOnly } // tests only
        #endif
        if !window.setFrameUsingName("P2PTalkMain") { window.center() }
        window.setFrameAutosaveName("P2PTalkMain")

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.alphaValue = 0 // no white flash before the first paint (shown in didFinish)
        webView.load(URLRequest(url: Self.home))
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        #if DEBUG
        DebugConsole.startIfAsked(webView)
        #endif
    }

    // MARK: - View menu: page zoom (saved for next time)

    @objc func actualSize(_ sender: Any?) { setZoom(1) }
    @objc func zoomIn(_ sender: Any?) { setZoom(min(2, webView.pageZoom + 0.1)) }
    @objc func zoomOut(_ sender: Any?) { setZoom(max(0.6, webView.pageZoom - 0.1)) }

    private func setZoom(_ z: CGFloat) {
        webView.pageZoom = (z * 10).rounded() / 10
        UserDefaults.standard.set(Double(webView.pageZoom), forKey: Self.zoomKey)
    }

    // MARK: - Loading and links

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView.alphaValue < 1 {
            NSAnimationContext.runAnimationGroup { $0.duration = 0.15; webView.animator().alphaValue = 1 }
        }
    }

    /// The web content stopped (for example memory): load the app again rather than show a blank window.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.load(URLRequest(url: Self.home))
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { return decisionHandler(.download) }
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { return decisionHandler(.cancel) }
        switch scheme {
        case Self.scheme, "blob", "data", "about":
            decisionHandler(.allow)
        case "http", "https", "mailto", "tel", "sms", "facetime":
            // Only when the person clicked a link: open it outside, never inside the app window.
            if action.navigationType == .linkActivated || action.targetFrame == nil || action.targetFrame?.isMainFrame == true {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel)
        default:
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    /// target="_blank" links: open in the browser (http/https) or the matching app.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    // MARK: - Camera, microphone and screen

    /// The page asks for the camera or microphone (calls, scanning codes). macOS itself asks the person
    /// the first time ("P2P Talk would like to access the camera"); the web view doesn't ask again.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        #if DEBUG
        print("P2P_MEDIA asked type=\(type.rawValue) origin=\(origin.protocol)://\(origin.host) main=\(frame.isMainFrame)"); fflush(stdout)
        #endif
        decisionHandler(origin.protocol == Self.scheme && frame.isMainFrame ? .grant : .deny)
    }

    // MARK: - Files: the Open panel

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.prompt = "Choose"
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }

    // MARK: - Files: saving (to Downloads, like Safari)

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        guard let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first else {
            return completionHandler(nil)
        }
        let url = Self.freeName(in: folder, for: Self.safeName(suggestedFilename))
        downloads[download] = url
        completionHandler(url)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = downloads.removeValue(forKey: download) else { return }
        // The Downloads stack in the Dock bounces, as it does for Safari downloads.
        DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: url.path)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let url = downloads.removeValue(forKey: download) { try? FileManager.default.removeItem(at: url) }
    }

    /// No folders, no hidden files, nothing that could escape the Downloads folder.
    static func safeName(_ name: String) -> String {
        let cleaned = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: CharacterSet(charactersIn: ". ").union(.whitespacesAndNewlines))
        return cleaned.isEmpty ? "P2P Talk file" : String(cleaned.prefix(200))
    }

    /// "photo.jpg", then "photo 2.jpg", "photo 3.jpg"… (never overwrites a file that is already there).
    static func freeName(in folder: URL, for name: String) -> URL {
        let first = folder.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: first.path) else { return first }
        let ext = (name as NSString).pathExtension
        let base = (name as NSString).deletingPathExtension
        for n in 2... {
            let candidate = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
            if !FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        }
        return first
    }

    // MARK: - The page's alert / confirm / prompt boxes

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = Self.alert(message)
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = Self.alert(message)
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = Self.alert(prompt)
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    private static func alert(_ text: String) -> NSAlert {
        let alert = NSAlert()
        alert.messageText = "P2P Talk"
        alert.informativeText = text
        return alert
    }

    // MARK: - Window

    /// The red close button hides the window; P2P Talk keeps running for chats and calls (Dock icon brings it back).
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }
}

/// Serves the bundled web app (Resources/index.html) at p2ptalk://app/. It is one self-contained file.
final class AppScheme: NSObject, WKURLSchemeHandler {
    private lazy var page: Data? = Bundle.main.url(forResource: "index", withExtension: "html").flatMap { try? Data(contentsOf: $0) }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let path = url.path
        let body: Data
        let type: String
        if path.isEmpty || path == "/" || path == "/index.html", let page = page {
            body = page
            type = "text/html; charset=utf-8"
        } else if path == "/favicon.ico" || path.hasPrefix("/cordova") {
            body = Data()
            type = "text/plain"
        } else {
            let response = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "text/plain", "Content-Length": "0"])!
            task.didReceive(response)
            task.didReceive(Data())
            task.didFinish()
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": type,
            "Content-Length": String(body.count),
            "Cache-Control": "no-store"
        ])!
        task.didReceive(response)
        task.didReceive(body)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

#if DEBUG
/// Debug builds only, for tests from a terminal: launch the app's binary with `-P2PConsole YES`; every
/// line typed on standard input runs in the page (top-level await allowed) and the result is printed
/// as one line starting with "P2P_JS".
enum DebugConsole {
    static func startIfAsked(_ webView: WKWebView) {
        guard UserDefaults.standard.bool(forKey: "P2PConsole") else { return }
        let names: [AVAuthorizationStatus: String] = [.notDetermined: "not asked", .restricted: "restricted", .denied: "denied", .authorized: "allowed"]
        print("P2P_TCC camera=\(names[AVCaptureDevice.authorizationStatus(for: .video)] ?? "?") microphone=\(names[AVCaptureDevice.authorizationStatus(for: .audio)] ?? "?")")
        fflush(stdout)
        Thread.detachNewThread {
            while let line = readLine() {
                DispatchQueue.main.async {
                    webView.callAsyncJavaScript(line, arguments: [:], in: nil, in: .page) { result in
                        let text: String
                        switch result {
                        case .success(let v): text = "\(v)"
                        case .failure(let e): text = "ERROR \(e)"
                        }
                        print("P2P_JS " + text.replacingOccurrences(of: "\n", with: " "))
                        fflush(stdout)
                    }
                }
            }
        }
    }
}
#endif
