import assert from "node:assert/strict";
import test from "node:test";

import {
  createUsageService,
  makeLimit,
  parseClaudeDirectUsage,
  parseClaudeUsage,
  readClaudeUsageDirect,
  readJsonLineProcess,
  resolveResetLabel,
} from "../server/usage-service.mjs";

// 2026-09-10 12:00 in Asia/Shanghai (UTC+8, no DST).
const NOON_SHANGHAI = Date.UTC(2026, 8, 10, 4, 0);
const shanghai = (month, day, hour, minute = 0) => Date.UTC(2026, month, day, hour - 8, minute) / 1000;

test("missing quota is unavailable, not 100 percent remaining", () => {
  for (const value of [null, undefined, "", NaN]) {
    assert.equal(makeLimit("window", "Window", value, null).remainingPercent, null);
  }
  assert.equal(makeLimit("window", "Window", 0, null).remainingPercent, 100);
});

test("parses Claude Code plan usage without retaining terminal formatting", () => {
  const output = [
    "you: /usage",
    "\u001B[1mCurrent session\u001B[0m",
    "41% 41% used",
    "Resets 11:30pm (Asia/Shanghai)",
    "Current week (all models)",
    "23% 23% used",
    "Resets Sep 15 at 4pm (Asia/Shanghai)",
  ].join("\r\n");

  assert.deepEqual(parseClaudeUsage(output, NOON_SHANGHAI), {
    limits: [
      {
        id: "window",
        label: "Current window",
        usedPercent: 41,
        remainingPercent: 59,
        resetsAt: shanghai(8, 10, 23, 30),
        resetLabel: "11:30pm (Asia/Shanghai)",
      },
      {
        id: "weekly",
        label: "Weekly",
        usedPercent: 23,
        remainingPercent: 77,
        resetsAt: shanghai(8, 15, 16),
        resetLabel: "Sep 15 at 4pm (Asia/Shanghai)",
      },
    ],
  });
});

test("prefers the 'NN% used' figure over other percentages in a section", () => {
  const output = [
    "Current session",
    "Context 88%",
    "12% used",
    "Resets 5pm (Asia/Shanghai)",
    "Current week (all models)",
    "30% used",
    "Resets Sep 15 at 4pm (Asia/Shanghai)",
  ].join("\n");

  const [current, weekly] = parseClaudeUsage(output, NOON_SHANGHAI).limits;
  assert.equal(current.usedPercent, 12);
  assert.equal(weekly.usedPercent, 30);
});

test("returns null when Claude Code does not expose subscription limits", () => {
  assert.equal(parseClaudeUsage("Session cost only"), null);
});

test("resolves Claude reset labels to the next matching wall-clock time", () => {
  assert.equal(resolveResetLabel("11:30pm (Asia/Shanghai)", NOON_SHANGHAI), shanghai(8, 10, 23, 30));
  // A time earlier than now rolls over to tomorrow.
  assert.equal(resolveResetLabel("9am (Asia/Shanghai)", NOON_SHANGHAI), shanghai(8, 11, 9));
  assert.equal(resolveResetLabel("12am (Asia/Shanghai)", NOON_SHANGHAI), shanghai(8, 11, 0));
  assert.equal(resolveResetLabel("Sep 15 at 4pm (Asia/Shanghai)", NOON_SHANGHAI), shanghai(8, 15, 16));
  // A date far in the past belongs to next year.
  assert.equal(
    resolveResetLabel("Jan 2 at 9am (Asia/Shanghai)", Date.UTC(2026, 11, 30, 4)),
    Date.UTC(2027, 0, 2, 1) / 1000,
  );
  for (const label of ["soon", "25pm (Asia/Shanghai)", "Foo 3 at 1pm", "", null]) {
    assert.equal(resolveResetLabel(label, NOON_SHANGHAI), null);
  }
});

const nodeScript = (source) => [process.execPath, ["-e", source]];

test("reads JSON-lines replies after initialization", async () => {
  const [command, args] = nodeScript(`
    const rl = require("node:readline").createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const message = JSON.parse(line);
      const result = message.id === 1 ? {} : { ok: message.method };
      process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
    });
  `);
  const replies = await readJsonLineProcess(command, args, [{ method: "demo/read", id: 2 }], 5000);
  assert.deepEqual(replies, { "demo/read": { ok: "demo/read" } });
});

