import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildWeeklyWindows,
  claudeUsageCost,
  createQuotaLog,
  estimateWeeklyWindows,
  extractCodexWeeklyReading,
  weeklyReadingFromProvider,
} from "../server/quota-weeks.mjs";
import { aggregateClaudeTranscript, aggregateCodexRollout } from "../server/usage-stats.mjs";
import { createUsageService } from "../server/usage-service.mjs";
import {
  FULL_WEEK_PERCENT,
  formatMonthDay,
  findEarlyResets,
  isIdleWindow,
  summarizeCreditDays,
  summarizeQuotaWeeks,
  summarizeThisWeek,
} from "../src/stats-format.js";

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
        qoder: async () => ({ id: "qoder", connected: false, installed: false, limits: [] }),
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

test("weights Claude usage by model and token type", () => {
  const million = 1_000_000;
  assert.equal(claudeUsageCost("claude-opus-5", { input: million }), 5);
  assert.equal(claudeUsageCost("claude-opus-4-8[1m]", { output: million }), 25);
  assert.equal(claudeUsageCost("claude-fable-5-1", { cacheRead: million, cacheWrite: million }), 12.75);
  assert.equal(claudeUsageCost("claude-fable-5", { cacheRead: million }), 1);
  assert.equal(claudeUsageCost("claude-sonnet-5", { input: million }), 2);
  assert.equal(claudeUsageCost("claude-haiku-4-5-20251001", { output: million }), 5);
  assert.equal(claudeUsageCost("unknown", { input: million }), 5);
});

