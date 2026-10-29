import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEEPSEEK_KEY_NAME, fetchDeepseekBalance, summarizeSpending } from "./deepseek-balance.mjs";
import { BUILTIN_DEEPSEEK_PRICES, priceInfo } from "./deepseek-pricing.mjs";
import { aggregateDeepseekSession, dayKey, decodeDeepseekSessionLog, listDeepseekSessionLogs } from "./usage-stats.mjs";

// DeepSeek Harness (DeepSeek's desktop agent app) bills by the token from a prepaid balance, so
// it has no quota to show: its card shows how many tokens this computer's Harness sessions used,
// read from the session logs under $DSH_HOME/sessions. With an API key the user saved in
// Settings (server/secret-store.mjs) it also shows the API balance and the spending worked out
// from it (server/deepseek-balance.mjs). Harness's own credential store (`.credentials.yaml`)
// is never opened.

const harnessAppPaths = (platform = process.platform, env = process.env, home = os.homedir()) =>
  platform === "win32"
    ? [path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Programs", "DeepSeek Harness", "DeepSeek Harness.exe")]
    : ["/Applications/DeepSeek Harness.app", path.join(home, "Applications", "DeepSeek Harness.app")];

export const defaultDshHome = (env = process.env, home = os.homedir()) => env.DSH_HOME || path.join(home, ".dsh");

const DAY_MS = 86_400_000;
// How long a balance reading is reused before DeepSeek is asked again (the refresh button asks now).
const BALANCE_TTL_MS = 5 * 60_000;

/** Token and message totals for today and the last 7 and 30 days (today included). */
export function summarizeDeepseekUsage(aggregates, now = Date.now()) {
  const spans = { today: 1, week: 7, month: 30 };
  const firstDay = Object.fromEntries(Object.entries(spans).map(([id, days]) => [id, dayKey(now - (days - 1) * DAY_MS)]));
  const usage = Object.fromEntries(Object.keys(spans).map((id) => [id, { tokens: 0, messages: 0, cost: 0 }]));
  const today = dayKey(now);
  for (const aggregate of aggregates) {
    for (const [day, entry] of Object.entries(aggregate.days)) {
      if (day > today) continue;
      const tokens = Object.values(entry.models).reduce((sum, model) => sum + model.total, 0);
      const cost = Object.values(entry.models).reduce((sum, model) => sum + (model.cost ?? 0), 0);
      for (const id of Object.keys(spans)) {
        if (day < firstDay[id]) continue;
        usage[id].tokens += tokens;
        usage[id].messages += entry.messages;
        usage[id].cost = Math.round((usage[id].cost + cost) * 1_000_000) / 1_000_000;
      }
    }
  }
  return usage;
}

/**
 * Reads DeepSeek Harness usage for the quota view. Session logs are parsed again only when they
 * change, or when the prices do. `installed: false` hides DeepSeek for people without Harness.
 * `secrets` and `balanceLog` add the balance; without a saved key there is none. `priceBook`
 * (server/deepseek-price-book.mjs) supplies DeepSeek's current prices; without one the built-in
 * table applies.
 */
export function createDeepseekReader({
  dshHome = defaultDshHome(),
  appPaths = harnessAppPaths(),
  secrets = null,
  balanceLog = null,
  fetchImpl = fetch,
  priceBook = null,
} = {}) {
  const parsed = new Map();
  // The last balance DeepSeek returned, shown with its age while a later request fails.
  let lastBalance = null;
  let lastKey = null;

  async function readBalance(now, force) {
    const key = await secrets?.get(DEEPSEEK_KEY_NAME);
    if (!key) {
      lastBalance = null;
      return undefined;
    }
    let error = null;
    // The balance is a network request: a recent one is reused unless the refresh was forced.
    const recent = lastBalance && lastKey === key && now - lastBalance.readAt < BALANCE_TTL_MS;
    if (recent && !force) {
      const spending = balanceLog ? summarizeSpending(await balanceLog.readings(), now) : null;
      return { ...lastBalance, error, spending };
    }
    lastKey = key;
    try {
      const balance = await fetchDeepseekBalance(key, { fetchImpl });
      lastBalance = { ...balance, readAt: now };
      await balanceLog?.record(balance, now);
    } catch (failure) {
      error = failure.code ?? "deepseekBalanceUnavailable";
      if (error === "deepseekKeyInvalid") lastBalance = null;
    }
    const spending = balanceLog ? summarizeSpending(await balanceLog.readings(), now) : null;
    return { ...(lastBalance ?? {}), error, spending };
  }

  return async function readDeepseekUsage(now = Date.now(), { force = false } = {}) {
    const sessionsDir = path.join(dshHome, "sessions");
    const installed = appPaths.some((app) => existsSync(app)) || existsSync(sessionsDir);
    if (!installed) {
      return { id: "deepseek", name: "DeepSeek", connected: false, installed: false, account: null, source: null, limits: [] };
    }

    const balanceRead = readBalance(now, force);
    const prices = (await priceBook?.table()) ?? BUILTIN_DEEPSEEK_PRICES;
    const files = await listDeepseekSessionLogs(sessionsDir);
    const aggregates = [];
    for (const file of files) {
      const info = await stat(file).catch(() => null);
      if (!info) continue;
      const cached = parsed.get(file);
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size && cached.priceVersion === prices.version) {
        aggregates.push(cached.aggregate);
        continue;
      }
      try {
        const aggregate = aggregateDeepseekSession(decodeDeepseekSessionLog(await readFile(file), file), prices);
        parsed.set(file, { mtimeMs: info.mtimeMs, size: info.size, priceVersion: prices.version, aggregate });
        aggregates.push(aggregate);
      } catch {
        // Harness is still writing this log; its last reading (if any) stands until it settles.
        if (cached) aggregates.push(cached.aggregate);
      }
    }
    for (const file of parsed.keys()) if (!files.includes(file)) parsed.delete(file);

    return {
      id: "deepseek",
      name: "DeepSeek",
      connected: true,
      installed: true,
      account: "DeepSeek Harness",
      source: "DeepSeek Harness session logs",
      limits: [],
      usage: summarizeDeepseekUsage(aggregates, now),
      // Where the cost estimate's prices come from and when they were last checked.
      prices: priceInfo(prices),
      balance: await balanceRead,
    };
  };
}
