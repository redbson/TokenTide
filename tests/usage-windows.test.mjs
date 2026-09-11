import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";

import { drawTrayIcon, renderTrayIcon } from "../windows/tray-icon.mjs";
import { createUpdater, installerName, isNewer, parseRelease } from "../windows/updater.mjs";

const pixel = (rgba, size, x, y) => Array.from(rgba.subarray((y * size + x) * 4, (y * size + x) * 4 + 4));

test("tray icon: the mark before a reading, then one bar per tool", () => {
  const mark = drawTrayIcon({ size: 16 });
  assert.equal(pixel(mark, 16, 2, 3)[3], 255, "the mark's bar is drawn");
  assert.equal(pixel(mark, 16, 0, 15)[3], 0, "corners stay transparent");

  // Three tools: 4-px bars at y 0, 6, 12 in white on a dark taskbar.
  const bars = drawTrayIcon({ size: 16, items: [{ remaining: 50 }, { remaining: 100 }, { remaining: 5 }] });
  assert.deepEqual(pixel(bars, 16, 2, 1), [255, 255, 255, 255], "filled part of the first bar");
  assert.ok(pixel(bars, 16, 12, 1)[3] < 120, "the empty part of the first bar is only the faint track");
  assert.deepEqual(pixel(bars, 16, 15, 7), [255, 255, 255, 255], "a full bar reaches the edge");
  assert.deepEqual(pixel(bars, 16, 0, 13), [240, 167, 58, 255], "a low quota is amber");
  assert.equal(pixel(bars, 16, 8, 4)[3], 0, "gap between bars");

  // Dark glyph on a light taskbar; an empty quota still shows an amber sliver.
  const light = drawTrayIcon({ size: 16, light: true, items: [{ remaining: 100 }, { remaining: 0 }] });
  assert.deepEqual(pixel(light, 16, 8, 3), [26, 26, 26, 255]);
  assert.deepEqual(pixel(light, 16, 0, 10), [240, 167, 58, 255]);
  // A tool without a reading has only its track.
  const unknown = drawTrayIcon({ size: 16, items: [{ remaining: null }] });
  assert.ok(pixel(unknown, 16, 0, 7)[3] < 120);
});

test("tray icon PNGs decode to the drawn pixels", () => {
  const png = renderTrayIcon({ size: 24, items: [{ remaining: 40 }] });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 24);
  const idatLength = png.readUInt32BE(33);
  assert.equal(png.subarray(37, 41).toString("ascii"), "IDAT");
  const rows = inflateSync(png.subarray(41, 41 + idatLength));
  assert.equal(rows.length, (24 * 4 + 1) * 24);
  const drawn = drawTrayIcon({ size: 24, items: [{ remaining: 40 }] });
  assert.deepEqual([...rows.subarray(1, 1 + 24 * 4)], [...drawn.subarray(0, 24 * 4)]);
});

const release = (version, names = [installerName(version), `${installerName(version)}.sha256`]) => ({
  tag_name: `v${version}`,
  html_url: `https://github.com/redbson/TokenTide/releases/tag/v${version}`,
  assets: names.map((name) => ({ name, browser_download_url: `https://github.com/redbson/TokenTide/releases/download/v${version}/${name}` })),
});

test("updater: version order and the release's Windows installer", () => {
  assert.equal(isNewer("0.10.0", "0.9.2"), true);
  assert.equal(isNewer("0.5.0", "0.5.0"), false);
  assert.equal(isNewer("0.5", "0.5.1"), false);

  const parsed = parseRelease(release("0.6.0"));
  assert.equal(parsed.version, "0.6.0");
  assert.match(parsed.installer, /TokenTide-Setup-0\.6\.0\.exe$/);
  // The macOS-only assets, drafts, and links off github.com don't count.
  assert.equal(parseRelease(release("0.6.0", ["TokenTide-0.6.0.zip", "TokenTide-0.6.0.zip.sha256"])), null);
  assert.equal(parseRelease({ ...release("0.6.0"), draft: true }), null);
  const offsite = release("0.6.0");
  offsite.assets[0].browser_download_url = "https://example.com/TokenTide-Setup-0.6.0.exe";
  assert.equal(parseRelease(offsite), null);
  assert.throws(() => parseRelease({}), (error) => error.code === "response");
});

function fakeGitHub(files) {
  return async (url) => {
    const body = files[url];
    if (body === undefined) return new Response("missing", { status: 404 });
    return new Response(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body), { status: 200 });
  };
}

test("updater: downloads, verifies, and launches the installer while the panel is closed", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tokentide-updater-"));
  try {
    const installer = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64, 1)]);
    const digest = createHash("sha256").update(installer).digest("hex");
    const latest = release("0.6.0");
    const files = {
      "https://api.github.com/repos/redbson/TokenTide/releases/latest": latest,
      [latest.assets[0].browser_download_url]: installer,
      [latest.assets[1].browser_download_url]: `${digest}  ${installerName("0.6.0")}\n`,
    };
    let panelOpen = true;
    let launched = null;
    let autoUpdate = true;
    const updater = createUpdater({
      currentVersion: "0.5.0",
      getAutoUpdate: () => autoUpdate,
      setAutoUpdate: (value) => {
        autoUpdate = value;
      },
      canInstallNow: () => !panelOpen,
      launchInstaller: async (file) => {
        launched = await readFile(file);
      },
      fetchImpl: fakeGitHub(files),
      tempDir,
    });

    await updater.check();
    assert.equal(updater.snapshot().status, "available");
    assert.equal(updater.snapshot().latestVersion, "0.6.0");
    assert.equal(launched, null, "waits for the panel to close");

    panelOpen = false;
    updater.panelDidHide();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(updater.snapshot().status, "installing");
    assert.deepEqual(launched, installer);

    // A download that doesn't match its checksum is never launched.
    launched = null;
    files[latest.assets[1].browser_download_url] = `${"0".repeat(64)}  x\n`;
    const tampered = createUpdater({
      currentVersion: "0.5.0",
      getAutoUpdate: () => true,
      setAutoUpdate: () => {},
      launchInstaller: async () => {
        launched = true;
      },
      fetchImpl: fakeGitHub(files),
      tempDir,
    });
    await tampered.check();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(tampered.snapshot().status, "failed");
    assert.equal(tampered.snapshot().error, "checksum");
    assert.equal(launched, null);

    // Up to date, and offline.
    const current = createUpdater({ currentVersion: "0.6.0", getAutoUpdate: () => true, setAutoUpdate: () => {}, fetchImpl: fakeGitHub(files) });
    await current.check();
    assert.equal(current.snapshot().status, "upToDate");
    const offline = createUpdater({
      currentVersion: "0.5.0",
      getAutoUpdate: () => true,
      setAutoUpdate: () => {},
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await offline.check();
    assert.equal(offline.snapshot().error, "network");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
