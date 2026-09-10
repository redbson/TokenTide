#!/usr/bin/env node
// Entry point of the packaged app's local service (TokenTide.app/Contents/Resources/app).
// Development uses `npm run dev` (Vite) instead.
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createLocalApi } from "./api.mjs";
import { createAppServer } from "./app-server.mjs";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4173" },
    client: { type: "string", default: fileURLToPath(new URL("../client/", import.meta.url)) },
  },
});

const port = Number(values.port);
const api = createLocalApi();
const server = createAppServer({ api, clientDir: values.client, port });

server.on("error", (error) => {
  console.error(`TokenTide service could not start: ${error.message}`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`TokenTide service on http://127.0.0.1:${port}/`);
});

const shutdown = () => {
  api.close();
  server.close();
  setTimeout(() => process.exit(0), 800).unref();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
