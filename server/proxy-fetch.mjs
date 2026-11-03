import { execFile } from "node:child_process";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";

// TokenTide's own requests (DeepSeek, OpenAI, Anthropic, Azure) go through the proxy the user
// has set up, as a browser's would: HTTPS_PROXY / ALL_PROXY first, else the system proxy (macOS
// network settings via `scutil --proxy`, Windows Internet Settings). Node's built-in fetch
// ignores both, and api.openai.com is unreachable without one on some networks. Only HTTP
// proxies are supported (CONNECT tunnels); with none, requests go out directly.

const SYSTEM_PROXY_TTL_MS = 60_000;

/** `{ host, port, auth }` from "http://user:pass@host:port" or "host:port", or null. */
export function parseProxy(value) {
  if (!value || typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return null;
  }
  // SOCKS needs a different handshake; HTTP proxies are what Clash, Surge, etc. offer too.
  if (!/^https?:$/.test(url.protocol) || !url.hostname) return null;
  const auth = url.username ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : null;
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) || 80, auth };
}

/** Whether `hostname` matches a NO_PROXY-style list ("localhost,.local,10.0.0.1"). */
export function bypassesProxy(hostname, list = []) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  return list
    .map((entry) => entry.trim().toLowerCase().replace(/^\*\./, ".").replace(/:\d+$/, ""))
    .filter(Boolean)
    .some((entry) => entry === "*" || host === entry.replace(/^\./, "") || (entry.startsWith(".") && host.endsWith(entry)) || host.endsWith(`.${entry}`));
}

/** macOS: the HTTPS (else HTTP) proxy and its exceptions from `scutil --proxy` output. */
export function parseScutilProxy(output) {
  const value = (key) => output.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m"))?.[1].trim();
  const exceptions = [...(output.match(/ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/)?.[1] ?? "").matchAll(/:\s*(\S+)/g)].map((match) => match[1]);
  for (const kind of ["HTTPS", "HTTP"]) {
    if (value(`${kind}Enable`) === "1" && value(`${kind}Proxy`)) {
      return { proxy: { host: value(`${kind}Proxy`), port: Number(value(`${kind}Port`)) || 80, auth: null }, exceptions };
    }
  }
  return null;
}

/** Windows: ProxyEnable / ProxyServer / ProxyOverride from `reg query` of Internet Settings. */
export function parseWindowsProxy(output) {
  const value = (name) => output.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, "m"))?.[1].trim();
  if (!/^0x0*1$/i.test(value("ProxyEnable") ?? "")) return null;
  const server = value("ProxyServer");
  if (!server) return null;
  // "host:port", or per scheme: "http=host:port;https=host:port".
  const byScheme = Object.fromEntries(server.split(";").map((part) => part.split("=")).filter((part) => part.length === 2));
  const proxy = parseProxy(byScheme.https ?? byScheme.http ?? (server.includes("=") ? null : server));
  if (!proxy) return null;
  const exceptions = (value("ProxyOverride") ?? "").split(";").filter((entry) => entry && entry !== "<local>");
  return { proxy, exceptions };
}

const run = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 5000, windowsHide: true }, (error, stdout) => resolve(error ? "" : String(stdout)));
  });

async function systemProxy(platform) {
  if (platform === "darwin") return parseScutilProxy(await run("/usr/sbin/scutil", ["--proxy"]));
  if (platform === "win32") {
    return parseWindowsProxy(await run("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"]));
  }
  return null;
}

/** Finds the proxy for a URL: environment variables first, then the system's (cached a minute). */
export function createProxyResolver({ env = process.env, platform = process.platform, readSystem = () => systemProxy(platform) } = {}) {
  let cached = null;
  let cachedAt = 0;
  return async function proxyFor(url) {
    const { hostname, protocol } = new URL(url);
    const fromEnv =
      protocol === "https:"
        ? (env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy)
        : (env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy);
    const noProxy = (env.NO_PROXY ?? env.no_proxy ?? "").split(",");
    const proxy = parseProxy(fromEnv);
    if (proxy) return bypassesProxy(hostname, noProxy) ? null : proxy;
    if (!cached || Date.now() - cachedAt > SYSTEM_PROXY_TTL_MS) {
      cached = (await readSystem().catch(() => null)) ?? { proxy: null, exceptions: [] };
      cachedAt = Date.now();
    }
    return cached.proxy && !bypassesProxy(hostname, [...cached.exceptions, ...noProxy]) ? cached.proxy : null;
  };
}

const proxyHeaders = (proxy) => (proxy.auth ? { "Proxy-Authorization": `Basic ${Buffer.from(proxy.auth).toString("base64")}` } : {});

