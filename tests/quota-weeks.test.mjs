import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildWeeklyWindows,
  createQuotaLog,
  extractCodexWeeklyReading,
  weeklyReadingFromProvider,
} from "../server/quota-weeks.mjs";
import { aggregateCodexRollout } from "../server/usage-stats.mjs";
import { createUsageService } from "../server/usage-service.mjs";
import { FULL_WEEK_PERCENT, formatMonthDay, summarizeQuotaWeeks } from "../src/stats-format.js";

const DAY = 86_400;
// Weekly windows ending at 2026-09-16 14:36 local-ish epoch (exact value is arbitrary).
const END = 1_789_540_560;
const reading = (resetsAt, usedPercent, at = (resetsAt - DAY) * 1000) => ({ resetsAt, usedPercent, at });

test("reads the weekly Codex window from either rate-limit slot", () => {
  const at = 1_789_000_000_000;
  assert.deepEqual(
    extractCodexWeeklyReading(
      {
        limit_id: "codex",
        primary: { used_percent: 12, window_minutes: 300, resets_at: END - 6 * DAY },
        secondary: { used_percent: 41.5, window_minutes: 10080, resets_at: END },
      },
      at,
    ),
    { resetsAt: END, usedPercent: 41.5, at },
  );
  // Weekly-only plans report the week as the primary window.
  assert.equal(extractCodexWeeklyReading({ primary: { used_percent: 7, window_minutes: 10079, resets_at: END } }, at).usedPercent, 7);
  // Separate quotas and broken snapshots are ignored.
  assert.equal(extractCodexWeeklyReading({ limit_id: "premium", secondary: { used_percent: 1, window_minutes: 10080, resets_at: END } }, at), null);
  assert.equal(extractCodexWeeklyReading({ secondary: { used_percent: 1, window_minutes: 10080, resets_at: 0 } }, at), null);
  assert.equal(extractCodexWeeklyReading({ primary: { used_percent: 1, window_minutes: 300, resets_at: END } }, at), null);
  assert.equal(extractCodexWeeklyReading(null, at), null);
});

test("groups jittering reset times into one window and keeps the peak", () => {
  const windows = buildWeeklyWindows([
    reading(END - 7 * DAY, 30),
    reading(END - 7 * DAY + 5, 55),
    reading(END, 10, (END - 3 * DAY) * 1000),
    reading(END + 376, 58, (END - DAY) * 1000),
    reading(END + 90, 40, (END - 2 * DAY) * 1000),
  ]);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].usedPercent, 55);
  assert.equal(windows[1].usedPercent, 58);
  assert.equal(windows[1].firstAt, (END - 3 * DAY) * 1000);
  assert.equal(windows[1].lastAt, (END - DAY) * 1000);
});

test("rollouts contribute weekly readings", () => {
  const text = [
    { timestamp: new Date((END - 2 * DAY) * 1000).toISOString(), type: "session_meta", payload: {} },
    {
      timestamp: new Date((END - 2 * DAY) * 1000).toISOString(),
      type: "event_msg",
      payload: { type: "token_count", info: null, rate_limits: { secondary: { used_percent: 20, window_minutes: 10080, resets_at: END } } },
    },
    {
      timestamp: new Date((END - DAY) * 1000).toISOString(),
      type: "event_msg",
      payload: { type: "token_count", info: null, rate_limits: { secondary: { used_percent: 35, window_minutes: 10080, resets_at: END } } },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  assert.deepEqual(aggregateCodexRollout(text).quota, [
    { resetsAt: END, usedPercent: 35, firstAt: (END - 2 * DAY) * 1000, lastAt: (END - DAY) * 1000 },
  ]);
});

test("summarizes completed weeks in a range and reports the open week", () => {
  const now = (END - DAY) * 1000;
  const windows = [
    { resetsAt: END - 63 * DAY, usedPercent: 20, firstAt: 0, lastAt: 1 },
    { resetsAt: END - 21 * DAY, usedPercent: 100, firstAt: 0, lastAt: 2 },
    { resetsAt: END - 14 * DAY, usedPercent: 40, firstAt: 0, lastAt: 3 },
    { resetsAt: END - 7 * DAY, usedPercent: 60, firstAt: 0, lastAt: 4 },
    // Two open windows (two accounts): the most recently seen one is this week.
    { resetsAt: END - DAY / 2, usedPercent: 50, firstAt: 0, lastAt: 5 },
    { resetsAt: END, usedPercent: 58, firstAt: 0, lastAt: 9 },
  ];

  const all = summarizeQuotaWeeks(windows, "all", now);
  assert.equal(all.weeks.length, 4);
  assert.equal(all.average, 55);
  assert.equal(all.peak, 100);
  assert.equal(all.fullWeeks, 1);
  assert.equal(all.current.usedPercent, 58);
  assert.equal(all.since, END - 70 * DAY);
  assert.equal(all.recordedSince, 0);

  const month = summarizeQuotaWeeks(windows, "30d", now);
  assert.deepEqual(month.weeks.map((window) => window.usedPercent), [100, 40, 60]);

  const week = summarizeQuotaWeeks(windows, "7d", now);
  assert.deepEqual(week.weeks.map((window) => window.usedPercent), [60]);

  const empty = summarizeQuotaWeeks([], "all", now);
  assert.equal(empty.average, null);
  assert.equal(empty.current, null);
  assert.ok(FULL_WEEK_PERCENT < 100);
});

test("formats week dates with the year only outside the current year", () => {
  const now = new Date(2026, 8, 10);
  assert.equal(formatMonthDay(new Date(2026, 8, 16, 14).getTime() / 1000, now), "9/16");
  assert.equal(formatMonthDay(new Date(2025, 10, 6, 14).getTime() / 1000, now), "2025/11/6");
});

test("the usage service records weekly readings and the log survives a restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quota-weeks-"));
  try {
    const logPath = path.join(root, "quota-weeks.json");
    const quotaLog = createQuotaLog({ logPath });
    const provider = (id, usedPercent) => ({
      id,
      name: id,
      connected: true,
      limits: [
        { id: "window", usedPercent: 5, resetsAt: END - 6 * DAY },
        { id: "weekly", usedPercent, resetsAt: END },
      ],
    });
    const service = createUsageService(
      {
        codex: async () => provider("codex", 41),
        claudeDirect: async () => provider("claude", 42),
        claudeFallback: async () => {
          throw new Error("unused");
        },
      },
      { quotaLog },
    );

    await service.read();
    assert.equal((await quotaLog.readings("claude"))[0].usedPercent, 42);

    const reopened = createQuotaLog({ logPath });
    assert.equal((await reopened.readings("codex"))[0].usedPercent, 41);
    assert.match(await readFile(logPath, "utf8"), /"version":1/);

    // Disconnected providers and missing weekly limits are not recorded.
    assert.equal(weeklyReadingFromProvider({ connected: false, limits: [] }, Date.now()), null);
    assert.equal(weeklyReadingFromProvider(provider("x", Number.NaN), Date.now()), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
