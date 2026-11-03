import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultDataDir } from "./secret-store.mjs";

// The local API for other apps: a stable, read-only JSON view of the latest reading at
// http://127.0.0.1:<port>/v1/usage (and /v1/usage/<tool>). It serves the reading the panel's
// own refreshes keep current, and reads again only when that is older than MAX_AGE_MS, so other
// apps polling it never start the command-line tools more often than that. It carries no keys,
// tokens, account identifiers, or error text (which can hold file paths): status and error codes
// only. On by default; Settings → Local API turns it off (local-api.json in the data folder).

export const SCHEMA = "tokentide.usage.v1";
const MAX_AGE_MS = 5 * 60_000;
const MIN_AGE_MS = 60_000;

const iso = (seconds) => (Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null);
const isoMs = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const number = (value) => (Number.isFinite(value) ? value : null);

/** The plan name from the service's account label ("max plan" → "max"), or null. */
const planOf = (account) => (typeof account === "string" && / plan$/i.test(account) ? account.replace(/ plan$/i, "") : null);

/** The limit behind the headline, as the panel picks it: the current window, Qoder's total, else the first. */
const primaryOf = (limits) => limits.find((limit) => limit.id === "window") ?? limits.find((limit) => limit.id === "total") ?? limits[0];

function publicLimit(limit) {
  return {
    id: limit.id,
    usedPercent: number(limit.usedPercent),
    remainingPercent: number(limit.remainingPercent),
    resetsAt: iso(limit.resetsAt),
    ...(Number.isFinite(limit.totalAmount)
      ? { remainingAmount: number(limit.remainingAmount), totalAmount: limit.totalAmount, unit: limit.unit ?? null }
      : {}),
  };
}

const spans = (usage, pick) => Object.fromEntries(["today", "week", "month"].map((span) => [span, pick(usage?.[span] ?? {})]));

/** One tool in the public shape. */
export function publicTool(provider, updatedAt) {
  const limits = (provider.limits ?? []).map(publicLimit);
  const primary = primaryOf(provider.limits ?? []);
  const status = provider.stale ? "stale" : provider.connected ? "ok" : "unavailable";
  const tool = {
    id: provider.id,
    name: provider.name ?? provider.id,
    status,
    plan: planOf(provider.account),
    // The headline percentage left (null when there is none, e.g. DeepSeek, which has no quota).
    remainingPercent: provider.connected ? number(primary?.remainingPercent) : null,
    headline: provider.connected && primary ? primary.id : null,
    limits: provider.connected ? limits : [],
    readAt: isoMs(provider.stale ? provider.readAt : updatedAt),
    error: status === "ok" ? null : provider.stale ? "stale" : (provider.errorCode ?? "unavailable"),
  };
  if (provider.usage) {
    tool.usage = {
      currency: "CNY",
      ...spans(provider.usage, (span) => ({
        tokens: number(span.tokens),
        messages: number(span.messages),
        // At DeepSeek's published prices: an estimate, not the bill.
        estimatedCost: number(span.cost),
      })),
    };
  }
  const balance = provider.balance;
  if (balance && Number.isFinite(balance.total)) {
    tool.balance = {
      currency: balance.currency ?? "CNY",
      total: balance.total,
      available: balance.available !== false,
      readAt: isoMs(balance.readAt),
      error: balance.error ?? null,
      spent: balance.spending ? spans(balance.spending, (value) => number(value)) : null,
    };
  }
  return tool;
}

/** The whole reading in the public shape; tools that are not installed are left out. */
export function publicUsage(payload) {
  return {
    schema: SCHEMA,
    updatedAt: isoMs(payload?.updatedAt),
    tools: (payload?.providers ?? []).filter((provider) => provider.installed !== false).map((provider) => publicTool(provider, payload.updatedAt)),
  };
}

