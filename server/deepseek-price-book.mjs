import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { BUILTIN_DEEPSEEK_PRICES, withVersion } from "./deepseek-pricing.mjs";
import { defaultDataDir } from "./secret-store.mjs";

// Keeps DeepSeek's prices current without a TokenTide release: at most once a day, and only
// while DeepSeek is shown, the service reads DeepSeek's public pricing page (a plain GET, no key
// or cookie), takes the price table out of it, and keeps it in deepseek-prices.json once it
// passes the checks below. A failed fetch or a table that does not pass keeps the last good
// prices; with none, the built-in table in deepseek-pricing.mjs applies. Prices are never guessed.

export const DEEPSEEK_PRICING_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
const FETCH_TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 2_000_000;
const STORE_VERSION = 1;
const DAY_MS = 86_400_000;
// Far above any real price; a larger number means the page was misread.
const MAX_PRICE = 1000;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The page as text: one line per table row or paragraph, table cells separated by tabs. */
export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    // Footnote markers such as deepseek-flash<sup>(1)</sup>.
    .replace(/<sup\b[\s\S]*?<\/sup>/gi, "")
    .replace(/<br\s*\/?>/gi, "")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<\/(tr|p|div|li|h\d|table|section)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) =>
      name[0] === "#"
        ? String.fromCodePoint(name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1)))
        : (ENTITIES[name.toLowerCase()] ?? entity),
    )
    .replace(/​/g, "");
}

const normalize = (cell) => cell.replace(/\s+/g, "").replace(/（/g, "(").replace(/）/g, ")");
const PRICE_KINDS = {
  "百万tokens输入(缓存命中)": "cacheHit",
  "百万tokens输入(缓存未命中)": "cacheMiss",
  百万tokens输出: "output",
};
const PERIODS = { 空闲时段: "offPeak", 高峰时段: "peak" };
const MODEL_NAME = /^deepseek-[a-z0-9][a-z0-9.-]*$/;

/**
 * Reads the price table out of the page's text: the `模型` row names the models, and each
 * price row (`百万tokens输入（缓存命中）` and so on) has an off-peak (`空闲时段`) and a peak
 * (`高峰时段`) line with one `N元` per model. Returns `{ models: { name: { peak, offPeak } },
 * aliases }`, or null when no model row is found. A price that does not read as `N元` is left
 * out, so validation rejects the table.
 */
export function parseDeepseekPricing(text) {
  const rows = String(text)
    .split("\n")
    .map((line) => line.split("\t").map((cell) => cell.trim()).filter(Boolean))
    .filter((cells) => cells.length);

  const header = rows.findIndex((cells) => cells[0] === "模型" && cells.length > 1 && cells.slice(1).every((cell) => MODEL_NAME.test(cell)));
  if (header < 0) return null;
  const names = rows[header].slice(1);
  const models = Object.fromEntries(names.map((name) => [name, { peak: {}, offPeak: {} }]));

  let kind = null;
  for (const cells of rows.slice(header + 1)) {
    if (cells[0] === "模型") break;
    const label = cells.map(normalize).find((cell) => cell in PRICE_KINDS);
    if (label) kind = PRICE_KINDS[label];
    const periodAt = cells.findIndex((cell) => cell in PERIODS);
    if (periodAt < 0) {
      kind = null;
      continue;
    }
    if (!kind) continue;
    const values = cells.slice(periodAt + 1);
    if (values.length !== names.length) continue;
    values.forEach((value, index) => {
      const match = /^(\d+(?:\.\d+)?)\s*元$/.exec(value);
      if (match) models[names[index]][PERIODS[cells[periodAt]]][kind] = Number(match[1]);
    });
  }

  return { models, aliases: parseAliases(text, names) };
}

/**
 * The retired names the page's note says are billed at another model's price, e.g. "旧模型名
 * deepseek-v4-flash、deepseek-v4-flash-vision-exp 仍可调用 … 并按 Flash 价格计费".
 */
function parseAliases(text, names) {
  const aliases = {};
  for (const line of String(text).split("\n")) {
    const start = line.indexOf("旧模型名");
    const billed = /按\s*([A-Za-z0-9.-]+)\s*价格计费/.exec(line);
    if (start < 0 || !billed) continue;
    const targets = names.filter((name) => name.includes(billed[1].toLowerCase()));
    if (targets.length !== 1) continue;
    const end = line.indexOf("仍可调用", start);
    const listed = line.slice(start, end > start ? end : billed.index).match(/deepseek-[a-z0-9][a-z0-9.-]*[a-z0-9]/g) ?? [];
    for (const name of listed) if (!names.includes(name)) aliases[name] = targets[0];
  }
  return aliases;
}

const isPrice = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_PRICE;
const KINDS = Object.values(PRICE_KINDS);

/**
 * The peak price table `{ models: { name: { cacheHit, cacheMiss, output } }, aliases }` when the
 * parsed page passes every check, otherwise null: at least one model, all three peak prices
 * positive for every model, and each off-peak price half its peak price (the cost estimate
 * relies on that, as DeepSeek's page states it).
 */
