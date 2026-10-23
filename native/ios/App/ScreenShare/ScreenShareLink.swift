import Foundation

/// What the P2P Talk app and its screen sharing extension share (both targets compile this file).
///
/// The extension (ScreenShare/SampleHandler.swift) gets the phone's screen from iOS, makes small JPEG
/// pictures and writes them into the shared App Group folder; the app (App/ScreenCapturePlugin.swift)
/// reads them and hands them to the web page, which turns them into the call's screen video, exactly
/// like the Android app does. Small signals go both ways as Darwin notifications (names only, no data).
///
/// Files in the App Group folder "ScreenShare":
///   request.json  written by the app when the person taps Share screen (time, size, frames a second, sound)
///   frame.jpg     the newest picture (replaced atomically, so the app never reads half a picture)
///   audio.ring    the phone's sound: a small ring of 48 kHz 16-bit stereo samples (see AudioRing)
enum ScreenShareLink {
    static let appGroup = "group.com.vilnek.p2p"
    static let extensionBundleId = "com.vilnek.p2p.ScreenShare"

    // Extension -> app
    static let started = "com.vilnek.p2p.screen.started"
    static let frame = "com.vilnek.p2p.screen.frame"
    static let alive = "com.vilnek.p2p.screen.alive"
    static let stopped = "com.vilnek.p2p.screen.stopped"
    /// The extension found no share request from the app (started from Control Center, or too late).
    static let refused = "com.vilnek.p2p.screen.refused"
    // App -> extension
    static let stop = "com.vilnek.p2p.screen.stop"
    static let appAlive = "com.vilnek.p2p.screen.app-alive"

    /// A request older than this is not used (the person tapped Share screen, then did nothing).
    static let requestMaxAge: TimeInterval = 180

    static var folder: URL? {
        guard let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
        let url = base.appendingPathComponent("ScreenShare", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    static var requestURL: URL? { folder?.appendingPathComponent("request.json") }
    static var frameURL: URL? { folder?.appendingPathComponent("frame.jpg") }
    static var audioURL: URL? { folder?.appendingPathComponent("audio.ring") }

    static func now() -> Double { Date().timeIntervalSince1970 }

    static func post(_ name: String) {
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(),
                                             CFNotificationName(name as CFString), nil, nil, true)
    }

    struct Request: Codable {
        var at: Double
        var fps: Int
        var maxWidth: Int
        var maxHeight: Int
        var audio: Bool
    }

    static func readRequest() -> Request? {
        guard let url = requestURL, let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Request.self, from: data)
    }

    static func writeRequest(_ r: Request) {
        guard let url = requestURL, let data = try? JSONEncoder().encode(r) else { return }
        try? data.write(to: url, options: .atomic)
    }

    static func clearRequest() {
        if let url = requestURL { try? FileManager.default.removeItem(at: url) }
    }
}

/// Darwin notifications -> closures (main thread). One observer per name.
final class DarwinSignals {
    private var handlers: [String: () -> Void] = [:]

    func on(_ name: String, _ fn: @escaping () -> Void) {
        handlers[name] = fn
        let observer = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), observer, { _, observer, name, _, _ in
            guard let observer = observer, let name = name?.rawValue as String? else { return }
            let me = Unmanaged<DarwinSignals>.fromOpaque(observer).takeUnretainedValue()
            if Thread.isMainThread { me.handlers[name]?() } else { DispatchQueue.main.async { me.handlers[name]?() } }
        }, name as CFString, nil, .deliverImmediately)
    }

    deinit {
        CFNotificationCenterRemoveEveryObserver(CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque())
    }
}

/// The phone's sound between the two processes: one writer (extension), one reader (app), lock-free.
/// A memory-mapped file: 16-byte header (bytes written so far, as UInt64) + 1 s of 48 kHz 16-bit stereo.
/// The reader that falls more than ~0.5 s behind skips ahead (only the newest sound matters in a call).
final class AudioRing {
    static let channels = 2
    static let rate = 48000
    static let capacity = rate * channels * 2 // bytes: 1 second
    private static let header = 16

    private var base: UnsafeMutableRawPointer?
    private var fd: Int32 = -1
    private var readPos: UInt64 = 0
    private let size = AudioRing.header + AudioRing.capacity

    /// create: the writer makes a fresh, empty ring.
    init?(url: URL, create: Bool) {
        let flags = create ? (O_RDWR | O_CREAT | O_TRUNC) : O_RDWR
        fd = open(url.path, flags, 0o600)
        guard fd >= 0 else { return nil }
        if create && ftruncate(fd, off_t(size)) != 0 { close(fd); return nil }
        let p = mmap(nil, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0)
        guard let ptr = p, ptr != MAP_FAILED else { close(fd); return nil }
        base = ptr
        readPos = written
    }

    deinit {
        if let b = base { munmap(b, size) }
        if fd >= 0 { close(fd) }
    }

    private var written: UInt64 {
        get { base!.load(as: UInt64.self) }
        set { base!.storeBytes(of: newValue, as: UInt64.self) }
    }

    /// Writer: interleaved stereo Int16 samples.
    func write(_ samples: UnsafeBufferPointer<Int16>) {
        guard let b = base, let src = samples.baseAddress else { return }
        let bytes = samples.count * 2
        guard bytes > 0, bytes <= AudioRing.capacity else { return }
        let start = Int(written % UInt64(AudioRing.capacity))
        let first = min(bytes, AudioRing.capacity - start)
        let data = b + AudioRing.header
        memcpy(data + start, UnsafeRawPointer(src), first)
        if first < bytes { memcpy(data, UnsafeRawPointer(src) + first, bytes - first) }
        OSMemoryBarrier()
        written = written + UInt64(bytes)
    }

    /// Reader: everything new since the last read (at most ~0.5 s), as bytes.
    func read() -> Data? {
        guard let b = base else { return nil }
        let w = written
        OSMemoryBarrier()
        if w < readPos { readPos = w } // the writer started a fresh ring
        let maxBehind = UInt64(AudioRing.capacity / 2)
        if w - readPos > maxBehind { readPos = w - maxBehind }
        let bytes = Int(w - readPos) & ~3 // whole stereo frames
        guard bytes > 0 else { return nil }
        var out = Data(count: bytes)
        let start = Int(readPos % UInt64(AudioRing.capacity))
        let first = min(bytes, AudioRing.capacity - start)
        let data = b + AudioRing.header
        out.withUnsafeMutableBytes { dst in
            memcpy(dst.baseAddress!, data + start, first)
            if first < bytes { memcpy(dst.baseAddress! + first, data, bytes - first) }
        }
        readPos += UInt64(bytes)
        return out
    }
}
