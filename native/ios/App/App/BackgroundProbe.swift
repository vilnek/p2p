#if DEBUG
import UIKit
import WebKit
import AVFoundation

/// Debug builds only. Launch with `-P2PBgProbe YES` to check what keeps running while P2P Talk is in the
/// background during a call: a loop-back call on the phone (microphone + a very quiet tone + a picture
/// drawn on a canvas), the page's own timers, and pictures pushed from the app into the page (the way
/// screen sharing hands pictures over). Every 2 seconds one line goes to Library/Caches/bgprobe.log.
enum BackgroundProbe {
    private static var timers: [Timer] = []

    static func startIfAsked(webView: WKWebView?) {
        guard UserDefaults.standard.bool(forKey: "P2PBgProbe"), let webView = webView else { return }
        let log = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("bgprobe.log")
        try? "".write(to: log, atomically: true, encoding: .utf8)
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
            webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
                append(log, "setup \(result)")
            }
            let push = Timer(timeInterval: 0.1, repeats: true) { _ in
                webView.evaluateJavaScript("window.__bgPush && window.__bgPush()", completionHandler: nil)
            }
            let sample = Timer(timeInterval: 2, repeats: true) { _ in
                let state = UIApplication.shared.applicationState == .background ? "background"
                    : UIApplication.shared.applicationState == .inactive ? "inactive" : "active"
                webView.evaluateJavaScript("JSON.stringify(window.__bgStat || null)") { value, error in
                    append(log, "\(Date().timeIntervalSince1970) app=\(state) \(value ?? "nil") \(error.map { "\($0)" } ?? "")")
                }
            }
            for t in [push, sample] { RunLoop.main.add(t, forMode: .common); timers.append(t) }
        }
    }

    private static func append(_ url: URL, _ line: String) {
        guard let data = (line + "\n").data(using: .utf8) else { return }
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile()
            h.write(data)
            try? h.close()
        }
    }

    static let script = """
    const s = { ticks: 0, pushes: 0, resumes: 0, resumeOk: 0 };
    window.__bgStat = s;
    setInterval(() => { s.ticks++; }, 250);
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Like peer.ts mixDeviceSound + androidScreen soundTrack: microphone + "device sound" mixed in WebAudio, sent.
    const ac = new AudioContext();
    ac.onstatechange = () => { s.acChanges = (s.acChanges || '') + ac.state[0]; if (ac.state !== 'running' && ac.state !== 'closed') { s.resumes++; ac.resume().then(() => s.resumeOk++).catch((e) => s.resumeErr = String(e)); } };
    const osc = ac.createOscillator(); const g = ac.createGain(); g.gain.value = 0.05;
    const dest = ac.createMediaStreamDestination(); osc.connect(g); g.connect(dest); osc.start();
    ac.createMediaStreamSource(mic).connect(dest);
    // Like androidScreen soundTrack: a context with no microphone in it (a ScriptProcessor making sound -> a track).
    const ac2 = new AudioContext({ sampleRate: 48000 });
    ac2.onstatechange = () => { s.ac2Changes = (s.ac2Changes || '') + ac2.state[0]; if (ac2.state !== 'running' && ac2.state !== 'closed') ac2.resume().then(() => s.ac2ResumeOk = (s.ac2ResumeOk || 0) + 1).catch((e) => s.ac2Err = String(e)); };
    const sp = ac2.createScriptProcessor(1024, 1, 2); let ph = 0; s.spCalls = 0;
    sp.onaudioprocess = (e) => { s.spCalls++; const L = e.outputBuffer.getChannelData(0); for (let i = 0; i < L.length; i++) { L[i] = Math.sin(ph) * 0.1; ph += 0.05; } };
    const dest2 = ac2.createMediaStreamDestination(); sp.connect(dest2);
    await ac2.resume().catch(() => {});
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d');
    const vtrack = canvas.captureStream(10).getVideoTracks()[0];
    window.__bgPush = () => { s.pushes++; ctx.fillStyle = `hsl(${(s.pushes * 7) % 360},80%,50%)`; ctx.fillRect(0, 0, 320, 240); };
    const pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    const remote = new MediaStream();
    const player = document.createElement('audio'); player.autoplay = true; player.volume = 0.05; document.body.append(player);
    pc2.ontrack = (e) => { remote.addTrack(e.track); player.srcObject = remote; player.play().catch((x) => s.playErr = String(x)); };
    pc1.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
    pc1.addTrack(vtrack);
    const gathered = (pc) => new Promise((ok) => { if (pc.iceGatheringState === 'complete') ok(); pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && ok(); setTimeout(ok, 3000); });
    await pc1.setLocalDescription(await pc1.createOffer()); await gathered(pc1);
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription(await pc2.createAnswer()); await gathered(pc2);
    await pc1.setRemoteDescription(pc2.localDescription);
    s.cands = (pc1.localDescription.sdp.match(/a=candidate:[^\\r\\n]*/g) || []).map((c) => c.split(' ').slice(4, 8).join(' ')).slice(0, 4);
    pc1.oniceconnectionstatechange = () => s.ice = (s.ice || '') + pc1.iceConnectionState[0];
    setInterval(async () => {
      s.vis = document.visibilityState; s.ac = ac.state; s.ac2 = ac2.state; s.mic = mic.getAudioTracks()[0].readyState + (mic.getAudioTracks()[0].muted ? '/muted' : '');
      s.pc = pc1.connectionState; s.paused = player.paused;
      const a = await pc1.getStats(); const b = await pc2.getStats();
      a.forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video') s.vEnc = r.framesEncoded; if (r.type === 'media-source' && r.kind === 'video') s.vSrc = r.frames; });
      b.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') s.vDec = r.framesDecoded; if (r.type === 'inbound-rtp' && r.kind === 'audio') { s.aRecv = r.totalSamplesReceived; s.aEnergy = Math.round((r.totalAudioEnergy || 0) * 1000) / 1000; } });
    }, 1000);
    return 'ok';
    """
}

