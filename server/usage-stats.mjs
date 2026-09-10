import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildWeeklyWindows,
  claudeUsageCost,
  compactReadings,
  estimateWeeklyWindows,
  extractCodexWeeklyReading,
} from "./quota-weeks.mjs";

// Aggregates local Codex and Claude Code transcripts into per-day activity for the history view.
// Only counts, token totals, model names, and hours leave this module; never transcript content.

// Version 2 added Codex weekly quota readings; version 3 adds Claude Code cost per hour.
const CACHE_VERSION = 3;
const STALE_MS = 30_000;

export function dayKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

function createAggregate() {
  return { sessions: [], days: {} };
}

function dayEntry(aggregate, day) {
  return (aggregate.days[day] ??= { messages: 0, models: {} });
}

function addTokens(aggregate, day, model, total, io) {
  if (total <= 0) return;
  const bucket = (dayEntry(aggregate, day).models[model] ??= { total: 0, io: 0 });
  bucket.total += total;
  bucket.io += io;
}

function addSession(aggregate, timestamp) {
  const day = dayKey(timestamp);
  if (day) aggregate.sessions.push({ day, hour: new Date(timestamp).getHours() });
}

/**
 * One Claude Code transcript (`projects/<project>/<session>.jsonl`, or a subagent transcript).
 * Mirrors Claude Code's /stats: a main transcript is one session that starts at its first
 * message; messages are counted in main transcripts only; tokens include subagents and are
 * input + output + cache read + cache write. Unlike /stats, an API response that is split
 * across several transcript entries is counted once. `costByHour` (API-price equivalent per
 * epoch hour) feeds the weekly utilization estimate.
 */
export function aggregateClaudeTranscript(text, { subagent = false } = {}) {
  const aggregate = createAggregate();
  const responses = new Map();
  const assistantIds = new Set();
  let firstTimestamp = null;

  for (const line of text.split("\n")) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    const entry = parseLine(line);
    if (!entry || (entry.type !== "user" && entry.type !== "assistant")) continue;
    if (!subagent && entry.isSidechain) continue;
    const day = dayKey(entry.timestamp);
    if (!day) continue;

    const message = entry.message && typeof entry.message === "object" ? entry.message : null;
    if (!subagent) {
      firstTimestamp ??= entry.timestamp;
      const id = entry.type === "assistant" ? message?.id : null;
      if (!id || !assistantIds.has(id)) {
        if (id) assistantIds.add(id);
        dayEntry(aggregate, day).messages += 1;
      }
    }

    const model = message?.model || "unknown";
    if (entry.type === "assistant" && message?.usage && model !== "<synthetic>") {
      // Later entries of the same response carry the final usage.
      const key = message.id ? `${message.id}:${entry.requestId ?? ""}` : `entry:${responses.size}`;
      responses.set(key, { day, model, usage: message.usage, at: Date.parse(entry.timestamp) });
    }
  }

  aggregate.costByHour = {};
  for (const { day, model, usage, at } of responses.values()) {
    const input = count(usage.input_tokens);
    const output = count(usage.output_tokens);
    const cacheRead = count(usage.cache_read_input_tokens);
    const cacheWrite = count(usage.cache_creation_input_tokens);
    addTokens(aggregate, day, model, input + output + cacheRead + cacheWrite, input + output);
    if (Number.isFinite(at)) {
      const hour = Math.floor(at / 3_600_000);
      aggregate.costByHour[hour] =
        (aggregate.costByHour[hour] ?? 0) + claudeUsageCost(model, { input, output, cacheRead, cacheWrite });
    }
  }
  if (firstTimestamp) addSession(aggregate, firstTimestamp);
  return aggregate;
}

/**
 * One Codex rollout (`sessions/**\/rollout-*.jsonl`). A rollout is one session; messages are
 * user turns plus assistant replies; tokens are the growth of the cumulative
 * `total_token_usage`, attributed to the model of the current turn. The `rate_limits` on
 * `token_count` events also give the weekly quota readings for the 使用率 view.
 */
