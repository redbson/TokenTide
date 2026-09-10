import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Weekly quota windows for the 使用率 view. A reading is one observation of a weekly
// window: { resetsAt (epoch seconds), usedPercent, at (epoch ms) }. A window's utilization
// is the highest reading seen before it resets.

const WEEKLY_MINUTES = 10_080;
const LOG_VERSION = 1;
// The same window's reset time jitters by a few minutes between readings.
const SAME_WINDOW_SECONDS = 3600;
// Some Codex snapshots carry a zero or missing reset time; anything before 2020 is not real.
const EARLIEST_RESET = Date.UTC(2020, 0, 1) / 1000;

const isValidReading = (reading) =>
  Boolean(reading) &&
  Number.isFinite(reading.resetsAt) &&
  reading.resetsAt > EARLIEST_RESET &&
  Number.isFinite(reading.usedPercent);

/** The weekly window from a Codex `rate_limits` snapshot (rollout `token_count` events). */
export function extractCodexWeeklyReading(rateLimits, at) {
  if (!rateLimits || typeof rateLimits !== "object") return null;
  // Other limit ids (e.g. "premium") are separate quotas, not the Codex plan.
  if (rateLimits.limit_id && rateLimits.limit_id !== "codex") return null;
  const weekly = [rateLimits.secondary, rateLimits.primary].find(
    (window) => window && Math.abs(Number(window.window_minutes) - WEEKLY_MINUTES) <= 1,
  );
  const reading = { resetsAt: Number(weekly?.resets_at), usedPercent: Number(weekly?.used_percent), at };
  if (!isValidReading(reading)) return null;
  return { ...reading, usedPercent: Math.min(100, Math.max(0, reading.usedPercent)) };
}

/** The weekly limit from a provider entry returned by the usage service. */
export function weeklyReadingFromProvider(provider, at) {
  const weekly = provider?.connected ? provider.limits?.find((limit) => limit.id === "weekly") : null;
  const reading = { resetsAt: weekly?.resetsAt, usedPercent: weekly?.usedPercent, at };
  return isValidReading(reading) ? reading : null;
}

/** Collapses readings that share a reset minute, keeping the peak and the observed span. */
export function compactReadings(readings) {
  const byMinute = new Map();
  for (const reading of readings) {
    if (!isValidReading(reading)) continue;
    const key = Math.round(reading.resetsAt / 60);
    const first = reading.firstAt ?? reading.at;
    const last = reading.lastAt ?? reading.at;
    const existing = byMinute.get(key);
    if (!existing) {
      byMinute.set(key, { resetsAt: reading.resetsAt, usedPercent: reading.usedPercent, firstAt: first, lastAt: last });
      continue;
    }
    existing.usedPercent = Math.max(existing.usedPercent, reading.usedPercent);
    existing.firstAt = Math.min(existing.firstAt, first);
    existing.lastAt = Math.max(existing.lastAt, last);
    if (last >= existing.lastAt) existing.resetsAt = reading.resetsAt;
  }
  return [...byMinute.values()];
}

/**
 * Groups readings into weekly windows, oldest first. Readings whose reset times fall within
 * an hour of each other belong to the same window.
 */
export function buildWeeklyWindows(readings) {
  const sorted = compactReadings(readings).sort((a, b) => a.resetsAt - b.resetsAt);
  const windows = [];
  for (const reading of sorted) {
    const current = windows.at(-1);
    if (current && reading.resetsAt - current.resetsAt <= SAME_WINDOW_SECONDS) {
      current.usedPercent = Math.max(current.usedPercent, reading.usedPercent);
      current.firstAt = Math.min(current.firstAt, reading.firstAt);
      current.lastAt = Math.max(current.lastAt, reading.lastAt);
      current.resetsAt = reading.resetsAt;
    } else {
      windows.push({ ...reading });
    }
  }
  return windows.map((window) => ({ ...window, usedPercent: Math.round(window.usedPercent * 10) / 10 }));
}

const WEEK_SECONDS = 7 * 86_400;
const MAX_ESTIMATED_WEEKS = 104;
// Readings below this carry too little signal to calibrate against.
const MIN_CALIBRATION_PERCENT = 5;

// Anthropic API list prices in USD per million tokens: [input, output, cache write, cache read].
// Subscription limits are not billed this way; the prices only weight models and token types
// against each other for the utilization estimate.
const CLAUDE_PRICES = [
  [/^claude-fable-5-1/, [10, 50, 12.5, 0.25]],
  [/^claude-(fable|mythos)/, [10, 50, 12.5, 1]],
  [/^claude-opus-(5|4-[5-9])/, [5, 25, 6.25, 0.5]],
  [/^claude-opus/, [15, 75, 18.75, 1.5]],
  [/^claude-sonnet-5/, [2, 10, 2.5, 0.2]],
  [/^claude-sonnet/, [3, 15, 3.75, 0.3]],
  [/^claude-haiku/, [1, 5, 1.25, 0.1]],
];
const DEFAULT_PRICE = [5, 25, 6.25, 0.5];