export function validateDeepseekPricing(parsed) {
  const entries = Object.entries(parsed?.models ?? {});
  if (!entries.length) return null;
  const models = {};
  for (const [name, { peak = {}, offPeak = {} } = {}] of entries) {
    if (!MODEL_NAME.test(name)) return null;
    for (const kind of KINDS) {
      if (!isPrice(peak[kind]) || !isPrice(offPeak[kind])) return null;
      if (Math.abs(offPeak[kind] * 2 - peak[kind]) > 1e-9 * Math.max(1, peak[kind])) return null;
    }
    models[name] = { cacheHit: peak.cacheHit, cacheMiss: peak.cacheMiss, output: peak.output };
  }
  const aliases = {};
  for (const [alias, target] of Object.entries(parsed.aliases ?? {})) {
    if (MODEL_NAME.test(alias) && target in models && !(alias in models)) aliases[alias] = target;
  }
  return { models, aliases };
}

/** A stored table (`{ models, aliases }` of peak prices) when it still passes the checks. */
function validStored(stored) {
  if (!stored?.models || typeof stored.models !== "object") return null;
  // Stored prices are peak only; off-peak is half by definition.
  const asParsed = Object.fromEntries(
    Object.entries(stored.models).map(([name, peak]) => [
      name,
      { peak, offPeak: Object.fromEntries(KINDS.map((kind) => [kind, peak?.[kind] / 2])) },
    ]),
  );
  return validateDeepseekPricing({ models: asParsed, aliases: stored.aliases });
}

/** The built-in aliases whose model the fetched table still lists, then the page's own. */
function withBuiltinAliases({ models, aliases }) {
  const builtin = Object.entries(BUILTIN_DEEPSEEK_PRICES.aliases).filter(([alias, target]) => target in models && !(alias in models));
  return { models, aliases: { ...Object.fromEntries(builtin), ...aliases } };
}

/** Fetches and checks DeepSeek's pricing page; resolves the peak table or null. Never throws. */
export async function fetchDeepseekPricing({ fetchImpl = fetch, url = DEEPSEEK_PRICING_URL, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  try {
    const response = await fetchImpl(url, { headers: { Accept: "text/html" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const html = await response.text();
    if (html.length > PAGE_LIMIT) return null;
    return validateDeepseekPricing(parseDeepseekPricing(htmlToText(html)));
  } catch {
    return null;
  }
}

/**
 * The prices costs are worked out with. `table()` resolves the current table (`source`
 * "deepseek" with the time it was last confirmed on DeepSeek's page, or "builtin"), each with a
 * `version` that changes with the prices. `refreshIfDue()` checks DeepSeek's page when the last
 * check (successful or not) is a day old, and resolves whether the prices changed.
 */
export function createDeepseekPriceBook({
  storePath = path.join(defaultDataDir(), "deepseek-prices.json"),
  fetchImpl = fetch,
  url = DEEPSEEK_PRICING_URL,
} = {}) {
  let loaded = null;
  let stored = null;
  let attemptedAt = 0;
  let current = BUILTIN_DEEPSEEK_PRICES;
  let inFlight = null;

  function apply() {
    current = stored ? withVersion({ source: "deepseek", checkedAt: stored.checkedAt, ...withBuiltinAliases(stored) }) : BUILTIN_DEEPSEEK_PRICES;
  }

  function load() {
    loaded ??= (async () => {
      try {
        const file = JSON.parse(await readFile(storePath, "utf8"));
        if (file?.version !== STORE_VERSION) return;
        attemptedAt = Number.isFinite(file.attemptedAt) ? file.attemptedAt : 0;
        const table = validStored(file);
        if (table && Number.isFinite(file.checkedAt)) stored = { ...table, checkedAt: file.checkedAt };
      } catch {
        // Nothing stored yet (or unreadable): the built-in table applies.
      }
      apply();
    })();
    return loaded;
  }

  async function persist() {
    try {
      await mkdir(path.dirname(storePath), { recursive: true });
      const file = { version: STORE_VERSION, attemptedAt, ...(stored ?? {}) };
      await writeFile(`${storePath}.tmp`, JSON.stringify(file, null, 2), { mode: 0o600 });
      await rename(`${storePath}.tmp`, storePath);
    } catch {
      // Best effort: the prices still apply for this run.
    }
  }

  async function refresh(now) {
    const before = current.version;
    attemptedAt = now;
    const table = await fetchDeepseekPricing({ fetchImpl, url });
    if (table) {
      stored = { ...table, checkedAt: now };
      apply();
    }
    await persist();
    return current.version !== before;
  }

  return {
    async table() {
      await load();
      return current;
    },

    async refreshIfDue(now = Date.now()) {
      await load();
      if (inFlight) return inFlight;
      // A clock set back makes the last check look like it is in the future: check again.
      if (attemptedAt && now >= attemptedAt && now - attemptedAt < DAY_MS) return false;
      inFlight = refresh(now).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