export function aggregateCodexRollout(text) {
  const aggregate = createAggregate();
  const quotaReadings = [];
  const agentMessageDays = [];
  let assistantMessages = 0;
  let model = "unknown";
  let previous = null;
  let sessionStarted = false;

  for (const line of text.split("\n")) {
    if (
      !line.includes('"token_count"') &&
      !line.includes('"task_started"') &&
      !line.includes('"turn_context"') &&
      !line.includes('"session_meta"') &&
      !line.includes('"assistant"') &&
      !line.includes('"agent_message"')
    ) {
      continue;
    }
    const entry = parseLine(line);
    if (!entry) continue;
    const payload = entry.payload && typeof entry.payload === "object" ? entry.payload : {};
    const timestamp = entry.timestamp ?? payload.timestamp;

    if (entry.type === "session_meta") {
      if (!sessionStarted && dayKey(timestamp)) {
        sessionStarted = true;
        addSession(aggregate, timestamp);
      }
      continue;
    }
    if (entry.type === "turn_context") {
      if (typeof payload.model === "string" && payload.model) model = payload.model;
      continue;
    }

    const day = dayKey(timestamp);
    if (!day) continue;

    if (entry.type === "event_msg" && payload.type === "task_started") {
      dayEntry(aggregate, day).messages += 1;
    } else if (entry.type === "response_item" && payload.type === "message" && payload.role === "assistant") {
      assistantMessages += 1;
      dayEntry(aggregate, day).messages += 1;
    } else if (entry.type === "response_item" && payload.type === "agent_message") {
      agentMessageDays.push(day);
    }
    if (entry.type === "event_msg" && payload.type === "token_count" && payload.rate_limits) {
      quotaReadings.push(extractCodexWeeklyReading(payload.rate_limits, Date.parse(timestamp)));
    }
    if (entry.type === "event_msg" && payload.type === "token_count" && payload.info?.total_token_usage) {
      const current = payload.info.total_token_usage;
      const base = previous ?? {};
      const total = count(current.total_tokens) - count(base.total_tokens);
      if (total > 0) {
        const input =
          count(current.input_tokens) - count(base.input_tokens) -
          (count(current.cached_input_tokens) - count(base.cached_input_tokens));
        const output = count(current.output_tokens) - count(base.output_tokens);
        addTokens(aggregate, day, model, total, Math.max(0, input) + Math.max(0, output));
      }
      previous = current;
    }
  }

  // Some rollouts record replies only as `agent_message`; others record both forms.
  if (assistantMessages === 0) {
    for (const day of agentMessageDays) dayEntry(aggregate, day).messages += 1;
  }
  aggregate.quota = compactReadings(quotaReadings.filter((reading) => reading && Number.isFinite(reading.at)));
  return aggregate;
}

