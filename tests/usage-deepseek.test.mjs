import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import { createDeepseekReader, summarizeDeepseekUsage } from "../server/deepseek-usage.mjs";
import {
  aggregateDeepseekSession,
  createStatsService,
  decodeDeepseekSessionLog,
  listDeepseekSessionLogs,
} from "../server/usage-stats.mjs";

// 2026-10-23 10:00 local time.
const T = new Date(2026, 9, 23, 10, 0).getTime();
const usage = (inputTokens, outputTokens, cacheReadTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens });

// A DeepSeek Harness session log in its on-disk shape: a header row, then `{ seq, type, time, data }`.
function sessionLog({ parentSession, at = T } = {}) {
  const rows = [
    { type: "session", version: 4, id: "s1", createdAt: at, isSeeded: false, delegationDepth: parentSession ? 1 : 0, ...(parentSession ? { parentSession } : {}) },
    { seq: 0, type: "request/context", time: at, data: { provider: "deepseek-account", model: "deepseek-v4" } },
    { seq: 1, type: "user/message", time: at, data: { message: { role: "user", content: "secret prompt" } } },
    // A streamed sample, then the final sample for the same turn and step: the final one counts.
    { seq: 2, type: "assistant/attempt", time: at, data: { turn: 1, step: 1, stream: [{ type: "chunk", chunk: { type: "usage", usage: usage(10, 1) } }] } },
    { seq: 3, type: "assistant/message", time: at + 1000, data: { turn: 1, step: 1, usage: usage(100, 20, 50) } },
    // A retry in step 2 is another billed attempt.
    { seq: 4, type: "assistant/attempt", time: at + 2000, data: { turn: 1, step: 2, stream: [{ type: "chunk", chunk: { type: "usage", usage: usage(30, 0) } }] } },
    { seq: 5, type: "llm/retry-started", time: at + 2500, data: { turn: 1, step: 2 } },
    { seq: 6, type: "assistant/message", time: at + 3000, data: { turn: 1, step: 2, stream: [{ type: "chunk", chunk: { type: "usage", usage: usage(40, 10) } }] } },
  ];
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

test("counts DeepSeek Harness tokens the way its own token meter does", () => {
  const aggregate = aggregateDeepseekSession(sessionLog());
  const day = Object.values(aggregate.days)[0];
  // Step 1: 100 + 20 + 50 cache read. Step 2: the failed attempt (30) plus the retry (40 + 10).
  assert.deepEqual(day.models, { "deepseek-v4": { total: 250, io: 200 } });
  // The prompt and one reply per step.
  assert.equal(day.messages, 3);
  assert.equal(aggregate.sessions.length, 1);
  assert.equal(JSON.stringify(aggregate).includes("secret"), false, "no message content is kept");

  // A subagent's tokens count, but it is not another session and its messages are not counted.
  const child = aggregateDeepseekSession(sessionLog({ parentSession: "s0" }));
  assert.equal(child.sessions.length, 0);
  assert.equal(Object.values(child.days)[0].messages, 0);
  assert.equal(Object.values(child.days)[0].models["deepseek-v4"].total, 250);
});

test("reads compressed logs written as several Zstandard frames", () => {
  const [first, ...rest] = sessionLog().split(/(?<=\n)/);
  const frames = Buffer.concat([zstdCompressSync(Buffer.from(first)), zstdCompressSync(Buffer.from(rest.join("")))]);
  assert.equal(decodeDeepseekSessionLog(frames, "session.v4.jsonl.zstd"), sessionLog());
  // A frame Harness is still writing is left out until it is complete.
  assert.equal(decodeDeepseekSessionLog(frames.subarray(0, frames.length - 3), "session.v4.jsonl.zstd"), first);
  assert.equal(decodeDeepseekSessionLog(Buffer.from(sessionLog()), "session.v4.jsonl"), sessionLog());
});

test("reads each session's newest log generation and sums today, 7 and 30 days", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dsh-home-"));
  try {
    const project = path.join(home, "sessions", "--Users-me-work--");
    await mkdir(path.join(project, "session-a"), { recursive: true });
    await mkdir(path.join(project, "session-b"), { recursive: true });
    // session-a was migrated: the old generation must not be counted again.
    await writeFile(path.join(project, "session-a", "session.v3.jsonl.zstd"), zstdCompressSync(Buffer.from(sessionLog())));
    await writeFile(path.join(project, "session-a", "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(sessionLog())));
    await writeFile(path.join(project, "session-a", "session.lock"), "");
    // session-b ran 10 days ago, as a raw log.
    await writeFile(path.join(project, "session-b", "session.v4.jsonl"), sessionLog({ at: T - 10 * 86_400_000 }));

    const logs = await listDeepseekSessionLogs(path.join(home, "sessions"));
    assert.deepEqual(logs.map((file) => path.basename(file)).sort(), ["session.v4.jsonl", "session.v4.jsonl.zstd"]);

    const provider = await createDeepseekReader({ dshHome: home, appPaths: [] })(T);
    assert.equal(provider.connected, true);
    assert.equal(provider.installed, true);
    assert.deepEqual(provider.usage, {
      today: { tokens: 250, messages: 3 },
      week: { tokens: 250, messages: 3 },
      month: { tokens: 500, messages: 6 },
    });

    const stats = await createStatsService({
      claudeDir: path.join(home, "no-claude"),
      codexDir: path.join(home, "no-codex"),
      qoderDir: null,
      dshHome: home,
      cachePath: null,
    }).read();
    const days = stats.providers.find((item) => item.id === "deepseek").days;
    assert.equal(days.reduce((sum, day) => sum + day.tokens, 0), 500);
    assert.equal(days.reduce((sum, day) => sum + day.sessions, 0), 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("DeepSeek is hidden without DeepSeek Harness", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dsh-none-"));
  try {
    const provider = await createDeepseekReader({ dshHome: home, appPaths: [] })();
    assert.equal(provider.installed, false);
    assert.equal(provider.connected, false);
    assert.deepEqual(summarizeDeepseekUsage([], T).today, { tokens: 0, messages: 0 });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
