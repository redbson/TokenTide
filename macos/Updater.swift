import AppKit
import CryptoKit

/// Keeps TokenTide current from GitHub Releases.
///
/// The release workflow (.github/workflows/release.yml) attaches `TokenTide-<version>.zip`
/// and `TokenTide-<version>.zip.sha256` to each published release. The updater checks the
/// latest release, verifies the download (checksum, bundle identifier, version, and code
/// signature), swaps the app bundle in place, and relaunches. It installs only while the
/// panel is closed.
final class Updater {
    enum Status: String {
        case idle, checking, upToDate, available, downloading, installing, failed
    }

    struct Release {
        let version: String
        let zip: URL
        let checksum: URL
        let page: URL
    }

    struct UpdateError: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }

    static let repository = "redbson/TokenTide"
    static let releasesPage = URL(string: "https://github.com/\(repository)/releases")!
    private static let latestReleaseAPI = URL(string: "https://api.github.com/repos/\(repository)/releases/latest")!
    private static let checkInterval: TimeInterval = 6 * 3600
    private static let autoUpdateKey = "autoUpdate"

    private(set) var status: Status = .idle
    private(set) var latest: Release?
    private(set) var lastError: String?
    private(set) var checkedAt: Date?
    private var pendingInstall = false
    private var timer: Timer?

    var onChange: (() -> Void)?
    var canInstallNow: () -> Bool = { true }

    var currentVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    var autoUpdate: Bool {
        get { UserDefaults.standard.object(forKey: Self.autoUpdateKey) as? Bool ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.autoUpdateKey)
            if newValue, status == .available { installWhenIdle() }
            onChange?()
        }
    }

    /// State for the 设置 tab (`usage-monitor:update` event).
    var snapshot: [String: Any] {
        var detail: [String: Any] = [
            "status": status.rawValue,
            "currentVersion": currentVersion,
            "autoUpdate": autoUpdate,
        ]
        if let latest { detail["latestVersion"] = latest.version }
        if let lastError { detail["error"] = lastError }
        if let checkedAt { detail["checkedAt"] = checkedAt.timeIntervalSince1970 * 1000 }
        return detail
    }

    func start() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in self?.check() }
        timer = Timer.scheduledTimer(withTimeInterval: Self.checkInterval, repeats: true) { [weak self] _ in
            self?.check()
        }
    }

    // MARK: Checking

    func check() {
        guard ![.checking, .downloading, .installing].contains(status) else { return }
        update(.checking)
        var request = URLRequest(url: Self.latestReleaseAPI)
        request.timeoutInterval = 20
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("TokenTide/\(currentVersion)", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async { self?.handleLatest(data: data, response: response, error: error) }
        }.resume()
    }

    private func handleLatest(data: Data?, response: URLResponse?, error: Error?) {
        checkedAt = Date()
        guard error == nil, let http = response as? HTTPURLResponse else {
            fail("无法连接 GitHub")
            return
        }
        // 404: the repository has no published release yet.
        if http.statusCode == 404 {
            latest = nil
            update(.upToDate)
            return
        }
        guard http.statusCode == 200, let data, let release = Self.parseRelease(data) else {
            fail("读取版本信息失败（HTTP \(http.statusCode)）")
            return
        }
        // A release whose build has not finished uploading has no zip yet; check again later.
        guard let release, Self.isVersion(release.version, newerThan: currentVersion) else {
            latest = nil
            update(.upToDate)
            return
        }
        latest = release
        update(.available)
        if autoUpdate { installWhenIdle() }
    }

    /// Parses the GitHub "latest release" response. Returns `.some(nil)` for a valid release
    /// that does not carry the expected assets (yet), and `nil` for an unreadable response.
    static func parseRelease(_ data: Data) -> Release?? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tag = json["tag_name"] as? String else { return nil }
        if json["draft"] as? Bool == true || json["prerelease"] as? Bool == true { return .some(nil) }
        let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
        let assets = json["assets"] as? [[String: Any]] ?? []
        func asset(named name: String) -> URL? {
            guard let entry = assets.first(where: { $0["name"] as? String == name }),
                  let link = entry["browser_download_url"] as? String,
                  let url = URL(string: link), url.scheme == "https", url.host == "github.com" else { return nil }
            return url
        }
        let zipName = "TokenTide-\(version).zip"
        guard let zip = asset(named: zipName), let checksum = asset(named: zipName + ".sha256") else { return .some(nil) }
        let page = (json["html_url"] as? String).flatMap(URL.init(string:)) ?? releasesPage
        return .some(Release(version: version, zip: zip, checksum: checksum, page: page))
    }

    /// Compares dotted numeric versions (`0.10.0` > `0.9.2`); non-numeric parts count as 0.
    static func isVersion(_ candidate: String, newerThan current: String) -> Bool {
        let parts = { (version: String) in version.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 } }
        let a = parts(candidate), b = parts(current)
        for index in 0..<max(a.count, b.count) {
            let x = index < a.count ? a[index] : 0
            let y = index < b.count ? b[index] : 0
            if x != y { return x > y }
        }
        return false
    }

    // MARK: Installing

    private func installWhenIdle() {
        if canInstallNow() { install() } else { pendingInstall = true }
    }

    func panelDidHide() {
        guard pendingInstall else { return }
        pendingInstall = false
        install()
    }

    func install() {
        guard let release = latest, status == .available || status == .failed else { return }
        pendingInstall = false
        update(.downloading)
        URLSession.shared.dataTask(with: release.checksum) { [weak self] data, response, _ in
            let text = data.flatMap { String(data: $0, encoding: .utf8) }
            let expected = text?.split(whereSeparator: \.isWhitespace).first.map { $0.lowercased() }
            guard (response as? HTTPURLResponse)?.statusCode == 200, let expected, expected.count == 64 else {
                DispatchQueue.main.async { self?.fail("校验文件无效") }
                return
            }
            URLSession.shared.downloadTask(with: release.zip) { location, response, error in
                let result = Result { () throws -> URL in
                    guard let location, error == nil, (response as? HTTPURLResponse)?.statusCode == 200 else {
                        throw UpdateError("下载失败")
                    }
                    return try Self.prepare(download: location, expectedSHA256: expected, version: release.version)
                }
                DispatchQueue.main.async {
                    switch result {
                    case .success(let app): self?.replaceAndRelaunch(with: app)
                    case .failure(let error): self?.fail(error.localizedDescription)
                    }
                }
            }.resume()
        }.resume()
    }

    /// Verifies and unpacks a downloaded release zip; returns the extracted TokenTide.app.
    private static func prepare(download: URL, expectedSHA256: String, version: String) throws -> URL {
        let files = FileManager.default
        let work = files.temporaryDirectory.appendingPathComponent("TokenTide-update-\(UUID().uuidString)")
        try files.createDirectory(at: work, withIntermediateDirectories: true)
        let zip = work.appendingPathComponent("TokenTide.zip")
        try files.moveItem(at: download, to: zip)

        let digest = SHA256.hash(data: try Data(contentsOf: zip)).map { String(format: "%02x", $0) }.joined()
        guard digest == expectedSHA256 else { throw UpdateError("下载内容校验失败，已放弃这次更新") }

        try run("/usr/bin/ditto", ["-x", "-k", zip.path, work.path])
        let app = work.appendingPathComponent("TokenTide.app")
        guard let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")),
              info["CFBundleIdentifier"] as? String == Bundle.main.bundleIdentifier,
              info["CFBundleShortVersionString"] as? String == version else {
            throw UpdateError("下载的程序包与 TokenTide 不匹配")
        }
        try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
        return app
    }

    private func replaceAndRelaunch(with app: URL) {
        update(.installing)
        let current = Bundle.main.bundleURL
        do {
            _ = try FileManager.default.replaceItemAt(current, withItemAt: app)
        } catch {
            fail("没有权限替换 \(current.path)，请从 GitHub 手动下载新版本")
            return
        }
        // Updates fetched by the app itself carry no quarantine flag; clear any left over anyway.
        try? Self.run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", current.path])

        let relaunch = Process()
        relaunch.executableURL = URL(fileURLWithPath: "/bin/sh")
        relaunch.arguments = ["-c", "sleep 1; /usr/bin/open \"$0\"", current.path]
        try? relaunch.run()
        NSApp.terminate(nil)
    }

    private static func run(_ tool: String, _ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw UpdateError("\((tool as NSString).lastPathComponent) 失败（\(process.terminationStatus)）")
        }
    }

    // MARK: State

    private func update(_ next: Status) {
        status = next
        if next != .failed { lastError = nil }
        onChange?()
    }

    private func fail(_ message: String) {
        lastError = message
        status = .failed
        onChange?()
    }
}
