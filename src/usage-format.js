import { translate } from "./i18n.js";

export const LOW_USAGE_THRESHOLD = 20;

export const PROVIDER_META = {
  codex: { name: "Codex", short: "CX", icon: "/assets/openai.svg", iconAlt: "OpenAI" },
  claude: { name: "Claude Code", short: "CC", icon: "/assets/claude.svg", iconAlt: "Claude" },
  qoder: { name: "Qoder", short: "QD", icon: "/assets/qoder.png", iconAlt: "Qoder" },
};

// Codex and Claude Code have local transcripts for the History tab; Qoder only reports quota.
export const STATS_PROVIDERS = ["codex", "claude"];
const LIMIT_IDS = ["window", "weekly", "total", "plan", "org", "addon"];

const pad = (value) => String(value).padStart(2, "0");
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// All user-facing helpers take the interface language ("zh" or "en") last.

export function limitLabel(limit, language = "en") {
  return LIMIT_IDS.includes(limit?.id) ? translate(language, `limit.${limit.id}`) : limit?.label;
}

const formatAmount = (value) => Number(value).toLocaleString("en-US", { maximumFractionDigits: 1 });

/** A limit row's right-hand text: credits left for credit pools, otherwise the reset time. */
export function formatLimitDetail(limit, now = Date.now(), language = "en") {
  if (Number.isFinite(limit?.remainingAmount) && Number.isFinite(limit?.totalAmount) && limit.totalAmount > 0) {
    return translate(language, "limit.amountLeft", {
      remaining: formatAmount(limit.remainingAmount),
      total: formatAmount(limit.totalAmount),
    });
  }
  return formatReset(limit, now, language);
}

export function formatPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : "—";
}

/** Localizes the generic account labels returned by the local bridge. */
export function formatAccount(account, language = "en") {
  if (!account) return null;
  if (/^usage view fallback$/i.test(account)) return translate(language, "account.fallback");
  if (/^local account$/i.test(account)) return translate(language, "account.local");
  const plan = account.match(/^(.+?)\s+plan$/i);
  if (plan) return translate(language, "account.plan", { plan: plan[1].replace(/\b\w/g, (letter) => letter.toUpperCase()) });
  return account;
}

/** The limit behind the big percentage: the 5-hour window, or Qoder's overall credits. */
export function getPrimaryLimit(provider) {
  const limits = provider?.limits ?? [];
  return limits.find((limit) => limit.id === "window") ?? limits.find((limit) => limit.id === "total") ?? limits[0];
}

/** Providers the panel shows: Qoder is hidden unless the Qoder app or CLI is installed. */
export const isVisibleProvider = (provider) => provider?.installed !== false;

export function getPrimaryRemaining(provider) {
  const remaining = getPrimaryLimit(provider)?.remainingPercent;
  return provider?.connected && Number.isFinite(remaining) ? remaining : null;
}

export function isLow(provider, threshold = LOW_USAGE_THRESHOLD) {
  const remaining = getPrimaryRemaining(provider);
  return remaining !== null && remaining < threshold;
}

export function formatReset(limit, now = Date.now(), language = "en") {
  const t = (key, params) => translate(language, key, params);
  if (Number.isFinite(limit?.resetsAt)) {
    const target = new Date(limit.resetsAt * 1000);
    const minutes = Math.round((target.getTime() - now) / 60_000);
    if (minutes <= 0) return t("reset.soon");
    if (minutes < 60) return t("reset.minutes", { minutes });
    if (minutes < 24 * 60) return t("reset.hours", { hours: Math.floor(minutes / 60), minutes: pad(minutes % 60) });
    return t("reset.date", {
      month: target.getMonth() + 1,
      monthName: MONTH_NAMES[target.getMonth()],
      day: target.getDate(),
      time: `${pad(target.getHours())}:${pad(target.getMinutes())}`,
    });
  }
  if (limit?.resetLabel) {
    return t("reset.label", { label: limit.resetLabel.replace(/\s*\([^)]*\)\s*$/, "").trim() });
  }
  return t("reset.unknown");
}

export function timeAgo(timestamp, now = Date.now(), language = "en") {
  const t = (key, params) => translate(language, key, params);
  if (!timestamp) return t("updated.never");
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 15) return t("updated.justNow");
  if (seconds < 60) return t("updated.seconds", { count: seconds });
  if (seconds < 3600) return t("updated.minutes", { count: Math.floor(seconds / 60) });
  return t("updated.hours", { count: Math.floor(seconds / 3600) });
}

/** Providers that are low now but were not low (or unknown) in the previous snapshot. */
export function findNewlyLow(previousProviders, nextProviders, threshold = LOW_USAGE_THRESHOLD) {
  const wasLow = new Set(
    (previousProviders ?? []).filter((provider) => isLow(provider, threshold)).map((provider) => provider.id),
  );
  return nextProviders.filter((provider) => isLow(provider, threshold) && !wasLow.has(provider.id));
}

export function describeLow(providers, language = "en") {
  return providers
    .map((provider) => {
      const remaining = getPrimaryRemaining(provider);
      const name = PROVIDER_META[provider.id]?.name ?? provider.id;
      return remaining <= 0
        ? translate(language, "low.exhausted", { name })
        : translate(language, "low.remaining", { name, percent: Math.round(remaining) });
    })
    .join(translate(language, "low.separator"));
}

export function makeSnapshot(payload) {
  const byId = Object.fromEntries(payload.providers.map((provider) => [provider.id, provider]));
  return {
    at: payload.updatedAt,
    codex: getPrimaryRemaining(byId.codex),
    claude: getPrimaryRemaining(byId.claude),
  };
}
