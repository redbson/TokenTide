import http from "node:http";

// TokenTide moved from port 4173 (Vite's `vite preview` default, so other projects kept taking
// it) to APP_PORT. The panel keeps its settings and quota trend in the WebView's localStorage,
// which belongs to the page's origin, so the move would reset them. To carry them over, the
// service briefly listens on the old port too, serving one page from the old origin: it reads
// that origin's localStorage, hands it to the service (POST /api/migration), and continues to
// the new origin, whose page picks it up from GET /api/migration (server/api.mjs).

export const APP_PORT = 46173;
export const LEGACY_PORT = 4173;
export const STORAGE_KEYS = { settings: "usage-monitor-settings-v1", history: "usage-monitor-history-v1" };

const MAX_BODY_BYTES = 1_000_000;
const MAX_HISTORY = 500;
const LEGACY_LIFETIME_MS = 5 * 60 * 1000;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isJsonScalar = (value) => value === null || ["string", "number", "boolean"].includes(typeof value);

/** Keeps only the shapes the panel stores: a flat settings object and quota-trend snapshots. */
export function sanitizeMigrationState(input) {
  if (!isPlainObject(input)) return null;
  let settings = null;
  if (isPlainObject(input.settings)) {
    settings = {};
    for (const [key, value] of Object.entries(input.settings).slice(0, 50)) {
      if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key)) continue;
      if (isJsonScalar(value) || (Array.isArray(value) && value.length <= 20 && value.every((item) => typeof item === "string"))) {
        settings[key] = value;
      }
    }
  }
  const history = Array.isArray(input.history)
    ? input.history
        .slice(0, MAX_HISTORY)
        .filter((item) => isPlainObject(item) && Number.isFinite(item.at))
        .map((item) => {
          const snapshot = { at: item.at };
          for (const id of ["codex", "claude", "qoder"]) snapshot[id] = Number.isFinite(item[id]) ? item[id] : null;
          return snapshot;
        })
    : null;
  return { settings, history };
}

/**
 * The hand-over between the old-origin page and the new one. `pending` is true while the old
 * port is open and has not delivered yet; `take()` returns the delivered state once.
 */
export function createMigrationStash() {
  let listening = false;
  let delivered = false;
  let state = null;
  return {
    setListening(value) {
      listening = value;
    },
    get pending() {
      return listening && !delivered;
    },
    put(value) {
      delivered = true;
      state = value;
    },
    take() {
      const value = state;
      state = null;
      return value;
    },
  };
}

const migratePage = (appPort) => `<!doctype html><meta charset="utf-8"><title>TokenTide</title>
<style>html,body{margin:0;background:transparent}</style>
<script>
(async () => {
  const read = (key) => { try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; } };
  const state = { settings: read(${JSON.stringify(STORAGE_KEYS.settings)}), history: read(${JSON.stringify(STORAGE_KEYS.history)}) };
  try {
    await fetch("/api/migration", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state) });
  } catch {}
  location.replace("http://127.0.0.1:${appPort}/");
})();
</script>`;

/**
 * The old-port server: GET /migrate and POST /api/migration only, for the old origin's own
 * page. Requests from other hosts or origins are refused.
 */
export function createLegacyServer({ stash, legacyPort = LEGACY_PORT, appPort = APP_PORT }) {
  const allowedHosts = new Set([`127.0.0.1:${legacyPort}`, `localhost:${legacyPort}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${legacyPort}`, `http://localhost:${legacyPort}`]);
  return http.createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const reply = (status, headers = {}, body = undefined) => {
      response.writeHead(status, { "Cache-Control": "no-store", ...headers });
      response.end(body);
    };
    if (!allowedHosts.has(request.headers.host ?? "")) return reply(403);

    if (request.method === "GET" && pathname === "/migrate") {
      return reply(200, { "Content-Type": "text/html; charset=utf-8" }, migratePage(appPort));
    }
    if (request.method === "GET" && pathname === "/api/health") {
      return reply(200, { "Content-Type": "application/json" }, JSON.stringify({ app: "tokentide", legacy: true }));
    }
    if (pathname !== "/api/migration") return reply(404);
    if (request.method !== "POST") return reply(405, { Allow: "POST" });
    if (!allowedOrigins.has(request.headers.origin ?? "")) return reply(403);
    if (!/^application\/json\b/i.test(request.headers["content-type"] ?? "")) return reply(415);

    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reply(413);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (response.writableEnded) return;
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reply(400);
      }
      stash.put(sanitizeMigrationState(parsed) ?? { settings: null, history: null });
      reply(204);
    });
  });
}

/**
 * Opens the old port for the hand-over, if it is free. Resolves true when listening; it closes
 * itself once the state is delivered or after five minutes.
 */
export function openLegacyPort({ stash, legacyPort = LEGACY_PORT, appPort = APP_PORT }) {
  return new Promise((resolve) => {
    const server = createLegacyServer({ stash, legacyPort, appPort });
    const close = () => {
      stash.setListening(false);
      server.close();
    };
    server.once("error", () => {
      stash.setListening(false);
      resolve(false);
    });
    server.listen(legacyPort, "127.0.0.1", () => {
      stash.setListening(true);
      const timer = setTimeout(close, LEGACY_LIFETIME_MS);
      timer.unref?.();
      // Close shortly after the hand-over, once the redirect has been answered.
      const watch = setInterval(() => {
        if (!stash.pending) {
          clearInterval(watch);
          clearTimeout(timer);
          setTimeout(close, 2000).unref?.();
        }
      }, 500);
      watch.unref?.();
      resolve(true);
    });
  });
}