/** API-price equivalent (USD) of one response's token usage. */
export function claudeUsageCost(model, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) {
  const id = String(model ?? "").replace(/\[.*\]$/, "");
  const [inPrice, outPrice, writePrice, readPrice] =
    CLAUDE_PRICES.find(([pattern]) => pattern.test(id))?.[1] ?? DEFAULT_PRICE;
  return (input * inPrice + output * outPrice + cacheWrite * writePrice + cacheRead * readPrice) / 1e6;
}

/**
 * Adds estimated weeks before (and between) the recorded ones. The local API-price
 * equivalent of each recorded week, up to its last reading, calibrates a percent-per-dollar
 * factor; earlier weeks follow the recorded reset time in 7-day steps back to the first
 * local activity. Estimates only see this Mac's Claude Code transcripts, so usage in
 * claude.ai or on other machines makes them read low.
 */
export function estimateWeeklyWindows(recorded, costByHour, now = Date.now()) {
  const hours = Object.entries(costByHour)
    .map(([hour, cost]) => [Number(hour) * 3600, cost])
    .filter(([, cost]) => cost > 0)
    .sort((a, b) => a[0] - b[0]);
  const costBetween = (from, to) =>
    hours.reduce((sum, [start, cost]) => (start >= from && start < to ? sum + cost : sum), 0);

  const samples = recorded
    .filter((window) => window.usedPercent >= MIN_CALIBRATION_PERCENT)
    .map((window) => ({
      percent: window.usedPercent,
      cost: costBetween(window.resetsAt - WEEK_SECONDS, Math.min(window.lastAt / 1000, window.resetsAt)),
    }))
    .filter((sample) => sample.cost > 0);
  if (samples.length === 0 || hours.length === 0) return { windows: recorded, estimate: null };

  const percentPerDollar =
    samples.reduce((sum, sample) => sum + sample.percent, 0) / samples.reduce((sum, sample) => sum + sample.cost, 0);
  const firstActivity = hours[0][0];
  // Skip weeks that share more than a day with a recorded window.
  const overlapsRecorded = (end) =>
    recorded.some((window) => Math.abs(window.resetsAt - end) < WEEK_SECONDS - 86_400);

  const estimated = [];
  for (let end = recorded.at(-1).resetsAt - WEEK_SECONDS; end > firstActivity; end -= WEEK_SECONDS) {
    if (estimated.length >= MAX_ESTIMATED_WEEKS) break;
    if (end > now / 1000 || overlapsRecorded(end)) continue;
    const percent = Math.min(100, costBetween(end - WEEK_SECONDS, end) * percentPerDollar);
    estimated.push({
      resetsAt: end,
      usedPercent: Math.round(percent * 10) / 10,
      firstAt: (end - WEEK_SECONDS) * 1000,
      lastAt: end * 1000,
      estimated: true,
    });
  }

  return {
    windows: [...estimated, ...recorded].sort((a, b) => a.resetsAt - b.resetsAt),
    estimate: { calibrationWeeks: samples.length, percentPerDollar },
  };
}

function defaultLogPath() {
  const base =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "TokenTide")
      : path.join(os.homedir(), ".local", "share", "tokentide");
  return path.join(base, "quota-weeks.json");
}

/**
 * Keeps the weekly readings seen by the usage service. Claude Code stores no quota history
 * of its own, so this log is the only source for its past weeks.
 */
export function createQuotaLog({ logPath = defaultLogPath() } = {}) {
  let providers = null;
  let loading = null;

  async function load() {
    if (providers) return;
    loading ??= (async () => {
      try {
        const stored = JSON.parse(await readFile(logPath, "utf8"));
        providers = stored.version === LOG_VERSION && stored.providers ? stored.providers : {};
      } catch {
        providers = {};
      }
    })();
    await loading;
  }

  async function persist() {
    try {
      await mkdir(path.dirname(logPath), { recursive: true });
      const temporary = `${logPath}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: LOG_VERSION, providers }), { mode: 0o600 });
      await rename(temporary, logPath);
    } catch {
      // Recording is best effort; the next refresh tries again.
    }
  }

  return {
    async record(providerId, reading) {
      if (!reading) return;
      await load();
      const before = JSON.stringify(providers[providerId] ?? []);
      providers[providerId] = compactReadings([...(providers[providerId] ?? []), reading]);
      if (JSON.stringify(providers[providerId]) !== before) await persist();
    },

    async readings(providerId) {
      await load();
      return providers[providerId] ?? [];
    },
  };
}
