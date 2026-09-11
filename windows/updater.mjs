import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Keeps the Windows app current from GitHub Releases, like macos/Updater.swift. The release
// workflow attaches `TokenTide-Setup-<version>.exe` and `TokenTide-Setup-<version>.exe.sha256`;
// the updater checks the latest release, verifies the installer's checksum, and runs it
// silently (it replaces the installed app and starts it again). It installs only while the
// panel is closed. No Electron imports, so it can be tested with plain Node.

export const REPOSITORY = "redbson/TokenTide";
export const RELEASES_PAGE = `https://github.com/${REPOSITORY}/releases`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const CHECK_INTERVAL_MS = 6 * 3600 * 1000;
const FIRST_CHECK_DELAY_MS = 20 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export const installerName = (version) => `TokenTide-Setup-${version}.exe`;

/** Failure codes are translated by the page (`updateError.<code>` in src/i18n.js). */
export class UpdateError extends Error {
  constructor(code, params = {}) {
    super(code);
    this.code = code;
    this.params = params;
  }
}

/** Compares dotted numeric versions (`0.10.0` > `0.9.2`); non-numeric parts count as 0. */
export function isNewer(candidate, current) {
  const parts = (version) => String(version).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(candidate), parts(current)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return false;
}

/**
 * Reads GitHub's "latest release" response. Returns null for a release without the Windows
 * installer (yet, or a draft/prerelease) and throws for an unreadable response.
 */
export function parseRelease(json) {
  if (!json || typeof json.tag_name !== "string") throw new UpdateError("response", { status: "200" });
  if (json.draft || json.prerelease) return null;
  const version = json.tag_name.replace(/^v/, "");
  const asset = (name) => {
    const link = (json.assets ?? []).find((entry) => entry?.name === name)?.browser_download_url;
    try {
      const url = new URL(link);
      return url.protocol === "https:" && url.host === "github.com" ? url.href : null;
    } catch {
      return null;
    }
  };
  const installer = asset(installerName(version));
  const checksum = asset(`${installerName(version)}.sha256`);
  if (!installer || !checksum) return null;
  const page = typeof json.html_url === "string" && json.html_url.startsWith("https://github.com/") ? json.html_url : RELEASES_PAGE;
  return { version, installer, checksum, page };
}

const withTimeout = (ms) => AbortSignal.timeout(ms);

export function createUpdater({
  currentVersion,
  getAutoUpdate,
  setAutoUpdate,
  canInstallNow = () => true,
  onChange = () => {},
  launchInstaller,
  fetchImpl = fetch,
  tempDir = os.tmpdir(),
}) {
  let status = "idle";
  let latest = null;
  let lastError = null;
  let checkedAt = null;
  let pendingInstall = false;
  let timers = [];

  const headers = { Accept: "application/vnd.github+json", "User-Agent": `TokenTide/${currentVersion}` };

  const update = (next) => {
    status = next;
    if (next !== "failed") lastError = null;
    onChange();
  };

  const fail = (error) => {
    lastError = error instanceof UpdateError ? error : new UpdateError("unknown");
    status = "failed";
    onChange();
  };

  async function check() {
    if (["checking", "downloading", "installing"].includes(status)) return;
    update("checking");
    let response;
    try {
      response = await fetchImpl(LATEST_RELEASE_API, { headers, signal: withTimeout(REQUEST_TIMEOUT_MS) });
    } catch {
      checkedAt = Date.now();
      fail(new UpdateError("network"));
      return;
    }
    checkedAt = Date.now();
    // 404: the repository has no published release yet.
    if (response.status === 404) {
      latest = null;
      update("upToDate");
      return;
    }
    let release;
    try {
      if (response.status !== 200) throw new UpdateError("response", { status: String(response.status) });
      release = parseRelease(await response.json());
    } catch (error) {
      fail(error instanceof UpdateError ? error : new UpdateError("response", { status: String(response.status) }));
      return;
    }
    // A release whose Windows build has not finished uploading has no installer yet.
    if (!release || !isNewer(release.version, currentVersion)) {
      latest = null;
      update("upToDate");
      return;
    }
    latest = release;
    update("available");
    if (getAutoUpdate()) installWhenIdle();
  }

  function installWhenIdle() {
    if (canInstallNow()) install();
    else pendingInstall = true;
  }

  async function download(url, file) {
    const response = await fetchImpl(url, { headers: { "User-Agent": headers["User-Agent"] }, signal: withTimeout(DOWNLOAD_TIMEOUT_MS) });
    if (response.status !== 200 || !response.body) throw new UpdateError("download");
    await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  }

  async function sha256(file) {
    const hash = createHash("sha256");
    await pipeline(createReadStream(file), hash);
    return hash.digest("hex");
  }

  async function install() {
    const release = latest;
    if (!release || !["available", "failed"].includes(status)) return;
    pendingInstall = false;
    update("downloading");
    try {
      let expected;
      try {
        const response = await fetchImpl(release.checksum, { headers: { "User-Agent": headers["User-Agent"] }, signal: withTimeout(REQUEST_TIMEOUT_MS) });
        expected = response.status === 200 ? (await response.text()).trim().split(/\s+/)[0]?.toLowerCase() : null;
      } catch {
        expected = null;
      }
      if (!/^[0-9a-f]{64}$/.test(expected ?? "")) throw new UpdateError("checksumFile");

      const work = await mkdtemp(path.join(tempDir, "TokenTide-update-"));
      const file = path.join(work, installerName(release.version));
      try {
        await download(release.installer, file);
      } catch (error) {
        throw error instanceof UpdateError ? error : new UpdateError("download");
      }
      if ((await sha256(file)) !== expected) throw new UpdateError("checksum");
      // A Windows program starts with "MZ".
      const handle = await open(file, "r");
      const { buffer } = await handle.read(Buffer.alloc(2), 0, 2, 0);
      await handle.close();
      if (buffer.toString("latin1") !== "MZ") throw new UpdateError("package");

      update("installing");
      await launchInstaller(file);
    } catch (error) {
      fail(error);
    }
  }

  return {
    start() {
      timers.push(setTimeout(check, FIRST_CHECK_DELAY_MS), setInterval(check, CHECK_INTERVAL_MS));
    },
    stop() {
      timers.forEach((timer) => clearTimeout(timer));
      timers = [];
    },
    check,
    install,
    panelDidHide() {
      if (!pendingInstall) return;
      pendingInstall = false;
      install();
    },
    setAutoUpdate(enabled) {
      setAutoUpdate(enabled);
      if (enabled && status === "available") installWhenIdle();
      onChange();
    },
    get latest() {
      return latest;
    },
    /** State for the Settings tab (`usage-monitor:update` event). */
    snapshot() {
      const detail = { status, currentVersion, autoUpdate: getAutoUpdate() };
      if (latest) detail.latestVersion = latest.version;
      if (lastError) {
        detail.error = lastError.code;
        detail.errorParams = lastError.params;
      }
      if (checkedAt) detail.checkedAt = checkedAt;
      return detail;
    },
  };
}
