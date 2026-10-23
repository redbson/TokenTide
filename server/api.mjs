import { createBalanceLog, DEEPSEEK_KEY_NAME, fetchDeepseekBalance } from "./deepseek-balance.mjs";
import { createDeepseekReader } from "./deepseek-usage.mjs";
import { createQuotaLog } from "./quota-weeks.mjs";
import { createSecretStore, isStorableSecret, maskSecret } from "./secret-store.mjs";
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

/**
 * The local JSON API (`/api/usage`, `/api/stats`, `/api/deepseek-key`), shared by the Vite dev
 * server and the packaged app's server. `services` lets tests replace the real readers, the
 * secret store, the balance log, and `fetch`.
 */
export function createLocalApi(services = {}, { migration = null } = {}) {
  const secrets = services.secrets ?? createSecretStore();
  const balanceLog = services.balanceLog ?? createBalanceLog();
  const fetchImpl = services.fetchImpl ?? fetch;
  let usageService = services.usageService;
  let statsService = services.statsService;
  if (!usageService || !statsService) {
    const quotaLog = createQuotaLog();
    usageService ??= createUsageService({ deepseek: createDeepseekReader({ secrets, balanceLog, fetchImpl }) }, { quotaLog });
    statsService ??= createStatsService({ quotaLog, balanceLog });
  }

  const keyState = async () => {
    const key = await secrets.get(DEEPSEEK_KEY_NAME);
    return { configured: Boolean(key), hint: maskSecret(key) };
  };

  // Each route: a handler per method, and the message for an unexpected failure.
  const routes = {
    "/api/usage": { GET: () => usageService.read(), error: "Local usage could not be read." },
    "/api/stats": { GET: () => statsService.read(), error: "Local history could not be read." },
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
      const route = routes[pathname];
      if (!route) return false;

      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}`) {
        response.statusCode = 403;
        response.end();
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
      usageService.close?.();
    },
  };
}
