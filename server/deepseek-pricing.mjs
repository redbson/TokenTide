import { createHash } from "node:crypto";

// DeepSeek API prices, in yuan per million tokens at peak hours. Off-peak is half. Peak is
// 9:00–12:00 and 14:00–18:00 Beijing time, Monday to Friday; Chinese public holidays are
// off-peak all day, but they are not known here, so a weekday holiday is priced as a working day.
//
// The service refreshes the table from DeepSeek's page once a day while DeepSeek is shown
// (server/deepseek-price-book.mjs). The built-in table below, from
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing as checked on its `checkedAt` date,
// is used until a valid table has been fetched. Update it (and the date) when DeepSeek's
// page changes.
//
// Costs worked out from these are estimates: DeepSeek's bill is the record.

export const BUILTIN_DEEPSEEK_PRICES = withVersion({
  source: "builtin",
  checkedAt: Date.UTC(2026, 9, 23, 12),
  models: {
    "deepseek-flash": { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    "deepseek-v4-pro": { cacheHit: 0.3, cacheMiss: 9, output: 27 },
  },
  // Retired names DeepSeek still serves and bills as Flash.
  aliases: { "deepseek-v4-flash": "deepseek-flash", "deepseek-v4-flash-vision-exp": "deepseek-flash" },
});

/** Adds `version`: a short hash of the prices, so cached costs can tell when they changed. */
export function withVersion(table) {
  const prices = JSON.stringify({ models: table.models, aliases: table.aliases });
  return { ...table, version: createHash("sha256").update(prices).digest("hex").slice(0, 12) };
}

/** What the panel says about a table: where it came from and when it was last checked. */
export const priceInfo = (table) => ({ source: table.source, checkedAt: table.checkedAt });

const BEIJING_OFFSET_MS = 8 * 3_600_000;

/** Whether `timestamp` falls in DeepSeek's peak hours (weekday 9–12, 14–18 Beijing time). */
export function isDeepseekPeak(timestamp) {
  const beijing = new Date(timestamp + BEIJING_OFFSET_MS);
  const day = beijing.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
}

/** The peak prices for `model` in `table`, or null for a model DeepSeek's page does not list. */
export function deepseekPrices(model, table = BUILTIN_DEEPSEEK_PRICES) {
  const id = String(model ?? "").toLowerCase();
  return table.models[table.aliases?.[id] ?? id] ?? null;
}

/**
 * The estimated cost in yuan of one reply: cache-hit input, cache-miss input (uncached plus any
 * cache write), and output, at the price of the hour it was made. Null for an unlisted model.
 */
export function deepseekCost(model, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }, timestamp, table) {
  const prices = deepseekPrices(model, table);
  if (!prices || !Number.isFinite(timestamp)) return null;
  const factor = isDeepseekPeak(timestamp) ? 1 : 0.5;
  const yuan = (cacheRead * prices.cacheHit + (input + cacheWrite) * prices.cacheMiss + output * prices.output) / 1_000_000;
  return Math.round(yuan * factor * 1_000_000) / 1_000_000;
}
