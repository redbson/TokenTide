// Builds release/TokenTide.app: the Swift menu-bar shell plus the local service and the
// built panel under Contents/Resources/app. The app only needs Node.js at runtime.
//
//   node scripts/build-macos.mjs              # this Mac's architecture
//   node scripts/build-macos.mjs --universal  # arm64 + x86_64 (release builds)
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MINIMUM_MACOS = "13.0";
const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const universal = process.argv.includes("--universal");
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });

run(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build"]);

const bundle = path.join(root, "release/TokenTide.app");
const contents = path.join(bundle, "Contents");
const app = path.join(contents, "Resources/app");
await rm(bundle, { recursive: true, force: true });
await mkdir(path.join(contents, "MacOS"), { recursive: true });
await mkdir(path.join(app, "server"), { recursive: true });

// The service uses Node built-ins only, so the server files are copied as-is.
for (const file of await readdir(path.join(root, "server"))) {
  if (file.endsWith(".mjs") || file.endsWith(".expect")) {
    await cp(path.join(root, "server", file), path.join(app, "server", file));
  }
}
await cp(path.join(root, "dist/client"), path.join(app, "client"), { recursive: true });

// The bundle identifier predates the TokenTide name. WebKit keys the panel's local storage
// (quota trend, settings) by bundle identifier, so changing it would reset that data.
await writeFile(
  path.join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>TokenTide</string>
<key>CFBundleIdentifier</key><string>local.usage-monitor</string>
<key>CFBundleName</key><string>TokenTide</string>
<key>CFBundleDisplayName</key><string>TokenTide</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>${MINIMUM_MACOS}</string>
<key>LSUIElement</key><true/>
</dict></plist>
`,
);

run("swift", [
  path.join(root, "scripts/make-icon.swift"),
  path.join(root, "branding/tokentide-icon.svg"),
  path.join(contents, "Resources/AppIcon.icns"),
]);

const sources = (await readdir(path.join(root, "macos")))
  .filter((file) => file.endsWith(".swift"))
  .map((file) => path.join(root, "macos", file));
const architectures = universal ? ["arm64", "x86_64"] : [process.arch === "arm64" ? "arm64" : "x86_64"];
const binaries = architectures.map((arch) => {
  const output = path.join(root, "release", `TokenTide-${arch}`);
  run("swiftc", [
    "-O",
    "-target", `${arch}-apple-macos${MINIMUM_MACOS}`,
    ...sources,
    "-o", output,
    "-framework", "AppKit",
    "-framework", "WebKit",
    "-framework", "ServiceManagement",
  ]);
  return output;
});
const executable = path.join(contents, "MacOS/TokenTide");
run("lipo", ["-create", ...binaries, "-output", executable]);
await Promise.all(binaries.map((binary) => rm(binary)));

// Ad-hoc signature: seals the bundle so the updater can verify downloads with codesign.
run("codesign", ["--force", "--deep", "--sign", "-", bundle]);
console.log(`${bundle} (${version}, ${architectures.join(" + ")})`);
