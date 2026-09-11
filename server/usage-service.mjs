import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { weeklyReadingFromProvider } from "./quota-weeks.mjs";
import { readQoderUsage } from "./qoder-usage.mjs";

const CLAUDE_TIMEOUT_MS = 45_000;
const CLAUDE_DIRECT_TIMEOUT_MS = 20_000;
const CLAUDE_DIRECT_ARGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--safe-mode",
  "--no-session-persistence",
  "--permission-mode",
  "plan",
];
const CODEX_TIMEOUT_MS = 10_000;
const CLAUDE_OUTPUT_LIMIT = 160_000;

function clampPercent(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : null;
}

export function makeLimit(id, label, usedPercent, resetsAt, resetLabel = null) {
  const used = clampPercent(usedPercent);
  const resetTimestamp = resetsAt == null ? null : Number(resetsAt);
  return {
    id,
    label,
    usedPercent: used,
    remainingPercent: used === null ? null : Math.round((100 - used) * 10) / 10,
    resetsAt: Number.isFinite(resetTimestamp) ? resetTimestamp : null,
    resetLabel,
  };
}

function stripTerminalCodes(value) {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[()][A-Z0-9]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g, "")
    .replace(/\r/g, "\n");
}

function readUsedPercent(section) {
  // Prefer the explicit "NN% used" label; fall back to the first percentage in the section.
  return (section.match(/(\d{1,3})%\s*used/i) ?? section.match(/(\d{1,3})%/))?.[1];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function zonedParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(timestamp);
  const value = (type) => Number(parts.find((part) => part.type === type).value);
  return {
    year: value("year"),
    month: value("month") - 1,
    day: value("day"),
    hour: value("hour") % 24,
    minute: value("minute"),
    second: value("second"),
  };
}

function zonedTimeToEpoch(year, month, day, hour, minute, timeZone) {
  const wallClock = Date.UTC(year, month, day, hour, minute);
  const offsetAt = (timestamp) => {
    const p = zonedParts(timestamp, timeZone);
    return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(timestamp / 1000) * 1000;
  };
  const first = wallClock - offsetAt(wallClock);
  // A second pass settles wall-clock times that sit next to a DST change.
  return wallClock - offsetAt(first);
}

/**
 * Converts Claude Code reset labels such as "11:30pm (Asia/Shanghai)" or
 * "Sep 15 at 4pm (Asia/Shanghai)" into epoch seconds. Returns null when unrecognized.
 */
