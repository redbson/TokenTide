import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalApi } from "../server/api.mjs";
import { SCHEMA, createLocalApiConfig, currentReading, publicUsage } from "../server/local-api.mjs";
import { makeLimit } from "../server/usage-service.mjs";

const NOW = Date.UTC(2026, 10, 3, 4, 0);
const reset = NOW / 1000 + 3600;

const PAYLOAD = {
  updatedAt: NOW,
  providers: [
    { id: "codex", name: "Codex", connected: true, account: "team plan", limits: [makeLimit("window", "Current window", 20, reset), makeLimit("weekly", "Weekly", 73, reset)] },
    // No five-hour window: the weekly quota is the headline.
    { id: "claude", name: "Claude Code", connected: true, account: "max plan", limits: [makeLimit("weekly", "Weekly", 78, reset)] },
    {
      id: "qoder",
      name: "Qoder",
      connected: false,
      installed: true,
      account: "Unavailable",
      limits: [],
      error: "/Users/someone/.local/bin/qodercli did not return usage data in time.",
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      connected: true,
      installed: true,
      account: "DeepSeek Harness",
      limits: [],
      usage: { today: { tokens: 10, messages: 2, cost: 0.01 }, week: { tokens: 20, messages: 4, cost: 0.02 }, month: { tokens: 30, messages: 6, cost: 0.03 } },
      balance: { currency: "CNY", total: 29.54, available: true, readAt: NOW, error: null, spending: { today: 0, week: 5.87, month: 5.87 } },
    },
    { id: "other", connected: false, installed: false, limits: [] },
  ],
};

test("the public reading: headline, windows, DeepSeek usage and balance, no error text", () => {
  const usage = publicUsage(PAYLOAD);
  assert.equal(usage.schema, SCHEMA);
  assert.equal(usage.updatedAt, new Date(NOW).toISOString());
  assert.deepEqual(usage.tools.map((tool) => tool.id), ["codex", "claude", "qoder", "deepseek"], "not-installed tools are left out");

  const [codex, claude, qoder, deepseek] = usage.tools;
  assert.deepEqual(
    { status: codex.status, plan: codex.plan, remainingPercent: codex.remainingPercent, headline: codex.headline },
    { status: "ok", plan: "team", remainingPercent: 80, headline: "window" },
  );
  assert.deepEqual(codex.limits[1], { id: "weekly", usedPercent: 73, remainingPercent: 27, resetsAt: new Date(reset * 1000).toISOString() });
  assert.equal(claude.headline, "weekly");
  assert.equal(claude.remainingPercent, 22);

  assert.equal(qoder.status, "unavailable");
  assert.equal(qoder.error, "unavailable");
  assert.equal(JSON.stringify(usage).includes("/Users/"), false, "error messages, which can hold paths, stay out");

  assert.equal(deepseek.remainingPercent, null);
  assert.deepEqual(deepseek.usage.week, { tokens: 20, messages: 4, estimatedCost: 0.02 });
  assert.equal(deepseek.balance.total, 29.54);
  assert.equal(deepseek.balance.spent.week, 5.87);
});

test("other apps get the latest reading; a new read only when it is older than 5 minutes", async () => {
  let reads = 0;
  const service = {
    current: { ...PAYLOAD, updatedAt: NOW - 2 * 60_000 },
    latest() {
      return this.current;
    },
    async read() {
      reads += 1;
      this.current = { ...PAYLOAD, updatedAt: NOW };
      return this.current;
    },
  };
  await currentReading(service, { now: NOW });
  assert.equal(reads, 0, "2 minutes old: served as it is");
  await currentReading(service, { now: NOW, maxAgeMs: 1000 });
  assert.equal(reads, 1, "?maxAge asks for fresher data, but never under a minute");
  await currentReading(service, { now: NOW + 30_000, maxAgeMs: 0 });
  assert.equal(reads, 1, "30 seconds after a read: still the same reading");
  await currentReading(service, { now: NOW + 6 * 60_000 });
  assert.equal(reads, 2);
  await currentReading({ latest: () => null, read: async () => (reads++, PAYLOAD) }, { now: NOW });
  assert.equal(reads, 3, "before the first reading, one is made");
});

test("/v1/usage answers other apps unless Settings turned it off", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tt-local-api-"));
  const localApi = createLocalApiConfig({ configPath: path.join(dir, "local-api.json") });
  const api = createLocalApi({
    usageService: { read: async () => PAYLOAD, latest: () => ({ ...PAYLOAD, updatedAt: Date.now() }), close() {} },
    statsService: { read: async () => ({ providers: [] }) },
    secrets: { get: async () => null },
    localApi,
  });
  const server = http.createServer((request, response) => api.handle(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const all = await fetch(`${base}/v1/usage`);
    assert.equal(all.status, 200);
    assert.equal((await all.json()).tools.length, 4);
    assert.equal((await (await fetch(`${base}/v1/usage/claude`)).json()).tool.remainingPercent, 22);
    assert.equal((await fetch(`${base}/v1/usage/nope`)).status, 404);
    assert.equal((await (await fetch(`${base}/v1`)).json()).schema, SCHEMA);
    assert.equal((await fetch(`${base}/v1/usage`, { method: "POST" })).status, 405);
    // A web page in a browser carries its own Origin and is refused.
    assert.equal((await fetch(`${base}/v1/usage`, { headers: { Origin: "https://example.com" } })).status, 403);

    const put = (body) => fetch(`${base}/api/local-api`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.deepEqual(await (await fetch(`${base}/api/local-api`)).json(), { enabled: true }, "on by default");
    assert.deepEqual(await (await put({ enabled: false })).json(), { enabled: false });
    const off = await fetch(`${base}/v1/usage`);
    assert.equal(off.status, 403);
    assert.deepEqual(await off.json(), { error: "disabled" });
    assert.equal((await put({ enabled: "yes" })).status, 400);
    assert.equal(await createLocalApiConfig({ configPath: path.join(dir, "local-api.json") }).enabled(), false, "the choice is kept");
    await put({ enabled: true });
    assert.equal((await fetch(`${base}/v1/usage`)).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
