import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { BUILTIN_DEEPSEEK_PRICES, deepseekCost } from "./deepseek-pricing.mjs";
import {
  buildWeeklyWindows,
  claudeUsageCost,
  compactReadings,
  estimateWeeklyWindows,
  extractCodexWeeklyReading,
} from "./quota-weeks.mjs";

// Aggregates local Codex, Claude Code, Qoder, and DeepSeek Harness transcripts into per-day
// activity for the history view.
// Only counts, token totals, model names, and hours leave this module; never transcript content.

// Version 2 added Codex weekly quota readings; version 3 Claude Code cost per hour; version 4
// DeepSeek Harness estimated cost.
const CACHE_VERSION = 4;
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

function addTokens(aggregate, day, model, total, io, credits = 0) {
  if (total <= 0 && credits <= 0) return;
  const bucket = (dayEntry(aggregate, day).models[model] ??= { total: 0, io: 0 });
  bucket.total += total;
  bucket.io += io;
  // Qoder bills in credits (and reports zero tokens); Claude Code has none.
  if (credits > 0) bucket.credits = (bucket.credits ?? 0) + credits;
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
export function aggregateClaudeTranscript(text, { subagent = false, pricing = true } = {}) {
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
    addTokens(aggregate, day, model, input + output + cacheRead + cacheWrite, input + output, count(usage.credits));
    if (pricing && Number.isFinite(at)) {
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

// DeepSeek Harness keeps one directory per session under `$DSH_HOME/sessions/<project>/`, holding
// one log per format generation: `session.jsonl`, `session.v1.jsonl`, … each raw or
// Zstandard-compressed (`.zstd`). Harness reads the numerically highest generation.
const DEEPSEEK_LOG = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/;

/** The current log of every DeepSeek Harness session under `sessionsDir`. */
export async function listDeepseekSessionLogs(sessionsDir) {
  const newest = new Map();
  let entries;
  try {
    entries = await readdir(sessionsDir, { recursive: true });
  } catch {
    return [];
  }
  for (const relative of entries) {
    const match = path.basename(relative).match(DEEPSEEK_LOG);
    if (!match) continue;
    const directory = path.dirname(relative);
    const version = Number(match[1] ?? 0);
    const current = newest.get(directory);
    if (!current || version > current.version) newest.set(directory, { version, file: path.join(sessionsDir, relative) });
  }
  return [...newest.values()].map((item) => item.file);
}

const ZSTD_MAGIC = 0xfd2fb528;

/**
 * The byte length of the Zstandard frame at `offset` (RFC 8878 §3.1), or null when the buffer
 * ends before the frame does. Skippable frames are reported with `skip: true`.
 */
function zstdFrameLength(buffer, offset) {
  if (offset + 8 > buffer.length) return null;
  const magic = buffer.readUInt32LE(offset);
  if ((magic & 0xfffffff0) === 0x184d2a50) {
    const length = 8 + buffer.readUInt32LE(offset + 4);
    return offset + length <= buffer.length ? { length, skip: true } : null;
  }
  if (magic !== ZSTD_MAGIC) throw new Error("Not a Zstandard frame.");
  const descriptor = buffer[offset + 4];
  const singleSegment = (descriptor >> 5) & 1;
  const contentSizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][descriptor >> 6];
  const dictionaryBytes = [0, 1, 2, 4][descriptor & 3];
  let position = offset + 5 + (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  for (;;) {
    if (position + 3 > buffer.length) return null;
    const header = buffer[position] | (buffer[position + 1] << 8) | (buffer[position + 2] << 16);
    const type = (header >> 1) & 3;
    if (type === 3) throw new Error("Corrupt Zstandard block.");
    position += 3 + (type === 1 ? 1 : header >>> 3);
    if (header & 1) break;
  }
  position += (descriptor >> 2) & 1 ? 4 : 0;
  return position <= buffer.length ? { length: position - offset, skip: false } : null;
}

/**
 * A DeepSeek Harness log as text. Compressed logs are a series of Zstandard frames, one per
 * write batch (Node's decoder stops after the first, so each is decoded on its own). A final
 * frame Harness is still writing is left out; the file is read again once it changes.
 */
export function decodeDeepseekSessionLog(buffer, file) {
  if (!file.endsWith(".zstd")) return buffer.toString("utf8");
  const parts = [];
  let offset = 0;
  while (offset < buffer.length) {
    const frame = zstdFrameLength(buffer, offset);
    if (!frame) break;
    if (!frame.skip) parts.push(zstdDecompressSync(buffer.subarray(offset, offset + frame.length)));
    offset += frame.length;
  }
  return Buffer.concat(parts).toString("utf8");
}

/** The provider-reported usage of one Assistant settlement: `data.usage`, or its stream's last usage chunk. */
function deepseekUsageOf(data) {
  if (data?.usage && typeof data.usage === "object") return data.usage;
  const stream = Array.isArray(data?.stream) ? data.stream : [];
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record?.type === "chunk" && record.chunk?.type === "usage") return record.chunk.usage ?? null;
  }
  return null;
}

/**
 * One DeepSeek Harness session log: a header row (`type: "session"`), then one event per row
 * (`{ seq, type, time, data }`). Follows Harness's own token meter: each `assistant/message`
 * or `assistant/attempt` reports its attempt's usage, a later sample for the same turn and step
 * replaces the earlier one, and `llm/retry-started` starts a new billed attempt. Tokens are
 * input + output + cache read + cache write. A session with a `parentSession` is a subagent's:
 * its tokens count, but it is not a separate session and its messages are not counted. A session
 * starts at its first message; one opened and never used is not counted. Costs use `prices`
 * (a table from deepseek-pricing.mjs; the built-in one by default).
 */
export function aggregateDeepseekSession(text, prices) {
  const aggregate = createAggregate();
  const attempts = new Map();
  const retries = new Map();
  let subagent = false;
  let started = false;
  let model = "deepseek";

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const entry = parseLine(line);
    if (!entry || typeof entry.type !== "string") continue;
    if (entry.type === "session") {
      subagent = Boolean(entry.parentSession);
      continue;
    }
    const data = entry.data && typeof entry.data === "object" ? entry.data : {};
    // Route metadata names the provider's model for the requests that follow.
    if (entry.type === "request/context" && typeof data.model === "string" && data.model) model = data.model;
    const day = dayKey(entry.time);
    if (!day) continue;

    if (!subagent && (entry.type === "user/message" || entry.type === "assistant/message")) {
      if (!started) {
        started = true;
        addSession(aggregate, entry.time);
      }
      dayEntry(aggregate, day).messages += 1;
    }
    const step = `${data.turn}:${data.step}`;
    if (entry.type === "llm/retry-started") {
      retries.set(step, (retries.get(step) ?? 0) + 1);
    } else if (entry.type === "assistant/message" || entry.type === "assistant/attempt") {
      const usage = deepseekUsageOf(data);
      if (usage) attempts.set(`${step}:${retries.get(step) ?? 0}`, { day, model, usage, at: entry.time });
    }
  }

  for (const { day, model: name, usage, at } of attempts.values()) {
    const tokens = {
      input: count(usage.inputTokens),
      output: count(usage.outputTokens),
      cacheRead: count(usage.cacheReadTokens),
      cacheWrite: count(usage.cacheWriteTokens),
    };
    addTokens(aggregate, day, name, tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite, tokens.input + tokens.output);
    // Estimated yuan at DeepSeek's published price for the hour of the reply (deepseek-pricing.mjs).
    const cost = deepseekCost(name, tokens, Number(at), prices);
    const bucket = aggregate.days[day]?.models[name];
    if (bucket && cost !== null) bucket.cost = Math.round(((bucket.cost ?? 0) + cost) * 1_000_000) / 1_000_000;
  }
  return aggregate;
}

