import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createLocalApi } from "./server/api.mjs";
import { CHANGELOG_HEADINGS, parseChangelog } from "./src/changelog-parse.js";

// Development only: serves the local API next to the Vite dev server. The packaged app runs
// the same API from server/main.mjs.
function localUsageApi() {
  return {
    name: "local-usage-api",
    configureServer(server) {
      const api = createLocalApi();
      const shutdown = () => {
        api.close();
        setTimeout(() => process.exit(0), 800);
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
      server.middlewares.use((request, response, next) => {
        api.handle(request, response).then((handled) => handled || next(), next);
      });
      server.httpServer?.once("close", () => api.close());
    },
  };
}

// `virtual:changelog`: the READMEs' changelog sections, parsed at build time (src/Changelog.jsx).
function changelog() {
  const id = "virtual:changelog";
  const files = { en: "./README.md", zh: "./README.zh-CN.md" };
  return {
    name: "tokentide-changelog",
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(resolved) {
      if (resolved !== `\0${id}`) return null;
      const data = {};
      for (const [language, file] of Object.entries(files)) {
        const path = fileURLToPath(new URL(file, import.meta.url));
        this.addWatchFile(path);
        data[language] = parseChangelog(readFileSync(path, "utf8"), CHANGELOG_HEADINGS[language]);
      }
      return `export default ${JSON.stringify(data)};`;
    },
  };
}

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
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
  plugins: [react(), localUsageApi(), changelog()],
});
