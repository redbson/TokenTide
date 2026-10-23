import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalApi } from "../server/api.mjs";
import {
  createBalanceLog,
  dailyLedger,
  fetchDeepseekBalance,
  parseDeepseekBalance,
  spendingByDay,
  summarizeSpending,
} from "../server/deepseek-balance.mjs";
import { createDeepseekReader } from "../server/deepseek-usage.mjs";
import { createSecretStore, maskSecret } from "../server/secret-store.mjs";
import { summarizeBalance, formatMoney } from "../src/stats-format.js";

const GOOD_KEY = "sk-0123456789abcdef0123456789abcdef";
const BALANCE = {
  is_available: true,
  balance_infos: [
    { currency: "USD", total_balance: "1.00", granted_balance: "0.00", topped_up_balance: "1.00" },
    { currency: "CNY", total_balance: "110.25", granted_balance: "10.00", topped_up_balance: "100.25" },
  ],
};

/** A stand-in for DeepSeek's /user/balance that accepts only GOOD_KEY. */
function fakeDeepseek(body = BALANCE) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, authorization: init.headers.Authorization });
    if (init.headers.Authorization !== `Bearer ${GOOD_KEY}`) return new Response("{}", { status: 401 });
    return Response.json(body);
  };
  return { fetchImpl, calls };
}

function memorySecrets() {
  const values = new Map();
  return {
    values,
    get: async (name) => values.get(name) ?? null,
    set: async (name, value) => void values.set(name, value),
    delete: async (name) => void values.delete(name),
  };
}

const day = (date, hour = 12) => new Date(`${date}T${String(hour).padStart(2, "0")}:00:00`).getTime();

test("reads the CNY balance from /user/balance and tells a rejected key apart", async () => {
  assert.deepEqual(parseDeepseekBalance(BALANCE), { currency: "CNY", total: 110.25, granted: 10, toppedUp: 100.25, available: true });
  assert.throws(() => parseDeepseekBalance({ balance_infos: [] }), { code: "deepseekBalanceUnavailable" });

  const { fetchImpl, calls } = fakeDeepseek();
  assert.equal((await fetchDeepseekBalance(GOOD_KEY, { fetchImpl })).total, 110.25);
  assert.equal(calls[0].url, "https://api.deepseek.com/user/balance");
  await assert.rejects(fetchDeepseekBalance("sk-wrong-key-000000", { fetchImpl }), { code: "deepseekKeyInvalid" });
  const offline = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(fetchDeepseekBalance(GOOD_KEY, { fetchImpl: offline }), { code: "deepseekBalanceUnavailable" });
});

test("spending is every drop in the balance; top-ups and currency changes are not", () => {
  const readings = [
    { at: day("2026-10-21", 9), currency: "CNY", total: 100 },
    { at: day("2026-10-21", 18), currency: "CNY", total: 98.5 },
    { at: day("2026-10-22", 9), currency: "CNY", total: 148.5 }, // topped up 50
    { at: day("2026-10-22", 20), currency: "CNY", total: 147.25 },
    { at: day("2026-10-23", 10), currency: "USD", total: 3 },
    { at: day("2026-10-23", 11), currency: "USD", total: 2.9 },
  ];
  assert.deepEqual(spendingByDay(readings), { "2026-10-21": 1.5, "2026-10-22": 1.25, "2026-10-23": 0.1 });
  const summary = summarizeSpending(readings, day("2026-10-23", 15));
  assert.deepEqual(summary, { today: 0.1, week: 2.85, month: 2.85, since: readings[0].at });
});

