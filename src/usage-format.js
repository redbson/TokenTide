export const LOW_USAGE_THRESHOLD = 20;

export const PROVIDER_META = {
  codex: { name: "Codex", short: "CX", icon: "/assets/openai.svg", iconAlt: "OpenAI" },
  claude: { name: "Claude Code", short: "CC", icon: "/assets/claude.svg", iconAlt: "Claude" },
};

export const LIMIT_LABELS = {
  window: "当前窗口",
  weekly: "每周",
};

const pad = (value) => String(value).padStart(2, "0");

export function formatPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : "—";
}

/** Localizes the generic account labels returned by the local bridge. */
export function formatAccount(account) {
  if (!account) return null;
  if (/^usage view fallback$/i.test(account)) return "/usage 备用读取";
  if (/^local account$/i.test(account)) return "本机账户";
  const plan = account.match(/^(.+?)\s+plan$/i);
  if (plan) return `${plan[1].replace(/\b\w/g, (letter) => letter.toUpperCase())} 套餐`;
  return account;
}

export function getPrimaryLimit(provider) {
  return provider?.limits?.find((limit) => limit.id === "window") ?? provider?.limits?.[0];
}

export function getPrimaryRemaining(provider) {
  const remaining = getPrimaryLimit(provider)?.remainingPercent;
  return provider?.connected && Number.isFinite(remaining) ? remaining : null;
}

export function isLow(provider, threshold = LOW_USAGE_THRESHOLD) {
  const remaining = getPrimaryRemaining(provider);
  return remaining !== null && remaining < threshold;
}

export function formatReset(limit, now = Date.now()) {
  if (Number.isFinite(limit?.resetsAt)) {
    const target = new Date(limit.resetsAt * 1000);
    const minutes = Math.round((target.getTime() - now) / 60_000);
    if (minutes <= 0) return "即将重置";
    if (minutes < 60) return `${minutes} 分钟后重置`;
    if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时 ${pad(minutes % 60)} 分后重置`;
    return `${target.getMonth() + 1}月${target.getDate()}日 ${pad(target.getHours())}:${pad(target.getMinutes())} 重置`;
  }
  if (limit?.resetLabel) {
    return `${limit.resetLabel.replace(/\s*\([^)]*\)\s*$/, "").trim()} 重置`;
  }
  return "重置时间未知";
}

export function timeAgo(timestamp, now = Date.now()) {
  if (!timestamp) return "尚未更新";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 15) return "刚刚更新";
  if (seconds < 60) return `${seconds} 秒前更新`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前更新`;
  return `${Math.floor(seconds / 3600)} 小时前更新`;
}

/** Providers that are low now but were not low (or unknown) in the previous snapshot. */
export function findNewlyLow(previousProviders, nextProviders, threshold = LOW_USAGE_THRESHOLD) {
  const wasLow = new Set(
    (previousProviders ?? []).filter((provider) => isLow(provider, threshold)).map((provider) => provider.id),
  );
  return nextProviders.filter((provider) => isLow(provider, threshold) && !wasLow.has(provider.id));
}

export function describeLow(providers) {
  return providers
    .map((provider) => {
      const remaining = getPrimaryRemaining(provider);
      const name = PROVIDER_META[provider.id]?.name ?? provider.id;
      return remaining <= 0 ? `${name} 当前窗口额度已用尽` : `${name} 仅剩 ${Math.round(remaining)}%`;
    })
    .join("，");
}

export function makeSnapshot(payload) {
  const byId = Object.fromEntries(payload.providers.map((provider) => [provider.id, provider]));
  return {
    at: payload.updatedAt,
    codex: getPrimaryRemaining(byId.codex),
    claude: getPrimaryRemaining(byId.claude),
  };
}
