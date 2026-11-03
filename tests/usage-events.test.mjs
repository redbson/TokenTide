import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalApi } from "../server/api.mjs";
import { createEventHub, createLocalApiConfig } from "../server/local-api.mjs";
import { makeLimit } from "../server/usage-service.mjs";

const reading = (usedPercent) => ({
  updatedAt: Date.now(),
  providers: [{ id: "claude", name: "Claude Code", connected: true, account: "Ultra plan", limits: [makeLimit("weekly", "Weekly", usedPercent, null)] }],
});

/** A usage service stand-in whose reads can be triggered by the test. */
function fakeUsageService(initial) {
  const listeners = new Set();
  let latest = initial;
  return {
    latest: () => latest,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async read() {
      return latest;
    },
    publish(next) {
      latest = next;
      for (const listener of listeners) listener(next);
    },
    listenerCount: () => listeners.size,
    close() {},
  };
}

/** Reads Server-Sent Events from a fetch response, one parsed event per `next()`. */
function eventReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return async function next() {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const fields = Object.fromEntries(
          block.split("\n").filter((line) => line && !line.startsWith(":")).map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]),
        );
        if (fields.event) return { event: fields.event, id: fields.id, data: JSON.parse(fields.data) };
        continue;
      }
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
  };
}

test("/v1/events pushes the current reading, then every new one, and ends when turned off", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tt-events-"));
  const usageService = fakeUsageService(reading(10));
  const localApi = createLocalApiConfig({ configPath: path.join(dir, "local-api.json") });
  const api = createLocalApi({ usageService, statsService: { read: async () => ({}) }, secrets: { get: async () => null }, localApi });
  const server = http.createServer((request, response) => api.handle(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/v1/events`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const next = eventReader(response);

    const first = await next();
    assert.equal(first.event, "usage");
    assert.equal(first.data.schema, "tokentide.usage.v1");
    assert.equal(first.data.tools[0].remainingPercent, 90);
    assert.equal(first.data.tools[0].plan, "Ultra");

    usageService.publish(reading(40));
    const second = await next();
    assert.equal(second.data.tools[0].remainingPercent, 60);
    assert.equal(Number(second.id) > 0, true, "events carry the reading time as their id");

    assert.equal((await fetch(`${base}/v1/events`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${base}/v1/events`, { headers: { Origin: "https://example.com" } })).status, 403);

    await fetch(`${base}/api/local-api`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    assert.equal((await next()).event, "disabled");
    assert.equal(await next(), null, "the stream ends");
    assert.equal(usageService.listenerCount(), 0, "nobody listens any more");
    assert.equal((await fetch(`${base}/v1/events`)).status, 403);
  } finally {
    api.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("the event hub limits streams and keeps a reading fresh while anyone listens", async () => {
  const usageService = fakeUsageService({ ...reading(10), updatedAt: Date.now() - 10 * 60_000 });
  let reads = 0;
  usageService.read = async () => {
    reads += 1;
    return usageService.latest();
  };
  const hub = createEventHub({ usageService, config: { enabled: async () => true }, maxStreams: 1, keepFreshMs: 20, heartbeatMs: 10_000 });
  const server = http.createServer((request, response) => hub.handle(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const first = await fetch(url);
    assert.equal(first.status, 200);
    assert.equal((await fetch(url)).status, 503, "over the limit");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(reads >= 2, "a 10-minute-old reading is refreshed for listeners");
  } finally {
    hub.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
