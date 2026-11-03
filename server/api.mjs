import { createApiAccountsReader, createSpendLog, readAnthropicSpend, readOpenAiSpend } from "./api-accounts.mjs";
import { createBalanceLog, DEEPSEEK_KEY_NAME, fetchDeepseekBalance } from "./deepseek-balance.mjs";
import { KEY_SOURCES, KEY_VARIABLES, createEnvCredentials, createKeyResolver } from "./env-credentials.mjs";
import { createDeepseekPriceBook } from "./deepseek-price-book.mjs";
import { createDeepseekReader } from "./deepseek-usage.mjs";
import { SCHEMA, createEventHub, createLocalApiConfig, currentReading, publicUsage } from "./local-api.mjs";
import { createProxyFetch } from "./proxy-fetch.mjs";
import { createQuotaLog } from "./quota-weeks.mjs";
import { createSecretStore, isStorableSecret, maskSecret } from "./secret-store.mjs";
import { createSkillInstaller } from "./skill-install.mjs";
import { createUsageService } from "./usage-service.mjs";
import { createStatsService } from "./usage-stats.mjs";

const BODY_LIMIT = 4096;

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** A small JSON request body; anything else is refused before it is read in full. */
async function readJsonBody(request) {
  if (!/^application\/json\b/i.test(request.headers["content-type"] ?? "")) throw new HttpError(415, "jsonRequired");
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError(413, "tooLarge");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "badJson");
  }
}

/** `?maxAge=<seconds>` in milliseconds, at most a day; undefined keeps the service's default. */
function maxAgeOf(request) {
  const value = new URL(request.url ?? "/", "http://localhost").searchParams.get("maxAge");
  if (value === null || value === "" || !Number.isFinite(Number(value))) return undefined;
  return Math.min(Math.max(Number(value), 0), 86_400) * 1000;
}

/**
 * The local JSON API (`/api/usage`, `/api/stats`, `/api/deepseek-key`), shared by the Vite dev
 * server and the packaged app's server. `services` lets tests replace the real readers, the
 * secret store, the balance log, DeepSeek's price book, and `fetch`.
 */
