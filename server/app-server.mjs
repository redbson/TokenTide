import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

/**
 * The packaged app's HTTP server: the local API plus the built panel (`dist/client`).
 * Only `127.0.0.1:<port>` / `localhost:<port>` Host headers are answered, which keeps other
 * sites from reaching the API through DNS rebinding.
 */
export function createAppServer({ api, clientDir, port }) {
  const root = path.resolve(clientDir);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  return http.createServer(async (request, response) => {
    if (!allowedHosts.has(request.headers.host ?? "")) {
      response.statusCode = 403;
      response.end();
      return;
    }
    if (await api.handle(request, response)) return;

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET, HEAD");
      response.end();
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    } catch {
      response.statusCode = 400;
      response.end();
      return;
    }
    const file = path.join(root, pathname === "/" ? "index.html" : pathname);
    if (!file.startsWith(root + path.sep)) {
      response.statusCode = 404;
      response.end();
      return;
    }

    try {
      const body = await readFile(file);
      response.statusCode = 200;
      response.setHeader("Content-Type", CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream");
      // Hashed build assets never change; the page itself must always be fresh after an update.
      response.setHeader(
        "Cache-Control",
        pathname.startsWith("/assets/index-") ? "public, max-age=31536000, immutable" : "no-cache",
      );
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });
}
