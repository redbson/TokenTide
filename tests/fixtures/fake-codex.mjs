// Stand-in for `codex app-server --stdio` (CI on Windows runs it through a .cmd shim).
import { writeFileSync } from "node:fs";
import readline from "node:readline";

if (process.env.FAKE_CLI_PID_FILE) writeFileSync(process.env.FAKE_CLI_PID_FILE, String(process.pid));
const now = Math.floor(Date.now() / 1000);
const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply({ id: message.id, result: {} });
  if (message.method === "account/rateLimits/read") {
    reply({
      id: message.id,
      result: {
        rateLimits: {
          planType: "plus",
          primary: { usedPercent: 40, resetsAt: now + 3600, windowDurationMins: 300 },
          secondary: { usedPercent: 10, resetsAt: now + 5 * 86400, windowDurationMins: 10080 },
        },
      },
    });
  }
});