export function resolveResetLabel(label, now = Date.now()) {
  const match = label
    ?.trim()
    .match(
      /^(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?$/i,
    );
  if (!match) return null;

  const [, monthName, dayText, yearText, hourText, minuteText, meridiem, zone] = match;
  const clockHour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  if (clockHour < 1 || clockHour > 12 || minute > 59) return null;
  const hour = (clockHour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);

  try {
    const timeZone = zone?.trim() || undefined;
    const today = zonedParts(now, timeZone);
    let resetAt;

    if (monthName) {
      const month = MONTHS.indexOf(monthName.toLowerCase());
      if (month < 0) return null;
      let year = yearText ? Number(yearText) : today.year;
      resetAt = zonedTimeToEpoch(year, month, Number(dayText), hour, minute, timeZone);
      // "Jan 2" read in late December belongs to the next year.
      if (!yearText && resetAt < now - 180 * 86_400_000) {
        year += 1;
        resetAt = zonedTimeToEpoch(year, month, Number(dayText), hour, minute, timeZone);
      }
    } else {
      resetAt = zonedTimeToEpoch(today.year, today.month, today.day, hour, minute, timeZone);
      if (resetAt < now - 60_000) {
        resetAt = zonedTimeToEpoch(today.year, today.month, today.day + 1, hour, minute, timeZone);
      }
    }

    return Math.round(resetAt / 1000);
  } catch {
    return null;
  }
}

export function parseClaudeUsage(rawOutput, now = Date.now()) {
  const usageView = stripTerminalCodes(rawOutput);
  const currentIndex = usageView.search(/Current session/i);
  const weeklyIndex = usageView.search(/Current week \(all models\)/i);
  if (currentIndex < 0 || weeklyIndex <= currentIndex) return null;

  const currentSection = usageView.slice(currentIndex, weeklyIndex);
  const weeklySection = usageView.slice(weeklyIndex);
  const currentPercent = readUsedPercent(currentSection);
  const weeklyPercent = readUsedPercent(weeklySection);
  const currentReset = currentSection.match(/Resets\s+([^\n]+)/i);
  const weeklyReset = weeklySection.match(/Resets\s+([^\n]+)/i);
  if (!currentPercent || !weeklyPercent || !currentReset || !weeklyReset) return null;

  const currentLabel = currentReset[1].trim();
  const weeklyLabel = weeklyReset[1].trim();
  return {
    limits: [
      makeLimit("window", "Current window", currentPercent, resolveResetLabel(currentLabel, now), currentLabel),
      makeLimit("weekly", "Weekly", weeklyPercent, resolveResetLabel(weeklyLabel, now), weeklyLabel),
    ],
  };
}

/**
 * Spawns a JSON-lines process, calls `start(send)`, then passes each parsed stdout
 * message to `handle(message, send)`. The call resolves with the first value `handle`
 * returns (or rejects with what it throws); the child is terminated once it settles.
 */
export function exchangeJsonLines({ command, args, env = process.env, timeoutMs, start, handle }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], env });
    let buffer = "";
    let settled = false;

    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value);
    };

    const send = (message) => {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const timer = setTimeout(
      () => settle(new Error(`${command} did not return usage data in time.`)),
      timeoutMs,
    );

    child.once("error", (error) => settle(error));
    // EPIPE when the process is missing or exits early; the exit/error handlers report it.
    child.stdin.on("error", () => {});
    child.once("exit", () => settle(new Error(`${command} exited before returning usage data.`)));

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (settled) return;
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        try {
          const outcome = handle(message, send);
          if (outcome !== undefined) settle(null, outcome);
        } catch (error) {
          settle(error);
        }
      }
    });

    start(send);
  });
}

/**
 * Runs a JSON-lines RPC process: sends `initialize` (id 1), then `requests` once
 * initialized, and resolves with `{ [method]: result }` after every request is answered.
 */
export function readJsonLineProcess(command, args, requests, timeoutMs = CODEX_TIMEOUT_MS) {
  const replies = new Map();
  let initialized = false;

  return exchangeJsonLines({
    command,
    args,
    timeoutMs,
    start: (send) =>
      send({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "tokentide",
            title: "TokenTide",
            version: "1.0.0",
          },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
      }),
    handle: (message, send) => {
      if (message.id === 1 && !initialized) {
        initialized = true;
        requests.forEach(send);
        return undefined;
      }

      const request = requests.find((item) => item.id === message.id);
      if (!request) return undefined;
      if (message.error) throw new Error("Codex rejected the local usage request.");
      replies.set(request.method, message.result);
      return replies.size === requests.length ? Object.fromEntries(replies) : undefined;
    },
  });
}

async function readCodexUsage() {
  const replies = await readJsonLineProcess("codex", ["app-server", "--stdio"], [
    { method: "account/rateLimits/read", id: 2, params: undefined },
  ]);
  const result = replies["account/rateLimits/read"];
  const snapshot = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;

  if (!snapshot) {
    throw new Error("Codex is signed in, but no quota windows were returned.");
  }

  return {
    id: "codex",
    name: "Codex",
    connected: true,
    account:
      snapshot.planType && snapshot.planType !== "unknown"
        ? `${snapshot.planType.replaceAll("_", " ")} plan`
        : "Local account",
    source: "Codex app server",
    limits: [
      makeLimit(
        "window",
        "Current window",
        snapshot.primary?.usedPercent,
        snapshot.primary?.resetsAt,
      ),
      makeLimit(
        "weekly",
        "Weekly",
        snapshot.secondary?.usedPercent,
        snapshot.secondary?.resetsAt,
      ),
    ],
  };
}

