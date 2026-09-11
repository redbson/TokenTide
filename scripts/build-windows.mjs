// Builds the Windows app: the Electron tray shell (windows/), the local service (server/), and
// the built panel (dist/client) are staged in release/windows-app and packaged by
// electron-builder as a per-user installer, release/windows/TokenTide-Setup-<version>.exe
// (plus a .sha256 file for the in-app updater, windows/updater.mjs).
//
//   npm --prefix windows ci                    # once: Electron and electron-builder
//   node scripts/build-windows.mjs             # installer (x64)
//   node scripts/build-windows.mjs --dir       # unpacked app only, for a quick check
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version, description, license } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const tools = path.join(root, "windows", "node_modules");
const { version: electronVersion } = JSON.parse(await readFile(path.join(tools, "electron", "package.json"), "utf8"));
const unpackedOnly = process.argv.includes("--dir");
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });

run(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build"]);

const stage = path.join(root, "release", "windows-app");
const output = path.join(root, "release", "windows");
await rm(stage, { recursive: true, force: true });
await rm(output, { recursive: true, force: true });
await mkdir(path.join(stage, "server"), { recursive: true });

for (const file of ["main.mjs", "preload.cjs", "tray-icon.mjs", "updater.mjs", "icon.ico"]) {
  await cp(path.join(root, "windows", file), path.join(stage, file));
}
// The service uses Node built-ins only (Electron's Node runs it), so the files are copied as-is.
for (const file of await readdir(path.join(root, "server"))) {
  if (file.endsWith(".mjs")) await cp(path.join(root, "server", file), path.join(stage, "server", file));
}
await cp(path.join(root, "dist", "client"), path.join(stage, "client"), { recursive: true });

const artifactName = "TokenTide-Setup-${version}.exe";
await writeFile(
  path.join(stage, "package.json"),
  JSON.stringify(
    {
      name: "tokentide",
      productName: "TokenTide",
      version,
      description,
      license,
      author: { name: "TokenTide", url: "https://github.com/redbson/TokenTide" },
      homepage: "https://github.com/redbson/TokenTide",
      type: "module",
      main: "main.mjs",
      build: {
        appId: "io.github.redbson.tokentide",
        productName: "TokenTide",
        electronVersion,
        // Plain files: the service runs from disk in a utility process.
        asar: false,
        npmRebuild: false,
        directories: { output },
        files: ["**/*"],
        win: {
          target: [{ target: unpackedOnly ? "dir" : "nsis", arch: ["x64"] }],
          icon: "icon.ico",
          executableName: "TokenTide",
          artifactName,
        },
        nsis: {
          // Per-user, no administrator rights: installs to %LOCALAPPDATA%\Programs\TokenTide.
          oneClick: true,
          perMachine: false,
          artifactName,
          shortcutName: "TokenTide",
          createDesktopShortcut: false,
          createStartMenuShortcut: true,
          runAfterFinish: true,
          deleteAppDataOnUninstall: false,
          installerIcon: "icon.ico",
          uninstallerIcon: "icon.ico",
        },
        publish: null,
      },
    },
    null,
    2,
  ),
);

run(process.execPath, [path.join(tools, "electron-builder", "cli.js"), "--projectDir", stage, "--win", "--publish", "never"]);

if (!unpackedOnly) {
  const installer = `TokenTide-Setup-${version}.exe`;
  const digest = createHash("sha256").update(await readFile(path.join(output, installer))).digest("hex");
  await writeFile(path.join(output, `${installer}.sha256`), `${digest}  ${installer}\n`);
  console.log(`${path.join(output, installer)} (${version}, x64)\n${digest}`);
} else {
  console.log(`${path.join(output, "win-unpacked")} (${version}, x64)`);
}
