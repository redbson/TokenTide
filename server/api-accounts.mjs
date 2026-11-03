import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultDataDir } from "./secret-store.mjs";
import { makeLimit } from "./usage-service.mjs";
import { resolveCommand } from "./commands.mjs";

// API accounts: what the OpenAI API, the Claude API, and Azure OpenAI cost this month. None of
// them documents an API for a prepaid balance, so these cards show spend for the billing month
// (UTC calendar month) and, where the provider has one (OpenAI's monthly spend limit), how much
// of the limit is left. Sources (checked 2026-11-03):
//   OpenAI     GET /v1/organization/costs and /v1/organization/spend_limit, organization admin key
//   Anthropic  GET /v1/organizations/cost_report, admin key (amounts are cents as decimal strings)
//   Azure      Cost Management query (MonthToDate), with a token from the signed-in Azure CLI or a
//              service principal in AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET.
// Keys come from Settings or the environment (server/env-credentials.mjs) and never leave here.

const TIMEOUT_MS = 15_000;
// OpenAI and Anthropic cost data is near real time; Azure's arrives hours late and its API
// allows few queries, so it is asked rarely, and a forced refresh still waits an hour.
const SPEND_TTL_MS = 5 * 60_000;
const AZURE_TTL_MS = 6 * 3_600_000;
const AZURE_FORCED_TTL_MS = 3_600_000;
const AZURE_API_VERSION = "2026-06-01";
// How far back each read asks for daily costs; the spend log keeps the rest.
const HISTORY_DAYS = 90;
// "Not set up" and failures are checked again sooner: a new sign-in should show up quickly,
// but a throttled or failing Azure must not be asked every minute.
const ABSENT_TTL_MS = 10 * 60_000;
const AZURE_FAILURE_TTL_MS = 15 * 60_000;
// Azure OpenAI appears under the Cognitive Services service name (Foundry for newer resources).
const AZURE_SERVICES = ["Cognitive Services", "Foundry Models", "Azure OpenAI"];

const codedError = (code, message) => Object.assign(new Error(message), { code });

/** Midnight UTC on the first of this month, and of today. */
export function billingPeriod(now = Date.now()) {
  const date = new Date(now);
  return {
    monthStart: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    dayStart: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    monthEnd: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  };
}

const round = (value) => Math.round(value * 100) / 100;
const DAY_MS = 86_400_000;
/** A day key (`2026-11-03`) for a timestamp, in UTC: providers bill by UTC day. */
export const utcDay = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);

/**
 * Totals per UTC day (`{ "2026-11-03": 0.75 }`) summarized: today, the last 7 and 30 days,
 * and this calendar month. `days` may hold more history than the periods need.
 */
export function summarizeSpend(days, now = Date.now()) {
  const { monthStart } = billingPeriod(now);
  const today = utcDay(now);
  const since = (count) => utcDay(now - (count - 1) * DAY_MS);
  const sum = (from) => round(Object.entries(days).reduce((total, [day, amount]) => (day >= from && day <= today ? total + amount : total), 0));
  return { today: sum(today), week: sum(since(7)), month: sum(since(30)), calendarMonth: sum(utcDay(monthStart)) };
}

const addDay = (days, day, amount) => {
  days[day] = round((days[day] ?? 0) + amount);
};