function claudeEnv() {
  // Plan quotas belong to the signed-in claude.ai account, never to an API key.
  const env = { ...process.env, TERM: process.env.TERM || "xterm-256color" };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

function toEpochSeconds(value) {
  if (typeof value === "number") return value;
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? Math.round(parsed / 1000) : null;
}

/** Maps a Claude Code `get_usage` control response to a provider entry. */
export function parseClaudeDirectUsage(usage) {
  const limits = usage?.rate_limits;
  if (!usage?.rate_limits_available || !limits?.five_hour || !limits?.seven_day) {
    throw new Error("Claude Code did not report plan limits for this account.");
  }

  return {
    id: "claude",
    name: "Claude Code",
    connected: true,
    account: usage.subscription_type ? `${usage.subscription_type} plan` : "Local account",
    source: "Claude Code get_usage",
    limits: [
      makeLimit("window", "Current window", limits.five_hour.utilization, toEpochSeconds(limits.five_hour.resets_at)),
      makeLimit("weekly", "Weekly", limits.seven_day.utilization, toEpochSeconds(limits.seven_day.resets_at)),
    ],
  };
}

/**
 * Reads plan usage through Claude Code's structured `get_usage` control request (the data
 * behind /usage). It sends no prompt, so it costs nothing. The request is marked
 * experimental upstream; callers fall back to the /usage view when it fails.
 */
export async function readClaudeUsageDirect(
  command = "claude",
  args = CLAUDE_DIRECT_ARGS,
  timeoutMs = CLAUDE_DIRECT_TIMEOUT_MS,
) {
  const usage = await exchangeJsonLines({
    command,
    args,
    env: claudeEnv(),
    timeoutMs,
    start: (send) =>
      send({
        type: "control_request",
        request_id: "usage",
        request: { subtype: "get_usage", skip_behaviors: true },
      }),
    handle: (message) => {
      if (message.type !== "control_response" || message.response?.request_id !== "usage") return undefined;
      if (message.response.subtype !== "success") {
        throw new Error("Claude Code rejected the structured usage request.");
      }
      return message.response.response ?? {};
    },
  });
  return parseClaudeDirectUsage(usage);
}

class ClaudeUsageSession {
  constructor() {
    this.child = null;
    this.output = "";
    this.pending = null;
    this.requestTimer = null;
    this.ready = false;
    this.sentForPending = false;
  }

  start() {
    if (this.child && !this.child.killed) return;

    const env = claudeEnv();
    this.output = "";
    this.ready = false;
    const child = spawn(
      "/usr/bin/expect",
      [fileURLToPath(new URL("./claude-usage.expect", import.meta.url)), randomUUID()],
      { stdio: ["pipe", "pipe", "ignore"], env },
    );
    this.child = child;
    // Events from a child that has since been replaced must not touch the new session.
    const isCurrent = () => this.child === child;

    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      if (!isCurrent()) return;
      this.output = `${this.output}${chunk.toString("utf8")}`.slice(-CLAUDE_OUTPUT_LIMIT);
      if (!this.ready && this.output.includes("@@READY@@")) {
        this.ready = true;
        this.sendUsageCommand();
      }
      if (this.output.includes("@@ERROR:")) {
        this.fail(new Error("Claude Code could not open its usage view."));
        return;
      }
      this.tryResolve();
    });

    child.once("exit", () => {
      if (!isCurrent()) return;
      this.child = null;
      this.ready = false;
      this.fail(new Error("Claude Code closed before returning usage data."));
    });

    child.once("error", (error) => {
      if (!isCurrent()) return;
      this.child = null;
      this.ready = false;
      this.fail(error);
    });
  }

  request() {
    if (this.pending) return this.pending.promise;
    this.start();
    this.output = "";
    this.sentForPending = false;

    let resolve;
    let reject;
    const promise = new Promise((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    this.pending = { promise, resolve, reject };
    this.sendUsageCommand();
    this.requestTimer = setTimeout(() => {
      this.fail(
        new Error("Claude Code did not expose plan usage. Open Claude Code and run /usage once."),
      );
      this.close();
    }, CLAUDE_TIMEOUT_MS);

    return promise;
  }

  sendUsageCommand() {
    if (!this.pending || !this.ready || this.sentForPending) return;
    if (!this.child?.stdin.writable) {
      this.fail(new Error("Claude Code usage session is not available."));
      return;
    }
    this.sentForPending = true;
    this.output = "";
    this.child.stdin.write("USAGE\n");
  }

  tryResolve() {
    if (!this.pending || !this.output.includes("@@END_USAGE@@")) return;
    const start = this.output.lastIndexOf("@@BEGIN_USAGE@@");
    const end = this.output.lastIndexOf("@@END_USAGE@@");
    const parsed = parseClaudeUsage(this.output.slice(Math.max(0, start), end));
    if (!parsed) {
      this.fail(new Error("Claude Code returned an unreadable usage view."));
      return;
    }

    this.pending.resolve({
      id: "claude",
      name: "Claude Code",
      connected: true,
      account: "Usage view fallback",
      source: "Claude Code /usage",
      limits: parsed.limits,
    });
    this.clearPending();
  }

  fail(error) {
    if (!this.pending) return;
    this.pending.reject(error);
    this.clearPending();
  }

  clearPending() {
    clearTimeout(this.requestTimer);
    this.requestTimer = null;
    this.pending = null;
    this.sentForPending = false;
  }

  close() {
    this.fail(new Error("Claude Code usage session was closed."));
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (!child) return;
    if (child.stdin.writable) child.stdin.write("EXIT\n");
    setTimeout(() => child.kill("SIGTERM"), 500).unref();
  }
}

function unavailableProvider(id, name, error) {
  return {
    id,
    name,
    connected: false,
    account: "Unavailable",
    source: null,
    limits: [],
    error: error instanceof Error ? error.message : "Usage is currently unavailable.",
  };
}

/**
 * `readers` lets tests replace the local CLI readers; production callers pass nothing.
 * `quotaLog` (see quota-weeks.mjs) receives each weekly reading for the 使用率 view.
 */
export function createUsageService(readers = {}, { quotaLog = null } = {}) {
  let claudeSession = null;
  const readCodex = readers.codex ?? readCodexUsage;
  const readQoder = readers.qoder ?? (() => readQoderUsage());
  const readClaudeDirect = readers.claudeDirect ?? (() => readClaudeUsageDirect());
  const readClaudeFallback =
    readers.claudeFallback ?? (() => (claudeSession ??= new ClaudeUsageSession()).request());
  let inFlight = null;

  async function readClaude() {
    try {
      const provider = await readClaudeDirect();
      // The structured request works, so the resident /usage session is not needed.
      claudeSession?.close();
      return provider;
    } catch (directError) {
      try {
        return await readClaudeFallback();
      } catch {
        throw directError;
      }
    }
  }

  async function readAll() {
    const [codex, claude, qoder] = await Promise.allSettled([readCodex(), readClaude(), readQoder()]);
    const result = {
      updatedAt: Date.now(),
      providers: [
        codex.status === "fulfilled"
          ? codex.value
          : unavailableProvider("codex", "Codex", codex.reason),
        claude.status === "fulfilled"
          ? claude.value
          : unavailableProvider("claude", "Claude Code", claude.reason),
        // The Qoder CLI exists when its read fails, so keep Qoder visible with the error.
        qoder.status === "fulfilled"
          ? qoder.value
          : { ...unavailableProvider("qoder", "Qoder", qoder.reason), installed: true },
      ],
    };

    if (quotaLog) {
      await Promise.all(
        result.providers.map((provider) =>
          quotaLog.record(provider.id, weeklyReadingFromProvider(provider, result.updatedAt)).catch(() => {}),
        ),
      );
    }
    return result;
  }

  return {
    // Concurrent callers share one read so each refresh spawns at most one Codex process.
    read() {
      inFlight ??= readAll().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    close() {
      claudeSession?.close();
    },
  };
}
