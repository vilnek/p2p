import ReplayKit
import CoreImage
import CoreMedia

/// P2P Talk Screen Share: the iPhone's screen (and the sound other apps play) for a P2P Talk call.
///
/// iOS runs this small extension while the person shares their screen (they start it from the call's
/// Share screen button, which opens iOS's own Start Broadcast sheet). It only works for a share the
/// app asked for in the last few minutes; it sends nothing over the network itself. Pictures and sound
/// go to the P2P Talk app through the shared App Group folder (ScreenShareLink.swift), and the app sends
/// them in the call, end-to-end encrypted like the rest of the call.
///
/// Memory: iOS allows a broadcast extension about 50 MB, so pictures are scaled down (default at most
/// 1280 px each way, 10 a second) before they are kept.
class SampleHandler: RPBroadcastSampleHandler {
    private let signals = DarwinSignals()
    private var request = ScreenShareLink.Request(at: 0, fps: 10, maxWidth: 1280, maxHeight: 1280, audio: false)
    private lazy var ciContext = CIContext(options: [.cacheIntermediates: false, .useSoftwareRenderer: false])
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    private var lastFrameAt: Double = 0
    private var frameBusy = false
    private let frameQueue = DispatchQueue(label: "p2p.screen.frames", qos: .userInteractive)
    private var ring: AudioRing?
    private var resampler = Resampler()
    private var timer: DispatchSourceTimer?
    private var lastAppAlive: Double = 0
    private var finished = false

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        accept(tries: 8)
    }

    /// Only a share the app asked for (Share screen in a call). The request is read a few times over
    /// 2 seconds, in case the app is still writing it.
    private func accept(tries: Int) {
        guard let r = ScreenShareLink.readRequest(), ScreenShareLink.now() - r.at < ScreenShareLink.requestMaxAge else {
            if tries > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.accept(tries: tries - 1) }
            } else {
                ScreenShareLink.post(ScreenShareLink.refused)
                end("To share your screen, tap Share screen in a P2P Talk call.")
            }
            return
        }
        request = r
        if r.audio, let url = ScreenShareLink.audioURL { ring = AudioRing(url: url, create: true) }
        lastAppAlive = ScreenShareLink.now()
        signals.on(ScreenShareLink.stop) { [weak self] in self?.end("You stopped sharing your screen in P2P Talk.") }
        signals.on(ScreenShareLink.appAlive) { [weak self] in self?.lastAppAlive = ScreenShareLink.now() }

        // Once a second: "still here" to the app; and stop if the app has gone (closed, or iOS stopped it).
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + 1, repeating: 1)
        t.setEventHandler { [weak self] in
            guard let self = self else { return }
            ScreenShareLink.post(ScreenShareLink.alive)
            if ScreenShareLink.now() - self.lastAppAlive > 8 {
                self.end("P2P Talk is closed, so screen sharing stopped.")
            }
        }
        t.resume()
        timer = t
        ScreenShareLink.post(ScreenShareLink.started)
    }

    override func broadcastPaused() {}
    override func broadcastResumed() {}

    override func broadcastFinished() {
        cleanUp()
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard !finished else { return }
        switch sampleBufferType {
        case .video: video(sampleBuffer)
        case .audioApp: if request.audio { audio(sampleBuffer) }
        case .audioMic: break // the call already sends the microphone
        @unknown default: break
        }
    }

    private func end(_ message: String) {
        guard !finished else { return }
        cleanUp()
        finishBroadcastWithError(NSError(domain: "P2PTalk", code: 1, userInfo: [NSLocalizedDescriptionKey: message]))
    }

    private func cleanUp() {
        guard !finished else { return }
        finished = true
        timer?.cancel()
        timer = nil
        ScreenShareLink.post(ScreenShareLink.stopped)
    }

    // MARK: - Pictures

    private func video(_ sb: CMSampleBuffer) {
        let now = ScreenShareLink.now()
        guard !frameBusy, now - lastFrameAt >= 1.0 / Double(max(1, request.fps)) - 0.005,
              let pixels = CMSampleBufferGetImageBuffer(sb) else { return }
        lastFrameAt = now
        frameBusy = true
        var orientation = CGImagePropertyOrientation.up
        if let n = CMGetAttachment(sb, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber,
           let o = CGImagePropertyOrientation(rawValue: n.uint32Value) {
            orientation = o
        }
        frameQueue.async { [weak self] in
            guard let self = self else { return }
            autoreleasepool { self.encode(pixels, orientation) }
            self.frameBusy = false
        }
    }

    private func encode(_ pixels: CVPixelBuffer, _ orientation: CGImagePropertyOrientation) {
        var image = CIImage(cvPixelBuffer: pixels).oriented(orientation)
        let w = image.extent.width, h = image.extent.height
        guard w > 0, h > 0 else { return }
        let scale = min(1, CGFloat(request.maxWidth) / w, CGFloat(request.maxHeight) / h)
        if scale < 1 {
            image = image.applyingFilter("CILanczosScaleTransform", parameters: [kCIInputScaleKey: scale, kCIInputAspectRatioKey: 1])
        }
        image = image.transformed(by: CGAffineTransform(translationX: -image.extent.origin.x, y: -image.extent.origin.y))
        let quality = [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.6]
        guard let jpeg = ciContext.jpegRepresentation(of: image, colorSpace: colorSpace, options: quality),
              let url = ScreenShareLink.frameURL, !finished else { return }
        do {
            try jpeg.write(to: url, options: .atomic)
            ScreenShareLink.post(ScreenShareLink.frame)
        } catch {
            // the shared folder is full or gone: skip this picture
        }
    }

    // MARK: - Sound (what other apps play)

    private func audio(_ sb: CMSampleBuffer) {
        guard let ring = ring,
              let desc = CMSampleBufferGetFormatDescription(sb),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(desc) else { return }
        let asbd = asbdPtr.pointee
        guard asbd.mFormatID == kAudioFormatLinearPCM else { return }
        let frames = CMSampleBufferGetNumSamples(sb)
        guard frames > 0 else { return }

        var listSize = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sb, bufferListSizeNeededOut: &listSize, bufferListOut: nil,
                                                                 bufferListSize: 0, blockBufferAllocator: nil,
                                                                 blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
        guard listSize > 0 else { return }
        let listRaw = UnsafeMutableRawPointer.allocate(byteCount: listSize, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { listRaw.deallocate() }
        let list = listRaw.bindMemory(to: AudioBufferList.self, capacity: 1)
        var block: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sb, bufferListSizeNeededOut: nil, bufferListOut: list, bufferListSize: listSize,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &block)
        guard status == noErr else { return }

        let buffers = UnsafeMutableAudioBufferListPointer(list)
        let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        let bigEndian = asbd.mFormatFlags & kAudioFormatFlagIsBigEndian != 0
        let nonInterleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        let channels = Int(asbd.mChannelsPerFrame)
        let bits = Int(asbd.mBitsPerChannel)
        guard channels > 0, (isFloat && bits == 32) || (!isFloat && bits == 16) else { return }

        // One sample (frame i, channel c) as -1...1, whatever the layout.
        func sample(_ i: Int, _ c: Int) -> Float {
            let (buf, index) = nonInterleaved ? (buffers[min(c, buffers.count - 1)], i) : (buffers[0], i * channels + c)
            guard let p = buf.mData else { return 0 }
            if isFloat {
                var bitsValue = p.load(fromByteOffset: index * 4, as: UInt32.self)
                if bigEndian { bitsValue = bitsValue.byteSwapped }
                return Float(bitPattern: bitsValue)
            }
            var v = p.load(fromByteOffset: index * 2, as: Int16.self)
            if bigEndian { v = v.byteSwapped }
            return Float(v) / 32768
        }

        let n = Int(frames)
        var left = [Float](repeating: 0, count: n)
        var right = [Float](repeating: 0, count: n)
        for i in 0..<n {
            left[i] = sample(i, 0)
            right[i] = channels > 1 ? sample(i, 1) : left[i]
        }
        let out = resampler.run(left: left, right: right, from: asbd.mSampleRate)
        out.withUnsafeBufferPointer { ring.write($0) }
    }
}

