import assert from "node:assert/strict";
import test from "node:test";

import {
  describeLow,
  findNewlyLow,
  formatAccount,
  formatReset,
  getPrimaryRemaining,
  isLow,
  isShownProvider,
  makeSnapshot,
  timeAgo,
} from "../src/usage-format.js";

const NOW = Date.UTC(2026, 8, 10, 4, 0);
const provider = (id, remainingPercent, connected = true) => ({
  id,
  connected,
  limits: [{ id: "window", remainingPercent }],
});

test("formats reset times relative to now", () => {
  const inMinutes = (minutes) => ({ resetsAt: (NOW + minutes * 60_000) / 1000 });
  assert.equal(formatReset(inMinutes(-1), NOW, "zh"), "即将重置");
  assert.equal(formatReset(inMinutes(42), NOW, "zh"), "42 分钟后重置");
  assert.equal(formatReset(inMinutes(125), NOW, "zh"), "2 小时 05 分后重置");
  assert.match(formatReset(inMinutes(3 * 24 * 60), NOW, "zh"), /^\d+月\d+日 \d{2}:\d{2} 重置$/);
  assert.equal(formatReset({ resetLabel: "Sep 15 at 4pm (Europe/Berlin)" }, NOW, "zh"), "Sep 15 at 4pm 重置");
  assert.equal(formatReset({}, NOW, "zh"), "重置时间未知");
});

test("formats last-updated time", () => {
  assert.equal(timeAgo(null, NOW, "zh"), "尚未更新");
  assert.equal(timeAgo(NOW - 5_000, NOW, "zh"), "刚刚更新");
  assert.equal(timeAgo(NOW - 30_000, NOW, "zh"), "30 秒前更新");
  assert.equal(timeAgo(NOW - 5 * 60_000, NOW, "zh"), "5 分钟前更新");
  assert.equal(timeAgo(NOW - 2 * 3_600_000, NOW, "zh"), "2 小时前更新");
});

test("alerts only when a provider newly drops below the threshold", () => {
  const first = [provider("codex", 10), provider("claude", 80)];
  assert.deepEqual(findNewlyLow(null, first).map((item) => item.id), ["codex"]);

  const stillLow = [provider("codex", 5), provider("claude", 80)];
  assert.deepEqual(findNewlyLow(first, stillLow), []);

  const claudeDrops = [provider("codex", 5), provider("claude", 12)];
  assert.deepEqual(findNewlyLow(stillLow, claudeDrops).map((item) => item.id), ["claude"]);

  // Disconnected or unknown values never count as low.
  assert.deepEqual(findNewlyLow(null, [provider("codex", 5, false), provider("claude", null)]), []);
});

test("describes low providers", () => {
  assert.equal(
    describeLow([provider("codex", 0), provider("claude", 12.4)], "zh"),
    "Codex 当前窗口额度已用尽，Claude Code 仅剩 12%",
  );
});

test("localizes account labels", () => {
  assert.equal(formatAccount("team plan", "zh"), "Team 套餐");
  assert.equal(formatAccount("pro lite plan", "zh"), "Pro Lite 套餐");
  assert.equal(formatAccount("max plan", "zh"), "Max 套餐");
  assert.equal(formatAccount("Usage view fallback", "zh"), "/usage 备用读取");
  assert.equal(formatAccount("Local account", "zh"), "本机账户");
  assert.equal(formatAccount(null, "zh"), null);
});

test("snapshots record only connected primary values", () => {
  assert.deepEqual(
    makeSnapshot({ updatedAt: NOW, providers: [provider("codex", 41), provider("claude", 70, false)] }),
    { at: NOW, codex: 41, claude: null, qoder: null },
  );
  // The last reading shown after a failed refresh is not a new trend point.
  assert.deepEqual(
    makeSnapshot({ updatedAt: NOW, providers: [{ ...provider("codex", 41), stale: true }] }),
    { at: NOW, codex: null, claude: null, qoder: null },
  );
});

test("tools turned off in Settings or not installed are not shown", () => {
  assert.equal(isShownProvider(provider("codex", 50)), true);
  assert.equal(isShownProvider(provider("codex", 50), ["codex"]), false);
  assert.equal(isShownProvider(provider("claude", 50), ["codex"]), true);
  assert.equal(isShownProvider({ id: "qoder", installed: false, limits: [] }), false);
});

test("with no current window the weekly quota leads, but stays off the window trend", () => {
  const claude = { id: "claude", connected: true, limits: [{ id: "weekly", remainingPercent: 0 }] };
  assert.equal(getPrimaryRemaining(claude), 0);
  assert.equal(isLow(claude), true);
  assert.equal(describeLow([claude], "zh"), "Claude Code 本周额度已用尽");
  assert.equal(makeSnapshot({ updatedAt: NOW, providers: [claude] }).claude, null);
});

test("an API account's spend view averages over the whole range, treating quiet days as $0", async () => {
  const { summarizeSpendDays } = await import("../src/stats-format.js");
  const byDay = { "2026-10-30": 0.12, "2026-11-02": 0.94, "2026-11-03": 0.09 };
  const week = summarizeSpendDays(byDay, "7d", "2026-11-03");
  assert.equal(week.days.length, 7);
  assert.equal(week.total, 1.15);
  assert.equal(Math.round(week.average * 1000) / 1000, 0.164);
  assert.equal(week.peak, 0.94);
  assert.equal(week.calendarMonth, 1.03);
  // "All" starts at the first recorded day.
  assert.equal(summarizeSpendDays(byDay, "all", "2026-11-03").days[0].date, "2026-10-30");
});

test("an API account's overview and models come from the per-model usage log", async () => {
  const { summarizeAccountUsage } = await import("../src/stats-format.js");
  const usage = {
    "2026-11-02": { "gpt-5.1": { cost: 2, requests: 3, input: 1000, output: 200, cached: 400 }, "gpt-4o-mini": { cost: 0.5, requests: 0, input: 0, output: 0, cached: 0 } },
    "2026-11-03": { "gpt-5.1": { cost: 0.75, requests: 1, input: 100, output: 50, cached: 0 } },
    "2026-09-01": { "gpt-5.1": { cost: 9, requests: 9, input: 9, output: 9, cached: 0 } },
  };
  const week = summarizeAccountUsage(usage, "7d", "2026-11-03");
  assert.deepEqual(
    { cost: week.cost, requests: week.requests, tokens: week.tokens, cached: week.cached, activeDays: week.activeDays, totalDays: week.totalDays, favoriteModel: week.favoriteModel },
    { cost: 3.25, requests: 4, tokens: 1350, cached: 400, activeDays: 2, totalDays: 7, favoriteModel: "gpt-5.1" },
  );
  // Ranked by tokens (share of tokens); a cost-only line item keeps its cost and comes last.
  assert.deepEqual(week.models.map((model) => [model.model, model.tokens, model.cost, Math.round(model.share * 100)]), [["gpt-5.1", 1350, 2.75, 100], ["gpt-4o-mini", 0, 0.5, 0]]);
  // A free model (cost 0) still ranks by its tokens.
  const free = summarizeAccountUsage({ "2026-11-03": { a: { cost: 0, requests: 1, input: 10, output: 5, cached: 0 }, b: { cost: 1, requests: 1, input: 1, output: 1, cached: 0 } } }, "7d", "2026-11-03");
  assert.deepEqual(free.models.map((model) => model.model), ["a", "b"]);
});