test("the balance log keeps only changes and starts over when cleared", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsk-balance-"));
  try {
    const log = createBalanceLog({ logPath: path.join(dir, "deepseek-balance.json") });
    await log.record({ currency: "CNY", total: 10 }, 1000);
    await log.record({ currency: "CNY", total: 10 }, 2000);
    await log.record({ currency: "CNY", total: 9.5 }, 3000);
    assert.equal((await log.readings()).length, 2);
    const stored = JSON.parse(await readFile(path.join(dir, "deepseek-balance.json"), "utf8"));
    assert.equal(JSON.stringify(stored).includes("sk-"), false);
    assert.equal((await log.history()).total, 9.5);
    await log.clear();
    assert.equal(await log.history(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("History's balance view: spending per day, average over recorded days, and runway", () => {
  const balance = { currency: "CNY", total: 30, since: day("2026-10-20"), byDay: { "2026-10-21": 2, "2026-10-23": 1 } };
  const summary = summarizeBalance(balance, "7d", "2026-10-23");
  assert.equal(summary.days.length, 7);
  assert.equal(summary.days.filter((item) => item.recorded).length, 4);
  assert.equal(summary.total, 3);
  assert.equal(summary.average, 0.75);
  assert.equal(summary.runway, 40);
  assert.equal(summarizeBalance({ ...balance, byDay: {} }, "all", "2026-10-23").runway, null);
  assert.equal(formatMoney(110.25, "CNY"), "¥110.25");
  assert.equal(formatMoney(0.9356, "CNY"), "¥0.94");
  assert.equal(formatMoney(0.0012, "CNY"), "¥0.0012");
  assert.equal(formatMoney(2, "USD"), "$2.00");
});

test("the DeepSeek card adds the balance and spending once a key is saved", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsk-reader-"));
  try {
    const secrets = memorySecrets();
    const balanceLog = createBalanceLog({ logPath: path.join(dir, "log.json") });
    const { fetchImpl } = fakeDeepseek();
    const read = createDeepseekReader({ dshHome: dir, appPaths: [dir], secrets, balanceLog, fetchImpl });

    assert.equal((await read()).balance, undefined, "no key, no balance");
    secrets.values.set("deepseek-api-key", GOOD_KEY);
    const withKey = (await read()).balance;
    assert.equal(withKey.total, 110.25);
    assert.equal(withKey.error, null);
    assert.equal(withKey.spending.today, 0);

    secrets.values.set("deepseek-api-key", "sk-revoked-key-0000");
    const revoked = (await read()).balance;
    assert.equal(revoked.error, "deepseekKeyInvalid");
    assert.equal(revoked.total, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/api/deepseek-key saves only a key DeepSeek accepts and never returns it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsk-api-"));
  const secrets = memorySecrets();
  const balanceLog = createBalanceLog({ logPath: path.join(dir, "log.json") });
  const api = createLocalApi({
    usageService: { read: async () => ({ providers: [] }), close() {} },
    statsService: { read: async () => ({ providers: [] }) },
    secrets,
    balanceLog,
    fetchImpl: fakeDeepseek().fetchImpl,
  });
  const server = http.createServer((request, response) => api.handle(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/deepseek-key`;
  const send = (method, key, headers = { "Content-Type": "application/json" }) =>
    fetch(base, { method, headers, body: key === undefined ? undefined : JSON.stringify({ key }) });
  try {
    assert.deepEqual(await (await fetch(base)).json(), { configured: false, hint: null });

    const rejected = await send("PUT", "sk-wrong-key-000000");
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: "deepseekKeyInvalid" });
    assert.equal(secrets.values.size, 0);
    assert.equal((await send("PUT", "not a key")).status, 400);
    assert.equal((await send("PUT", GOOD_KEY, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await send("PUT", GOOD_KEY, { "Content-Type": "application/json", Origin: "https://evil.example" })).status, 403);

    const saved = await send("PUT", GOOD_KEY);
    assert.equal(saved.status, 200);
    const body = await saved.text();
    assert.equal(body.includes(GOOD_KEY), false, "the key never comes back");
    assert.deepEqual(JSON.parse(body), { configured: true, hint: maskSecret(GOOD_KEY) });
    assert.equal(secrets.values.get("deepseek-api-key"), GOOD_KEY);
    assert.equal((await balanceLog.history()).total, 110.25);

    assert.deepEqual(await (await send("DELETE")).json(), { configured: false, hint: null });
    assert.equal(secrets.values.size, 0);
    assert.equal(await balanceLog.history(), null);
    assert.equal((await send("POST", GOOD_KEY)).status, 405);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

// The real platform store: the login Keychain on macOS, DPAPI on Windows (CI).
test("the platform secret store keeps a value and forgets it", { skip: !["darwin", "win32"].includes(process.platform) }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsk-secret-"));
  const name = `tokentide-test-${process.pid}`;
  try {
    const store = createSecretStore({ directory: dir });
    await store.set(name, "test-value-1234567890");
    const fresh = createSecretStore({ directory: dir });
    assert.equal(await fresh.get(name), "test-value-1234567890");
    await fresh.delete(name);
    assert.equal(await createSecretStore({ directory: dir }).get(name), null);
    await assert.rejects(store.set(name, 'quote"breaks'), /Unsupported/);
  } finally {
    await createSecretStore({ directory: dir }).delete(name);
    await rm(dir, { recursive: true, force: true });
  }
});

test("the spending record lists each day's spending, top-ups, and closing balance, newest first", () => {
  const readings = [
    { at: day("2026-10-21", 9), currency: "CNY", total: 100 },
    { at: day("2026-10-21", 18), currency: "CNY", total: 98.5 },
    { at: day("2026-10-22", 9), currency: "CNY", total: 148.5 },
    { at: day("2026-10-22", 20), currency: "CNY", total: 147.25 },
    { at: day("2026-10-24", 10), currency: "CNY", total: 146 },
  ];
  assert.deepEqual(dailyLedger(readings), [
    { date: "2026-10-24", currency: "CNY", spent: 1.25, added: 0, balance: 146 },
    { date: "2026-10-22", currency: "CNY", spent: 1.25, added: 50, balance: 147.25 },
    { date: "2026-10-21", currency: "CNY", spent: 1.5, added: 0, balance: 98.5 },
  ]);
  assert.deepEqual(dailyLedger([]), []);
});