/** Request body and headers from fetch-style `init`. */
function bodyOf(init) {
  // Node's https.request sends no User-Agent; OpenAI's front end leaves such requests unanswered.
  const headers = { "User-Agent": "TokenTide", Accept: "*/*", ...(init.headers ?? {}) };
  let body = init.body ?? null;
  if (body instanceof URLSearchParams) {
    headers["Content-Type"] ??= "application/x-www-form-urlencoded";
    body = body.toString();
  }
  if (body !== null) headers["Content-Length"] = Buffer.byteLength(body);
  return { headers, body };
}

/** Decodes a `Transfer-Encoding: chunked` body. */
export function decodeChunked(buffer) {
  const parts = [];
  let offset = 0;
  for (;;) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd < 0) break;
    const size = Number.parseInt(buffer.subarray(offset, lineEnd).toString("latin1").split(";")[0].trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    parts.push(buffer.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

/** A fetch `Response` from a raw HTTP/1.1 response (the connection was closed after it). */
export function parseHttpResponse(raw) {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd < 0) throw Object.assign(new Error("Incomplete response through the proxy."), { code: "proxyBadResponse" });
  const [statusLine, ...lines] = raw.subarray(0, headerEnd).toString("latin1").split("\r\n");
  const status = Number(statusLine.split(" ")[1]);
  const headers = new Headers();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  let body = raw.subarray(headerEnd + 4);
  if (/chunked/i.test(headers.get("transfer-encoding") ?? "")) {
    body = decodeChunked(body);
    headers.delete("transfer-encoding");
  } else if (headers.has("content-length")) {
    body = body.subarray(0, Number(headers.get("content-length")));
  }
  return new Response([101, 204, 205, 304].includes(status) ? null : body, { status, headers });
}

/**
 * Sends one request through `proxy` and resolves with a fetch `Response`. HTTPS goes through a
 * CONNECT tunnel; the HTTP/1.1 exchange on top is written by hand ("Connection: close", no
 * compression), because Node's own client stalls on some hosts (api.openai.com) over a tunnel.
 */
export function fetchThroughProxy(url, init = {}, proxy) {
  const target = new URL(url);
  const { headers, body } = bodyOf(init);
  const port = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
  return new Promise((resolve, reject) => {
    // Everything opened for this request, closed on failure so nothing keeps the process busy.
    const opened = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      for (const item of opened) item.destroy();
      reject(error);
    };
    const signal = init.signal;
    if (signal?.aborted) return fail(signal.reason ?? new Error("Aborted"));
    signal?.addEventListener("abort", () => fail(signal.reason ?? new Error("Aborted")), { once: true });

    const exchange = (socket, path) => {
      const lines = [`${init.method ?? "GET"} ${path} HTTP/1.1`, `Host: ${target.host}`];
      for (const [name, value] of Object.entries(headers)) {
        if (!/^(host|connection|accept-encoding)$/i.test(name)) lines.push(`${name}: ${value}`);
      }
      lines.push("Connection: close", "", "");
      const chunks = [];
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("error", fail);
      socket.on("end", () => {
        if (settled) return;
        try {
          const response = parseHttpResponse(Buffer.concat(chunks));
          settled = true;
          resolve(response);
        } catch (error) {
          fail(error);
        }
      });
      socket.write(lines.join("\r\n"));
      if (body !== null) socket.write(body);
    };

    if (target.protocol === "http:") {
      // Plain HTTP goes to the proxy itself, with the full URL as the path.
      const socket = net.connect({ host: proxy.host, port: proxy.port }, () => {
        if (proxy.auth) headers["Proxy-Authorization"] = proxyHeaders(proxy)["Proxy-Authorization"];
        exchange(socket, target.href);
      });
      opened.push(socket);
      socket.on("error", fail);
      return;
    }

    const connect = http.request({ host: proxy.host, port: proxy.port, method: "CONNECT", path: `${target.hostname}:${port}`, headers: { Host: `${target.hostname}:${port}`, ...proxyHeaders(proxy) } });
    opened.push(connect);
    connect.on("error", fail);
    connect.on("connect", (response, socket) => {
      opened.push(socket);
      if (response.statusCode !== 200) return fail(Object.assign(new Error(`Proxy refused the tunnel (${response.statusCode}).`), { code: "proxyRefused" }));
      // Some servers (OpenAI's) never answer a TLS client that names no protocol (ALPN).
      const secure = tls.connect({ socket, servername: target.hostname, ALPNProtocols: ["http/1.1"] }, () => exchange(secure, `${target.pathname}${target.search}`));
      opened.push(secure);
      secure.on("error", fail);
    });
    connect.end();
  });
}

/** A fetch that uses the user's proxy when there is one, and the built-in fetch otherwise. */
export function createProxyFetch({ proxyFor = createProxyResolver(), directFetch = globalThis.fetch } = {}) {
  return async function proxyFetch(url, init = {}) {
    const proxy = await proxyFor(String(url)).catch(() => null);
    return proxy ? fetchThroughProxy(String(url), init, proxy) : directFetch(url, init);
  };
}