test("rejects promptly when the process exits without replying", async () => {
  const [command, args] = nodeScript("process.exit(0)");
  const started = Date.now();
  await assert.rejects(readJsonLineProcess(command, args, [{ method: "demo/read", id: 2 }], 5000), /exited/);
  assert.ok(Date.now() - started < 4000);
});

test("rejects when the command is missing", async () => {
  await assert.rejects(
    readJsonLineProcess("usage-monitor-missing-command", [], [{ method: "demo/read", id: 2 }], 5000),
    /ENOENT/,
  );
});

const DIRECT_USAGE = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 41.5, resets_at: "2026-09-10T12:30:00.486948+00:00" },
    seven_day: { utilization: 39, resets_at: "2026-09-15T08:00:00.486970+00:00" },
    seven_day_opus: null,
  },
};

test("maps Claude Code get_usage data to exact quota windows", () => {
  assert.deepEqual(parseClaudeDirectUsage(DIRECT_USAGE), {
    id: "claude",
    name: "Claude Code",
    connected: true,
    account: "max plan",
    source: "Claude Code get_usage",
    limits: [
      {
        id: "window",
        label: "Current window",
        usedPercent: 41.5,
        remainingPercent: 58.5,
        resetsAt: Date.UTC(2026, 8, 10, 12, 30) / 1000,
        resetLabel: null,
      },
      {
        id: "weekly",
        label: "Weekly",
        usedPercent: 39,
        remainingPercent: 61,
        resetsAt: Date.UTC(2026, 8, 15, 8, 0) / 1000,
        resetLabel: null,
      },
    ],
  });
});

test("rejects get_usage data without plan limits (API key or third-party sessions)", () => {
  assert.throws(() => parseClaudeDirectUsage({ rate_limits_available: false, rate_limits: null }), /plan limits/);
  assert.throws(() => parseClaudeDirectUsage({}), /plan limits/);
});

test("reads plan usage through the get_usage control request", async () => {
  const [command, args] = nodeScript(`
    const rl = require("node:readline").createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.request?.subtype !== "get_usage" || !message.request.skip_behaviors) return;
      process.stdout.write(JSON.stringify({ type: "system", subtype: "noise" }) + "\\n");
      process.stdout.write(JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: message.request_id, response: ${JSON.stringify(DIRECT_USAGE)} },
      }) + "\\n");
    });
  `);
  const provider = await readClaudeUsageDirect(command, args, 5000);
  assert.equal(provider.account, "max plan");
  assert.equal(provider.limits[0].remainingPercent, 58.5);
});

test("surfaces a rejected get_usage request", async () => {
  const [command, args] = nodeScript(`
    process.stdin.once("data", (line) => {
      const { request_id } = JSON.parse(line);
      process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "error", request_id, error: "nope" } }) + "\\n");
    });
  `);
  await assert.rejects(readClaudeUsageDirect(command, args, 5000), /rejected/);
});

test("falls back to the /usage view only when the structured request fails", async () => {
  const fallbackProvider = { id: "claude", name: "Claude Code", connected: true, account: "Usage view fallback", limits: [] };
  let fallbackCalls = 0;
  const fallback = async () => {
    fallbackCalls += 1;
    return fallbackProvider;
  };
  const codex = async () => ({ id: "codex", name: "Codex", connected: true, limits: [] });

  const direct = createUsageService({ codex, claudeDirect: async () => parseClaudeDirectUsage(DIRECT_USAGE), claudeFallback: fallback });
  assert.equal((await direct.read()).providers[1].account, "max plan");
  assert.equal(fallbackCalls, 0);

  const broken = createUsageService({
    codex,
    claudeDirect: async () => {
      throw new Error("get_usage is not supported");
    },
    claudeFallback: fallback,
  });
  assert.equal((await broken.read()).providers[1], fallbackProvider);
  assert.equal(fallbackCalls, 1);
});

test("concurrent reads share one provider request", async () => {
  let codexCalls = 0;
  const service = createUsageService({
    codex: async () => {
      codexCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { id: "codex", name: "Codex", connected: true, limits: [] };
    },
    claudeDirect: async () => {
      throw new Error("Claude Code is signed out.");
    },
    claudeFallback: async () => {
      throw new Error("Usage view unavailable.");
    },
  });

  const [first, second] = await Promise.all([service.read(), service.read()]);
  assert.equal(codexCalls, 1);
  assert.equal(first, second);
  assert.equal(first.providers[1].connected, false);
  assert.equal(first.providers[1].error, "Claude Code is signed out.");

  await service.read();
  assert.equal(codexCalls, 2);
});
