import AppKit
import Foundation
import WebKit

guard CommandLine.arguments.count >= 3 else {
    fputs("usage: capture-webkit.swift <url> <output>\n", stderr)
    exit(2)
}

let targetURL = URL(string: CommandLine.arguments[1])!
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
let width = CommandLine.arguments.count >= 4 ? Double(CommandLine.arguments[3]) ?? 1448 : 1448
let height = CommandLine.arguments.count >= 5 ? Double(CommandLine.arguments[4]) ?? 1086 : 1086
let viewport = NSSize(width: width, height: height)

final class CaptureDelegate: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    let outputURL: URL
    var finished = false

    init(webView: WKWebView, outputURL: URL) {
        self.webView = webView
        self.outputURL = outputURL
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 9) { [weak self] in
            self?.capture()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail("navigation failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail("navigation failed: \(error.localizedDescription)")
    }

    private func capture() {
        let configuration = WKSnapshotConfiguration()
        configuration.rect = NSRect(origin: .zero, size: viewport)
        webView.takeSnapshot(with: configuration) { [weak self] image, snapshotError in
            guard let self else { return }
            if let snapshotError {
                self.fail("snapshot failed: \(snapshotError.localizedDescription)")
                return
            }
            guard
                let image,
                let tiff = image.tiffRepresentation,
                let bitmap = NSBitmapImageRep(data: tiff),
                let png = bitmap.representation(using: .png, properties: [:])
            else {
                self.fail("snapshot encoding failed")
                return
            }

            do {
                try png.write(to: self.outputURL)
                self.runInteractionChecks()
            } catch {
                self.fail("snapshot write failed: \(error.localizedDescription)")
            }
        }
    }

    private func runInteractionChecks() {
        let initialScript = """
        (() => {
          const toggles = [...document.querySelectorAll('[role="switch"]')];
          const before = toggles.map((item) => item.getAttribute('aria-checked'));
          toggles[0]?.click();
          return JSON.stringify({
            title: document.querySelector('h1')?.textContent,
            providers: [...document.querySelectorAll('.provider h2')].map((item) => item.textContent),
            progress: [...document.querySelectorAll('.progress-value')].map((item) => ({
              width: Math.round(item.getBoundingClientRect().width),
              parentWidth: Math.round(item.parentElement.getBoundingClientRect().width),
              inlineWidth: item.style.width,
              background: getComputedStyle(item).backgroundImage
            })),
            loading: Boolean(document.querySelector('.is-spinning')),
            before,
            errors: window.__usageMonitorErrors || []
          });
        })()
        """

        webView.evaluateJavaScript(initialScript) { [weak self] initialResult, error in
            guard let self else { return }
            if let error {
                self.fail("interaction check failed: \(error.localizedDescription)")
                return
            }

            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                self.webView.evaluateJavaScript("""
                (() => {
                  const after = [...document.querySelectorAll('[role="switch"]')].map((item) => item.getAttribute('aria-checked'));
                  document.querySelector('.history-link')?.click();
                  return JSON.stringify(after);
                })()
                """) { afterResult, afterError in
                    if let afterError {
                        self.fail("toggle check failed: \(afterError.localizedDescription)")
                        return
                    }

                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        self.webView.evaluateJavaScript("""
                        (() => {
                          const historyOpened = Boolean(document.querySelector('[role="dialog"]'));
                          document.querySelector('.close-button')?.click();
                          return historyOpened;
                        })()
                        """) { historyResult, historyError in
                            if let historyError {
                                self.fail("history check failed: \(historyError.localizedDescription)")
                                return
                            }
                            let initial = initialResult as? String ?? "{}"
                            let after = afterResult as? String ?? "[]"
                            let historyOpened = (historyResult as? Bool) == true
                            print("{\"initial\":\(initial),\"after\":\(after),\"historyOpened\":\(historyOpened)}")
                            self.complete(code: 0)
                        }
                    }
                }
            }
        }
    }

    private func fail(_ message: String) {
        fputs("{\"error\":\"\(message.replacingOccurrences(of: "\"", with: "'"))\"}\n", stderr)
        complete(code: 1)
    }

    private func complete(code: Int32) {
        guard !finished else { return }
        finished = true
        DispatchQueue.main.async {
            NSApplication.shared.terminate(nil)
        }
        exit(code)
    }
}

let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = .nonPersistent()
let errorScript = WKUserScript(
    source: """
    window.__usageMonitorErrors = [];
    window.addEventListener('error', (event) => window.__usageMonitorErrors.push(String(event.message)));
    window.addEventListener('unhandledrejection', (event) => window.__usageMonitorErrors.push(String(event.reason)));
    """,
    injectionTime: .atDocumentStart,
    forMainFrameOnly: true
)
configuration.userContentController.addUserScript(errorScript)

let webView = WKWebView(frame: NSRect(origin: .zero, size: viewport), configuration: configuration)
let window = NSWindow(
    contentRect: NSRect(origin: .zero, size: viewport),
    styleMask: [.borderless],
    backing: .buffered,
    defer: false
)
window.contentView = webView
window.orderOut(nil)

let delegate = CaptureDelegate(webView: webView, outputURL: outputURL)
webView.navigationDelegate = delegate
webView.load(URLRequest(url: targetURL, cachePolicy: .reloadIgnoringLocalCacheData))

DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
    if !delegate.finished {
        fputs("{\"error\":\"capture timed out\"}\n", stderr)
        exit(1)
    }
}

NSApplication.shared.run()
