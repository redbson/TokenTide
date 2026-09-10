import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = path.join(root, "release/TokenTide.app/Contents");
await mkdir(path.join(bundle, "MacOS"), { recursive: true });
await mkdir(path.join(bundle, "Resources"), { recursive: true });
const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
// The bundle identifier predates the TokenTide name. WebKit keys the panel's local storage
// (quota trend, settings) by bundle identifier, so changing it would reset that data.
await writeFile(path.join(bundle, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>TokenTide</string>
<key>CFBundleIdentifier</key><string>local.usage-monitor</string>
<key>CFBundleName</key><string>TokenTide</string>
<key>CFBundleDisplayName</key><string>TokenTide</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
<key>LSUIElement</key><true/>
<key>UsageProjectRoot</key><string>${escape(root)}</string>
</dict></plist>`);
execFileSync(
  "swift",
  [path.join(root, "scripts/make-icon.swift"), path.join(root, "branding/tokentide-icon.svg"), path.join(bundle, "Resources/AppIcon.icns")],
  { stdio: "inherit" },
);
execFileSync("swiftc", [path.join(root, "macos/UsageMonitor.swift"), "-o", path.join(bundle, "MacOS/TokenTide"), "-framework", "AppKit", "-framework", "WebKit"], { stdio: "inherit" });
console.log(path.dirname(bundle));
