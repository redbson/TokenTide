import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { resolveCommand, spawnCommand, stopCommand } from "../server/commands.mjs";
import { readJsonLineProcess } from "../server/usage-service.mjs";

async function withDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tokentide-commands-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Windows has no execute bit, so the macOS rules can only be checked on macOS and Linux.
test("finds executables on PATH, then in the installers' folders", { skip: process.platform === "win32" }, async () => {
  await withDir(async (dir) => {
    const bin = path.join(dir, "bin");
    const local = path.join(dir, "local");
    await mkdir(bin);
    await mkdir(local);
    await writeFile(path.join(local, "claude"), "#!/bin/sh\n");
    await chmod(path.join(local, "claude"), 0o755);
    await writeFile(path.join(bin, "codex"), "not executable");

    const options = { env: { PATH: bin }, platform: "darwin", extraDirs: [local] };
    assert.equal(resolveCommand("claude", options), path.join(local, "claude"));
    assert.equal(resolveCommand("codex", options), null, "a file without the execute bit is skipped");
    assert.equal(resolveCommand("/usr/bin/true", options), "/usr/bin/true");
  });
});

test("on Windows, tries PATHEXT extensions and ignores extension-less files", async () => {
  await withDir(async (dir) => {
    // npm's shims: `codex` (a shell script for Git Bash) next to `codex.cmd`.
    await writeFile(path.join(dir, "codex"), "#!/bin/sh\n");
    await writeFile(path.join(dir, "codex.cmd"), "@echo off\n");
    await writeFile(path.join(dir, "claude.exe"), "");
    const options = { env: { Path: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, platform: "win32", extraDirs: [] };
    assert.equal(resolveCommand("codex", options), path.join(dir, "codex.cmd"));
    assert.equal(resolveCommand("claude", options), path.join(dir, "claude.exe"));
    assert.equal(resolveCommand("qodercli", options), null);
  });
});

test("spawns a resolved command and stops it", async () => {
  const child = spawnCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["pipe", "ignore", "ignore"] });
  await new Promise((resolve) => child.once("spawn", resolve));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  stopCommand(child);
  await exited;
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test("on Windows, reads through an npm-style .cmd shim and stops the tool behind it", { skip: process.platform !== "win32" }, async () => {
  await withDir(async (dir) => {
    const tools = path.join(dir, "fake tools");
    await mkdir(tools);
    const script = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
    await writeFile(path.join(tools, "fake-codex.cmd"), `@"${process.execPath}" "${script}" %*\r\n`);
    const pidFile = path.join(dir, "pid");
    const saved = { PATH: process.env.PATH, FAKE_CLI_PID_FILE: process.env.FAKE_CLI_PID_FILE };
    process.env.PATH = `${tools};${process.env.PATH}`;
    process.env.FAKE_CLI_PID_FILE = pidFile;
    try {
      const replies = await readJsonLineProcess("fake-codex", ["app-server", "--stdio"], [{ method: "account/rateLimits/read", id: 2 }], 15_000);
      assert.equal(replies["account/rateLimits/read"].rateLimits.primary.usedPercent, 40);
      const pid = Number(await readFile(pidFile, "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.throws(() => process.kill(pid, 0), "the tool behind the shim was stopped");
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.FAKE_CLI_PID_FILE === undefined) delete process.env.FAKE_CLI_PID_FILE;
      else process.env.FAKE_CLI_PID_FILE = saved.FAKE_CLI_PID_FILE;
    }
  });
});
