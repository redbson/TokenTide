import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalApi } from "../server/api.mjs";
import { createAppServer } from "../server/app-server.mjs";

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const services = {
  usageService: { read: async () => ({ updatedAt: 1, providers: [] }), close() {} },
  statsService: {
    read: async () => {
      throw new Error("disk on fire");
    },
  },
};

async function withServer(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tokentide-server-"));
  await mkdir(path.join(root, "client", "assets"), { recursive: true });
  await writeFile(path.join(root, "client", "index.html"), "<!doctype html><title>TokenTide</title>");
  await writeFile(path.join(root, "client", "assets", "index-abc123.js"), "console.log(1)");
  await writeFile(path.join(root, "secret.txt"), "outside the client directory");

  const port = await freePort();
  const server = createAppServer({ api: createLocalApi(services), clientDir: path.join(root, "client"), port });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const get = (pathname, init = {}) => fetch(`http://127.0.0.1:${port}${pathname}`, init);
  try {
    await run({ get, port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

test("serves the panel and its assets with suitable caching", async () => {
  await withServer(async ({ get }) => {
    const page = await get("/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.equal(page.headers.get("cache-control"), "no-cache");
    assert.match(await page.text(), /TokenTide/);

    const asset = await get("/assets/index-abc123.js");
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type"), /javascript/);
    assert.match(asset.headers.get("cache-control"), /immutable/);

    assert.equal((await get("/missing.png")).status, 404);
    assert.equal((await get("/%2e%2e/secret.txt")).status, 404);
    assert.equal((await get("/", { method: "POST" })).status, 405);
  });
});

test("answers the local API and reports failures as JSON", async () => {
  await withServer(async ({ get }) => {
    const usage = await get("/api/usage");
    assert.equal(usage.status, 200);
    assert.equal(usage.headers.get("cache-control"), "no-store");
    assert.deepEqual(await usage.json(), { updatedAt: 1, providers: [] });

    const stats = await get("/api/stats");
    assert.equal(stats.status, 500);
    assert.deepEqual(await stats.json(), { error: "Local history could not be read." });

    assert.equal((await get("/api/usage", { method: "POST" })).status, 405);
    assert.equal((await get("/api/usage", { headers: { origin: "http://evil.example" } })).status, 403);
  });
});

test("rejects requests addressed to other host names", async () => {
  await withServer(async ({ port }) => {
    // fetch() cannot override Host, so speak HTTP directly.
    const status = await new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write("GET /api/usage HTTP/1.1\r\nHost: rebind.example\r\nConnection: close\r\n\r\n");
      });
      let reply = "";
      socket.on("data", (chunk) => (reply += chunk));
      socket.on("end", () => resolve(Number(reply.split(" ")[1])));
      socket.on("error", reject);
    });
    assert.equal(status, 403);
  });
});
