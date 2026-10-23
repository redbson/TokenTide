import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Keeps the few secrets the user hands to TokenTide (the DeepSeek API key) outside the app's
// files: the login Keychain on macOS, Windows' per-user data protection (DPAPI) on Windows.
// Values travel over stdin, never on a command line, and are never returned to the panel or
// logged.

const SERVICE = "TokenTide";

/** Runs `command` with `input` on stdin; resolves `{ code, stdout }`. */
function run(command, args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Secrets are plain printable tokens; anything else could break the Keychain command line. */
export const isStorableSecret = (value) => typeof value === "string" && /^[A-Za-z0-9._~+\/=-]{8,256}$/.test(value);

function keychainStore() {
  const security = "/usr/bin/security";
  return {
    async get(name) {
      const { code, stdout } = await run(security, ["find-generic-password", "-s", SERVICE, "-a", name, "-w"]);
      return code === 0 ? stdout.trim() || null : null;
    },
    async set(name, value) {
      if (!isStorableSecret(value)) throw new Error("Unsupported secret.");
      // `security -i` reads the command from stdin, so the value never appears in `ps`.
      const command = `add-generic-password -U -s ${SERVICE} -a ${name} -l "${SERVICE} ${name}" -w "${value}"\n`;
      const { code } = await run(security, ["-i"], command);
      if (code !== 0) throw new Error("The Keychain did not save the key.");
    },
    async delete(name) {
      await run(security, ["delete-generic-password", "-s", SERVICE, "-a", name]);
    },
  };
}

const POWERSHELL = ["-NoProfile", "-NonInteractive", "-Command"];
const DPAPI = "Add-Type -AssemblyName System.Security; $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser;";

function dpapiStore(directory) {
  const file = (name) => path.join(directory, `${name}.dpapi`);
  return {
    async get(name) {
      const sealed = await readFile(file(name), "utf8").catch(() => null);
      if (!sealed) return null;
      const script = `${DPAPI} $in = [Console]::In.ReadToEnd().Trim(); $bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $null, $scope); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))`;
      const { code, stdout } = await run("powershell.exe", [...POWERSHELL, script], sealed);
      return code === 0 ? stdout.trim() || null : null;
    },
    async set(name, value) {
      if (!isStorableSecret(value)) throw new Error("Unsupported secret.");
      const script = `${DPAPI} $in = [Console]::In.ReadToEnd(); $bytes = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($in), $null, $scope); [Console]::Out.Write([Convert]::ToBase64String($bytes))`;
      const { code, stdout } = await run("powershell.exe", [...POWERSHELL, script], value);
      if (code !== 0 || !stdout.trim()) throw new Error("Windows did not protect the key.");
      await mkdir(directory, { recursive: true });
      await writeFile(`${file(name)}.tmp`, stdout.trim(), { mode: 0o600 });
      await rename(`${file(name)}.tmp`, file(name));
    },
    async delete(name) {
      await rm(file(name), { force: true });
    },
  };
}

/** Elsewhere (Linux development): a file only the user can read. */
function fileStore(directory) {
  const file = (name) => path.join(directory, `${name}.secret`);
  return {
    get: async (name) => (await readFile(file(name), "utf8").catch(() => "")).trim() || null,
    async set(name, value) {
      if (!isStorableSecret(value)) throw new Error("Unsupported secret.");
      await mkdir(directory, { recursive: true });
      await writeFile(file(name), value, { mode: 0o600 });
    },
    delete: (name) => rm(file(name), { force: true }),
  };
}

export function defaultDataDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "TokenTide");
  if (platform === "win32") return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "TokenTide");
  return path.join(home, ".local", "share", "tokentide");
}

/** The platform's store, with each value cached in memory after its first read. */
export function createSecretStore({ platform = process.platform, directory = defaultDataDir(platform) } = {}) {
  const store =
    platform === "darwin" ? keychainStore() : platform === "win32" ? dpapiStore(directory) : fileStore(directory);
  const cache = new Map();
  return {
    async get(name) {
      if (!cache.has(name)) cache.set(name, await store.get(name).catch(() => null));
      return cache.get(name);
    },
    async set(name, value) {
      await store.set(name, value);
      cache.set(name, value);
    },
    async delete(name) {
      await store.delete(name).catch(() => {});
      cache.set(name, null);
    },
  };
}

/** A key as the panel may show it: the first three and last four characters. */
export const maskSecret = (value) => (value ? `${value.slice(0, 3)}…${value.slice(-4)}` : null);