async function getJson(fetchImpl, url, headers, label) {
  let response;
  try {
    response = await fetchImpl(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw codedError("accountUnreachable", `${label} could not be reached.`);
  }
  if (response.status === 401 || response.status === 403) throw codedError("accountKeyInvalid", `${label} did not accept the key.`);
  if (!response.ok) throw codedError("accountUnavailable", `${label} answered ${response.status}.`);
  return response.json();
}

/** Daily cost buckets as totals per UTC day (`amountOf` reads one result, `startOf` a bucket). */
function bucketsByDay(buckets, amountOf, startOf) {
  const days = {};
  for (const bucket of buckets) {
    const total = (bucket.results ?? []).reduce((sum, result) => sum + amountOf(result), 0);
    if (total) addDay(days, utcDay(startOf(bucket)), total);
  }
  return days;
}

/** OpenAI: daily costs for the last HISTORY_DAYS, and the monthly spend limit if one is set. */
export async function readOpenAiSpend(key, { fetchImpl = fetch, now = Date.now() } = {}) {
  const headers = { Authorization: `Bearer ${key}` };
  const start = Date.parse(utcDay(now - (HISTORY_DAYS - 1) * DAY_MS));
  const buckets = [];
  let page = null;
  do {
    const query = new URLSearchParams({ start_time: String(start / 1000), bucket_width: "1d", limit: "180" });
    if (page) query.set("page", page);
    const body = await getJson(fetchImpl, `https://api.openai.com/v1/organization/costs?${query}`, headers, "OpenAI");
    buckets.push(...(body.data ?? []));
    page = body.has_more ? body.next_page : null;
  } while (page && buckets.length < 400);
  const days = bucketsByDay(buckets, (result) => Number(result.amount?.value) || 0, (bucket) => bucket.start_time * 1000);
  const currency = (buckets.flatMap((bucket) => bucket.results ?? [])[0]?.amount?.currency ?? "usd").toUpperCase();

  // The spend limit is optional; an organization without one (or a key without access) has none.
  let limit = null;
  try {
    const body = await getJson(fetchImpl, "https://api.openai.com/v1/organization/spend_limit", headers, "OpenAI");
    const cents = Number(body?.threshold_amount);
    if (Number.isFinite(cents) && cents > 0 && (body.interval ?? "month") === "month") {
      limit = { amount: cents / 100, currency: (body.currency ?? currency).toUpperCase(), enforced: body.enforcement?.status === "enforcing" };
    }
  } catch {
    // No limit to show.
  }
  return { currency, days, limit };
}

/** Anthropic: daily costs for the last HISTORY_DAYS from the cost report (amounts are cents). */
export async function readAnthropicSpend(key, { fetchImpl = fetch, now = Date.now() } = {}) {
  const headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
  const buckets = [];
  const start = Date.parse(utcDay(now - (HISTORY_DAYS - 1) * DAY_MS));
  let page = null;
  do {
    // The report returns at most 31 buckets per request; `page` continues it.
    const query = new URLSearchParams({ starting_at: new Date(start).toISOString(), bucket_width: "1d", limit: "31" });
    if (page) query.set("page", page);
    const body = await getJson(fetchImpl, `https://api.anthropic.com/v1/organizations/cost_report?${query}`, headers, "Anthropic");
    buckets.push(...(body.data ?? []));
    page = body.has_more ? body.next_page : null;
  } while (page && buckets.length < 400);
  const days = bucketsByDay(buckets, (result) => (Number(result.amount) || 0) / 100, (bucket) => Date.parse(bucket.starting_at));
  const currency = buckets.flatMap((bucket) => bucket.results ?? [])[0]?.currency ?? "USD";
  return { currency, days, limit: null };
}

/** Runs the Azure CLI and parses its JSON output; null when it isn't installed or signed in. */
function runAz(args, { env = process.env } = {}) {
  const command = resolveCommand("az", { env, extraDirs: ["/opt/homebrew/bin", "/usr/local/bin"] });
  if (!command) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(command, [...args, "--output", "json"], { stdio: ["ignore", "pipe", "ignore"], env, windowsHide: true, shell: /\.(cmd|bat)$/i.test(command) });
    let output = "";
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", () => resolve(null));
    child.once("close", (code) => {
      clearTimeout(timer);
      try {
        resolve(code === 0 ? JSON.parse(output) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * A management-plane token for Azure: a service principal from the environment, else the
 * signed-in Azure CLI. `{ token, subscription }`, or null when neither is available.
 */
export async function azureToken({ envCredentials, fetchImpl = fetch, az = runAz } = {}) {
  const get = async (name) => (await envCredentials?.find([name]))?.value ?? null;
  const [tenant, client, secret, subscriptionFromEnv] = await Promise.all(
    ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_SUBSCRIPTION_ID"].map(get),
  );
  if (tenant && client && secret) {
    let response;
    try {
      response = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: client, client_secret: secret, scope: "https://management.azure.com/.default", grant_type: "client_credentials" }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw codedError("accountUnreachable", "Azure sign-in could not be reached.");
    }
    if (!response.ok) throw codedError("accountKeyInvalid", "Azure did not accept the service principal.");
    const body = await response.json();
    if (!subscriptionFromEnv) throw codedError("azureNoSubscription", "Set AZURE_SUBSCRIPTION_ID for the service principal.");
    return { token: body.access_token, subscription: subscriptionFromEnv, via: "servicePrincipal" };
  }
  const token = await az(["account", "get-access-token", "--resource", "https://management.azure.com/"]);
  if (!token?.accessToken) return null;
  const subscription = subscriptionFromEnv ?? token.subscription ?? (await az(["account", "show"]))?.id;
  if (!subscription) throw codedError("azureNoSubscription", "No Azure subscription is selected.");
  return { token: token.accessToken, subscription, via: "cli" };
}

/** Azure: this month's Azure OpenAI (Cognitive Services) cost for the subscription, by day. */
export async function readAzureSpend({ token, subscription }, { fetchImpl = fetch, now = Date.now() } = {}) {
  const from = utcDay(now - (HISTORY_DAYS - 1) * DAY_MS);
  const url = `https://management.azure.com/subscriptions/${encodeURIComponent(subscription)}/providers/Microsoft.CostManagement/query?api-version=${AZURE_API_VERSION}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        type: "ActualCost",
        timeframe: "Custom",
        timePeriod: { from: `${from}T00:00:00Z`, to: `${utcDay(now)}T23:59:59Z` },
        dataset: {
          granularity: "Daily",
          aggregation: { totalCost: { name: "PreTaxCost", function: "Sum" } },
          filter: { dimensions: { name: "ServiceName", operator: "In", values: AZURE_SERVICES } },
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw codedError("accountUnreachable", "Azure Cost Management could not be reached.");
  }
  if (response.status === 401 || response.status === 403) throw codedError("azureNoAccess", "Azure needs the Cost Management Reader role.");
  if (response.status === 429) throw codedError("azureThrottled", "Azure Cost Management is busy.");
  if (!response.ok) throw codedError("accountUnavailable", `Azure answered ${response.status}.`);
  const properties = (await response.json())?.properties ?? {};
  const columns = (properties.columns ?? []).map((column) => column.name);
  const costAt = columns.findIndex((name) => /cost/i.test(name));
  const dateAt = columns.indexOf("UsageDate");
  const currencyAt = columns.indexOf("Currency");
  const days = {};
  let currency = "USD";
  for (const row of properties.rows ?? []) {
    const cost = Number(row[costAt]) || 0;
    // UsageDate comes as 20261103.
    const date = dateAt >= 0 ? String(row[dateAt]).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3") : utcDay(now);
    if (cost) addDay(days, date, cost);
    if (currencyAt >= 0 && row[currencyAt]) currency = row[currencyAt];
  }
  return { currency, days, limit: null };
}

/**
 * Spend per day per account, kept in spend-history.json so History reaches further back than
 * the providers' own windows. Each read merges its days in (a provider's later figure for a day
 * replaces the earlier one); nothing is ever dropped.
 */
export function createSpendLog({ file = path.join(defaultDataDir(), "spend-history.json") } = {}) {
  let accounts = null;

  async function load() {
    if (accounts) return;
    try {
      const stored = JSON.parse(await readFile(file, "utf8"));
      accounts = stored.version === 1 && stored.accounts ? stored.accounts : {};
    } catch {
      accounts = {};
    }
  }

  async function persist() {
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify({ version: 1, accounts }), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    } catch {
      // Best effort: the next read records again.
    }
  }

  return {
    async record(id, currency, days) {
      await load();
      const entry = (accounts[id] ??= { currency, days: {} });
      const before = JSON.stringify(entry);
      entry.currency = currency;
      Object.assign(entry.days, days);
      if (JSON.stringify(entry) !== before) await persist();
      return entry;
    },
    async get(id) {
      await load();
      return accounts[id] ?? null;
    },
  };
}

const META = {
  "openai-api": { name: "OpenAI API", key: "openai-admin" },
  "anthropic-api": { name: "Claude API", key: "anthropic-admin" },
  "azure-openai": { name: "Azure OpenAI" },
};

/** A provider entry for the quota view from a spend reading. */
function accountProvider(id, spend, readAt, extra = {}) {
  const totals = summarizeSpend(spend.days, readAt);
  const limits = spend.limit
    ? [makeLimit("monthly", "Monthly limit", Math.min(100, (totals.calendarMonth / spend.limit.amount) * 100), Math.floor(billingPeriod(readAt).monthEnd / 1000))]
    : [];
  return {
    id,
    name: META[id].name,
    connected: true,
    installed: true,
    account: extra.account ?? "API account",
    source: extra.source ?? null,
    limits,
    spend: { currency: spend.currency, ...totals, limit: spend.limit, readAt },
    ...extra,
  };
}

/**
 * Reads every configured API account. Unconfigured ones come back `installed: false`, so the
 * panel hides them. Readings are cached (SPEND_TTL_MS; Azure AZURE_TTL_MS) unless forced.
 */
export function createApiAccountsReader({ keys, envCredentials, fetchImpl = fetch, az = runAz, spendLog = null } = {}) {
  const cache = new Map();

  async function cached(id, ttlMs, read) {
    const hit = cache.get(id);
    const ttl = hit?.value.installed === false ? Math.min(ttlMs, ABSENT_TTL_MS) : hit?.value.connected === false ? Math.min(ttlMs, AZURE_FAILURE_TTL_MS) : ttlMs;
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = await read();
    cache.set(id, { at: Date.now(), value });
    return value;
  }

  const absent = (id) => ({ id, name: META[id].name, connected: false, installed: false, account: null, source: null, limits: [] });
  const failed = (id, error, extra = {}) => ({
    id,
    name: META[id].name,
    connected: false,
    installed: true,
    account: "Unavailable",
    source: null,
    limits: [],
    error: error.message,
    errorCode: error.code ?? "accountUnavailable",
    ...extra,
  });

  async function keyAccount(id, readSpend, force) {
    const key = await keys.resolve(META[id].key);
    if (!key) return absent(id);
    const extra = { keySource: key.source, keyVariable: key.variable ?? null };
    try {
      return await cached(`${id}:${key.value.slice(-6)}`, force ? 0 : SPEND_TTL_MS, async () => {
        const spend = await readSpend(key.value, { fetchImpl });
        const logged = await spendLog?.record(id, spend.currency, spend.days);
        return accountProvider(id, { ...spend, days: logged?.days ?? spend.days }, Date.now(), { ...extra, account: "Organization" });
      });
    } catch (error) {
      return failed(id, error, extra);
    }
  }

  function azureAccount(force) {
    return cached("azure-openai", force ? AZURE_FORCED_TTL_MS : AZURE_TTL_MS, async () => {
      try {
        const credentials = await azureToken({ envCredentials, fetchImpl, az });
        if (!credentials) return absent("azure-openai");
        const spend = await readAzureSpend(credentials, { fetchImpl });
        const logged = await spendLog?.record("azure-openai", spend.currency, spend.days);
        // Azure's cost data lags by hours (up to three days on pay-as-you-go).
        return accountProvider("azure-openai", { ...spend, days: logged?.days ?? spend.days }, Date.now(), { account: credentials.via === "cli" ? "Azure CLI" : "Service principal", delayed: true });
      } catch (error) {
        return failed("azure-openai", error);
      }
    });
  }

  return async function readApiAccounts({ force = false } = {}) {
    return Promise.all([
      keyAccount("openai-api", readOpenAiSpend, force),
      keyAccount("anthropic-api", readAnthropicSpend, force),
      azureAccount(force),
    ]);
  };
}

export const API_ACCOUNT_IDS = Object.keys(META);
