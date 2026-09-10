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
