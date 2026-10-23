import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultDataDir } from "./secret-store.mjs";
import { dayKey } from "./usage-stats.mjs";

// The DeepSeek API balance, read with the API key the user saved in Settings through DeepSeek's
// documented endpoint (GET /user/balance). Spending is worked out from the balance readings
// TokenTide keeps (deepseek-balance.json): drops between readings are spending, rises are
// top-ups or grants. It covers the whole account, not only DeepSeek Harness.

export const DEEPSEEK_KEY_NAME = "deepseek-api-key";
const codedError = (code, message) => Object.assign(new Error(message), { code });
const BALANCE_URL = "https://api.deepseek.com/user/balance";
const BALANCE_TIMEOUT_MS = 10_000;
const LOG_VERSION = 1;
// Readings older than this are dropped; History looks back 90 days at most.
const LOG_DAYS = 120;
const DAY_MS = 86_400_000;

const amount = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** Maps a /user/balance response; CNY is preferred when the account holds several currencies. */
export function parseDeepseekBalance(body) {
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  const info = infos.find((item) => item?.currency === "CNY") ?? infos[0];
  const total = amount(info?.total_balance);
  if (!info || total === null) throw codedError("deepseekBalanceUnavailable", "DeepSeek returned no balance.");
  return {
    currency: typeof info.currency === "string" ? info.currency : "CNY",
    total,
    granted: amount(info.granted_balance),
    toppedUp: amount(info.topped_up_balance),
    // false when the balance cannot pay for API calls.
    available: body.is_available !== false,
  };
}

/** Asks DeepSeek for the balance; a rejected key is `deepseekKeyInvalid`. */
export async function fetchDeepseekBalance(key, { fetchImpl = fetch, timeoutMs = BALANCE_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetchImpl(BALANCE_URL, {
      headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw codedError("deepseekBalanceUnavailable", "DeepSeek could not be reached just now.");
  }
  if (response.status === 401 || response.status === 403) {
    throw codedError("deepseekKeyInvalid", "DeepSeek did not accept the API key.");
  }
  if (!response.ok) throw codedError("deepseekBalanceUnavailable", `DeepSeek answered ${response.status}.`);
  return parseDeepseekBalance(await response.json().catch(() => null));
}

/**
 * Spending per local day from balance readings (`{ at, currency, total }`, oldest first): every
 * drop is attributed to the day of the reading that saw it. A currency change starts over.
 */
export function spendingByDay(readings) {
  const days = {};
  for (let index = 1; index < readings.length; index += 1) {
    const [before, after] = [readings[index - 1], readings[index]];
    if (before.currency !== after.currency) continue;
    const drop = before.total - after.total;
    if (drop <= 0) continue;
    const day = dayKey(after.at);
    days[day] = Math.round(((days[day] ?? 0) + drop) * 10_000) / 10_000;
  }
  return days;
}

/**
 * The spending record: one entry per local day the balance moved (and the day readings start),
 * newest first: what was spent, what was added (top-ups, grants), and the balance at day's end.
 */
export function dailyLedger(readings) {
  const days = new Map();
  const entry = (reading) => {
    const date = dayKey(reading.at);
    if (!days.has(date)) days.set(date, { date, currency: reading.currency, spent: 0, added: 0, balance: reading.total });
    return days.get(date);
  };
  if (readings.length) entry(readings[0]);
  for (let index = 1; index < readings.length; index += 1) {
    const [before, after] = [readings[index - 1], readings[index]];
    const day = entry(after);
    day.balance = after.total;
    day.currency = after.currency;
    if (before.currency !== after.currency) continue;
    const change = after.total - before.total;
    if (change < 0) day.spent = Math.round((day.spent - change) * 10_000) / 10_000;
    else day.added = Math.round((day.added + change) * 10_000) / 10_000;
  }
  return [...days.values()].reverse();
}

/** Spending today and over the last 7 and 30 days, plus when the readings start. */
export function summarizeSpending(readings, now = Date.now()) {
  const byDay = spendingByDay(readings);
  const sum = (days) => {
    const first = dayKey(now - (days - 1) * DAY_MS);
    const total = Object.entries(byDay).reduce((value, [day, spent]) => (day >= first ? value + spent : value), 0);
    return Math.round(total * 100) / 100;
  };
  return { today: sum(1), week: sum(7), month: sum(30), since: readings[0]?.at ?? null };
}

/** The balance readings TokenTide has seen, kept only when the balance changes. */
export function createBalanceLog({ logPath = path.join(defaultDataDir(), "deepseek-balance.json") } = {}) {
  let readings = null;

  async function load() {
    if (readings) return;
    try {
      const stored = JSON.parse(await readFile(logPath, "utf8"));
      readings = stored.version === LOG_VERSION && Array.isArray(stored.readings) ? stored.readings : [];
    } catch {
      readings = [];
    }
  }

  async function persist() {
    try {
      await mkdir(path.dirname(logPath), { recursive: true });
      await writeFile(`${logPath}.tmp`, JSON.stringify({ version: LOG_VERSION, readings }), { mode: 0o600 });
      await rename(`${logPath}.tmp`, logPath);
    } catch {
      // Best effort: the next refresh records again.
    }
  }

  return {
    async record(balance, at = Date.now()) {
      await load();
      const last = readings.at(-1);
      if (last && last.currency === balance.currency && last.total === balance.total) return;
      readings = [...readings.filter((item) => item.at >= at - LOG_DAYS * DAY_MS), { at, currency: balance.currency, total: balance.total }];
      await persist();
    },
    async readings() {
      await load();
      return readings;
    },
    /** For History: the latest balance, when readings start, and spending per local day. */
    async history() {
      await load();
      const last = readings.at(-1);
      if (!last) return null;
      return {
        currency: last.currency,
        total: last.total,
        at: last.at,
        since: readings[0].at,
        byDay: spendingByDay(readings),
        ledger: dailyLedger(readings),
      };
    },
    // A new key may belong to another account, so its readings start over.
    async clear() {
      readings = [];
      await persist();
    },
  };
}
