import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalApi } from "../server/api.mjs";
import { createBalanceLog } from "../server/deepseek-balance.mjs";
import { createDeepseekReader } from "../server/deepseek-usage.mjs";
import { createStatsService } from "../server/usage-stats.mjs";

const KEY = "sk-0123456789abcdef0123456789abcdef";

test("the DeepSeek balance is reused for 5 minutes unless the refresh is forced", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tt-refresh-"));
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return Response.json({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: String(100 - calls) }] });
    };
    const read = createDeepseekReader({
      dshHome: dir,
      appPaths: [dir],
      secrets: { get: async () => KEY },
      balanceLog: createBalanceLog({ logPath: path.join(dir, "log.json") }),
      fetchImpl,
    });
    const start = Date.now();
    assert.equal((await read(start)).balance.total, 99);
    assert.equal((await read(start + 60_000)).balance.total, 99, "a minute later: the cached reading");
    assert.equal(calls, 1);
    assert.equal((await read(start + 90_000, { force: true })).balance.total, 98, "the refresh button asks again");
    assert.equal((await read(start + 90_000 + 5 * 60_000)).balance.total, 97, "after 5 minutes DeepSeek is asked again");
    assert.equal(calls, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a history scan is reused until it is older than the requested age", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tt-stats-"));
  try {
    const stats = createStatsService({
      claudeDir: path.join(dir, "claude"),
      codexDir: path.join(dir, "codex"),
      qoderDir: null,
      dshHome: path.join(dir, "dsh"),
      cachePath: null,
    });
    const first = await stats.read({ maxAgeMs: 30 * 60_000 });
    assert.equal(await stats.read({ maxAgeMs: 30 * 60_000 }), first, "within 30 minutes: the same scan");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.notEqual(await stats.read({ maxAgeMs: 0 }), first, "maxAge 0 rescans");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the API passes ?force=1 and ?maxAge on to the services", async () => {
  const seen = { usage: [], stats: [] };
  const api = createLocalApi({
    usageService: { read: async (options) => (seen.usage.push(options), { providers: [] }), close() {} },
    statsService: { read: async (options) => (seen.stats.push(options), { providers: [] }) },
    secrets: { get: async () => null },
  });
  const server = http.createServer((request, response) => api.handle(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const get = (pathname) => fetch(`http://127.0.0.1:${server.address().port}${pathname}`).then((response) => response.json());
  try {
    await get("/api/usage");
    await get("/api/usage?force=1");
    await get("/api/stats?maxAge=1800");
    await get("/api/stats?maxAge=0");
    await get("/api/stats?maxAge=999999");
    await get("/api/stats");
    assert.deepEqual(seen.usage, [{ force: false }, { force: true }]);
    assert.deepEqual(seen.stats.map((options) => options.maxAgeMs), [1_800_000, 0, 86_400_000, undefined]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
