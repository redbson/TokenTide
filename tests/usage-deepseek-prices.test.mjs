import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalApi } from "../server/api.mjs";
import {
  createDeepseekPriceBook,
  DEEPSEEK_PRICING_URL,
  htmlToText,
  parseDeepseekPricing,
  validateDeepseekPricing,
} from "../server/deepseek-price-book.mjs";
import { BUILTIN_DEEPSEEK_PRICES, deepseekCost } from "../server/deepseek-pricing.mjs";
import { createDeepseekReader } from "../server/deepseek-usage.mjs";
import { createStatsService } from "../server/usage-stats.mjs";

const PAGE = await readFile(new URL("./fixtures/deepseek-pricing.html", import.meta.url), "utf8");
const DAY_MS = 86_400_000;
// Friday 2026-10-23 10:00 Beijing time: DeepSeek's peak hours.
const T = Date.UTC(2026, 9, 23, 2, 0);

const PAGE_TABLE = {
  models: {
    "deepseek-flash": { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    "deepseek-v4-pro": { cacheHit: 0.3, cacheMiss: 9, output: 27 },
  },
  aliases: { "deepseek-v4-flash": "deepseek-flash", "deepseek-v4-flash-vision-exp": "deepseek-flash" },
};

/** The fixture with every Flash price doubled: a price change on DeepSeek's page. */
const RAISED_PAGE = PAGE.replace(/<td>(\d+(?:\.\d+)?)元<\/td><td>(\d+(?:\.\d+)?)元<\/td>/g, (_, flash, pro) => `<td>${Number(flash) * 2}元</td><td>${pro}元</td>`);

/** A fetch that serves `pages` in turn (the last one repeats) and counts its calls. */
function fakePage(...pages) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const page = pages[Math.min(calls.length - 1, pages.length - 1)];
    if (page instanceof Error) throw page;
    return new Response(page, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  };
  return { fetchImpl, calls };
}

async function withDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsp-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("reads the price table and the retired names out of DeepSeek's pricing page", () => {
  const text = htmlToText(PAGE);
  assert.equal(text.includes("window.x"), false, "scripts are dropped");
  const parsed = parseDeepseekPricing(text);
  assert.deepEqual(parsed.models["deepseek-flash"], {
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  });
  assert.deepEqual(parsed.models["deepseek-v4-pro"].offPeak, { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 });
  assert.deepEqual(validateDeepseekPricing(parsed), PAGE_TABLE);
  // Today's page matches the built-in table, so nothing is priced again.
  assert.deepEqual({ models: BUILTIN_DEEPSEEK_PRICES.models, aliases: BUILTIN_DEEPSEEK_PRICES.aliases }, PAGE_TABLE);
});

test("rejects a price table that does not pass every check", () => {
  const check = (html) => validateDeepseekPricing(parseDeepseekPricing(htmlToText(html)));
  assert.equal(check("<p>维护中</p>"), null, "no model row");
  assert.equal(check(PAGE.replace("<td>8元</td>", "<td>—</td>")), null, "a peak price that is not a number");
  assert.equal(check(PAGE.replace("<td>0.04元</td>", "<td>0元</td>")), null, "a zero price");
  assert.equal(check(PAGE.replace("<td>4元</td>", "<td>5元</td>")), null, "off-peak not half of peak");
  assert.equal(check(PAGE.replace("<td>27.0元</td>", "")), null, "a row with a price missing");
  assert.equal(check(PAGE.replace(/<tr><td rowspan="2">百万tokens输出[\s\S]*?<\/tr><tr>[\s\S]*?<\/tr>/, "")), null, "no output prices");
  assert.equal(check(PAGE.replace("<td>8元</td>", "<td>80000元</td>").replace("<td>4元</td>", "<td>40000元</td>")), null, "an absurd price");
  assert.equal(validateDeepseekPricing(null), null);
  assert.equal(validateDeepseekPricing({ models: {} }), null);
});

test("uses stored prices first, then the built-in table", async () => {
  await withDir(async (dir) => {
    const storePath = path.join(dir, "deepseek-prices.json");
    const offline = { fetchImpl: async () => { throw new Error("offline"); } };
    const million = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 };

    // Nothing stored: the built-in table.
    assert.equal((await createDeepseekPriceBook({ storePath, ...offline }).table()), BUILTIN_DEEPSEEK_PRICES);

    // A stored table that passes the checks wins, with its aliases and the built-in ones.
    const checkedAt = Date.UTC(2026, 10, 2);
    await writeFile(storePath, JSON.stringify({ version: 1, attemptedAt: checkedAt, checkedAt, models: { "deepseek-flash": { cacheHit: 0.1, cacheMiss: 3, output: 9 } }, aliases: {} }));
    const stored = await createDeepseekPriceBook({ storePath, ...offline }).table();
    assert.equal(stored.source, "deepseek");
    assert.equal(stored.checkedAt, checkedAt);
    assert.notEqual(stored.version, BUILTIN_DEEPSEEK_PRICES.version);
    assert.equal(deepseekCost("deepseek-flash", million, T, stored), 12.1);
    assert.equal(deepseekCost("deepseek-v4-flash", million, T, stored), 12.1, "a retired name still bills as Flash");
    assert.equal(deepseekCost("deepseek-v4-pro", million, T, stored), null, "only what DeepSeek's page listed");

    // A damaged or hand-edited file is not trusted.
    await writeFile(storePath, JSON.stringify({ version: 1, checkedAt, models: { "deepseek-flash": { cacheHit: -1, cacheMiss: 3, output: 9 } } }));
    assert.equal((await createDeepseekPriceBook({ storePath, ...offline }).table()), BUILTIN_DEEPSEEK_PRICES);
    await writeFile(storePath, "{ not json");
    assert.equal((await createDeepseekPriceBook({ storePath, ...offline }).table()), BUILTIN_DEEPSEEK_PRICES);
  });
});

