import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCommand } from "./commands.mjs";
import { exchangeJsonLines, makeLimit } from "./usage-service.mjs";

// Qoder credits, read through the official Qoder CLI (`qodercli`): the `get_usage_info`
// control request over stream-json returns the signed-in account's quota, like Claude
// Code's `get_usage`. Only quota numbers, the plan type, and reset times leave this module;
// the response's user id is dropped.

const QODER_TIMEOUT_MS = 20_000;
const QODER_ARGS = ["--print", "--output-format", "stream-json", "--input-format", "stream-json"];
const qoderAppPaths = (platform = process.platform, env = process.env, home = os.homedir()) =>
  platform === "win32"
    ? [
        path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Programs", "Qoder", "Qoder.exe"),
        path.join(env.ProgramFiles ?? "C:\\Program Files", "Qoder", "Qoder.exe"),
      ]
    : ["/Applications/Qoder.app", path.join(home, "Applications", "Qoder.app")];

/** The installer's versioned binaries (`~/.qoder/bin/qodercli/qodercli-1.1.49`), newest first. */
function versionedQoderClis(directory) {
  try {
    const version = (name) => name.slice("qodercli-".length).split(".").map((part) => Number.parseInt(part, 10) || 0);
    return readdirSync(directory)
      .filter((name) => name.startsWith("qodercli-"))
      .map((name) => name.replace(/\.exe$/i, ""))
      .sort((a, b) => {
        const [x, y] = [version(a), version(b)];
        for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
          if ((x[index] ?? 0) !== (y[index] ?? 0)) return (y[index] ?? 0) - (x[index] ?? 0);
        }
        return 0;
      })
      .map((name) => path.join(directory, process.platform === "win32" ? `${name}.exe` : name));
  } catch {
    return [];
  }
}

/** `qodercli` on PATH or in the Qoder installer's locations (as `qoder` looks for it). */
export function findQoderCli(env = process.env, home = os.homedir()) {
  const installDir = path.join(home, ".qoder", "bin", "qodercli");
  return (
    resolveCommand("qodercli", { env, extraDirs: [path.join(home, ".local", "bin"), installDir] }) ??
    versionedQoderClis(installDir).find((file) => existsSync(file)) ??
    null
  );
}

export const isQoderAppInstalled = () => qoderAppPaths().some((app) => existsSync(app));

const toEpochSeconds = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number > 1e12 ? Math.round(number / 1000) : number;
};

const finiteOr = (value, fallback = null) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** A credit pool as a limit row: used percentage plus the credits left. */
function creditLimit(id, label, pool, resetsAt = null) {
  const total = finiteOr(pool.total ?? pool.cap, 0);
  const used = finiteOr(pool.used, 0);
  const percentage = finiteOr(pool.percentage, total > 0 ? (used / total) * 100 : null);
  const limit = makeLimit(id, label, percentage, resetsAt);
  limit.remainingAmount = finiteOr(pool.remaining, Math.max(total - used, 0));
  limit.totalAmount = total;
  limit.unit = typeof pool.unit === "string" && pool.unit ? pool.unit : "credits";
  return limit;
}

/** Maps the `get_usage_info` response (`{ usage, session }`) to a provider entry. */
export function parseQoderUsage(response) {
  const usage = response?.usage;
  if (!usage || typeof usage !== "object") {
    throw new Error(response?.usage_error ? `Qoder CLI: ${response.usage_error}` : "Qoder CLI returned no quota. Sign in with qodercli.");
  }

  const resetsAt = toEpochSeconds(usage.expiresAt ?? usage.expires_at);
  const plan = usage.userQuota ?? usage.user_quota;
  const addOn = usage.addOnQuota ?? usage.add_on_quota;
  const org = usage.orgResourcePackage ?? usage.org_resource_package;
  const personal = [];
  if (plan && finiteOr(plan.total, 0) > 0) personal.push(creditLimit("plan", "Plan credits", plan, resetsAt));
  if (addOn && finiteOr(addOn.total, 0) > 0) personal.push(creditLimit("addon", "Add-on credits", addOn));
  const orgLimit = org && (org.available ?? finiteOr(org.cap ?? org.total, 0) > 0) ? creditLimit("org", "Org package", org) : null;

  // The headline covers the account's own credits (plan and add-on). The org resource package
  // is shared by the team, so it gets its own row but never lifts the headline.
  const total = personal.reduce((sum, pool) => sum + pool.totalAmount, 0);
  const remaining = personal.reduce((sum, pool) => sum + pool.remainingAmount, 0);
  const usedPercent = total > 0 ? ((total - remaining) / total) * 100 : (usage.totalUsagePercentage ?? usage.total_usage_percentage);
  const limits = [makeLimit("total", "Personal", usedPercent, resetsAt), ...personal];
  if (orgLimit) limits.push(orgLimit);

  const planType = String(usage.userType ?? usage.user_type ?? "").trim();
  return {
    id: "qoder",
    name: "Qoder",
    connected: true,
    installed: true,
    account: planType ? `${planType.replaceAll("_", " ")} plan` : "Local account",
    source: "Qoder CLI get_usage_info",
    limits,
  };
}

/** Qoder's entry for the quota view; `installed: false` hides it for people without Qoder. */
export async function readQoderUsage({ command = findQoderCli(), args = QODER_ARGS, timeoutMs = QODER_TIMEOUT_MS } = {}) {
  if (!command) {
    return {
      id: "qoder",
      name: "Qoder",
      connected: false,
      installed: isQoderAppInstalled(),
      account: "Unavailable",
      source: null,
      limits: [],
      errorCode: "qoderCliMissing",
      error: "Install the Qoder CLI (qodercli) and sign in to show Qoder credits.",
    };
  }

  const response = await exchangeJsonLines({
    command,
    args,
    timeoutMs,
    start: (send) =>
      send({ type: "control_request", request_id: "usage", request: { subtype: "get_usage_info" } }),
    handle: (message) => {
      if (message.type !== "control_response" || message.response?.request_id !== "usage") return undefined;
      if (message.response.subtype !== "success") {
        throw new Error(`Qoder CLI rejected the usage request${message.response.error ? `: ${message.response.error}` : "."}`);
      }
      return message.response.response ?? {};
    },
  });
  return parseQoderUsage(response);
}
