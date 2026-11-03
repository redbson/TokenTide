import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApiAccountsReader, createSpendLog, lineItemModel, summarizeSpend, azureToken, readAnthropicSpend, readAzureSpend, readOpenAiSpend } from "../server/api-accounts.mjs";
import { createLocalApi } from "../server/api.mjs";
import { createEnvCredentials, createKeyResolver, readShellEnv } from "../server/env-credentials.mjs";
import { publicUsage } from "../server/local-api.mjs";

// 2026-11-03 15:00 UTC: the billing month started 2026-11-01.
const NOW = Date.UTC(2026, 10, 3, 15);
const day = (d) => Date.UTC(2026, 10, d) / 1000;
const OPENAI_ADMIN = "sk-admin-0123456789abcdef";
const ANTHROPIC_ADMIN = "sk-ant-admin01-0123456789abcdef";

function memorySecrets() {
  const values = new Map();
  return { values, get: async (name) => values.get(name) ?? null, set: async (name, value) => void values.set(name, value), delete: async (name) => void values.delete(name) };
}

/** A fake OpenAI / Anthropic / Azure backend that checks the key and records what was asked. */
function fakeProviders({ openaiLimit = 5000 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    calls.push(pathname);
    if (url.startsWith("https://api.openai.com/v1/organization/costs")) {
      if (init.headers.Authorization !== `Bearer ${OPENAI_ADMIN}`) return new Response("{}", { status: 401 });
      if (!searchParams.get("page")) {
        return Response.json({
          data: [{ start_time: day(1), end_time: day(2), results: [{ amount: { value: 1.25, currency: "usd" }, line_item: "gpt-5.1, input" }] }],
          has_more: true,
          next_page: "p2",
        });
      }
      return Response.json({
        data: [
          { start_time: day(2), end_time: day(3), results: [{ amount: { value: 2 }, line_item: "gpt-5.1, output" }, { amount: { value: 0.5 }, line_item: "gpt-4o-mini-2024-07-18, input" }] },
          { start_time: day(3), end_time: day(4), results: [{ amount: { value: 0.75 }, line_item: "gpt-5.1, input" }] },
        ],
        has_more: false,
      });
    }
    if (url.startsWith("https://api.openai.com/v1/organization/usage/completions")) {
      return Response.json({
        data: [
          { start_time: day(2), end_time: day(3), results: [{ model: "gpt-5.1", num_model_requests: 3, input_tokens: 1000, output_tokens: 200, input_cached_tokens: 400 }] },
          { start_time: day(3), end_time: day(4), results: [{ model: "gpt-5.1", num_model_requests: 1, input_tokens: 100, output_tokens: 50, input_cached_tokens: 0 }] },
        ],
        has_more: false,
      });
    }
    if (url === "https://api.openai.com/v1/organization/spend_limit") {
      return openaiLimit ? Response.json({ object: "organization.spend_limit", threshold_amount: openaiLimit, currency: "USD", interval: "month", enforcement: { status: "enforcing" } }) : new Response("{}", { status: 404 });
    }
    if (url.startsWith("https://api.anthropic.com/v1/organizations/cost_report")) {
      if (init.headers["x-api-key"] !== ANTHROPIC_ADMIN) return new Response("{}", { status: 401 });
      assert.equal(searchParams.get("starting_at"), "2026-08-06T00:00:00.000Z", "90 days back");
      return Response.json({
        data: [
          { starting_at: "2026-11-01T00:00:00Z", results: [{ amount: "123.45", currency: "USD" }] },
          { starting_at: "2026-11-03T00:00:00Z", results: [{ amount: "50", currency: "USD" }] },
        ],
        has_more: false,
      });
    }
    if (pathname.endsWith("/providers/Microsoft.CostManagement/query")) {
      assert.equal(init.headers.Authorization, "Bearer azure-token");
      const body = JSON.parse(init.body);
      assert.equal(body.timeframe, "Custom");
      assert.equal(body.timePeriod.from, "2026-08-06T00:00:00Z");
      return Response.json({
        properties: {
          columns: [{ name: "PreTaxCost" }, { name: "UsageDate" }, { name: "Currency" }],
          rows: [
            [3.5, 20261101, "USD"],
            [1.25, 20261103, "USD"],
          ],
        },
      });
    }
    return new Response("{}", { status: 404 });
  };
  return { fetchImpl, calls };
}

