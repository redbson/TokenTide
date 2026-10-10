import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { createLocalApi } from "../server/api.mjs";
import {
  APP_PORT,
  LEGACY_PORT,
  createMigrationStash,
  openLegacyPort,
  sanitizeMigrationState,
} from "../server/storage-migration.mjs";
import { mergeMigratedHistory, mergeMigratedSettings } from "../src/storage-migration.js";

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

test("TokenTide no longer uses Vite's `vite preview` port", () => {
  assert.equal(LEGACY_PORT, 4173);
  assert.notEqual(APP_PORT, 4173);
  assert.ok(APP_PORT < 49152, "outside macOS's ephemeral port range");
});

test("keeps only the panel's own storage shapes", () => {
  const state = sanitizeMigrationState({
    settings: { language: "zh", hiddenProviders: ["qoder"], "bad key": 1, nested: { a: 1 }, autoRefresh: false },
    history: [{ at: 1, codex: 40, claude: "x", extra: "dropped" }, { at: "nope" }, null],
  });
  assert.deepEqual(state.settings, { language: "zh", hiddenProviders: ["qoder"], autoRefresh: false });
  assert.deepEqual(state.history, [{ at: 1, codex: 40, claude: null, qoder: null }]);
  assert.equal(sanitizeMigrationState("x"), null);
});

test("the old port hands the old origin's storage to the new one", async () => {
  const legacyPort = await freePort();
  const appPort = await freePort();
  const stash = createMigrationStash();
  assert.equal(await openLegacyPort({ stash, legacyPort, appPort }), true);
  assert.equal(stash.pending, true);
  const legacy = (path, init = {}) => fetch(`http://127.0.0.1:${legacyPort}${path}`, init);

  // The hand-over page reads the old origin's storage and continues to the new port.
  const page = await (await legacy("/migrate")).text();
  assert.match(page, /usage-monitor-settings-v1/);
  assert.match(page, new RegExp(`127\\.0\\.0\\.1:${appPort}/`));

  // Other origins, other content types, and anything but the two routes are refused.
  const body = JSON.stringify({ settings: { language: "en" }, history: [{ at: 5, codex: 10 }] });
  const json = { "Content-Type": "application/json" };
  assert.equal((await legacy("/api/migration", { method: "POST", headers: { ...json, Origin: "https://evil.example" }, body })).status, 403);
  assert.equal((await legacy("/api/migration", { method: "POST", headers: { Origin: `http://127.0.0.1:${legacyPort}`, "Content-Type": "text/plain" }, body })).status, 415);
  assert.equal((await legacy("/api/usage")).status, 404);
  assert.equal(stash.pending, true);

  const delivered = await legacy("/api/migration", { method: "POST", headers: { ...json, Origin: `http://127.0.0.1:${legacyPort}` }, body });
  assert.equal(delivered.status, 204);
  assert.equal(stash.pending, false);

  // The new origin's page picks it up once, through the regular API.
  const api = createLocalApi(
    { usageService: { read: async () => ({}), close() {} }, statsService: { read: async () => ({}) } },
    { migration: stash },
  );
  const call = async (pathname) => {
    let status;
    let payload = "";
    const response = { setHeader() {}, end: (text) => (payload = text), set statusCode(value) { status = value; } };
    await api.handle({ url: pathname, method: "GET", headers: { host: `127.0.0.1:${appPort}` } }, response);
    return { status, body: JSON.parse(payload) };
  };
  assert.deepEqual((await call("/api/health")).body, { app: "tokentide", migrationPending: false });
  assert.deepEqual((await call("/api/migration")).body.state, { settings: { language: "en" }, history: [{ at: 5, codex: 10, claude: null, qoder: null }] });
  assert.equal((await call("/api/migration")).body.state, null, "delivered once");

  // The old port closes itself after the hand-over.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await assert.rejects(legacy("/migrate"));
});

test("a busy old port skips the hand-over instead of failing", async () => {
  const blocker = net.createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => blocker.once("listening", resolve));
  try {
    const stash = createMigrationStash();
    assert.equal(await openLegacyPort({ stash, legacyPort: blocker.address().port, appPort: 1 }), false);
    assert.equal(stash.pending, false);
  } finally {
    blocker.close();
  }
});

test("merging keeps settings changed here and the newest snapshots", () => {
  const defaults = { language: "system", hiddenProviders: [], autoRefresh: true };
  const current = { language: "en", hiddenProviders: [], autoRefresh: true };
  const migrated = { language: "zh", hiddenProviders: ["qoder"], autoRefresh: "yes", unknown: 1 };
  // language was changed here, so it stays; hiddenProviders comes over; a wrong type is ignored.
  assert.deepEqual(mergeMigratedSettings(current, migrated, defaults), { language: "en", hiddenProviders: ["qoder"], autoRefresh: true });
  assert.equal(mergeMigratedSettings(current, null, defaults), current);

  const history = mergeMigratedHistory([{ at: 30 }, { at: 20, codex: 1 }], [{ at: 20, codex: 9 }, { at: 10 }, { at: "x" }], 3);
  assert.deepEqual(history, [{ at: 30 }, { at: 20, codex: 1 }, { at: 10 }]);
  assert.equal(mergeMigratedHistory([], [{ at: 1 }, { at: 2 }, { at: 3 }], 2).length, 2);
});