/** Merges per-file aggregates into a sorted per-day series. */
export function summarizeAggregates(aggregates) {
  const days = new Map();
  const dayOf = (date) => {
    if (!days.has(date)) days.set(date, { date, sessions: 0, messages: 0, tokens: 0, io: 0, models: {}, hours: {} });
    return days.get(date);
  };

  for (const aggregate of aggregates) {
    for (const { day, hour } of aggregate.sessions) {
      const entry = dayOf(day);
      entry.sessions += 1;
      entry.hours[hour] = (entry.hours[hour] ?? 0) + 1;
    }
    for (const [day, value] of Object.entries(aggregate.days)) {
      const entry = dayOf(day);
      entry.messages += value.messages;
      for (const [model, tokens] of Object.entries(value.models)) {
        entry.tokens += tokens.total;
        entry.io += tokens.io;
        entry.models[model] = (entry.models[model] ?? 0) + tokens.total;
      }
    }
  }

  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function claudeProvider(aggregates, logged) {
  const costByHour = {};
  for (const aggregate of aggregates) {
    for (const [hour, cost] of Object.entries(aggregate.costByHour ?? {})) {
      costByHour[hour] = (costByHour[hour] ?? 0) + cost;
    }
  }
  // Claude Code keeps no quota history, so weeks before TokenTide's log are estimated.
  const { windows, estimate } = estimateWeeklyWindows(buildWeeklyWindows(logged), costByHour);
  return { id: "claude", days: summarizeAggregates(aggregates), quotaWeeks: windows, quotaEstimate: estimate };
}

async function listFiles(directory, accept) {
  try {
    const entries = await readdir(directory, { recursive: true });
    return entries.filter(accept).map((relative) => path.join(directory, relative));
  } catch {
    return [];
  }
}

function defaultCachePath() {
  const base =
    process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches", "TokenTide") : os.tmpdir();
  return path.join(base, `usage-stats-v${CACHE_VERSION}.json`);
}

export function createStatsService({
  claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  codexDir = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  cachePath = defaultCachePath(),
  quotaLog = null,
} = {}) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let files = null;
  let result = null;
  let computedAt = 0;
  let inFlight = null;

  async function loadCache() {
    if (files) return;
    files = {};
    if (!cachePath) return;
    try {
      const stored = JSON.parse(await readFile(cachePath, "utf8"));
      // Day keys are local dates, so a time zone change invalidates them.
      if (stored.version === CACHE_VERSION && stored.timeZone === timeZone) files = stored.files ?? {};
    } catch {
      // Missing or unreadable cache: rebuild from the transcripts.
    }
  }

  async function persist() {
    if (!cachePath) return;
    try {
      await mkdir(path.dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify({ version: CACHE_VERSION, timeZone, files }), { mode: 0o600 });
    } catch {
      // The in-memory cache still avoids rescans for this process.
    }
  }

  async function scan() {
    await loadCache();
    const projects = path.join(claudeDir, "projects");
    const [claudeFiles, codexSessions, codexArchived] = await Promise.all([
      listFiles(projects, (file) => {
        const parts = file.split(path.sep);
        return (
          file.endsWith(".jsonl") &&
          (parts.length === 2 || (parts.length === 4 && parts[2] === "subagents" && parts[3].startsWith("agent-")))
        );
      }),
      listFiles(path.join(codexDir, "sessions"), (file) => file.endsWith(".jsonl")),
      listFiles(path.join(codexDir, "archived_sessions"), (file) => file.endsWith(".jsonl")),
    ]);

    const sources = [
      ...claudeFiles.map((file) => ({ file, kind: "claude", subagent: file.includes(`${path.sep}subagents${path.sep}`) })),
      ...[...codexSessions, ...codexArchived].map((file) => ({ file, kind: "codex" })),
    ];

    const next = {};
    let changed = Object.keys(files).length !== sources.length;
    for (const { file, kind, subagent } of sources) {
      const info = await stat(file).catch(() => null);
      if (!info) continue;
      const cached = files[file];
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
        next[file] = cached;
        continue;
      }
      const text = await readFile(file, "utf8").catch(() => null);
      if (text === null) continue;
      next[file] = {
        kind,
        mtimeMs: info.mtimeMs,
        size: info.size,
        aggregate: kind === "claude" ? aggregateClaudeTranscript(text, { subagent }) : aggregateCodexRollout(text),
      };
      changed = true;
      // Keep the dev server responsive during a cold scan.
      await new Promise((resolve) => setImmediate(resolve));
    }

    files = next;
    if (changed) await persist();

    const byKind = (kind) => Object.values(files).filter((item) => item.kind === kind).map((item) => item.aggregate);
    const codexAggregates = byKind("codex");
    const [codexLogged, claudeLogged] = await Promise.all([
      quotaLog?.readings("codex") ?? [],
      quotaLog?.readings("claude") ?? [],
    ]);
    return {
      generatedAt: Date.now(),
      providers: [
        {
          id: "codex",
          days: summarizeAggregates(codexAggregates),
          quotaWeeks: buildWeeklyWindows([...codexAggregates.flatMap((aggregate) => aggregate.quota ?? []), ...codexLogged]),
        },
        claudeProvider(byKind("claude"), claudeLogged),
      ],
    };
  }

  return {
    read() {
      if (result && Date.now() - computedAt < STALE_MS) return Promise.resolve(result);
      inFlight ??= scan()
        .then((value) => {
          result = value;
          computedAt = Date.now();
          return value;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
