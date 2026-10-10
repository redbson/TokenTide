#!/usr/bin/env node
// Entry point of the packaged app's local service: started with the user's Node.js by the
// macOS app (TokenTide.app/Contents/Resources/app), and as an Electron utility process by the
// Windows app (windows/main.mjs), which listens for the messages below on `parentPort`.
// Development uses `npm run dev` (Vite) instead.
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createLocalApi } from "./api.mjs";
import { createAppServer } from "./app-server.mjs";
import { APP_PORT, createMigrationStash, openLegacyPort } from "./storage-migration.mjs";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: String(APP_PORT) },
    client: { type: "string", default: fileURLToPath(new URL("../client/", import.meta.url)) },
    // The port of earlier versions, opened briefly to carry the panel's storage over.
    "legacy-port": { type: "string" },
  },
});

const port = Number(values.port);
const migration = createMigrationStash();
const legacyListening = values["legacy-port"]
  ? await openLegacyPort({ stash: migration, legacyPort: Number(values["legacy-port"]), appPort: port })
  : false;
const api = createLocalApi({}, { migration });
const server = createAppServer({ api, clientDir: values.client, port });

// Electron utility processes talk to the app through `process.parentPort`.
const parent = process.parentPort ?? null;

server.on("error", (error) => {
  console.error(`TokenTide service could not start: ${error.message}`);
  parent?.postMessage({ type: "error", code: error.code ?? null, message: error.message });
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`TokenTide service on http://127.0.0.1:${port}/`);
  parent?.postMessage({ type: "listening", port, migrationPending: legacyListening });
});

const shutdown = () => {
  api.close();
  server.close();
  setTimeout(() => process.exit(0), 800).unref();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
parent?.on("message", (event) => {
  if (event.data?.type === "shutdown") shutdown();
});