/** Merges per-file aggregates into a sorted per-day series. */
export function summarizeAggregates(aggregates) {
  const days = new Map();
  const dayOf = (date) => {
    if (!days.has(date)) {
      days.set(date, { date, sessions: 0, messages: 0, tokens: 0, io: 0, credits: 0, cost: 0, models: {}, modelCredits: {}, hours: {} });
    }
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
        // DeepSeek's estimated cost in yuan.
        if (tokens.cost > 0) entry.cost = Math.round((entry.cost + tokens.cost) * 1_000_000) / 1_000_000;
        if (tokens.credits > 0) {
          entry.credits += tokens.credits;
          entry.modelCredits[model] = (entry.modelCredits[model] ?? 0) + tokens.credits;
        }
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

/** A transcript's text, or null when it cannot be read (yet). */
async function readTranscript(file, kind) {
  try {
    if (kind === "deepseek") return decodeDeepseekSessionLog(await readFile(file), file);
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
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
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches", "TokenTide")
      : process.platform === "win32"
        ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "TokenTide", "Cache")
        : os.tmpdir();
  return path.join(base, `usage-stats-v${CACHE_VERSION}.json`);
}

export function createStatsService({
  claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  codexDir = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  // Qoder (app and CLI) keeps Claude Code-style transcripts under ~/.qoder/projects.
  qoderDir = path.join(os.homedir(), ".qoder"),
  // DeepSeek Harness keeps its session logs under $DSH_HOME/sessions.
  dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh"),
  cachePath = defaultCachePath(),
  quotaLog = null,
  // DeepSeek balance readings (server/deepseek-balance.mjs), for History's Balance view.
  balanceLog = null,
  // DeepSeek's current prices (server/deepseek-price-book.mjs); the built-in table without one.
  priceBook = null,
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
    const prices = (await priceBook?.table()) ?? BUILTIN_DEEPSEEK_PRICES;
    const transcriptFile = (file) => {
      const parts = file.split(path.sep);
      return (
        file.endsWith(".jsonl") &&
        (parts.length === 2 || (parts.length === 4 && parts[2] === "subagents" && parts[3].startsWith("agent-")))
      );
    };
    const [claudeFiles, qoderFiles, deepseekFiles, codexSessions, codexArchived] = await Promise.all([
      listFiles(path.join(claudeDir, "projects"), transcriptFile),
      qoderDir ? listFiles(path.join(qoderDir, "projects"), transcriptFile) : [],
      dshHome ? listDeepseekSessionLogs(path.join(dshHome, "sessions")) : [],
      listFiles(path.join(codexDir, "sessions"), (file) => file.endsWith(".jsonl")),
      listFiles(path.join(codexDir, "archived_sessions"), (file) => file.endsWith(".jsonl")),
    ]);

    const isSubagent = (file) => file.includes(`${path.sep}subagents${path.sep}`);
    const sources = [
      ...claudeFiles.map((file) => ({ file, kind: "claude", subagent: isSubagent(file) })),
      ...qoderFiles.map((file) => ({ file, kind: "qoder", subagent: isSubagent(file) })),
      ...deepseekFiles.map((file) => ({ file, kind: "deepseek" })),
      ...[...codexSessions, ...codexArchived].map((file) => ({ file, kind: "codex" })),
    ];

    const next = {};
    let changed = Object.keys(files).length !== sources.length;
    for (const { file, kind, subagent } of sources) {
      const info = await stat(file).catch(() => null);
      if (!info) continue;
      const cached = files[file];
      // A DeepSeek session's costs are worked out again when the prices change.
      const priceVersion = kind === "deepseek" ? prices.version : undefined;
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size && cached.priceVersion === priceVersion) {
        next[file] = cached;
        continue;
      }
      const text = await readTranscript(file, kind);
      if (text === null) continue;
      next[file] = {
        kind,
        mtimeMs: info.mtimeMs,
        size: info.size,
        ...(priceVersion ? { priceVersion } : {}),
        aggregate:
          kind === "codex"
            ? aggregateCodexRollout(text)
            : kind === "deepseek"
              ? aggregateDeepseekSession(text, prices)
              : aggregateClaudeTranscript(text, { subagent, pricing: kind === "claude" }),
      };
      changed = true;
      // Keep the dev server responsive during a cold scan.
      await new Promise((resolve) => setImmediate(resolve));
    }

    files = next;
    if (changed) await persist();

    const byKind = (kind) => Object.values(files).filter((item) => item.kind === kind).map((item) => item.aggregate);
    const codexAggregates = byKind("codex");
    const [codexLogged, claudeLogged, balance] = await Promise.all([
      quotaLog?.readings("codex") ?? [],
      quotaLog?.readings("claude") ?? [],
      balanceLog?.history() ?? null,
    ]);
    return {
      generatedAt: Date.now(),
      priceVersion: prices.version,
      providers: [
        {
          id: "codex",
          days: summarizeAggregates(codexAggregates),
          quotaWeeks: buildWeeklyWindows([...codexAggregates.flatMap((aggregate) => aggregate.quota ?? []), ...codexLogged]),
        },
        claudeProvider(byKind("claude"), claudeLogged),
        { id: "qoder", days: summarizeAggregates(byKind("qoder")) },
        { id: "deepseek", days: summarizeAggregates(byKind("deepseek")), balance },
      ],
    };
  }

  return {
    async read() {
      const priceVersion = (await priceBook?.table())?.version;
      const fresh = result && Date.now() - computedAt < STALE_MS && (!priceVersion || result.priceVersion === priceVersion);
      if (fresh) return result;
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
