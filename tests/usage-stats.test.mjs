import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  aggregateClaudeTranscript,
  aggregateCodexRollout,
  createStatsService,
  dayKey,
  summarizeAggregates,
} from "../server/usage-stats.mjs";
import {
  buildHeatmap,
  compareToBook,
  formatModelName,
  formatShare,
  formatTokens,
  summarizeStats,
} from "../src/stats-format.js";

const lines = (...entries) => entries.map((entry) => JSON.stringify(entry)).join("\n");
const at = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute).toISOString();
const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
});

test("aggregates a Claude Code transcript once per API response", () => {
  const response = { id: "msg_1", model: "claude-fable-5-1", usage: usage(10, 20, 100, 5) };
  const text = lines(
    { type: "user", timestamp: at(9, 19, 5), message: { role: "user" } },
    // One response split across two content-block entries.
    { type: "assistant", timestamp: at(9, 19, 6), requestId: "req_1", message: response },
    { type: "assistant", timestamp: at(9, 19, 6), requestId: "req_1", message: response },
    { type: "assistant", timestamp: at(10, 9), requestId: "req_2", message: { id: "msg_2", model: "claude-opus-5", usage: usage(1, 2) } },
    { type: "assistant", timestamp: at(10, 9), message: { id: "msg_3", model: "<synthetic>", usage: usage(50, 50) } },
    { type: "user", timestamp: at(10, 9), isSidechain: true, message: { role: "user" } },
    { type: "ai-title", timestamp: at(10, 9) },
    "not json",
  );

  const aggregate = aggregateClaudeTranscript(text);
  assert.deepEqual(aggregate.sessions, [{ day: "2026-09-09", hour: 19 }]);
  assert.equal(aggregate.days["2026-09-09"].messages, 2);
  assert.deepEqual(aggregate.days["2026-09-09"].models, { "claude-fable-5-1": { total: 135, io: 30 } });
  assert.deepEqual(aggregate.days["2026-09-10"].models, { "claude-opus-5": { total: 3, io: 3 } });
  assert.equal(aggregate.days["2026-09-10"].messages, 2);
});

test("subagent transcripts add tokens but no sessions or messages", () => {
  const text = lines({
    type: "assistant",
    timestamp: at(9, 8),
    isSidechain: true,
    message: { id: "msg_9", model: "claude-haiku-4-5-20251001", usage: usage(4, 6) },
  });
  const aggregate = aggregateClaudeTranscript(text, { subagent: true });
  assert.deepEqual(aggregate.sessions, []);
  assert.equal(aggregate.days["2026-09-09"].messages, 0);
  assert.equal(aggregate.days["2026-09-09"].models["claude-haiku-4-5-20251001"].total, 10);
});

const tokenCount = (timestamp, input, cached, output) => ({
  timestamp,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        total_tokens: input + output,
      },
    },
  },
});

