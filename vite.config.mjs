import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createUsageService } from "./server/usage-service.mjs";
import { createStatsService } from "./server/usage-stats.mjs";
import { createQuotaLog } from "./server/quota-weeks.mjs";

function jsonEndpoint(read, errorMessage) {
  return async (request, response) => {
    const origin = request.headers.origin;
    if (origin && origin !== `http://${request.headers.host}`) {
      response.statusCode = 403;
      response.end();
      return;
    }
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET");
      response.end();
      return;
    }

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
  };
}

function localUsageApi() {
  const quotaLog = createQuotaLog();
  const usageService = createUsageService({}, { quotaLog });
  const statsService = createStatsService({ quotaLog });

  return {
    name: "local-usage-api",
    configureServer(server) {
      const shutdown = () => {
        usageService.close();
        setTimeout(() => process.exit(0), 800);
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
      server.middlewares.use("/api/usage", jsonEndpoint(() => usageService.read(), "Local usage could not be read."));
      server.middlewares.use("/api/stats", jsonEndpoint(() => statsService.read(), "Local history could not be read."));
      server.httpServer?.once("close", () => usageService.close());
    },
  };
}

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    allowedHosts: ["localhost"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react(), localUsageApi()],
});
