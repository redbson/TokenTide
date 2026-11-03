#!/usr/bin/env node
// Reads TokenTide's local usage API (http://127.0.0.1:46173/v1/usage) and prints it for an agent.
// Node 18+ only, no dependencies.
//
//   node tokentide-usage.mjs                 one line per tool (default)
//   node tokentide-usage.mjs --json          the API's JSON as it is
//   node tokentide-usage.mjs --tool claude   one tool only
//   node tokentide-usage.mjs --min 20        exit 3 if a shown tool (or --tool) is under 20% left
//
// Exit codes: 0 ok · 1 TokenTide not running · 2 local API turned off · 3 under --min · 4 other error.

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const base = process.env.TOKENTIDE_URL ?? "http://127.0.0.1:46173";
const tool = value("--tool");
const min = value("--min") === undefined ? null : Number(value("--min"));

let response;
try {
  response = await fetch(`${base}/v1/usage${tool ? `/${encodeURIComponent(tool)}` : ""}`, { signal: AbortSignal.timeout(30_000) });
} catch {
  console.error("TokenTide is not running (nothing answers on 127.0.0.1:46173). Ask the user to open TokenTide.");
  process.exit(1);
}
const body = await response.json().catch(() => ({}));
if (response.status === 403 && body.error === "disabled") {
  console.error("TokenTide's local API is off. The user can turn it on in TokenTide → Settings → More settings → Local API.");
  process.exit(2);
}
if (response.status === 404) {
  console.error(`TokenTide has no tool "${tool}". Tools: codex, claude, qoder, deepseek (only installed ones appear).`);
  process.exit(4);
}
if (!response.ok) {
  console.error(`TokenTide answered ${response.status}${body.error ? ` (${body.error})` : ""}.`);
  process.exit(4);
}

if (flag("--json")) {
  console.log(JSON.stringify(body, null, 2));
} else {
  const tools = body.tools ?? (body.tool ? [body.tool] : []);
  const age = body.updatedAt ? Math.round((Date.now() - Date.parse(body.updatedAt)) / 60_000) : null;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  console.log(`TokenTide usage${age === null ? "" : `, read ${age} min ago`} (times in ${zone}):`);
  for (const item of tools) console.log(`- ${describe(item)}`);
}

if (min !== null && Number.isFinite(min)) {
  const tools = body.tools ?? (body.tool ? [body.tool] : []);
  const low = tools.filter((item) => item.status === "ok" && Number.isFinite(item.remainingPercent) && item.remainingPercent < min);
  if (low.length) {
    console.error(`Under ${min}% left: ${low.map((item) => `${item.name} ${item.remainingPercent}%`).join(", ")}`);
    process.exit(3);
  }
}

/** `2026-11-10 16:00` in this computer's time zone. */
function local(isoTime) {
  const date = new Date(isoTime);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function money(amount) {
  return Number.isFinite(amount) ? amount.toFixed(2) : "?";
}

function describe(item) {
  const head = `${item.name} (${item.id})${item.plan ? `, ${item.plan} plan` : ""}`;
  if (item.status === "unavailable") return `${head}: unavailable (${item.error})`;
  const stale = item.status === "stale" ? ` [stale, last read ${item.readAt}]` : "";
  if (item.usage) {
    const today = item.usage.today ?? {};
    const balance = item.balance ? `, balance ${money(item.balance.total)} ${item.balance.currency}${item.balance.available ? "" : " (cannot pay)"}` : "";
    return `${head}: no quota (pay as you go); today ${today.tokens ?? 0} tokens, ≈${money(today.estimatedCost)} ${item.usage.currency} (estimate)${balance}${stale}`;
  }
  const limits = (item.limits ?? [])
    .map((limit) => `${limit.id} ${limit.remainingPercent}% left${limit.resetsAt ? `, resets ${local(limit.resetsAt)}` : ""}`)
    .join("; ");
  return `${head}: ${item.remainingPercent ?? "?"}% left (${item.headline ?? "?"})${limits ? ` — ${limits}` : ""}${stale}`;
}