/// Debug builds only. Launch with `-P2PCallProbe YES`: answers incoming calls by itself and every 2 s writes
/// the phone's sound setup (category, route, volume) and the page's call sound state to Library/Caches/callprobe.log.
enum CallProbe {
    private static var timer: Timer?
    private static var dumps = 0

    static func startIfAsked(webView: WKWebView?) {
        let calls = UserDefaults.standard.bool(forKey: "P2PCallProbe")
        guard calls || UserDefaults.standard.bool(forKey: "P2PEvalProbe"), let webView = webView else { return }
        let log = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("callprobe.log")
        try? "".write(to: log, atomically: true, encoding: .utf8)
        let wrap = WKUserScript(source: """
        (() => { const O = window.RTCPeerConnection; if (!O || window.__pcs) return; window.__pcs = [];
          window.RTCPeerConnection = function (...a) { const pc = new O(...a); window.__pcs.push(pc); return pc; };
          window.RTCPeerConnection.prototype = O.prototype; Object.setPrototypeOf(window.RTCPeerConnection, O); })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        if calls {
            webView.configuration.userContentController.addUserScript(wrap)
            webView.reload()
        }
        let t = Timer(timeInterval: 2, repeats: true) { _ in
            let a = AVAudioSession.sharedInstance()
            let outs = a.currentRoute.outputs.map { "\($0.portType.rawValue)" }.joined(separator: ",")
            let native = "cat=\(a.category.rawValue) mode=\(a.mode.rawValue) opts=\(a.categoryOptions.rawValue) out=\(outs) vol=\(a.outputVolume) other=\(a.isOtherAudioPlaying)"
            let write: (String) -> Void = { line in
                if let h = try? FileHandle(forWritingTo: log), let d = (line + "\n").data(using: .utf8) { h.seekToEndOfFile(); h.write(d); try? h.close() }
            }
            webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
                write("\(Date().timeIntervalSince1970) \(native) \(result)")
            }
            // Debug: Library/Caches/dump.cmd -> log every window's view tree (to see what covers what).
            if !ScreenCapturePlugin.debugLines.isEmpty {
                write(ScreenCapturePlugin.debugLines.map { "SHARE " + $0 }.joined(separator: "\n"))
                ScreenCapturePlugin.debugLines.removeAll()
            }
            let dumpURL = log.deletingLastPathComponent().appendingPathComponent("dump.cmd")
            let autoDump = ScreenCapturePlugin.active && dumps < 12
            if FileManager.default.fileExists(atPath: dumpURL.path) || autoDump {
                if autoDump { dumps += 1 }
                try? FileManager.default.removeItem(at: dumpURL)
                var out = "DUMP\n"
                func walk(_ v: UIView, _ depth: Int) {
                    guard depth < 9 else { return }
                    let pad = String(repeating: "  ", count: depth)
                    out += "\(pad)\(type(of: v)) frame=\(v.frame.integral) a=\(v.alpha) hidden=\(v.isHidden) ui=\(v.isUserInteractionEnabled)\n"
                    for c in v.subviews { walk(c, depth + 1) }
                }
                for scene in UIApplication.shared.connectedScenes {
                    guard let ws = scene as? UIWindowScene else { continue }
                    for w in ws.windows { out += "WINDOW \(type(of: w)) level=\(w.windowLevel.rawValue) key=\(w.isKeyWindow)\n"; walk(w, 1) }
                }
                if let root = webView.window?.rootViewController {
                    out += "presented: \(String(describing: root.presentedViewController)) state=\(UIApplication.shared.applicationState.rawValue)\n"
                }
                write(out)
            }
            // Debug: run Library/Caches/eval.js once (pushed from the Mac), log its result.
            let evalURL = log.deletingLastPathComponent().appendingPathComponent("eval.js")
            if let js = try? String(contentsOf: evalURL, encoding: .utf8) {
                try? FileManager.default.removeItem(at: evalURL)
                webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in write("EVAL \(result)") }
            }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    static let script = """
    const acc = document.querySelector('[data-testid=accept]'); if (acc) acc.click();
    const r = { accepted: !!acc, status: document.querySelector('[data-testid=call-status]')?.textContent || '-' };
    const vids = [...document.querySelectorAll('video,audio')].map((v) => {
      const s = v.srcObject; const at = s ? s.getAudioTracks() : [];
      return `${v.dataset.testid || v.tagName}:p=${v.paused},m=${v.muted},vol=${v.volume},rs=${v.readyState},a=${at.map((t) => `${t.readyState}/${t.enabled}/${t.muted}`).join('|')}`;
    });
    r.vids = vids;
    r.pcs = [];
    for (const pc of window.__pcs || []) {
      if (pc.connectionState === 'closed') continue;
      const st = await pc.getStats(); const o = { cs: pc.connectionState };
      st.forEach((x) => { if (x.type === 'inbound-rtp' && x.kind === 'audio') { o.pk = x.packetsReceived; o.smp = x.totalSamplesReceived; o.lvl = x.audioLevel; o.conc = x.concealedSamples; o.en = Math.round((x.totalAudioEnergy || 0) * 1000) / 1000; }
        if (x.type === 'inbound-rtp' && x.kind === 'video') o.vdec = x.framesDecoded; });
      r.pcs.push(o);
    }
    return JSON.stringify(r);
    """
}
#endif