test("Claude transcripts record API-price cost per hour, once per response", () => {
  const at = new Date(END * 1000).toISOString();
  const message = { id: "m1", model: "claude-opus-5", usage: { input_tokens: 1_000_000, output_tokens: 0 } };
  const text = [
    { type: "assistant", timestamp: at, requestId: "r1", message },
    { type: "assistant", timestamp: at, requestId: "r1", message },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  assert.deepEqual(aggregateClaudeTranscript(text).costByHour, { [Math.floor(END / 3600)]: 5 });
});

test("estimates earlier weeks from local usage, calibrated on recorded weeks", () => {
  const hour = (seconds) => Math.floor(seconds / 3600);
  // $10 of usage per day for 14 days before END, and $5 on one day three weeks earlier.
  const costByHour = {};
  for (let day = 1; day <= 14; day += 1) costByHour[hour(END - day * DAY + 3600)] = 10;
  costByHour[hour(END - 20 * DAY)] = 5;
  // Recorded: the week ending at END reached 35% with $70 of local usage -> 0.5% per dollar.
  const recorded = [{ resetsAt: END, usedPercent: 35, firstAt: (END - 2 * DAY) * 1000, lastAt: END * 1000 }];

  const { windows, estimate } = estimateWeeklyWindows(recorded, costByHour, (END + DAY) * 1000);
  assert.equal(estimate.calibrationWeeks, 1);
  assert.equal(estimate.percentPerDollar, 0.5);
  assert.deepEqual(
    windows.map((window) => [window.resetsAt, window.usedPercent, Boolean(window.estimated)]),
    [
      [END - 14 * DAY, 2.5, true],
      [END - 7 * DAY, 35, true],
      [END, 35, false],
    ],
  );

  // Estimates are capped at 100% and skip weeks that overlap a recorded one.
  const heavy = { ...costByHour, [hour(END - 10 * DAY)]: 1000 };
  const other = { resetsAt: END - 7 * DAY + 3 * 3600, usedPercent: 50, firstAt: 0, lastAt: (END - 7 * DAY) * 1000 };
  assert.equal(estimateWeeklyWindows(recorded, heavy, END * 1000).windows.find((w) => w.resetsAt === END - 7 * DAY).usedPercent, 100);
  assert.equal(estimateWeeklyWindows([other, ...recorded], costByHour, END * 1000).windows.filter((w) => w.estimated).length, 1);

  // Without a usable recorded week there is nothing to calibrate against.
  assert.deepEqual(estimateWeeklyWindows([], costByHour), { windows: [], estimate: null });
  const quiet = [{ ...recorded[0], usedPercent: 2 }];
  assert.equal(estimateWeeklyWindows(quiet, costByHour).estimate, null);
});

test("flags figures that include estimated weeks", () => {
  const now = (END + DAY) * 1000;
  const windows = [
    { resetsAt: END - 14 * DAY, usedPercent: 100, firstAt: (END - 21 * DAY) * 1000, lastAt: 1, estimated: true },
    { resetsAt: END - 7 * DAY, usedPercent: 40, firstAt: (END - 14 * DAY) * 1000, lastAt: 1, estimated: true },
    { resetsAt: END, usedPercent: 60, firstAt: (END - 2 * DAY) * 1000, lastAt: 2 },
  ];
  const summary = summarizeQuotaWeeks(windows, "all", now);
  assert.equal(summary.estimatedWeeks, 2);
  assert.equal(summary.peakEstimated, true);
  assert.equal(summary.fullWeeksEstimated, true);
  assert.equal(summary.recordedSince, END - 2 * DAY);

  const recentOnly = summarizeQuotaWeeks(windows, "7d", now);
  assert.equal(recentOnly.estimatedWeeks, 0);
  assert.equal(recentOnly.peakEstimated, false);
});

test("idle Codex readings do not count as weeks", () => {
  // Before the first use after a reset, Codex reports "0%, resets 7 days from now" on every read.
  const idle = { resetsAt: END, usedPercent: 0, firstAt: (END - 7 * DAY) * 1000, lastAt: (END - 7 * DAY + 60) * 1000 };
  const quiet = { resetsAt: END - 14 * DAY, usedPercent: 0, firstAt: (END - 21 * DAY) * 1000, lastAt: (END - 16 * DAY) * 1000 };
  const busy = { resetsAt: END - 7 * DAY, usedPercent: 40, firstAt: (END - 14 * DAY) * 1000, lastAt: (END - 8 * DAY) * 1000 };
  assert.equal(isIdleWindow(idle), true);
  assert.equal(isIdleWindow(quiet), false, "a window watched for days at 0% did run");
  assert.equal(isIdleWindow(busy), false);
  const summary = summarizeQuotaWeeks([quiet, busy, idle], "all", (END + DAY) * 1000);
  assert.deepEqual(summary.weeks.map((window) => window.usedPercent), [0, 40]);
  assert.equal(summary.average, 20);
});

test("the 7-day view projects this week at its current pace", () => {
  const now = (END - 5 * DAY) * 1000; // two days into the week ending at END
  const previous = { resetsAt: END - 7 * DAY, usedPercent: 60, firstAt: 0, lastAt: (END - 8 * DAY) * 1000 };
  const current = { resetsAt: END, usedPercent: 20, firstAt: (END - 6 * DAY) * 1000, lastAt: now };
  const week = summarizeThisWeek([previous, current], now);
  assert.equal(week.current.usedPercent, 20);
  assert.equal(week.previous.usedPercent, 60);
  assert.equal(week.elapsedDays, 2);
  assert.equal(week.projected, 70);
  // Too early in the week to project.
  assert.equal(summarizeThisWeek([current], (END - 7 * DAY + 3600) * 1000).projected, null);
});

test("Qoder's 7-day view lists every day, today last", () => {
  const days = [{ date: "2026-10-04", credits: 30 }, { date: "2026-10-09", credits: 10 }, { date: "2026-09-01", credits: 99 }];
  const summary = summarizeCreditDays(days, "2026-10-10");
  assert.deepEqual(summary.days.map((day) => day.date), ["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"]);
  assert.equal(summary.days.at(-1).isToday, true);
  assert.equal(summary.total, 40);
  assert.equal(summary.peak, 30);
  assert.equal(summary.today, 0);
});

test("weeks reset before their seven days are marked, but overlapping accounts are not", () => {
  const H = 3600;
  // One account: each week's readings stop when the next week starts, days before the due reset.
  const first = { resetsAt: END, usedPercent: 50, firstAt: (END - 7 * DAY + H) * 1000, lastAt: (END - 4 * DAY) * 1000 };
  const second = { resetsAt: END + 3 * DAY, usedPercent: 90, firstAt: (END - 4 * DAY) * 1000, lastAt: (END + 3 * DAY - H) * 1000 };
  const early = findEarlyResets([first, second]);
  assert.equal(early.get(first), END - 4 * DAY);
  assert.equal(early.has(second), false, "the last week ran its course");

  // Two accounts: their readings interleave, so neither counts as reset early.
  const other = { resetsAt: END + 2 * DAY, usedPercent: 30, firstAt: (END - 5 * DAY) * 1000, lastAt: (END + DAY) * 1000 };
  const busy = { ...first, lastAt: (END - DAY) * 1000 };
  assert.equal(findEarlyResets([busy, other]).size, 0);

  // A next week starting an hour or two before the due reset is reset-time drift, not an early reset.
  const onTime = { resetsAt: END, usedPercent: 28, firstAt: (END - 3 * DAY) * 1000, lastAt: (END - 2 * H) * 1000 };
  const following = { resetsAt: END + 7 * DAY - 2 * H, usedPercent: 11, firstAt: (END - H) * 1000, lastAt: (END + DAY) * 1000 };
  assert.equal(findEarlyResets([onTime, following]).size, 0);

  const summary = summarizeQuotaWeeks([first, second], "all", (END + 4 * DAY) * 1000);
  assert.equal(summary.earlyResets, 1);
  assert.equal(summary.weeks[0].endedEarly, true);
  assert.equal(summary.weeks[0].endedAt, END - 4 * DAY);
});