export function createLocalApi(services = {}, { migration = null } = {}) {
  const secrets = services.secrets ?? createSecretStore();
  const balanceLog = services.balanceLog ?? createBalanceLog();
  // Outbound requests use the user's proxy (environment, else the system's): server/proxy-fetch.mjs.
  const fetchImpl = services.fetchImpl ?? createProxyFetch();
  const priceBook = services.priceBook ?? createDeepseekPriceBook({ fetchImpl });
  const localApi = services.localApi ?? createLocalApiConfig();
  const skills = services.skills ?? createSkillInstaller();
  // Keys saved in Settings win; otherwise they come from the environment (DEEPSEEK_API_KEY …).
  const envCredentials = services.envCredentials ?? createEnvCredentials({ names: KEY_VARIABLES });
  const keys = createKeyResolver({ secrets, envCredentials });
  // Spend per day per API account, for the cards and History (server/api-accounts.mjs).
  const spendLog = services.spendLog ?? createSpendLog();
  // The DeepSeek reader asks the store for its key; answer with the resolved one.
  const deepseekSecrets = {
    get: async (name) => (name === DEEPSEEK_KEY_NAME ? ((await keys.resolve("deepseek"))?.value ?? null) : secrets.get(name)),
  };
  let usageService = services.usageService;
  let statsService = services.statsService;
  if (!usageService || !statsService) {
    const quotaLog = createQuotaLog();
    usageService ??= createUsageService(
      {
        deepseek: createDeepseekReader({ secrets: deepseekSecrets, balanceLog, fetchImpl, priceBook }),
        apiAccounts: createApiAccountsReader({ keys, envCredentials, fetchImpl, spendLog }),
      },
      { quotaLog },
    );
    statsService ??= createStatsService({ quotaLog, balanceLog, priceBook, spendLog });
  }

  // What Settings shows about a key: whether there is one, a masked hint, and where it came from
  // ("saved" in Settings, or "env" with the variable's name). The key itself never goes back.
  const stateOf = async (id) => {
    const key = await keys.resolve(id);
    return { configured: Boolean(key), hint: maskSecret(key?.value), source: key?.source ?? null, variable: key?.variable ?? null };
  };
  const keyState = () => stateOf("deepseek");

  // Admin keys for the API accounts: checked with the provider before they are saved.
  const ADMIN_KEYS = {
    "openai-admin": { check: (key) => readOpenAiSpend(key, { fetchImpl }), prefix: "sk-admin-" },
    "anthropic-admin": { check: (key) => readAnthropicSpend(key, { fetchImpl }), prefix: "sk-ant-admin" },
  };
  const adminKeyId = (request) => {
    const id = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname.slice("/api/keys/".length));
    if (!ADMIN_KEYS[id]) throw new HttpError(404, "unknownKey");
    return id;
  };

  // The panel names the tools hidden in Settings (`?hidden=deepseek,qoder`). While DeepSeek is
  // shown, its prices are checked against DeepSeek's page at most once a day; the request does
  // not wait for it, and the next refresh uses the new prices. `?force=1` (the refresh button)
  // also reads what is normally cached between refreshes, such as the DeepSeek balance.
  async function readUsage(request) {
    const query = new URL(request.url ?? "/", "http://localhost").searchParams;
    const payload = await usageService.read({ force: query.get("force") === "1" });
    const hidden = (query.get("hidden") ?? "").split(",");
    const deepseek = payload?.providers?.find((provider) => provider.id === "deepseek");
    if (deepseek && deepseek.installed !== false && !hidden.includes("deepseek")) priceBook.refreshIfDue().catch(() => {});
    return payload;
  }

  // For other apps (server/local-api.mjs): the latest reading, unless Settings turned it off,
  // and the same readings pushed on /v1/events.
  const events = createEventHub({ usageService, config: localApi });
  const readPublic = async (request) => {
    if (!(await localApi.enabled())) throw new HttpError(403, "disabled");
    return publicUsage(await currentReading(usageService, { maxAgeMs: maxAgeOf(request) }));
  };
  const readPublicTool = async (request) => {
    const id = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname.slice("/v1/usage/".length));
    const usage = await readPublic(request);
    const tool = usage.tools.find((item) => item.id === id);
    if (!tool) throw new HttpError(404, "unknownTool");
    return { schema: usage.schema, updatedAt: usage.updatedAt, tool };
  };

  async function changeSkill(request, action) {
    const agent = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname.slice("/api/skills/".length));
    try {
      return await skills[action](agent);
    } catch (error) {
      if (error.code) throw new HttpError(error.code === "unknownAgent" ? 404 : 409, error.code);
      throw error;
    }
  }

  // Each route: a handler per method, and the message for an unexpected failure.
  const routes = {
    "/v1": {
      GET: async () => ({ schema: SCHEMA, endpoints: ["/v1/usage", "/v1/usage/{codex|claude|qoder|deepseek}", "/v1/events"] }),
      error: "Unavailable.",
    },
    "/v1/usage": { GET: readPublic, error: "Usage could not be read." },
    "/v1/usage/*": { GET: readPublicTool, error: "Usage could not be read." },
    // Settings → More → Agent skill: the tokentide-usage skill in Claude Code's and Codex's folders.
    "/api/skills": { GET: () => skills.status(), error: "Skills could not be read." },
    "/api/skills/*": {
      PUT: (request) => changeSkill(request, "install"),
      DELETE: (request) => changeSkill(request, "uninstall"),
      error: "The skill could not be changed.",
    },
    // Settings → More → API accounts: the OpenAI and Anthropic admin keys.
    "/api/keys/*": {
      GET: (request) => stateOf(adminKeyId(request)),
      PUT: async (request) => {
        const id = adminKeyId(request);
        const { key } = await readJsonBody(request);
        const value = typeof key === "string" ? key.trim() : "";
        if (!isStorableSecret(value) || !value.startsWith(ADMIN_KEYS[id].prefix)) throw new HttpError(400, "adminKeyMalformed");
        try {
          await ADMIN_KEYS[id].check(value);
        } catch (error) {
          throw new HttpError(error.code === "accountKeyInvalid" ? 400 : 502, error.code ?? "accountUnavailable");
        }
        await secrets.set(KEY_SOURCES[id].secret, value);
        return stateOf(id);
      },
      DELETE: async (request) => {
        const id = adminKeyId(request);
        await secrets.delete(KEY_SOURCES[id].secret);
        return stateOf(id);
      },
      error: "The key could not be changed.",
    },
    // Settings → More settings → Local API.
    "/api/local-api": {
      GET: async () => ({ enabled: await localApi.enabled() }),
      PUT: async (request) => {
        const { enabled } = await readJsonBody(request);
        if (typeof enabled !== "boolean") throw new HttpError(400, "badRequest");
        const saved = await localApi.setEnabled(enabled);
        if (!saved) events.disable();
        return { enabled: saved };
      },
      error: "The setting could not be saved.",
    },
    "/api/usage": { GET: readUsage, error: "Local usage could not be read." },
    // `?maxAge=<seconds>`: how old a cached history may be (the panel's History interval); 0 rescans.
    "/api/stats": { GET: (request) => statsService.read({ maxAgeMs: maxAgeOf(request) }), error: "Local history could not be read." },
    // Lets the native shells tell TokenTide's service apart from another program on the port,
    // and whether the old-port hand-over (server/storage-migration.mjs) is waiting.
    "/api/health": { GET: async () => ({ app: "tokentide", migrationPending: Boolean(migration?.pending) }), error: "Unavailable." },
    // The panel's settings and quota trend from the old origin, delivered once.
    "/api/migration": { GET: async () => ({ state: migration?.take() ?? null }), error: "Unavailable." },
    // The DeepSeek API key for the balance: saved only after DeepSeek accepts it, and never
    // returned (only a masked hint).
    "/api/deepseek-key": {
      GET: keyState,
      PUT: async (request) => {
        const { key } = await readJsonBody(request);
        const value = typeof key === "string" ? key.trim() : "";
        if (!isStorableSecret(value)) throw new HttpError(400, "deepseekKeyMalformed");
        let balance;
        try {
          balance = await fetchDeepseekBalance(value, { fetchImpl });
        } catch (error) {
          throw new HttpError(error.code === "deepseekKeyInvalid" ? 400 : 502, error.code ?? "deepseekBalanceUnavailable");
        }
        const previous = await secrets.get(DEEPSEEK_KEY_NAME);
        await secrets.set(DEEPSEEK_KEY_NAME, value);
        // Another key may be another account: its balance history starts over.
        if (previous !== value) await balanceLog.clear();
        await balanceLog.record(balance);
        return keyState();
      },
      DELETE: async () => {
        await secrets.delete(DEEPSEEK_KEY_NAME);
        await balanceLog.clear();
        return keyState();
      },
      error: "The DeepSeek key could not be changed.",
    },
  };

  return {
    /** Answers API requests; resolves `false` for any other path so the caller can serve it. */
    async handle(request, response) {
      const { pathname } = new URL(request.url ?? "/", "http://localhost");
      const route =
        routes[pathname] ??
        (pathname.startsWith("/v1/usage/")
          ? routes["/v1/usage/*"]
          : pathname.startsWith("/api/skills/")
            ? routes["/api/skills/*"]
            : pathname.startsWith("/api/keys/")
              ? routes["/api/keys/*"]
            : pathname === "/v1/events"
              ? {}
              : undefined);
      if (!route) return false;

      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}`) {
        response.statusCode = 403;
        response.end();
        return true;
      }
      // A long-lived event stream, not a JSON answer.
      if (pathname === "/v1/events") {
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.setHeader("Allow", "GET");
          response.end();
          return true;
        }
        await events.handle(request, response);
        return true;
      }
      const methods = Object.keys(route).filter((key) => key !== "error");
      const handler = methods.includes(request.method) ? route[request.method] : null;
      if (!handler) {
        response.statusCode = 405;
        response.setHeader("Allow", methods.join(", "));
        response.end();
        return true;
      }

      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      try {
        const payload = await handler(request);
        response.statusCode = 200;
        response.end(JSON.stringify(payload));
      } catch (error) {
        if (error instanceof HttpError) {
          response.statusCode = error.status;
          response.end(JSON.stringify({ error: error.code }));
        } else {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: route.error }));
        }
      }
      return true;
    },

    close() {
      events.close();
      usageService.close?.();
    },
  };
}