test("checks DeepSeek's page at most once a day and keeps the last good prices", async () => {
  await withDir(async (dir) => {
    const storePath = path.join(dir, "deepseek-prices.json");
    const { fetchImpl, calls } = fakePage(RAISED_PAGE, "<p>维护中</p>", new Error("offline"));
    const book = createDeepseekPriceBook({ storePath, fetchImpl });

    assert.equal(await book.refreshIfDue(T), true, "the prices changed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, DEEPSEEK_PRICING_URL);
    assert.equal(calls[0].init.headers.Authorization, undefined, "no credentials go with it");
    const raised = await book.table();
    assert.equal(raised.source, "deepseek");
    assert.equal(raised.checkedAt, T);
    assert.deepEqual(raised.models["deepseek-flash"], { cacheHit: 0.08, cacheMiss: 4, output: 16 });
    const saved = JSON.parse(await readFile(storePath, "utf8"));
    assert.equal(saved.checkedAt, T);
    assert.deepEqual(saved.models["deepseek-flash"], { cacheHit: 0.08, cacheMiss: 4, output: 16 });

    // Within a day nothing is fetched, also by a new service reading the same file.
    assert.equal(await book.refreshIfDue(T + DAY_MS - 1), false);
    assert.equal(await createDeepseekPriceBook({ storePath, fetchImpl }).refreshIfDue(T + 3_600_000), false);
    assert.equal(calls.length, 1);

    // A day later the page no longer reads as a price table: the last good prices stay.
    assert.equal(await book.refreshIfDue(T + DAY_MS), false);
    assert.equal(calls.length, 2);
    assert.equal((await book.table()).version, raised.version);
    // A failed check also waits a day before the next one.
    assert.equal(await book.refreshIfDue(T + DAY_MS + 60_000), false);
    assert.equal(calls.length, 2);
    assert.equal(await book.refreshIfDue(T + 2 * DAY_MS), false, "offline");
    assert.equal(calls.length, 3);

    const reopened = await createDeepseekPriceBook({ storePath, fetchImpl }).table();
    assert.equal(reopened.version, raised.version);
    assert.equal(reopened.checkedAt, T, "the date of the last check that succeeded");
  });
});

// One Flash reply at Friday 10:00 Beijing: 100 uncached input, 20 output, 50 cache read.
function sessionLog() {
  const rows = [
    { type: "session", version: 4, id: "s1", createdAt: T },
    { seq: 0, type: "request/context", time: T, data: { model: "deepseek-flash" } },
    { seq: 1, type: "user/message", time: T, data: {} },
    { seq: 2, type: "assistant/message", time: T, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 } } },
  ];
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

test("prices DeepSeek usage again when the prices change", async () => {
  await withDir(async (home) => {
    const project = path.join(home, "sessions", "--Users-me-work--", "session-a");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "session.v4.jsonl"), sessionLog());
    const priceBook = createDeepseekPriceBook({ storePath: path.join(home, "prices.json"), fetchImpl: fakePage(RAISED_PAGE).fetchImpl });
    const read = createDeepseekReader({ dshHome: home, appPaths: [], priceBook });
    const stats = createStatsService({
      claudeDir: path.join(home, "no-claude"),
      codexDir: path.join(home, "no-codex"),
      qoderDir: null,
      dshHome: home,
      cachePath: path.join(home, "stats-cache.json"),
      priceBook,
    });
    const historyCost = async () => (await stats.read()).providers.find((item) => item.id === "deepseek").days[0].cost;

    // 100 × 2 + 20 × 8 + 50 × 0.04 per million at the built-in prices.
    const before = await read(T);
    assert.equal(before.usage.today.cost, 0.000362);
    assert.deepEqual(before.prices, { source: "builtin", checkedAt: BUILTIN_DEEPSEEK_PRICES.checkedAt });
    assert.equal(await historyCost(), 0.000362);

    await priceBook.refreshIfDue(T);
    const after = await read(T);
    assert.equal(after.usage.today.cost, 0.000724, "the same file, priced again");
    assert.deepEqual(after.prices, { source: "deepseek", checkedAt: T });
    assert.equal(await historyCost(), 0.000724);
    const cache = JSON.parse(await readFile(path.join(home, "stats-cache.json"), "utf8"));
    assert.equal(Object.values(cache.files)[0].priceVersion, (await priceBook.table()).version);
  });
});

test("checks prices only while DeepSeek is shown", async () => {
  let refreshes = 0;
  let deepseek = { id: "deepseek", installed: true };
  const api = createLocalApi({
    usageService: { read: async () => ({ providers: [deepseek] }), close() {} },
    statsService: { read: async () => ({ providers: [] }) },
    priceBook: { table: async () => BUILTIN_DEEPSEEK_PRICES, refreshIfDue: async () => (refreshes += 1) },
  });
  const get = async (url) => {
    let payload = "";
    const response = { setHeader() {}, end: (text) => (payload = text), statusCode: 0 };
    await api.handle({ url, method: "GET", headers: { host: "127.0.0.1:46173" } }, response);
    return JSON.parse(payload);
  };

  await get("/api/usage");
  assert.equal(refreshes, 1);
  await get("/api/usage?hidden=qoder%2Cdeepseek");
  assert.equal(refreshes, 1, "hidden in Settings");
  await get("/api/usage?hidden=qoder");
  assert.equal(refreshes, 2);
  deepseek = { id: "deepseek", installed: false };
  await get("/api/usage");
  assert.equal(refreshes, 2, "DeepSeek Harness is not installed");
});
