// Mac app icon: the square P2P Talk icon on Apple's macOS icon grid (an 824 px rounded square in a
// 1024 px canvas, soft shadow below), so it sits right with the other icons in the Dock and Finder.
// Usage: mac-icon <icon-1024.png> <out.png> <size>
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
let a = CommandLine.arguments
let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: a[1]) as CFURL, nil)!
let img = CGImageSourceCreateImageAtIndex(src, 0, nil)!
let n = CGFloat(Int(a[3])!)
let s = n / 1024
let ctx = CGContext(data: nil, width: Int(n), height: Int(n), bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.interpolationQuality = .high
let rect = CGRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s)
let shape = CGPath(roundedRect: rect, cornerWidth: 185 * s, cornerHeight: 185 * s, transform: nil)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -10 * s), blur: 20 * s, color: CGColor(gray: 0, alpha: 0.3))
ctx.addPath(shape); ctx.setFillColor(CGColor(srgbRed: 7 / 255, green: 11 / 255, blue: 20 / 255, alpha: 1)); ctx.fillPath()
ctx.restoreGState()
ctx.addPath(shape); ctx.clip()
ctx.draw(img, in: rect)
let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dst, ctx.makeImage()!, nil); CGImageDestinationFinalize(dst)
