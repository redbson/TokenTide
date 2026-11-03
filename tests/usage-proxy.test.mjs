import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import {
  bypassesProxy,
  createProxyFetch,
  createProxyResolver,
  decodeChunked,
  fetchThroughProxy,
  parseHttpResponse,
  parseProxy,
  parseScutilProxy,
  parseWindowsProxy,
} from "../server/proxy-fetch.mjs";

test("reads proxies from variables, macOS settings, and Windows settings", () => {
  assert.deepEqual(parseProxy("http://127.0.0.1:7890"), { host: "127.0.0.1", port: 7890, auth: null });
  assert.deepEqual(parseProxy("user:p%40ss@proxy.local:8080"), { host: "proxy.local", port: 8080, auth: "user:p@ss" });
  assert.equal(parseProxy("socks5://127.0.0.1:7891"), null, "SOCKS isn't supported");
  assert.equal(parseProxy(""), null);

  const scutil = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
}`;
  assert.deepEqual(parseScutilProxy(scutil), { proxy: { host: "127.0.0.1", port: 7890, auth: null }, exceptions: ["*.local", "169.254/16"] });
  assert.equal(parseScutilProxy("<dictionary> {\n  HTTPEnable : 0\n}"), null);

  const reg = `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891
    ProxyOverride    REG_SZ    localhost;*.corp;<local>`;
  assert.deepEqual(parseWindowsProxy(reg), { proxy: { host: "127.0.0.1", port: 7891, auth: null }, exceptions: ["localhost", "*.corp"] });
  assert.equal(parseWindowsProxy(reg.replace("0x1", "0x0")), null);

  assert.equal(bypassesProxy("api.openai.com", ["localhost", ".local"]), false);
  assert.equal(bypassesProxy("printer.local", ["*.local"]), true);
  assert.equal(bypassesProxy("localhost", []), true);
});

test("environment variables win over the system proxy, and NO_PROXY is honoured", async () => {
  let systemReads = 0;
  const system = async () => (systemReads++, { proxy: { host: "10.0.0.1", port: 3128, auth: null }, exceptions: ["*.internal"] });
  const fromEnv = createProxyResolver({ env: { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "api.deepseek.com" }, readSystem: system });
  assert.deepEqual(await fromEnv("https://api.openai.com/"), { host: "127.0.0.1", port: 7890, auth: null });
  assert.equal(await fromEnv("https://api.deepseek.com/user/balance"), null);
  assert.equal(systemReads, 0);

  const fromSystem = createProxyResolver({ env: {}, readSystem: system });
  assert.deepEqual(await fromSystem("https://api.openai.com/"), { host: "10.0.0.1", port: 3128, auth: null });
  assert.equal(await fromSystem("https://billing.internal/"), null);
  await fromSystem("https://api.anthropic.com/");
  assert.equal(systemReads, 1, "the system proxy is read once a minute at most");
  assert.equal(await createProxyResolver({ env: {}, readSystem: async () => null })("https://api.openai.com/"), null);
});

test("parses raw HTTP/1.1 responses, chunked or not", async () => {
  const chunked = Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"a\":1,\r\n6\r\n\"b\":2}\r\n0\r\n\r\n");
  const response = parseHttpResponse(chunked);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { a: 1, b: 2 });
  assert.equal(decodeChunked(Buffer.from("3\r\nabc\r\n0\r\n\r\n")).toString(), "abc");
  const sized = parseHttpResponse(Buffer.from("HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\n\r\n{}extra"));
  assert.deepEqual([sized.status, await sized.text()], [401, "{}"]);
  assert.throws(() => parseHttpResponse(Buffer.from("HTTP/1.1 200")), { code: "proxyBadResponse" });
});

/** A tiny HTTP proxy: forwards plain requests and refuses CONNECT to one host. */
async function fakeProxy(origin) {
  const seen = [];
  const proxy = http.createServer((request, response) => {
    seen.push({ method: request.method, url: request.url, auth: request.headers["proxy-authorization"] ?? null, ua: request.headers["user-agent"] });
    const forward = http.request(new URL(request.url), { method: request.method, headers: { ...request.headers } }, (answer) => {
      response.writeHead(answer.statusCode, answer.headers);
      answer.pipe(response);
    });
    request.pipe(forward);
  });
  proxy.on("connect", (request, socket) => {
    seen.push({ method: "CONNECT", url: request.url });
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  return { proxy, seen, port: proxy.address().port, origin };
}

test("requests go through the proxy, and a refused tunnel is an error", async () => {
  const origin = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ path: request.url, body, method: request.method }));
    });
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const { proxy, seen, port } = await fakeProxy();
  const proxyInfo = { host: "127.0.0.1", port, auth: "me:secret" };
  try {
    const url = `http://127.0.0.1:${origin.address().port}/v1/thing?x=1`;
    const response = await fetchThroughProxy(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "hello" }, proxyInfo);
    assert.deepEqual(await response.json(), { path: "/v1/thing?x=1", body: "hello", method: "POST" });
    assert.equal(seen[0].auth, `Basic ${Buffer.from("me:secret").toString("base64")}`);
    assert.equal(seen[0].ua, "TokenTide");

    await assert.rejects(fetchThroughProxy("https://api.openai.com/v1/models", {}, proxyInfo), { code: "proxyRefused" });
    assert.equal(seen.at(-1).method, "CONNECT");
    assert.equal(seen.at(-1).url, "api.openai.com:443");

    // Without a proxy, the built-in fetch is used.
    let direct = 0;
    const plain = createProxyFetch({ proxyFor: async () => null, directFetch: async () => (direct++, new Response("ok")) });
    assert.equal(await (await plain("https://api.deepseek.com/")).text(), "ok");
    assert.equal(direct, 1);

    // A timeout aborts the request and leaves nothing open.
    const silent = net.createServer(() => {});
    await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
    await assert.rejects(
      fetchThroughProxy("http://example.test/", { signal: AbortSignal.timeout(100) }, { host: "127.0.0.1", port: silent.address().port, auth: null }),
      { name: "TimeoutError" },
    );
    silent.close();
  } finally {
    proxy.close();
    origin.close();
  }
});