test("aggregates a Codex rollout from cumulative token counts", () => {
  const text = lines(
    { timestamp: at(9, 23, 50), type: "session_meta", payload: { id: "thread" } },
    { timestamp: at(9, 23, 50), type: "turn_context", payload: { model: "gpt-5.5" } },
    { timestamp: at(9, 23, 51), type: "event_msg", payload: { type: "task_started" } },
    { timestamp: at(9, 23, 52), type: "response_item", payload: { type: "message", role: "assistant" } },
    { timestamp: at(9, 23, 52), type: "response_item", payload: { type: "agent_message" } },
    tokenCount(at(9, 23, 53), 1000, 600, 100),
    // Repeated snapshot (rate-limit update) adds nothing.
    tokenCount(at(9, 23, 54), 1000, 600, 100),
    { timestamp: at(10, 0, 5), type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    tokenCount(at(10, 0, 6), 1500, 800, 150),
  );

  const aggregate = aggregateCodexRollout(text);
  assert.deepEqual(aggregate.sessions, [{ day: "2026-09-09", hour: 23 }]);
  assert.equal(aggregate.days["2026-09-09"].messages, 2);
  assert.deepEqual(aggregate.days["2026-09-09"].models, { "gpt-5.5": { total: 1100, io: 500 } });
  assert.deepEqual(aggregate.days["2026-09-10"].models, { "gpt-5.6-sol": { total: 550, io: 350 } });
});

test("counts Codex agent_message replies only when a rollout has no assistant messages", () => {
  const text = lines(
    { timestamp: at(9, 10), type: "session_meta", payload: {} },
    { timestamp: at(9, 10), type: "response_item", payload: { type: "agent_message" } },
    { timestamp: at(9, 10), type: "response_item", payload: { type: "agent_message" } },
  );
  assert.equal(aggregateCodexRollout(text).days["2026-09-09"].messages, 2);
});

test("merges aggregates into a per-day series", () => {
  const days = summarizeAggregates([
    { sessions: [{ day: "2026-09-09", hour: 19 }], days: { "2026-09-09": { messages: 3, models: { a: { total: 10, io: 4 } } } } },
    { sessions: [{ day: "2026-09-09", hour: 19 }, { day: "2026-09-08", hour: 9 }], days: { "2026-09-09": { messages: 1, models: { a: { total: 5, io: 1 }, b: { total: 7, io: 7 } } } } },
  ]);
  assert.deepEqual(days, [
    { date: "2026-09-08", sessions: 1, messages: 0, tokens: 0, io: 0, models: {}, hours: { 9: 1 } },
    { date: "2026-09-09", sessions: 2, messages: 4, tokens: 22, io: 12, models: { a: 15, b: 7 }, hours: { 19: 2 } },
  ]);
});

test("stats service reads both tools and reuses its file cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-stats-"));
  try {
    const claudeDir = path.join(root, "claude");
    const codexDir = path.join(root, "codex");
    const cachePath = path.join(root, "cache.json");
    await mkdir(path.join(claudeDir, "projects", "demo", "session-a", "subagents"), { recursive: true });
    await mkdir(path.join(codexDir, "sessions", "2026", "09", "09"), { recursive: true });
    await writeFile(
      path.join(claudeDir, "projects", "demo", "session-a.jsonl"),
      lines({ type: "assistant", timestamp: at(9, 12), message: { id: "m", model: "claude-opus-5", usage: usage(1, 1) } }),
    );
    await writeFile(
      path.join(claudeDir, "projects", "demo", "session-a", "subagents", "agent-1.jsonl"),
      lines({ type: "assistant", timestamp: at(9, 12), message: { id: "s", model: "claude-opus-5", usage: usage(2, 2) } }),
    );
    await writeFile(
      path.join(codexDir, "sessions", "2026", "09", "09", "rollout-a.jsonl"),
      lines({ timestamp: at(9, 8), type: "session_meta", payload: {} }, tokenCount(at(9, 8), 10, 0, 5)),
    );

    const first = await createStatsService({ claudeDir, codexDir, cachePath }).read();
    const [codex, claude] = first.providers;
    assert.equal(codex.days[0].tokens, 15);
    assert.equal(claude.days[0].tokens, 6);
    assert.equal(claude.days[0].sessions, 1);

    // A new service instance answers from the on-disk cache with identical results.
    const second = await createStatsService({ claudeDir, codexDir, cachePath }).read();
    assert.deepEqual(second.providers, first.providers);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const day = (date, values = {}) => ({ date, sessions: 0, messages: 0, tokens: 0, io: 0, models: {}, hours: {}, ...values });

test("summarizes a range with streaks, peak hour, and favorite model", () => {
  const days = [
    day("2026-08-01", { sessions: 1, messages: 5, tokens: 200, io: 10, models: { "gpt-5.4": 200 }, hours: { 9: 1 } }),
    day("2026-09-05", { sessions: 1, messages: 2, tokens: 50, io: 5, models: { "gpt-5.5": 50 }, hours: { 19: 1 } }),
    day("2026-09-06", { sessions: 2, messages: 2, tokens: 50, io: 5, models: { "gpt-5.5": 50 }, hours: { 19: 2 } }),
    day("2026-09-08", { sessions: 1, messages: 1, tokens: 10, io: 1, models: { "gpt-5.5": 10 }, hours: { 8: 1 } }),
    day("2026-09-09", { sessions: 1, messages: 1, tokens: 10, io: 1, models: { "gpt-5.4": 10 }, hours: { 8: 1 } }),
  ];

  const week = summarizeStats(days, "7d", "2026-09-10");
  assert.equal(week.sessions, 5);
  assert.equal(week.tokens, 120);
  assert.equal(week.activeDays, 4);
  assert.equal(week.totalDays, 7);
  assert.equal(week.currentStreak, 2); // through yesterday; today has no activity yet
  assert.equal(week.longestStreak, 2);
  assert.equal(week.peakHour, 19);
  assert.equal(week.favoriteModel, "gpt-5.5");
  assert.deepEqual(week.models.map((item) => item.model), ["gpt-5.5", "gpt-5.4"]);

  const all = summarizeStats(days, "all", "2026-09-10");
  assert.equal(all.start, "2026-08-01");
  assert.equal(all.totalDays, 41);
  assert.equal(all.favoriteModel, "gpt-5.4");
});

test("builds a Monday-first heatmap with quartile levels", () => {
  const days = [day("2026-09-07", { tokens: 1 }), day("2026-09-08", { tokens: 10 }), day("2026-09-09", { tokens: 100 }), day("2026-09-10", { tokens: 1000 })];
  const { columns, first } = buildHeatmap(days, "2026-09-10", 2);
  assert.equal(first, "2026-08-31"); // Monday of the previous week
  assert.equal(columns.length, 2);
  const week = columns[1];
  assert.deepEqual(week.slice(0, 4).map((cell) => cell.level), [1, 2, 3, 4]);
  assert.equal(week[4].future, true);
  assert.equal(columns[0][0].level, 0);
});

test("formats token counts, model names, and book comparisons", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(8_200), "8.2K");
  assert.equal(formatTokens(46_100_000), "46.1M");
  assert.equal(formatTokens(1_928_500_000), "1.9B");
  assert.equal(formatTokens(128_000_000), "128M");

  assert.equal(formatModelName("claude-fable-5-1"), "Fable 5.1");
  assert.equal(formatModelName("claude-opus-5"), "Opus 5");
  assert.equal(formatModelName("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(formatModelName("gpt-5.2-codex"), "GPT-5.2 Codex");
  assert.equal(formatModelName("gpt-5.5"), "GPT-5.5");
  assert.equal(formatModelName("custom-model"), "custom-model");

  assert.equal(compareToBook(1_000), null);
  // Only the largest few qualifying books are candidates.
  for (const seed of ["a", "b", "c", "d", "e", "f"]) {
    assert.match(compareToBook(46_000_000, seed), /《(安娜·卡列尼娜|堂吉诃德|指环王|基督山伯爵|悲惨世界|战争与和平)》/);
  }
  assert.equal(formatShare(0.004), "<1%");
  assert.equal(formatShare(0.42), "42%");
  assert.equal(formatShare(0), "0%");
  assert.equal(compareToBook(30_000), "输入和输出大约相当于一本《小王子》。");
  assert.match(compareToBook(46_000_000, "seed"), /^输入和输出约是《.+》全书的 \d+ 倍。$/);
  assert.equal(compareToBook(46_000_000, "seed"), compareToBook(46_000_000, "seed"));
});

test("day keys use the local calendar date", () => {
  assert.equal(dayKey(new Date(2026, 0, 2, 23, 59).toISOString()), "2026-01-02");
  assert.equal(dayKey("garbage"), null);
});