test("OpenAI: costs per day across pages, and the monthly spend limit", async () => {
  const { fetchImpl } = fakeProviders();
  const spend = await readOpenAiSpend(OPENAI_ADMIN, { fetchImpl, now: NOW });
  assert.deepEqual(spend.days, { "2026-11-01": 1.25, "2026-11-02": 2.5, "2026-11-03": 0.75 });
  assert.deepEqual(spend.limit, { amount: 50, currency: "USD", enforced: true });
  // Per model: cost from the line items, requests and tokens from the usage report.
  assert.deepEqual(spend.usage["2026-11-02"], {
    "gpt-5.1": { cost: 2, requests: 3, input: 1000, output: 200, cached: 400 },
    "gpt-4o-mini-2024-07-18": { cost: 0.5, requests: 0, input: 0, output: 0, cached: 0 },
  });
  assert.deepEqual(spend.usage["2026-11-01"], { "gpt-5.1": { cost: 1.25, requests: 0, input: 0, output: 0, cached: 0 } });
  assert.deepEqual(summarizeSpend(spend.days, NOW), { today: 0.75, week: 4.5, month: 4.5, calendarMonth: 4.5 });
  await assert.rejects(readOpenAiSpend("sk-admin-wrong", { fetchImpl, now: NOW }), { code: "accountKeyInvalid" });
  assert.equal((await readOpenAiSpend(OPENAI_ADMIN, { fetchImpl: fakeProviders({ openaiLimit: 0 }).fetchImpl, now: NOW })).limit, null);
});

test("Anthropic: the cost report's cents become dollars", async () => {
  const { fetchImpl } = fakeProviders();
  assert.deepEqual(await readAnthropicSpend(ANTHROPIC_ADMIN, { fetchImpl, now: NOW }), { currency: "USD", days: { "2026-11-01": 1.23, "2026-11-03": 0.5 }, limit: null });
});

test("Azure: a token from the CLI or a service principal, and month-to-date cost by day", async () => {
  const { fetchImpl } = fakeProviders();
  const env = (values) => createEnvCredentials({ env: values, readShell: async () => ({}) });
  const az = async (args) => (args[1] === "get-access-token" ? { accessToken: "azure-token", subscription: "sub-1" } : null);
  assert.deepEqual(await azureToken({ envCredentials: env({}), fetchImpl, az }), { token: "azure-token", subscription: "sub-1", via: "cli" });
  assert.equal(await azureToken({ envCredentials: env({}), fetchImpl, az: async () => null }), null, "no CLI, no service principal");

  const servicePrincipal = await azureToken({
    envCredentials: env({ AZURE_TENANT_ID: "t", AZURE_CLIENT_ID: "c", AZURE_CLIENT_SECRET: "s", AZURE_SUBSCRIPTION_ID: "sub-2" }),
    fetchImpl: async (url) => (url.includes("login.microsoftonline.com/t/") ? Response.json({ access_token: "sp-token" }) : new Response("{}", { status: 400 })),
    az,
  });
  assert.deepEqual(servicePrincipal, { token: "sp-token", subscription: "sub-2", via: "servicePrincipal" });

  assert.deepEqual(await readAzureSpend({ token: "azure-token", subscription: "sub-1" }, { fetchImpl, now: NOW }), { currency: "USD", days: { "2026-11-01": 3.5, "2026-11-03": 1.25 }, limit: null });
});

test("the API accounts reader: hidden until set up, keys from Settings or the environment, Azure asked rarely", async () => {
  const { fetchImpl, calls } = fakeProviders();
  const secrets = memorySecrets();
  const envCredentials = createEnvCredentials({ env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_ADMIN, OPENAI_API_KEY: "sk-proj-not-an-admin-key" }, readShell: async () => ({}) });
  const keys = createKeyResolver({ secrets, envCredentials });
  let azCalls = 0;
  const az = async (args) => (azCalls++, args[1] === "get-access-token" ? { accessToken: "azure-token", subscription: "sub-1" } : null);
  const read = createApiAccountsReader({ keys, envCredentials, fetchImpl, az });

  let [openai, anthropic, azure] = await read();
  assert.equal(openai.installed, false, "a project key in OPENAI_API_KEY is not an admin key");
  assert.equal(anthropic.connected, true);
  assert.equal(anthropic.keySource, "env");
  assert.equal(anthropic.keyVariable, "ANTHROPIC_ADMIN_KEY");
  assert.equal(azure.spend.month, 4.75);
  assert.equal(azure.spend.today, 1.25);
  assert.equal(azure.delayed, true);

  secrets.values.set("openai-admin-key", OPENAI_ADMIN);
  [openai] = await read();
  assert.equal(openai.spend.month, 4.5);
  assert.equal(openai.limits[0].id, "monthly");
  assert.equal(openai.limits[0].remainingPercent, 91);

  const azureQueries = calls.filter((call) => call.endsWith("/query")).length;
  await read();
  await read({ force: true });
  assert.equal(calls.filter((call) => call.endsWith("/query")).length, azureQueries, "Azure is not asked again within the hour, even when forced");

  // What other apps see: spend, no keys.
  const usage = publicUsage({ updatedAt: NOW, providers: await read() });
  const tool = usage.tools.find((item) => item.id === "openai-api");
  assert.deepEqual(tool.spend.limit, { amount: 50, currency: "USD", enforced: true });
  assert.equal(JSON.stringify(usage).includes("sk-"), false);
});