/// Any sample rate -> 48 kHz, interleaved stereo Int16 (straight-line interpolation, keeps its place
/// between buffers so there are no clicks).
struct Resampler {
    private var pos: Double = 0 // position in the input stream, relative to the current buffer
    private var lastL: Float = 0
    private var lastR: Float = 0

    mutating func run(left: [Float], right: [Float], from rate: Float64) -> [Int16] {
        guard rate > 0, !left.isEmpty else { return [] }
        let step = rate / Double(AudioRing.rate)
        var out: [Int16] = []
        out.reserveCapacity(Int(Double(left.count) / step + 2) * 2)
        let count = Double(left.count)
        // pos is measured from the sample before this buffer (index -1 = lastL/lastR).
        while pos < count - 1 + 1 {
            let x = pos - 1
            let i = Int(floor(x))
            let f = Float(x - Double(i))
            let l0 = i < 0 ? lastL : left[i], r0 = i < 0 ? lastR : right[i]
            let l1 = left[min(i + 1, left.count - 1)], r1 = right[min(i + 1, right.count - 1)]
            out.append(Self.pcm(l0 + (l1 - l0) * f))
            out.append(Self.pcm(r0 + (r1 - r0) * f))
            pos += step
        }
        pos -= count
        lastL = left[left.count - 1]
        lastR = right[right.count - 1]
        return out
    }

    private static func pcm(_ v: Float) -> Int16 {
        Int16(max(-1, min(1, v)) * 32767)
    }
}
