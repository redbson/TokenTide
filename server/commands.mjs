import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

// Starting the command-line tools on macOS and Windows. On Windows, npm installs `codex`,
// `claude`, and `qodercli` as `.cmd` shims, which Node can only start through cmd.exe, and
// killing cmd.exe leaves the tool itself running, so the whole process tree is ended.

const isWindows = (platform) => platform === "win32";

const isRunnable = (file, platform) => {
  try {
    accessSync(file, isWindows(platform) ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Folders searched after PATH: where the Claude Code and Qoder installers put their tools. */
export const extraCommandDirs = (home = os.homedir()) => [path.join(home, ".local", "bin")];

/**
 * The full path of `name` on PATH (plus `extraDirs`), trying PATHEXT extensions on Windows;
 * null when it is not installed. Absolute paths are returned as they are.
 */
export function resolveCommand(name, { env = process.env, platform = process.platform, extraDirs = extraCommandDirs() } = {}) {
  if (path.isAbsolute(name)) return name;
  const pathValue = env.PATH ?? env.Path ?? "";
  const dirs = [...pathValue.split(isWindows(platform) ? ";" : ":").filter(Boolean), ...extraDirs];
  // On Windows only PATHEXT names run; npm's extension-less `codex` next to `codex.cmd` is a
  // shell script for Git Bash.
  const extensions = isWindows(platform)
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => ext.toLowerCase())
    : [""];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir.replace(/^"(.*)"$/, "$1"), name + extension);
      if (isRunnable(candidate, platform)) return candidate;
    }
  }
  return null;
}

const quoteForCmd = (value) => (/[\s"&|<>^()%!]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

/**
 * Starts `command` like `child_process.spawn`, resolving it on PATH first. `.cmd`/`.bat` shims
 * on Windows run through cmd.exe with quoted arguments (the tools only take plain flags).
 */
export function spawnCommand(command, args, options = {}, platform = process.platform) {
  const resolved = resolveCommand(command, { env: options.env ?? process.env, platform }) ?? command;
  if (isWindows(platform) && /\.(cmd|bat)$/i.test(resolved)) {
    const line = [resolved, ...args].map(quoteForCmd).join(" ");
    return spawn(line, [], { ...options, shell: true, windowsHide: true });
  }
  return spawn(resolved, args, { ...options, windowsHide: true });
}

/** Ends a child started by `spawnCommand`, including the tool behind a Windows shim. */
export function stopCommand(child, platform = process.platform) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.stdin?.end();
  } catch {
    // Already closed.
  }
  if (isWindows(platform) && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  child.kill("SIGTERM");
}