test("keys come from Settings first, then the environment, then the user's shell", async () => {
  const secrets = memorySecrets();
  let shellReads = 0;
  const envCredentials = createEnvCredentials({ env: {}, readShell: async () => (shellReads++, { DEEPSEEK_API_KEY: "sk-from-shell" }) });
  const keys = createKeyResolver({ secrets, envCredentials });
  assert.deepEqual(await keys.resolve("deepseek"), { value: "sk-from-shell", source: "env", variable: "DEEPSEEK_API_KEY" });
  await keys.resolve("deepseek");
  assert.equal(shellReads, 1, "the shell is asked once, then remembered");
  secrets.values.set("deepseek-api-key", "sk-saved");
  assert.deepEqual(await keys.resolve("deepseek"), { value: "sk-saved", source: "saved" });
});

test("the user's shell environment is read past whatever the rc files print", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tt-shell-"));
  try {
    // A stand-in "shell" that prints noise, then runs the command it is given.
    const shell = path.join(dir, "fake-shell");
    await writeFile(shell, `#!/bin/sh\nprintf '\\033]1337;Noise\\007Welcome!\\n'\nexport DEEPSEEK_API_KEY=sk-shell-value OTHER=ignored\nshift\nexec /bin/sh -c "$1"\n`);
    await chmod(shell, 0o755);
    assert.deepEqual(await readShellEnv(["DEEPSEEK_API_KEY", "MISSING"], { shell }), { DEEPSEEK_API_KEY: "sk-shell-value" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/api/keys saves only an admin key the provider accepts, and shows where a key came from", async () => {
  const secrets = memorySecrets();
  const api = createLocalApi({
    usageService: { read: async () => ({ providers: [] }), close() {} },
    statsService: { read: async () => ({}) },
    secrets,
    fetchImpl: fakeProviders().fetchImpl,
    envCredentials: createEnvCredentials({ env: { ANTHROPIC_ADMIN_KEY: ANTHROPIC_ADMIN }, readShell: async () => ({}) }),
  });
  const server = http.createServer((request, response) => api.handle(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/keys`;
  const put = (id, key) => fetch(`${base}/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
  try {
    assert.deepEqual(await (await fetch(`${base}/anthropic-admin`)).json(), { configured: true, hint: "sk-…cdef", source: "env", variable: "ANTHROPIC_ADMIN_KEY" });
    assert.equal((await put("openai-admin", "sk-proj-123456789")).status, 400, "not an admin key");
    const wrong = await put("openai-admin", "sk-admin-wrongwrongwrong");
    assert.deepEqual([wrong.status, (await wrong.json()).error], [400, "accountKeyInvalid"]);
    const saved = await put("openai-admin", OPENAI_ADMIN);
    assert.deepEqual(await saved.json(), { configured: true, hint: "sk-…cdef", source: "saved", variable: null });
    assert.equal(secrets.values.get("openai-admin-key"), OPENAI_ADMIN);
    assert.deepEqual((await (await fetch(`${base}/openai-admin`, { method: "DELETE" })).json()).configured, false);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the spend log keeps every day a provider ever reported, so History outlasts their windows", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tt-spend-log-"));
  try {
    const file = path.join(dir, "spend-history.json");
    const log = createSpendLog({ file });
    await log.record("openai-api", "USD", { "2026-08-01": 1, "2026-08-02": 2 });
    // A later read no longer includes August 1, and reports a revised August 2.
    const entry = await log.record("openai-api", "USD", { "2026-08-02": 2.5, "2026-11-03": 0.75 }, { "2026-11-03": { "gpt-5.1": { cost: 0.75, requests: 1, input: 100, output: 50, cached: 0 } } });
    assert.deepEqual(entry, {
      currency: "USD",
      days: { "2026-08-01": 1, "2026-08-02": 2.5, "2026-11-03": 0.75 },
      usage: { "2026-11-03": { "gpt-5.1": { cost: 0.75, requests: 1, input: 100, output: 50, cached: 0 } } },
    });
    assert.deepEqual(await createSpendLog({ file }).get("openai-api"), entry, "kept on disk");
    assert.equal(await log.get("azure-openai"), null);
    // Summaries count only the periods asked for.
    assert.deepEqual(summarizeSpend(entry.days, NOW), { today: 0.75, week: 0.75, month: 0.75, calendarMonth: 0.75 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cost line items map to models, whatever their wording", () => {
  assert.equal(lineItemModel("gpt-5.1, input"), "gpt-5.1");
  assert.equal(lineItemModel("gpt-4o-mini-2024-07-18, cached input"), "gpt-4o-mini-2024-07-18");
  assert.equal(lineItemModel("chatgpt-image-latest image, output"), "chatgpt-image-latest");
  assert.equal(lineItemModel("chatgpt-image-latest text, input"), "chatgpt-image-latest");
  assert.equal(lineItemModel("gpt-6-luna, cache writes - 12hr"), "gpt-6-luna");
  assert.equal(lineItemModel("web search tool calls"), "web search tool calls");
  assert.equal(lineItemModel(null), "other");
});
