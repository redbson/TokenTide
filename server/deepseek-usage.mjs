import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEEPSEEK_KEY_NAME, fetchDeepseekBalance, summarizeSpending } from "./deepseek-balance.mjs";
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

/** Token and message totals for today and the last 7 and 30 days (today included). */
export function summarizeDeepseekUsage(aggregates, now = Date.now()) {
  const spans = { today: 1, week: 7, month: 30 };
  const firstDay = Object.fromEntries(Object.entries(spans).map(([id, days]) => [id, dayKey(now - (days - 1) * DAY_MS)]));
  const usage = Object.fromEntries(Object.keys(spans).map((id) => [id, { tokens: 0, messages: 0 }]));
  const today = dayKey(now);
  for (const aggregate of aggregates) {
    for (const [day, entry] of Object.entries(aggregate.days)) {
      if (day > today) continue;
      const tokens = Object.values(entry.models).reduce((sum, model) => sum + model.total, 0);
      for (const id of Object.keys(spans)) {
        if (day < firstDay[id]) continue;
        usage[id].tokens += tokens;
        usage[id].messages += entry.messages;
      }
    }
  }
  return usage;
}

/**
 * Reads DeepSeek Harness usage for the quota view. Session logs are parsed again only when they
 * change. `installed: false` hides DeepSeek for people without Harness. `secrets` and
 * `balanceLog` add the balance; without a saved key there is none.
 */
export function createDeepseekReader({
  dshHome = defaultDshHome(),
  appPaths = harnessAppPaths(),
  secrets = null,
  balanceLog = null,
  fetchImpl = fetch,
} = {}) {
  const parsed = new Map();
  // The last balance DeepSeek returned, shown with its age while a later request fails.
  let lastBalance = null;

  async function readBalance(now) {
    const key = await secrets?.get(DEEPSEEK_KEY_NAME);
    if (!key) {
      lastBalance = null;
      return undefined;
    }
    let error = null;
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

  return async function readDeepseekUsage(now = Date.now()) {
    const sessionsDir = path.join(dshHome, "sessions");
    const installed = appPaths.some((app) => existsSync(app)) || existsSync(sessionsDir);
    if (!installed) {
      return { id: "deepseek", name: "DeepSeek", connected: false, installed: false, account: null, source: null, limits: [] };
    }

    const balanceRead = readBalance(now);
    const files = await listDeepseekSessionLogs(sessionsDir);
    const aggregates = [];
    for (const file of files) {
      const info = await stat(file).catch(() => null);
      if (!info) continue;
      const cached = parsed.get(file);
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
        aggregates.push(cached.aggregate);
        continue;
      }
      try {
        const aggregate = aggregateDeepseekSession(decodeDeepseekSessionLog(await readFile(file), file));
        parsed.set(file, { mtimeMs: info.mtimeMs, size: info.size, aggregate });
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
      balance: await balanceRead,
    };
  };
}
