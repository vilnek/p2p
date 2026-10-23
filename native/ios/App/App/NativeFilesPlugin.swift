import UIKit
import Capacitor
import Photos
import PhotosUI
import UniformTypeIdentifiers
import AVFoundation
import ImageIO

/// "NativeFiles": photos, videos and files sent as the ORIGINAL bytes, and received files saved to
/// Photos, to Files, or shared. The web side is p2p/src/native/nativeFiles.ts.
///
///   pick({ kind: media|files|camera, multiple }) -> { files: [{ handle, name, size, mime, path }] }
///       media:  PHPickerViewController with preferredAssetRepresentationMode = .current (HEIC stays
///               HEIC, videos are not transcoded); no Photos permission is needed to pick.
///       files:  UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true).
///       camera: UIImagePickerController (photo or video). Photos are saved as JPEG (quality 0.95,
///               with the camera's metadata); videos are passed through as recorded.
///       Each pick is a file in tmp/p2p-tmp. The page reads it in pieces through the local server
///       (Capacitor.convertFileSrc(path) + an HTTP Range header), or with read() as a fallback.
///       Closed without a choice: files [].
///   read({ handle, offset, length }) -> { data: base64 }, release({ handle })
///   create({ name, mime, size }) -> { handle }; write({ handle, offset, data: base64 });
///   finish({ handle, size }) -> { ref, size }   (moved to Application Support/p2p-received/<id>/<name>)
///   abort({ handle })
///   saveToPhotos({ ref, name, mime })  asks for "add only" Photos access the first time
///   saveToFiles({ ref, name, mime }) -> { saved }   the Files "Save" sheet
///   share({ ref, name, mime })        the share sheet (open in an app, AirDrop, Save to Files, ...)
///   thumb({ ref, mime, max }) -> { data: base64 JPEG }   a preview of a received photo (ImageIO,
///                                     scaled while decoding, HEIC too) or video (a frame); the file
///                                     itself is not changed
///   remove({ ref }), cleanup({ keep? }), info() -> { binary: false, range: true, platform: "ios" }
///
/// Temporary files (tmp/p2p-tmp, tmp/p2p-partial) are deleted when the app starts, after a cancel
/// and on release(). Received files are excluded from iCloud / iTunes backups.
@objc(NativeFilesPlugin)
public class NativeFilesPlugin: CAPPlugin, CAPBridgedPlugin, PHPickerViewControllerDelegate, UIDocumentPickerDelegate,
    UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    public let identifier = "NativeFilesPlugin"
    public let jsName = "NativeFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pick", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "release", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "abort", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveToPhotos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveToFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "thumb", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cleanup", returnType: CAPPluginReturnPromise)
    ]

    private struct Source { let url: URL; let size: Int64; let mime: String }
    private final class Sink {
        let url: URL
        let name: String
        let handle: FileHandle
        init(url: URL, name: String, handle: FileHandle) { self.url = url; self.name = name; self.handle = handle }
    }

    private let lock = NSLock()
    private var sources: [Int: Source] = [:]
    private var sinks: [Int: Sink] = [:]
    private var nextHandle = 1
    /// Writes: one at a time (seek + write). Reads and copies: in parallel.
    private let writeQueue = DispatchQueue(label: "p2p.files.write", qos: .userInitiated)
    private let workQueue = DispatchQueue(label: "p2p.files.work", qos: .userInitiated, attributes: .concurrent)

    private var pickCall: CAPPluginCall?
    private var exportCall: CAPPluginCall?
    private enum DocMode { case open, export }
    private var docMode: DocMode = .open

    private static let maxRead = 16 * 1024 * 1024
    private static let spaceMargin: Int64 = 50 * 1024 * 1024
    private static let mb = 1024 * 1024

    // MARK: - Folders

    private var tmpDir: URL { Self.dir(FileManager.default.temporaryDirectory, "p2p-tmp") }
    private var partialDir: URL { Self.dir(FileManager.default.temporaryDirectory, "p2p-partial") }
    private var receivedDir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        var d = Self.dir(base, "p2p-received")
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? d.setResourceValues(values)
        return d
    }

    private static func dir(_ base: URL, _ name: String) -> URL {
        let d = base.appendingPathComponent(name, isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    override public func load() {
        let tmp = tmpDir, partial = partialDir
        workQueue.async {
            Self.empty(tmp, keep: [])
            Self.empty(partial, keep: [])
        }
    }

    @objc func info(_ call: CAPPluginCall) {
        call.resolve(["binary": false, "range": true, "platform": "ios"])
    }

    // MARK: - Picking

    @objc func pick(_ call: CAPPluginCall) {
        let kind = call.getString("kind") ?? "files"
        let multiple = call.getBool("multiple") ?? true
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else {
                call.reject("The app is not ready yet.", "failed")
                return
            }
            if self.pickCall != nil {
                call.reject("A picker is already open.", "failed")
                return
            }
            switch kind {
            case "media":
                var config = PHPickerConfiguration()
                config.filter = .any(of: [.images, .videos])
                config.selectionLimit = multiple ? 0 : 1
                config.preferredAssetRepresentationMode = .current // the original: no HEIC -> JPEG, no transcoding
                let picker = PHPickerViewController(configuration: config)
                picker.delegate = self
                self.pickCall = call
                vc.present(picker, animated: true)
            case "camera":
                guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
                    call.reject("This phone has no camera.", "unsupported")
                    return
                }
                let picker = UIImagePickerController()
                picker.sourceType = .camera
                picker.mediaTypes = [UTType.image.identifier, UTType.movie.identifier]
                picker.videoQuality = .typeHigh
                picker.videoExportPreset = AVAssetExportPresetPassthrough
                picker.delegate = self
                self.pickCall = call
                vc.present(picker, animated: true)
            default:
                let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
                picker.allowsMultipleSelection = multiple
                picker.delegate = self
                self.docMode = .open
                self.pickCall = call
                vc.present(picker, animated: true)
            }
        }
    }

    private func finishPick(_ files: [[String: Any]]) {
        let call = pickCall
        pickCall = nil
        call?.resolve(["files": files])
    }

    private func failPick(_ message: String) {
        let call = pickCall
        pickCall = nil
        call?.reject(message, "failed")
    }

    /// Registers a file we own in tmp/p2p-tmp as a picked source.
    private func addSource(url: URL, name: String) -> [String: Any] {
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? 0
        let mime = Self.mime(for: name.isEmpty ? url.lastPathComponent : name)
        lock.lock()
        let h = nextHandle
        nextHandle += 1
        sources[h] = Source(url: url, size: size, mime: mime)
        lock.unlock()
        return ["handle": h, "name": name, "size": size, "mime": mime, "path": url.path]
    }

    /// Takes a file the system gave us into tmp/p2p-tmp under a plain name (<uuid>.<ext>), so its
    /// local server address needs no escaping. Moves when possible (no copy of a big video).
    private func adopt(_ src: URL, preferMove: Bool) throws -> URL {
        let ext = src.pathExtension
        let dst = tmpDir.appendingPathComponent(UUID().uuidString + (ext.isEmpty ? "" : "." + ext))
        if preferMove, (try? FileManager.default.moveItem(at: src, to: dst)) != nil { return dst }
        try FileManager.default.copyItem(at: src, to: dst)
        return dst
    }

    public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        if results.isEmpty {
            finishPick([])
            return
        }
        let group = DispatchGroup()
        var picked = [[String: Any]?](repeating: nil, count: results.count)
        var failed = false
        let resultLock = NSLock()
        for (i, r) in results.enumerated() {
            let p = r.itemProvider
            guard let type = Self.originalType(p) else {
                #if DEBUG
                NSLog("NativeFiles pick: no type in %@", p.registeredTypeIdentifiers)
                #endif
                continue
            }
            group.enter()
            // A file copy of the asset as it is stored (with .current): loaded straight to disk.
            p.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                defer { group.leave() }
                #if DEBUG
                NSLog("NativeFiles pick %@ types=%@ url=%@ error=%@", type, p.registeredTypeIdentifiers, url?.path ?? "-", String(describing: error))
                #endif
                guard let url = url else {
                    resultLock.lock(); failed = true; resultLock.unlock()
                    return
                }
                do {
                    let own = try self.adopt(url, preferMove: true)
                    var name = url.lastPathComponent
                    if let suggested = p.suggestedName, !suggested.isEmpty {
                        let ext = url.pathExtension.isEmpty ? (UTType(type)?.preferredFilenameExtension ?? "") : url.pathExtension
                        name = (suggested as NSString).pathExtension.isEmpty && !ext.isEmpty ? suggested + "." + ext : suggested
                    }
                    let info = self.addSource(url: own, name: name)
                    resultLock.lock(); picked[i] = info; resultLock.unlock()
                } catch {
                    resultLock.lock(); failed = true; resultLock.unlock()
                }
            }
        }
        group.notify(queue: .main) {
            let files = picked.compactMap { $0 }
            if files.isEmpty && failed {
                self.failPick("The photo or video could not be opened. If it is in iCloud, check the internet connection.")
            } else {
                self.finishPick(files)
            }
        }
    }

    /// The type of the original file: the first image or movie type, never the Live Photo bundle.
    private static func originalType(_ p: NSItemProvider) -> String? {
        let types = p.registeredTypeIdentifiers
        for t in types {
            guard let u = UTType(t), t != "com.apple.live-photo-bundle", t != UTType.livePhoto.identifier else { continue }
            if u.conforms(to: .image) || u.conforms(to: .movie) || u.conforms(to: .audiovisualContent) { return t }
        }
        return types.first
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        if docMode == .export {
            let call = exportCall
            exportCall = nil
            call?.resolve(["saved": true])
            return
        }
        workQueue.async {
            var files: [[String: Any]] = []
            for u in urls {
                // asCopy: true gives our own copy (in tmp/<app>-Inbox): move it, no second copy.
                let scoped = u.startAccessingSecurityScopedResource()
                defer { if scoped { u.stopAccessingSecurityScopedResource() } }
                if let own = try? self.adopt(u, preferMove: true) {
                    files.append(self.addSource(url: own, name: u.lastPathComponent))
                }
            }
            DispatchQueue.main.async {
                if files.isEmpty && !urls.isEmpty { self.failPick("The file could not be opened.") } else { self.finishPick(files) }
            }
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        if docMode == .export {
            let call = exportCall
            exportCall = nil
            call?.resolve(["saved": false])
            return
        }
        finishPick([])
    }

    public func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        finishPick([])
    }

    public func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        let stamp = Self.stamp()
        workQueue.async {
            do {
                if let movie = info[.mediaURL] as? URL {
                    let own = try self.adopt(movie, preferMove: true)
                    let name = "Video \(stamp).\(movie.pathExtension.isEmpty ? "mov" : movie.pathExtension)"
                    let r = self.addSource(url: own, name: name)
                    DispatchQueue.main.async { self.finishPick([r]) }
                    return
                }
                guard let image = info[.originalImage] as? UIImage, let cg = image.cgImage else {
                    DispatchQueue.main.async { self.finishPick([]) }
                    return
                }
                let url = self.tmpDir.appendingPathComponent(UUID().uuidString + ".jpg")
                guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
                    throw CocoaError(.fileWriteUnknown)
                }
                var props = (info[.mediaMetadata] as? [String: Any]) ?? [:]
                props[kCGImageDestinationLossyCompressionQuality as String] = 0.95
                props[kCGImagePropertyOrientation as String] = Self.exifOrientation(image.imageOrientation)
                CGImageDestinationAddImage(dest, cg, props as CFDictionary)
                guard CGImageDestinationFinalize(dest) else { throw CocoaError(.fileWriteUnknown) }
                let r = self.addSource(url: url, name: "Photo \(stamp).jpg")
                DispatchQueue.main.async { self.finishPick([r]) }
            } catch {
                DispatchQueue.main.async { self.failPick("The photo could not be saved for sending.") }
            }
        }
    }

    // MARK: - Reading (fallback; the page normally reads through the local server)

    @objc func read(_ call: CAPPluginCall) {
        let h = call.getInt("handle") ?? -1
        let offset = UInt64(max(0, call.getDouble("offset") ?? 0))
        let length = min(Self.maxRead, max(0, Int(call.getDouble("length") ?? 0)))
        lock.lock()
        let src = sources[h]
        lock.unlock()
        guard let s = src else {
            call.reject("This file is no longer on this phone.", "missing")
            return
        }
        workQueue.async {
            do {
                let fh = try FileHandle(forReadingFrom: s.url)
                defer { try? fh.close() }
                try fh.seek(toOffset: offset)
                let data = try fh.read(upToCount: length) ?? Data()
                call.resolve(["data": data.base64EncodedString()])
            } catch {
                call.reject("The file could not be read.", "failed")
            }
        }
    }

    @objc func release(_ call: CAPPluginCall) {
        let h = call.getInt("handle") ?? -1
        lock.lock()
        let src = sources.removeValue(forKey: h)
        lock.unlock()
        if let s = src { try? FileManager.default.removeItem(at: s.url) }
        call.resolve()
    }

    // MARK: - Receiving

    @objc func create(_ call: CAPPluginCall) {
        let name = Self.fsName(call.getString("name") ?? "file")
        let size = Int64(max(0, call.getDouble("size") ?? 0))
        let dir = partialDir
        writeQueue.async {
            if let free = try? dir.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage,
               free < size + Self.spaceMargin {
                call.reject("There is not enough free space on this phone for this file.", "failed")
                return
            }
            let url = dir.appendingPathComponent(UUID().uuidString + ".part")
            guard FileManager.default.createFile(atPath: url.path, contents: nil),
                  let fh = try? FileHandle(forWritingTo: url) else {
                call.reject("The file could not be made on this phone.", "failed")
                return
            }
            self.lock.lock()
            let h = self.nextHandle
            self.nextHandle += 1
            self.sinks[h] = Sink(url: url, name: name, handle: fh)
            self.lock.unlock()
            call.resolve(["handle": h])
        }
    }

    @objc func write(_ call: CAPPluginCall) {
        let h = call.getInt("handle") ?? -1
        let offset = UInt64(max(0, call.getDouble("offset") ?? 0))
        guard let b64 = call.getString("data"), let data = Data(base64Encoded: b64) else {
            call.reject("The file could not be written.", "failed")
            return
        }
        writeQueue.async {
            self.lock.lock()
            let sink = self.sinks[h]
            self.lock.unlock()
            guard let s = sink else {
                call.reject("This file was closed.", "missing")
                return
            }
            do {
                try s.handle.seek(toOffset: offset)
                try s.handle.write(contentsOf: data)
                call.resolve()
            } catch {
                call.reject("The file could not be written. Is the phone full?", "failed")
            }
        }
    }

    @objc func finish(_ call: CAPPluginCall) {
        let h = call.getInt("handle") ?? -1
        let expected = call.getDouble("size").map { Int64($0) }
        let received = receivedDir
        writeQueue.async {
            self.lock.lock()
            let sink = self.sinks.removeValue(forKey: h)
            self.lock.unlock()
            guard let s = sink else {
                call.reject("This file was closed.", "missing")
                return
            }
            do {
                var size = Int64(try s.handle.seekToEnd())
                if let e = expected, e != size {
                    try s.handle.truncate(atOffset: UInt64(e))
                    size = e
                }
                try s.handle.synchronize()
                try s.handle.close()
                let id = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16)).lowercased()
                let d = received.appendingPathComponent(id, isDirectory: true)
                try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
                let target = d.appendingPathComponent(s.name)
                try FileManager.default.moveItem(at: s.url, to: target)
                // Locked with the phone's passcode while the phone is locked (security review L-8).
                try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: target.path)
                call.resolve(["ref": "\(id)/\(s.name)", "size": size])
            } catch {
                try? s.handle.close()
                try? FileManager.default.removeItem(at: s.url)
                call.reject("The file could not be finished.", "failed")
            }
        }
    }

    @objc func abort(_ call: CAPPluginCall) {
        let h = call.getInt("handle") ?? -1
        writeQueue.async {
            self.lock.lock()
            let sink = self.sinks.removeValue(forKey: h)
            self.lock.unlock()
            if let s = sink {
                try? s.handle.close()
                try? FileManager.default.removeItem(at: s.url)
            }
            call.resolve()
        }
    }

    // MARK: - Saving

    /// The received file named by the call's "ref", or nil after rejecting the call.
    private func receivedFile(_ call: CAPPluginCall) -> URL? {
        let ref = call.getString("ref") ?? ""
        let parts = ref.split(separator: "/", omittingEmptySubsequences: false)
        let idOK = parts.count == 2 && !parts[0].isEmpty && parts[0].allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
        guard idOK, !parts[1].isEmpty, parts[1] != ".", parts[1] != "..", !ref.contains("\\") else {
            call.reject("This file is no longer on this phone.", "missing")
            return nil
        }
        let base = receivedDir.standardizedFileURL
        let url = base.appendingPathComponent(String(parts[0])).appendingPathComponent(String(parts[1])).standardizedFileURL
        guard url.path.hasPrefix(base.path + "/"), FileManager.default.fileExists(atPath: url.path) else {
            call.reject("This file is no longer on this phone.", "missing")
            return nil
        }
        return url
    }

    @objc func saveToPhotos(_ call: CAPPluginCall) {
        guard let url = receivedFile(call) else { return }
        let mime = (call.getString("mime") ?? "").lowercased()
        let isVideo = mime.hasPrefix("video/")
        guard isVideo || mime.hasPrefix("image/") else {
            call.reject("Photos cannot keep this type of file. Use Save to Files.", "unsupported")
            return
        }
        let name = Self.fsName(call.getString("name") ?? url.lastPathComponent)
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                call.reject("P2P Talk is not allowed to add to your photos. You can allow it in Settings.", "denied")
                return
            }
            // Photos needs the right file extension to know the type.
            var source = url
            var link: URL?
            if url.pathExtension.isEmpty, let ext = UTType(mimeType: mime)?.preferredFilenameExtension {
                let l = self.tmpDir.appendingPathComponent(UUID().uuidString + "." + ext)
                if (try? FileManager.default.linkItem(at: url, to: l)) != nil { source = l; link = l }
            }
            PHPhotoLibrary.shared().performChanges({
                let req = PHAssetCreationRequest.forAsset()
                let opts = PHAssetResourceCreationOptions()
                opts.originalFilename = name
                opts.shouldMoveFile = false
                req.addResource(with: isVideo ? .video : .photo, fileURL: source, options: opts)
            }, completionHandler: { ok, _ in
                if let l = link { try? FileManager.default.removeItem(at: l) }
                if ok { call.resolve() } else {
                    call.reject("Photos could not keep this file. Use Save to Files.", "unsupported")
                }
            })
        }
    }

    @objc func saveToFiles(_ call: CAPPluginCall) {
        guard let url = receivedFile(call) else { return }
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else {
                call.reject("The app is not ready yet.", "failed")
                return
            }
            if self.exportCall != nil || self.pickCall != nil {
                call.reject("A picker is already open.", "failed")
                return
            }
            let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
            picker.delegate = self
            self.docMode = .export
            self.exportCall = call
            vc.present(picker, animated: true)
        }
    }

    @objc func share(_ call: CAPPluginCall) {
        guard let url = receivedFile(call) else { return }
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else {
                call.reject("The app is not ready yet.", "failed")
                return
            }
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let pop = sheet.popoverPresentationController {
                pop.sourceView = vc.view
                pop.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.maxY - 40, width: 1, height: 1)
            }
            sheet.completionWithItemsHandler = { _, completed, _, error in
                if completed { call.resolve() } else if error != nil {
                    call.reject("The file could not be shared.", "failed")
                } else { call.reject("Cancelled.", "cancelled") }
            }
            vc.present(sheet, animated: true)
        }
    }

    /// A small JPEG preview of a received photo or video. ImageIO makes it scaled down while decoding
    /// (a 48 MP photo is never decoded whole) and turns it the right way up; videos: one frame.
    @objc func thumb(_ call: CAPPluginCall) {
        guard let url = receivedFile(call) else { return }
        let mime = (call.getString("mime") ?? "").lowercased()
        let maxPx = CGFloat(min(1024, max(64, call.getInt("max") ?? 360)))
        workQueue.async {
            var image: CGImage?
            if mime.hasPrefix("video/") {
                let gen = AVAssetImageGenerator(asset: AVURLAsset(url: url))
                gen.appliesPreferredTrackTransform = true
                gen.maximumSize = CGSize(width: maxPx, height: maxPx)
                image = try? gen.copyCGImage(at: CMTime(seconds: 0.5, preferredTimescale: 600), actualTime: nil)
                if image == nil { image = try? gen.copyCGImage(at: .zero, actualTime: nil) }
            } else if mime.hasPrefix("image/") {
                let opts: [CFString: Any] = [kCGImageSourceShouldCache: false]
                if let src = CGImageSourceCreateWithURL(url as CFURL, opts as CFDictionary) {
                    let t: [CFString: Any] = [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceCreateThumbnailWithTransform: true,
                        kCGImageSourceShouldCacheImmediately: true,
                        kCGImageSourceThumbnailMaxPixelSize: maxPx
                    ]
                    image = CGImageSourceCreateThumbnailAtIndex(src, 0, t as CFDictionary)
                }
            }
            guard let cg = image, let jpeg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.78) else {
                call.reject("No preview for this file.", "unsupported")
                return
            }
            call.resolve(["data": jpeg.base64EncodedString()])
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let url = receivedFile(call) else { return }
        try? FileManager.default.removeItem(at: url)
        let parent = url.deletingLastPathComponent()
        if (try? FileManager.default.contentsOfDirectory(atPath: parent.path))?.isEmpty ?? false {
            try? FileManager.default.removeItem(at: parent)
        }
        call.resolve()
    }

    @objc func cleanup(_ call: CAPPluginCall) {
        let keepRefs = call.getArray("keep", String.self)
        lock.lock()
        var inUse = Set(sources.values.map { $0.url.lastPathComponent })
        inUse.formUnion(sinks.values.map { $0.url.lastPathComponent })
        lock.unlock()
        let tmp = tmpDir, partial = partialDir, received = receivedDir
        workQueue.async {
            Self.empty(tmp, keep: inUse)
            Self.empty(partial, keep: inUse)
            if let refs = keepRefs {
                Self.empty(received, keep: Set(refs.compactMap { $0.split(separator: "/").first.map(String.init) }))
            }
            call.resolve()
        }
    }

    // MARK: - Helpers

    private static func empty(_ dir: URL, keep: Set<String>) {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        for n in names where !keep.contains(n) {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(n))
        }
    }

    private static func mime(for name: String) -> String {
        let ext = (name as NSString).pathExtension
        return UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
    }

    /// A safe file name: no folders or odd characters, at most 200 bytes.
    static func fsName(_ name: String) -> String {
        let bad = CharacterSet(charactersIn: "/\\:*?\"<>|").union(.controlCharacters)
        // Defence in depth (the web side already runs safeFileName): invisible direction and format
        // characters (U+202E and friends) are dropped, not replaced.
        let invisible = CharacterSet(charactersIn: "\u{200B}\u{200E}\u{200F}\u{202A}\u{202B}\u{202C}\u{202D}\u{202E}\u{2066}\u{2067}\u{2068}\u{2069}\u{061C}\u{FEFF}\u{2028}\u{2029}")
        var s = String(String.UnicodeScalarView(name.unicodeScalars.filter { !invisible.contains($0) }.map { bad.contains($0) ? "_" : $0 }))
        while s.hasPrefix(".") { s = "_" + s.dropFirst() }
        s = s.trimmingCharacters(in: .whitespaces)
        while s.hasSuffix(".") || s.hasSuffix(" ") { s.removeLast() }
        if s.isEmpty { s = "file" }
        if s.utf8.count <= 200 { return s }
        let ext = (s as NSString).pathExtension
        var base = ext.isEmpty || ext.count > 15 ? s : (s as NSString).deletingPathExtension
        let suffix = ext.isEmpty || ext.count > 15 ? "" : "." + ext
        while !base.isEmpty && (base + suffix).utf8.count > 200 { base.removeLast() }
        return base + suffix
    }

    private static func stamp() -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH.mm.ss"
        return f.string(from: Date())
    }

    private static func exifOrientation(_ o: UIImage.Orientation) -> Int {
        switch o {
        case .up: return 1
        case .down: return 3
        case .left: return 8
        case .right: return 6
        case .upMirrored: return 2
        case .downMirrored: return 4
        case .leftMirrored: return 5
        case .rightMirrored: return 7
        @unknown default: return 1
        }
    }
}
