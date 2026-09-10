import { createQuotaLog } from "./quota-weeks.mjs";
import { createUsageService } from "./usage-service.mjs";
import { createStatsService } from "./usage-stats.mjs";

/**
 * The local JSON API (`/api/usage`, `/api/stats`), shared by the Vite dev server and the
 * packaged app's server. `services` lets tests replace the real readers.
 */
export function createLocalApi(services = {}) {
  let usageService = services.usageService;
  let statsService = services.statsService;
  if (!usageService || !statsService) {
    const quotaLog = createQuotaLog();
    usageService ??= createUsageService({}, { quotaLog });
    statsService ??= createStatsService({ quotaLog });
  }

  const routes = {
    "/api/usage": [() => usageService.read(), "Local usage could not be read."],
    "/api/stats": [() => statsService.read(), "Local history could not be read."],
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
      if (request.method !== "GET") {
        response.statusCode = 405;
        response.setHeader("Allow", "GET");
        response.end();
        return true;
      }

      const [read, errorMessage] = route;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      try {
        const payload = await read();
        response.statusCode = 200;
        response.end(JSON.stringify(payload));
      } catch {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: errorMessage }));
      }
      return true;
    },

    close() {
      usageService.close?.();
    },
  };
}
