import AppKit

/// P2P Talk for Mac: a native macOS app around the same P2P Talk web app the iPhone and Android apps
/// carry (www/index.html, bundled, never loaded from the internet). See MainWindow.swift.
///
/// Why not the iPad app on the Mac (Mac Catalyst / "Designed for iPad"): those use the iPad web view,
/// which on the Mac has no peer-to-peer connections, camera or microphone, so P2P Talk can't run there.
/// The Mac's own web view has all of them.
@main
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var main: MainWindow?

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = Self.makeMenu()
        let window = MainWindow()
        main = window
        window.show()
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Closing the window keeps P2P Talk running, so chats and calls keep arriving (like Messages).
    /// Clicking the Dock icon brings the window back; P2P Talk › Quit ends it.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { main?.show() }
        return true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    @objc func showMainWindow(_ sender: Any?) { main?.show() }
    @objc func actualSize(_ sender: Any?) { main?.actualSize(sender) }
    @objc func zoomIn(_ sender: Any?) { main?.zoomIn(sender) }
    @objc func zoomOut(_ sender: Any?) { main?.zoomOut(sender) }

    // MARK: - Menu bar

    private static func makeMenu() -> NSMenu {
        let bar = NSMenu()
        let name = "P2P Talk"

        let app = NSMenu(title: name)
        app.addItem(withTitle: "About \(name)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        let services = NSMenu(title: "Services")
        let servicesItem = app.addItem(withTitle: "Services", action: nil, keyEquivalent: "")
        servicesItem.submenu = services
        NSApp.servicesMenu = services
        app.addItem(.separator())
        app.addItem(withTitle: "Hide \(name)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
            .keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit \(name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        bar.addItem(submenu: app)

        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Paste and Match Style", action: #selector(NSTextView.pasteAsPlainText(_:)), keyEquivalent: "V")
            .keyEquivalentModifierMask = [.command, .option, .shift]
        edit.addItem(withTitle: "Delete", action: #selector(NSText.delete(_:)), keyEquivalent: "")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.addItem(.separator())
        // Emoji & Symbols (macOS adds it to a menu called "Edit").
        edit.addItem(withTitle: "Emoji & Symbols", action: #selector(NSApplication.orderFrontCharacterPalette(_:)), keyEquivalent: " ")
            .keyEquivalentModifierMask = [.command, .control]
        bar.addItem(submenu: edit)

        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Actual Size", action: #selector(AppDelegate.actualSize(_:)), keyEquivalent: "0")
        view.addItem(withTitle: "Zoom In", action: #selector(AppDelegate.zoomIn(_:)), keyEquivalent: "+")
        view.addItem(withTitle: "Zoom Out", action: #selector(AppDelegate.zoomOut(_:)), keyEquivalent: "-")
        view.addItem(.separator())
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
            .keyEquivalentModifierMask = [.command, .control]
        bar.addItem(submenu: view)

        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        window.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        window.addItem(.separator())
        window.addItem(withTitle: name, action: #selector(showMainWindow(_:)), keyEquivalent: "1")
        window.addItem(.separator())
        window.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        bar.addItem(submenu: window)
        NSApp.windowsMenu = window
        return bar
    }
}

private extension NSMenu {
    func addItem(submenu: NSMenu) {
        let item = NSMenuItem(title: submenu.title, action: nil, keyEquivalent: "")
        item.submenu = submenu
        addItem(item)
    }
}
