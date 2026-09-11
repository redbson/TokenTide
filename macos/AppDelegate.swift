import AppKit
import ServiceManagement
import WebKit

/// Borderless panel that drops down from the menu-bar item, like a system status menu.
final class DropdownPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    let address = URL(string: "http://127.0.0.1:4173/")!
    let panelWidth: CGFloat = 360
    let panelGap: CGFloat = 6
    let panelBackground = NSColor(srgbRed: 0x23 / 255, green: 0x24 / 255, blue: 0x28 / 255, alpha: 1)

    var panel: DropdownPanel!
    var webView: WKWebView!
    var statusItem: NSStatusItem!
    var service: Process?
    var attempts = 0
    var contentHeight: CGFloat = 520
    var lastHidden = Date.distantPast
    var outsideClickMonitor: Any?
    var quotaLow = false
    let updater = Updater()

    // MARK: Language

    /// "zh" or "en", as chosen in the panel's settings (sent with `setLanguage`); before the
    /// page has said, Chinese when the primary system language is Chinese, English otherwise.
    var language: String {
        if let chosen = UserDefaults.standard.string(forKey: "language"), ["zh", "en"].contains(chosen) { return chosen }
        return Locale.preferredLanguages.first?.lowercased().hasPrefix("zh") == true ? "zh" : "en"
    }

    func tr(_ chinese: String, _ english: String) -> String { language == "zh" ? chinese : english }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        setUpStatusItem()
        setUpPanel()
        showLoading(tr("正在启动本机额度服务…", "Starting the local quota service…"))
        probe(startIfNeeded: true)

        updater.onChange = { [weak self] in self?.sendUpdateStatus() }
        // Never swap the app out from under an open panel.
        updater.canInstallNow = { [weak self] in !(self?.panel.isVisible ?? false) }
        updater.start()
    }

    // MARK: Status item

    func setUpStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        guard let button = statusItem.button else { return }
        button.target = self
        button.action = #selector(statusItemClicked(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        showStatusGlyph()
    }

    /// The TokenTide mark (a "T" built from two quota bars), shown until the first reading arrives.
    func showStatusGlyph() {
        guard let button = statusItem.button else { return }
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
            // (track, fill): the bar fills from the left, the stem from the bottom.
            let parts: [(NSRect, NSRect)] = [
                (NSRect(x: 2, y: 2.5, width: 14, height: 4), NSRect(x: 2, y: 2.5, width: 9.5, height: 4)),
                (NSRect(x: 7, y: 8, width: 4, height: 8), NSRect(x: 7, y: 11, width: 4, height: 5)),
            ]
            for (track, fill) in parts {
                NSColor.black.withAlphaComponent(0.35).setFill()
                NSBezierPath(roundedRect: track, xRadius: 2, yRadius: 2).fill()
                NSColor.black.setFill()
                NSBezierPath(roundedRect: fill, xRadius: 2, yRadius: 2).fill()
            }
            return true
        }
        image.isTemplate = true
        button.image = image
        button.imagePosition = .imageOnly
        button.toolTip = "TokenTide"
    }

    /// Draws the readout as small text, two lines per column (CX / CC, then QD beside them),
    /// like the network and memory readouts in the menu bar.
    func updateStatusItem(lines: [String], low: Bool) {
        guard let button = statusItem.button else { return }
        let font = NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .semibold)
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.black]
        let rendered = lines.map { NSAttributedString(string: $0, attributes: attributes) }
        let columns = stride(from: 0, to: rendered.count, by: 2).map { Array(rendered[$0..<min($0 + 2, rendered.count)]) }
        let columnWidths = columns.map { ceil($0.map { $0.size().width }.max() ?? 0) }
        let columnGap: CGFloat = 6
        let lineHeight: CGFloat = 10
        let width = columnWidths.reduce(0, +) + columnGap * CGFloat(max(columns.count - 1, 0)) + 2
        let height: CGFloat = 22
        let image = NSImage(size: NSSize(width: max(width, 4), height: height), flipped: true) { _ in
            let top = (height - lineHeight * 2) / 2
            var x: CGFloat = 1
            for (column, lines) in columns.enumerated() {
                for (row, line) in lines.enumerated() {
                    line.draw(at: NSPoint(x: x, y: top + CGFloat(row) * lineHeight - 1))
                }
                x += columnWidths[column] + columnGap
            }
            return true
        }
        image.isTemplate = true
        button.image = image
        button.imagePosition = .imageOnly
        quotaLow = low
        updateTooltip()
    }

    func updateTooltip() {
        statusItem.button?.toolTip = quotaLow ? tr("TokenTide · 有额度偏低", "TokenTide · quota running low") : "TokenTide"
    }

    @objc func statusItemClicked(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            hidePanel()
            let menu = NSMenu()
            menu.addItem(withTitle: tr("显示额度", "Show Quota"), action: #selector(showPanel), keyEquivalent: "").target = self
            menu.addItem(withTitle: tr("立即刷新", "Refresh Now"), action: #selector(refreshNow), keyEquivalent: "r").target = self
            menu.addItem(.separator())
            menu.addItem(withTitle: tr("退出", "Quit"), action: #selector(quit), keyEquivalent: "q").target = self
            statusItem.menu = menu
            sender.performClick(nil)
            statusItem.menu = nil
            return
        }
        togglePanel()
    }

    // MARK: Panel

    func setUpPanel() {
        panel = DropdownPanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: contentHeight),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.isMovable = false
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.delegate = self

        let container = NSView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: contentHeight))
        container.wantsLayer = true
        container.layer?.cornerRadius = 12
        container.layer?.cornerCurve = .continuous
        container.layer?.masksToBounds = true
        container.layer?.backgroundColor = panelBackground.cgColor

        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "usageMonitor")
        // WebKit's navigator.language follows the app's own localizations, not the Mac's,
        // so the page gets the system languages from here (see src/i18n.js).
        if let data = try? JSONSerialization.data(withJSONObject: Locale.preferredLanguages),
           let languages = String(data: data, encoding: .utf8) {
            configuration.userContentController.addUserScript(WKUserScript(
                source: "window.__TOKENTIDE__ = { systemLanguages: \(languages) };",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
        }
        webView = WKWebView(frame: container.bounds, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        container.addSubview(webView)
        panel.contentView = container
    }

    @objc func togglePanel() {
        if panel.isVisible {
            hidePanel()
        } else if Date().timeIntervalSince(lastHidden) > 0.25 {
            // A click on the status item first hides the panel via resignKey; don't reopen it.
            showPanel()
        }
    }

    @objc func showPanel() {
        positionPanel()
        panel.makeKeyAndOrderFront(nil)
        panel.invalidateShadow()
        webView.evaluateJavaScript("window.dispatchEvent(new Event('usage-monitor:show'))")
        if outsideClickMonitor == nil {
            outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                self?.hidePanel()
            }
        }
    }

    func hidePanel() {
        if let monitor = outsideClickMonitor {
            NSEvent.removeMonitor(monitor)
            outsideClickMonitor = nil
        }
        guard panel.isVisible else { return }
        panel.orderOut(nil)
        lastHidden = Date()
        updater.panelDidHide()
    }

    func positionPanel() {
        guard let button = statusItem.button, let buttonWindow = button.window else { return }
        let buttonFrame = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
        let visible = (buttonWindow.screen ?? NSScreen.main)?.visibleFrame ?? .zero
        let height = min(contentHeight, visible.height - panelGap * 2)
        var x = buttonFrame.midX - panelWidth / 2
        x = min(max(x, visible.minX + 8), visible.maxX - panelWidth - 8)
        let y = buttonFrame.minY - panelGap - height
        panel.setFrame(NSRect(x: x, y: y, width: panelWidth, height: height), display: true)
    }

    func windowDidResignKey(_ notification: Notification) {
        hidePanel()
    }

    // MARK: Web bridge

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "resize":
            guard let height = body["height"] as? Double, height > 0 else { return }
            contentHeight = CGFloat(height)
            if panel.isVisible { positionPanel(); panel.invalidateShadow() }
        case "summary":
            let items = body["items"] as? [[String: Any]] ?? []
            let lines = items.map { item -> String in
                let label = item["label"] as? String ?? "?"
                guard let remaining = item["remaining"] as? Double else { return "\(label) —" }
                return "\(label) \(Int(remaining.rounded()))%"
            }
            if lines.isEmpty { showStatusGlyph() } else { updateStatusItem(lines: lines, low: body["low"] as? Bool ?? false) }
        case "hide":
            hidePanel()
        case "setLanguage":
            guard let chosen = body["language"] as? String, ["zh", "en"].contains(chosen) else { return }
            UserDefaults.standard.set(chosen, forKey: "language")
            updateTooltip()
        case "getLoginItem":
            sendLoginItemStatus()
        case "setLoginItem":
            setLoginItem(enabled: body["enabled"] as? Bool ?? false)
        case "openLoginItems":
            hidePanel()
            SMAppService.openSystemSettingsLoginItems()
        case "getUpdate":
            sendUpdateStatus()
        case "checkUpdate":
            updater.check()
        case "installUpdate":
            updater.install()
        case "setAutoUpdate":
            updater.autoUpdate = body["enabled"] as? Bool ?? true
        case "openRelease":
            hidePanel()
            NSWorkspace.shared.open(updater.latest?.page ?? Updater.releasesPage)
        case "quit":
            quit()
        default:
            break
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        // The local service went away (for example after a restart); bring it back.
        attempts = 0
        showLoading(tr("正在重新连接本机额度服务…", "Reconnecting to the local quota service…"))
        probe(startIfNeeded: true)
    }

    // MARK: Launch at login

    func setLoginItem(enabled: Bool) {
        var failure: String?
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            failure = error.localizedDescription
        }
        sendLoginItemStatus(error: failure)
    }

    /// Reports SMAppService's status to the page as a `usage-monitor:login-item` event.
    func sendLoginItemStatus(error: String? = nil) {
        let status: String
        switch SMAppService.mainApp.status {
        case .enabled: status = "enabled"
        case .requiresApproval: status = "requiresApproval"
        case .notFound: status = "notFound"
        default: status = "notRegistered"
        }
        var detail: [String: Any] = ["status": status]
        if let error { detail["error"] = error }
        dispatch("usage-monitor:login-item", detail)
    }

    func sendUpdateStatus() {
        dispatch("usage-monitor:update", updater.snapshot)
    }

    /// Delivers a native state change to the page as a DOM event.
    func dispatch(_ event: String, _ detail: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('\(event)', { detail: \(json) }))")
    }

    @objc func refreshNow() {
        // Reloading the page performs a fresh read on mount.
        webView.reload()
    }

    // MARK: Local service

    func showLoading(_ message: String, detail: String? = nil) {
        let detailHTML = detail.map { "<p>\($0)</p>" } ?? ""
        let html = """
        <html><head><meta charset="utf-8"><style>
        html,body{margin:0;background:transparent;color:#b4b8c1;font:13px -apple-system,"PingFang SC",sans-serif}
        main{padding:40px 24px;text-align:center}h2{margin:0 0 8px;font-size:14px;font-weight:600;color:#eceef2}
        p{margin:0;line-height:1.5;color:#8d929c;font-size:12px}
        </style></head><body><main><h2>\(message)</h2>\(detailHTML)</main></body></html>
        """
        contentHeight = detail == nil ? 110 : 140
        webView.loadHTMLString(html, baseURL: nil)
        if panel.isVisible { positionPanel() }
    }

    func probe(startIfNeeded: Bool) {
        var request = URLRequest(url: address)
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    self.webView.load(URLRequest(url: self.address))
                    return
                }
                if startIfNeeded { self.startService() }
                self.attempts += 1
                if self.attempts < 60 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.probe(startIfNeeded: false) }
                } else {
                    self.showLoading(
                        self.tr("无法启动本机额度服务", "Couldn't start the local quota service"),
                        detail: self.tr(
                            "请确认已安装 Node.js 20 或更新版本（终端里能运行 node）。<br>日志：~/Library/Logs/TokenTide.log",
                            "Make sure Node.js 20 or later is installed (node runs in Terminal).<br>Log: ~/Library/Logs/TokenTide.log"
                        )
                    )
                }
            }
        }.resume()
    }

    /// Runs the bundled local service (`Resources/app/server/main.mjs`) with the user's Node.js.
    func startService() {
        if service?.isRunning == true { return }
        guard let app = Bundle.main.resourceURL?.appendingPathComponent("app") else { return }
        let quote = { (path: String) in "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let entry = quote(app.appendingPathComponent("server/main.mjs").path)
        let client = quote(app.appendingPathComponent("client").path)
        let process = Process()
        // A login shell picks up Node from nvm, Homebrew, or other version managers.
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", "exec node \(entry) --port 4173 --client \(client)"]
        process.currentDirectoryURL = app
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = NSHomeDirectory() + "/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = environment
        let log = openLogFile()
        process.standardOutput = log ?? FileHandle.nullDevice
        process.standardError = log ?? FileHandle.nullDevice
        do { try process.run(); service = process } catch { }
    }

    func openLogFile() -> FileHandle? {
        let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs")
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        let path = logs.appendingPathComponent("TokenTide.log").path
        FileManager.default.createFile(atPath: path, contents: nil)
        return FileHandle(forWritingAtPath: path)
    }

    @objc func quit() { NSApp.terminate(nil) }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showPanel()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        if service?.isRunning == true { service?.terminate() }
    }
}
