import assert from "node:assert/strict";
import test from "node:test";

import { findQoderCli, parseQoderUsage, readQoderUsage } from "../server/qoder-usage.mjs";
import { createUsageService } from "../server/usage-service.mjs";

// Shape of Qoder CLI's `get_usage_info` control response (`{ usage, session }`).
const EXPIRES_MS = Date.UTC(2026, 9, 1);
const USAGE_INFO = {
  usage: {
    userId: "should-not-leak",
    userType: "teams",
    totalUsagePercentage: 37.5,
    isHighestTier: false,
    expiresAt: EXPIRES_MS,
    upgradeUrl: "",
    userQuota: { total: 2000, used: 500, remaining: 1500, percentage: 25, unit: "credits" },
    isQuotaExceeded: false,
    orgResourcePackage: { used: 1000, cap: 2000, remaining: 1000, percentage: 50, available: true, unit: "credits" },
  },
  session: { total_credits: 3.2, model_usage: {} },
};

test("maps Qoder usage info to total, plan, and org package rows", () => {
  const provider = parseQoderUsage(USAGE_INFO);
  assert.equal(provider.id, "qoder");
  assert.equal(provider.connected, true);
  assert.equal(provider.installed, true);
  assert.equal(provider.account, "teams plan");
  assert.ok(!JSON.stringify(provider).includes("should-not-leak"), "the user id is dropped");

  const [total, plan, org] = provider.limits;
  // Headline: every pool the account can spend (1,500 + 1,000 of 4,000 credits left).
  assert.deepEqual([total.id, total.remainingPercent, total.resetsAt], ["total", 62.5, EXPIRES_MS / 1000]);
  assert.deepEqual([plan.id, plan.remainingPercent, plan.remainingAmount, plan.totalAmount], ["plan", 75, 1500, 2000]);
  assert.deepEqual([org.id, org.remainingPercent, org.remainingAmount, org.resetsAt], ["org", 50, 1000, null]);
  assert.equal(provider.limits.length, 3);
});

test("skips empty credit pools and accepts snake_case fields", () => {
  const provider = parseQoderUsage({
    usage: {
      user_type: "free",
      total_usage_percentage: 10,
      user_quota: { total: 0, used: 0 },
      add_on_quota: { total: 100, used: 10 },
      org_resource_package: { used: 0, cap: 0, available: false },
    },
  });
  assert.deepEqual(provider.limits.map((limit) => limit.id), ["total", "addon"]);
  assert.equal(provider.limits[1].remainingAmount, 90);
  assert.equal(provider.limits[1].remainingPercent, 90);
});

test("reports a signed-out Qoder CLI as an error", () => {
  assert.throws(() => parseQoderUsage({ usage: null, usage_error: "not authenticated" }), /not authenticated/);
  assert.throws(() => parseQoderUsage({}), /Sign in/);
});

const nodeScript = (source) => [process.execPath, ["-e", source]];

test("reads usage through the get_usage_info control request", async () => {
  const [command, args] = nodeScript(`
    const rl = require("node:readline").createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.type !== "control_request" || message.request?.subtype !== "get_usage_info") return;
      process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
      process.stdout.write(JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: message.request_id, response: ${JSON.stringify(USAGE_INFO)} },
      }) + "\\n");
    });
  `);
  const provider = await readQoderUsage({ command, args, timeoutMs: 5000 });
  assert.equal(provider.limits[0].remainingPercent, 62.5);
});

test("without the CLI Qoder is hidden unless the Qoder app is installed", async () => {
  const provider = await readQoderUsage({ command: null });
  assert.equal(provider.connected, false);
  assert.equal(provider.errorCode, "qoderCliMissing");
  assert.equal(typeof provider.installed, "boolean");
  assert.equal(findQoderCli({ PATH: "" }) === null || typeof findQoderCli({ PATH: "" }) === "string", true);
});

test("a failing Qoder CLI stays visible with its error", async () => {
  const service = createUsageService({
    codex: async () => ({ id: "codex", name: "Codex", connected: true, limits: [] }),
    claudeDirect: async () => ({ id: "claude", name: "Claude Code", connected: true, limits: [] }),
    claudeFallback: async () => {
      throw new Error("unused");
    },
    qoder: async () => {
      throw new Error("qodercli did not return usage data in time.");
    },
  });
  const { providers } = await service.read();
  assert.deepEqual(providers.map((provider) => provider.id), ["codex", "claude", "qoder"]);
  assert.equal(providers[2].installed, true);
  assert.equal(providers[2].connected, false);
  assert.match(providers[2].error, /in time/);
});

test("the headline counts org credits even when the plan quota is nearly used up", () => {
  const provider = parseQoderUsage({
    usage: {
      userType: "teams",
      totalUsagePercentage: 98,
      userQuota: { total: 3000, used: 2932, remaining: 68 },
      orgResourcePackage: { used: 0, cap: 6000, remaining: 6000, available: true },
    },
  });
  assert.equal(provider.limits[0].remainingPercent, 67.4);
  assert.equal(provider.limits[1].remainingPercent, 2.3);
  // Without credit pools, Qoder's own percentage is used.
  assert.equal(parseQoderUsage({ usage: { userType: "free", totalUsagePercentage: 40 } }).limits[0].remainingPercent, 60);
});

test("finds the installer's versioned binary when PATH has no qodercli", async () => {
  const { mkdtemp, mkdir, writeFile, chmod, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const home = await mkdtemp(path.join(os.tmpdir(), "qoder-home-"));
  try {
    const dir = path.join(home, ".qoder", "bin", "qodercli");
    await mkdir(dir, { recursive: true });
    for (const version of ["1.1.9", "1.1.49"]) {
      await writeFile(path.join(dir, `qodercli-${version}`), "#!/bin/sh\n");
      await chmod(path.join(dir, `qodercli-${version}`), 0o755);
    }
    assert.equal(findQoderCli({ PATH: "" }, home), path.join(dir, "qodercli-1.1.49"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