/** Whether other apps may read usage, kept in the data folder so the service knows it at start. */
export function createLocalApiConfig({ configPath = path.join(defaultDataDir(), "local-api.json") } = {}) {
  let enabled = null;
  return {
    async enabled() {
      if (enabled === null) {
        try {
          enabled = JSON.parse(await readFile(configPath, "utf8")).enabled !== false;
        } catch {
          enabled = true;
        }
      }
      return enabled;
    },
    async setEnabled(value) {
      enabled = Boolean(value);
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(`${configPath}.tmp`, JSON.stringify({ enabled }), { mode: 0o600 });
      await rename(`${configPath}.tmp`, configPath);
      return enabled;
    },
  };
}

/** The latest reading, read again only when older than `maxAgeMs` (never more often than a minute). */
export async function currentReading(usageService, { maxAgeMs = MAX_AGE_MS, now = Date.now() } = {}) {
  const age = Math.max(MIN_AGE_MS, Math.min(maxAgeMs, MAX_AGE_MS));
  const latest = usageService.latest?.();
  if (latest && now - latest.updatedAt < age) return latest;
  return usageService.read();
}

// /v1/events: the same readings pushed as Server-Sent Events, so other apps need not poll.
// Each connection gets the current reading at once, then an `usage` event after every new read.
// While anyone listens, a reading is kept no older than MAX_AGE_MS even if the panel's own
// refreshes are off. Comments keep idle connections from being dropped.
const HEARTBEAT_MS = 25_000;
const KEEP_FRESH_CHECK_MS = 60_000;
export const MAX_EVENT_STREAMS = 32;

/** One Server-Sent Event. Data is single-line JSON. */
export const sseEvent = (event, data, id) => `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function createEventHub({
  usageService,
  config,
  heartbeatMs = HEARTBEAT_MS,
  keepFreshMs = KEEP_FRESH_CHECK_MS,
  maxStreams = MAX_EVENT_STREAMS,
}) {
  const streams = new Set();
  let unsubscribe = null;
  let heartbeat = null;
  let keepFresh = null;

  const send = (response, chunk) => {
    try {
      response.write(chunk);
    } catch {
      streams.delete(response);
    }
  };
  const broadcast = (chunk) => {
    for (const response of streams) send(response, chunk);
  };
  const usageEvent = (payload) => sseEvent("usage", publicUsage(payload), payload?.updatedAt);

  function start() {
    unsubscribe = usageService.subscribe?.(async (payload) => {
      if (!(await config.enabled())) return endAll("disabled");
      broadcast(usageEvent(payload));
    });
    heartbeat = setInterval(() => broadcast(": ping\n\n"), heartbeatMs);
    heartbeat.unref?.();
    // Listeners get a reading at least every MAX_AGE_MS, whatever the panel's refresh setting.
    keepFresh = setInterval(() => {
      const latest = usageService.latest?.();
      if (!latest || Date.now() - latest.updatedAt >= MAX_AGE_MS) usageService.read().catch(() => {});
    }, keepFreshMs);
    keepFresh.unref?.();
  }

  function stop() {
    unsubscribe?.();
    clearInterval(heartbeat);
    clearInterval(keepFresh);
    unsubscribe = heartbeat = keepFresh = null;
  }

  function endAll(reason) {
    for (const response of streams) {
      send(response, sseEvent(reason, { reason }));
      response.end();
    }
    streams.clear();
    stop();
  }

  return {
    get size() {
      return streams.size;
    },

    /** Answers GET /v1/events. The caller has already checked the Host and Origin. */
    async handle(request, response) {
      if (!(await config.enabled())) return json(response, 403, { error: "disabled" });
      if (streams.size >= maxStreams) return json(response, 503, { error: "tooManyStreams" });

      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        // Tells proxies such as nginx not to buffer the stream.
        "X-Accel-Buffering": "no",
      });
      response.write("retry: 10000\n\n");
      streams.add(response);
      if (streams.size === 1) start();
      request.on("close", () => {
        streams.delete(response);
        if (streams.size === 0) stop();
      });

      const payload = await currentReading(usageService).catch(() => null);
      if (payload && streams.has(response)) send(response, usageEvent(payload));
    },

    /** Tells every listener the local API was turned off, and ends their streams. */
    disable: () => endAll("disabled"),
    close: () => endAll("closing"),
  };
}

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}
