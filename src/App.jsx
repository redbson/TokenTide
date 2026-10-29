import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SettingsView } from "./SettingsView.jsx";
import { I18nContext, useI18n } from "./i18n-context.js";
import { platform, resolveLanguage, systemLanguages, translate } from "./i18n.js";
import { UsageStats } from "./UsageStats.jsx";
import { mergeMigratedHistory, mergeMigratedSettings } from "./storage-migration.js";
import { ChangelogView, hasReleaseNotes } from "./Changelog.jsx";
import { isNewerVersion } from "./changelog-parse.js";
import { AlertIcon, CloseIcon, NotesIcon, PowerIcon } from "./icons.jsx";
import { formatMoney, formatTokens } from "./stats-format.js";
import {
  LOW_USAGE_THRESHOLD,
  PROVIDER_META,
  QUOTA_INTERVALS,
  STATS_INTERVALS,
  describeLow,
  findNewlyLow,
  formatAccount,
  formatLimitDetail,
  formatPercent,
  formatShortDate,
  getPrimaryLimit,
  getPrimaryRemaining,
  STATS_PROVIDERS,
  isLow,
  isShownProvider,
  isUsageOnly,
  limitLabel,
  makeSnapshot,
  timeAgo,
} from "./usage-format.js";

// Each kind of data has its own pace (see AGENTS.md, "Refresh tiers"):
// - quota left and current usage: every minute while the panel is open, at the chosen interval
//   (settings.quotaInterval, minutes) while only the menu bar shows it, and on opening if older
//   than 30 s;
// - history and stats: at most every settings.statsInterval minutes, checked when History is
//   open, or on demand.
const OPEN_REFRESH_MS = 60 * 1000;
const STALE_ON_SHOW_MS = 30 * 1000;
const CLOCK_TICK_MS = 30 * 1000;
const HISTORY_LIMIT = 72;
const HISTORY_KEY = "usage-monitor-history-v1";
const SETTINGS_KEY = "usage-monitor-settings-v1";
// Set once the storage from TokenTide's old port (4173) has been carried over.
const MIGRATION_KEY = "tokentide-port-migration-v1";
// Injected by vite.config.mjs from package.json.
const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";
const DEFAULT_SETTINGS = {
  autoRefresh: true,
  // Minutes between quota reads while the panel is closed (QUOTA_INTERVALS).
  quotaInterval: 2,
  // Minutes a history scan stays current (STATS_INTERVALS).
  statsInterval: 30,
  lowUsageAlert: true,
  statsProvider: "codex",
  statsRange: "all",
  statsView: "overview",
  // Provider ids turned off in Settings → Shown tools; they drop out of every view.
  hiddenProviders: [],
  // "system", "zh", or "en"; see i18n.js.
  language: "system",
  // The version whose release notes the user has seen; a newer app shows "What's new" once.
  lastSeenVersion: null,
  // macOS menu bar: "detailed" (CX 93% …) or "compact" (one thin bar per tool).
  menuBarStyle: "detailed",
};

// Present when the page runs inside a native shell: the macOS menu-bar panel
// (macos/AppDelegate.swift) or the Windows tray panel (windows/preload.cjs).
const nativeBridge =
  typeof window === "undefined" ? null : (window.webkit?.messageHandlers?.usageMonitor ?? window.tokentideNative ?? null);
const IS_WINDOWS = platform() === "windows";
// How to install the Qoder CLI: the shell installer on macOS, npm on Windows.
const QODER_INSTALL = IS_WINDOWS ? "npm install -g @qoder-ai/qodercli" : "curl -fsSL https://qoder.com/install | bash";
// Error codes from the service that get a translated notice, with the command that fixes it.
// `signIn` codes offer a button that runs the command in a terminal through the native shell.
const PROVIDER_ERRORS = {
  qoderCliMissing: { command: QODER_INSTALL },
  claudeSignedOut: { command: "claude auth login", signIn: true },
  claudeNoPlan: {},
  claudeTemporary: {},
};

/** A saved interval in minutes, if it is one of `choices`; otherwise the default. */
const intervalMinutes = (value, choices, fallback) => (choices.includes(Number(value)) ? Number(value) : fallback);

function postNative(message) {
  try {
    nativeBridge?.postMessage(message);
  } catch {
    // The page also runs in a normal browser, where there is no native host.
  }
}

function readStoredJson(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode, quota); the in-memory state still works.
  }
}

function ProviderBlock({ provider, loading, now, onSignIn }) {
  const { t, language } = useI18n();
  const meta = PROVIDER_META[provider.id];
  const primary = getPrimaryLimit(provider);
  const remaining = getPrimaryRemaining(provider);
  const low = isLow(provider);
  const usage = provider.usage;
  // DeepSeek with a saved API key: the balance leads, and each period shows what it spent.
  const balance = usage ? provider.balance : null;
  const hasBalance = Number.isFinite(balance?.total);
  // What Harness's replies cost at DeepSeek's published prices (an estimate; the bill decides).
  const cost = (span) => (usage?.[span]?.cost > 0 ? formatMoney(usage[span].cost, "CNY") : null);
  const pricesChecked = formatShortDate(provider.prices?.checkedAt, language);
  const costHint = pricesChecked ? t("usage.costHintChecked", { date: pricesChecked }) : t("usage.costHint");

  return (
    <section className={`provider provider-${provider.id}`} aria-labelledby={`${provider.id}-title`}>
      <div className="provider-heading">
        <img className="provider-icon" src={meta.icon} alt={meta.iconAlt} />
        <div className="provider-identity">
          <h2 id={`${provider.id}-title`}>{meta.name}</h2>
          {provider.stale ? (
            // The refresh failed, so this is the tool's last reading; the reason is in the tooltip.
            <div className="connection-line" title={provider.staleError ?? undefined}>
              <span className="status-dot is-warning" />
              <span>{t("provider.stale", { count: Math.max(1, Math.floor((now - provider.readAt) / 60000)) })}</span>
            </div>
          ) : (
            <div className="connection-line">
              <span className={`status-dot ${provider.connected ? "" : "is-offline"}`} />
              <span>
                {t(usage ? "provider.localUsage" : provider.connected ? "provider.connected" : loading ? "provider.checking" : "provider.unavailable")}
              </span>
              {provider.connected && provider.account ? (
                <>
                  <span className="separator" aria-hidden="true">·</span>
                  <span className="account-label">{formatAccount(provider.account, language)}</span>
                </>
              ) : null}
            </div>
          )}
        </div>
        <div
          className={`primary-usage ${low || balance?.available === false ? "is-low" : ""} ${loading ? "is-loading" : ""}`}
          title={hasBalance && balance.error ? t(`balanceError.${balance.error}`) : undefined}
        >
          <strong>
            {loading
              ? "—"
              : hasBalance
                ? formatMoney(balance.total, balance.currency)
                : usage
                  ? formatTokens(usage.today.tokens)
                  : formatPercent(remaining)}
          </strong>
          <span>
            {t(hasBalance ? (balance.error ? "usage.balanceStale" : "usage.balance") : usage ? "usage.todayTokens" : "provider.left")}
          </span>
        </div>
      </div>

      {usage ? null : (
        <div
          className="progress-track"
          role="progressbar"
          aria-label={t("provider.progress", { name: meta.name })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={remaining ?? undefined}
        >
          <div className="progress-value" style={{ width: `${remaining ?? 0}%` }} />
        </div>
      )}

      {provider.errorCode in PROVIDER_ERRORS ? (
        <div className="provider-error">
          <p>{t(`providerError.${provider.errorCode}`)}</p>
          {PROVIDER_ERRORS[provider.errorCode].signIn && nativeBridge ? (
            <>
              <button className="provider-action" type="button" onClick={() => onSignIn(provider.id)}>
                {t("providerError.signIn")}
              </button>
              <span className="provider-hint">{t("providerError.signInHint")}</span>
            </>
          ) : (
            PROVIDER_ERRORS[provider.errorCode].command && <code>{PROVIDER_ERRORS[provider.errorCode].command}</code>
          )}
        </div>
      ) : provider.error ? (
        <p className="provider-error">{provider.error}</p>
      ) : usage ? (
        // No quota to fill a bar: tokens used today and over the last 7 and 30 days.
        <>
          <dl className="limit-list">
            {["today", "week", "month"].map((span) => (
              <div className="limit-row" key={span}>
                <dt>{t(`usage.${span}`)}</dt>
                <dd className="limit-value">{formatTokens(usage[span].tokens)}</dd>
                <dd className="limit-reset" title={cost(span) ? costHint : undefined}>
                  {cost(span) ? `${t("usage.cost", { amount: cost(span) })} · ` : ""}
                  {t("usage.messages", { count: usage[span].messages })}
                </dd>
              </div>
            ))}
          </dl>
          {balance?.error && !hasBalance ? <p className="provider-hint">{t(`balanceError.${balance.error}`)}</p> : null}
        </>
      ) : (
        <dl className="limit-list">
          {(provider.limits ?? []).map((limit) => (
            <div className="limit-row" key={limit.id}>
              <dt>{limitLabel(limit, language)}</dt>
              <dd className="limit-value">{formatPercent(limit.remainingPercent)}</dd>
              <dd className="limit-reset">{formatLimitDetail(limit, now, language)}</dd>
            </div>
          ))}
          {!loading && primary == null ? <div className="limit-row is-empty">{t("provider.noData")}</div> : null}
        </dl>
      )}
    </section>
  );
}

function HistoryChart({ history, series: keys }) {
  const { t } = useI18n();
  const points = [...history].reverse();
  const width = 328;
  const height = 92;
  const x = (index) => (points.length < 2 ? width / 2 : (index / (points.length - 1)) * width);
  const y = (value) => 6 + (1 - value / 100) * (height - 12);

  const series = (key) => {
    const segments = [];
    let current = [];
    points.forEach((point, index) => {
      if (Number.isFinite(point[key])) {
        current.push([x(index), y(point[key])]);
      } else if (current.length) {
        segments.push(current);
        current = [];
      }
    });
    if (current.length) segments.push(current);
    return segments;
  };

  const renderSeries = (key) =>
    series(key).map((segment, index) => {
      const line = segment.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
      const area = `${segment[0][0].toFixed(1)},${height} ${line} ${segment.at(-1)[0].toFixed(1)},${height}`;
      return (
        <g key={`${key}-${index}`} className={`series series-${key}`}>
          {segment.length > 1 ? <polygon className="series-area" points={area} /> : null}
          {segment.length > 1 ? <polyline className="series-line" points={line} /> : null}
          {segment.length === 1 ? <circle className="series-dot" cx={segment[0][0]} cy={segment[0][1]} r="2.5" /> : null}
        </g>
      );
    });

  return (
    <svg className="history-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={t("trend.chart")}>
      <line className="grid-line" x1="0" x2={width} y1={y(50)} y2={y(50)} />
      <line className="grid-line" x1="0" x2={width} y1={y(LOW_USAGE_THRESHOLD)} y2={y(LOW_USAGE_THRESHOLD)} />
      {keys.map((key) => renderSeries(key))}
    </svg>
  );
}

function QuotaHistory({ history, hiddenProviders, onClear }) {
  const { t } = useI18n();
  return (
    <section className="quota-history" aria-labelledby="quota-history-title">
      <div className="history-heading">
        <h3 id="quota-history-title">{t("trend.title")}</h3>
        {history.length ? <button className="link-button" type="button" onClick={onClear}>{t("trend.clear")}</button> : null}
      </div>
      {history.length === 0 ? (
        <p className="empty-history">{t("trend.empty")}</p>
      ) : (
        <QuotaHistoryDetails history={history} hiddenProviders={hiddenProviders} />
      )}
    </section>
  );
}

function QuotaHistoryDetails({ history, hiddenProviders }) {
  const { t } = useI18n();
  // Qoder joins the legend once it has readings (DeepSeek has no quota, so never); hidden tools are left out.
  const series = STATS_PROVIDERS.filter(
    (id) =>
      !hiddenProviders.includes(id) &&
      (id === "codex" || id === "claude" || history.some((item) => Number.isFinite(item[id]))),
  );
  return (
    <>
      <div className="legend">
        {series.map((id) => (
          <span key={id} className={`legend-item legend-${id}`}>{PROVIDER_META[id].name}</span>
        ))}
      </div>
      <HistoryChart history={history} series={series} />
      <p className="history-caption">{t("trend.caption", { count: history.length })}</p>
    </>
  );
}

export function App() {
  const [providers, setProviders] = useState([
    { id: "codex", connected: false, account: null, limits: [] },
    { id: "claude", connected: false, account: null, limits: [] },
  ]);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("quota");
  const [showChangelog, setShowChangelog] = useState(false);
  // Whether the old port's storage hand-over has been checked, and whether this panel already
  // had data (an upgrade, so its first launch shows "What's new"; a fresh install does not).
  const [migrationChecked, setMigrationChecked] = useState(() => Boolean(readStoredJson(MIGRATION_KEY, false)));
  const hadDataRef = useRef(readStoredJson(HISTORY_KEY, []).length > 0);
  const [history, setHistory] = useState(() => readStoredJson(HISTORY_KEY, []));
  const [settings, setSettings] = useState(() => {
    const stored = { ...DEFAULT_SETTINGS, ...readStoredJson(SETTINGS_KEY, {}) };
    return { ...stored, hiddenProviders: Array.isArray(stored.hiddenProviders) ? stored.hiddenProviders : [] };
  });
  const [banner, setBanner] = useState(null);
  const [loginItem, setLoginItem] = useState({ status: nativeBridge ? "checking" : "unavailable", error: null });
  const [update, setUpdate] = useState({
    status: nativeBridge ? "idle" : "unavailable",
    currentVersion: APP_VERSION,
    autoUpdate: true,
  });
  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState(null);
  // Whether the panel is on screen. Inside the native shells it starts hidden (the menu bar or
  // tray icon opens it); in a normal browser tab it is open.
  const [panelOpen, setPanelOpen] = useState(!nativeBridge);
  const statsRequestRef = useRef(null);
  const statsLoadedAtRef = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  const panelRef = useRef(null);
  const settingsRef = useRef(settings);
  const updatedAtRef = useRef(null);
  const previousProvidersRef = useRef(null);
  // Set while a sign-in runs in a terminal, so reopening the panel reads the quota again.
  const signingInRef = useRef(false);
  const inFlightRef = useRef(null);

  settingsRef.current = settings;

  const language = resolveLanguage(settings.language, systemLanguages());
  const i18n = useMemo(() => ({ language, t: (key, params) => translate(language, key, params) }), [language]);

  const applyPayload = useCallback((payload) => {
    const visible = payload.providers.filter((provider) => isShownProvider(provider, settingsRef.current.hiddenProviders));
    const lowProviders = visible.filter((provider) => isLow(provider));
    const newlyLow = findNewlyLow(previousProvidersRef.current, visible);
    previousProvidersRef.current = payload.providers;
    updatedAtRef.current = payload.updatedAt;

    setProviders(payload.providers);
    setUpdatedAt(payload.updatedAt);
    setNow(Date.now());
    setBanner((current) => {
      if (settingsRef.current.lowUsageAlert && newlyLow.length) {
        // Rendered at display time, so a language switch applies immediately.
        return { tone: "warning", lowProviders };
      }
      if (current?.tone === "error") return null;
      if (current?.tone === "warning" && lowProviders.length === 0) return null;
      return current;
    });

    const snapshot = makeSnapshot(payload);
    if (snapshot.codex !== null || snapshot.claude !== null || snapshot.qoder !== null) {
      setHistory((current) => [snapshot, ...current.filter((item) => item.at !== snapshot.at)].slice(0, HISTORY_LIMIT));
    }
  }, []);

  // Concurrent callers (StrictMode, auto-refresh, the refresh button) share one request.
  // `force` (the refresh button, a new DeepSeek key) also rereads what the service caches between
  // refreshes, such as the DeepSeek balance.
  const refresh = useCallback(({ force = false } = {}) => {
    if (inFlightRef.current) return inFlightRef.current;
    setLoading(true);
    const request = (async () => {
      try {
        // Hidden tools are named so the service skips work for them (DeepSeek's price check).
        const hidden = settingsRef.current.hiddenProviders;
        const params = new URLSearchParams();
        if (hidden.length) params.set("hidden", hidden.join(","));
        if (force) params.set("force", "1");
        const query = params.toString() ? `?${params}` : "";
        const response = await fetch(`/api/usage${query}`, { cache: "no-store" });
        if (!response.ok) {
          setBanner({ tone: "error", key: "error.serviceNoResponse" });
          return;
        }
        applyPayload(await response.json());
      } catch (error) {
        // Connection refused: the local service is gone, so ask the shell to bring it back.
        if (error instanceof TypeError) postNative({ type: "serviceUnreachable" });
        setBanner(
          error instanceof TypeError || !error?.message
            ? { tone: "error", key: error instanceof TypeError ? "error.serviceUnreachable" : "error.refreshFailed" }
            : { tone: "error", text: error.message },
        );
      } finally {
        inFlightRef.current = null;
        setLoading(false);
      }
    })();
    inFlightRef.current = request;
    return request;
  }, [applyPayload]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Quota: every minute while the panel is open, at the chosen interval while it is closed.
  const quotaEvery = panelOpen ? OPEN_REFRESH_MS : intervalMinutes(settings.quotaInterval, QUOTA_INTERVALS, 2) * 60_000;
  useEffect(() => {
    if (!settings.autoRefresh) return undefined;
    const timer = window.setInterval(() => refresh(), quotaEvery);
    return () => window.clearInterval(timer);
  }, [refresh, settings.autoRefresh, quotaEvery]);

  // Keep relative times ("Updated 3 min ago", "Resets in 2 h") current between refreshes.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Refresh stale data when the panel is opened again.
  useEffect(() => {
    const onShow = () => {
      setPanelOpen(true);
      // WebKit focuses the first control when the panel becomes key; don't show a focus ring for that.
      window.setTimeout(() => document.activeElement?.blur?.(), 0);
      setNow(Date.now());
      if (signingInRef.current) {
        signingInRef.current = false;
        refresh();
      } else if (!updatedAtRef.current || Date.now() - updatedAtRef.current > STALE_ON_SHOW_MS) {
        refresh();
      }
    };
    const onHide = () => setPanelOpen(false);
    const onVisibility = () => {
      if (document.visibilityState === "visible") onShow();
      else onHide();
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") postNative({ type: "hide" });
    };
    window.addEventListener("usage-monitor:show", onShow);
    window.addEventListener("usage-monitor:hide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("usage-monitor:show", onShow);
      window.removeEventListener("usage-monitor:hide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [refresh]);

  // History: a scan is current for the chosen interval; `force` (its refresh link) rescans now.
  const loadStats = useCallback(({ force = false } = {}) => {
    const maxAgeMs = intervalMinutes(settingsRef.current.statsInterval, STATS_INTERVALS, 30) * 60_000;
    if (statsRequestRef.current || (!force && Date.now() - statsLoadedAtRef.current < maxAgeMs)) return;
    statsRequestRef.current = (async () => {
      try {
        const response = await fetch(`/api/stats?maxAge=${force ? 0 : maxAgeMs / 1000}`, { cache: "no-store" });
        if (!response.ok) {
          setStatsError({ key: "error.statsFailed" });
          return;
        }
        setStats(await response.json());
        setStatsError(null);
        statsLoadedAtRef.current = Date.now();
      } catch (error) {
        setStatsError(error instanceof TypeError ? { key: "error.serviceUnreachable" } : { text: error.message });
      } finally {
        statsRequestRef.current = null;
      }
    })();
  }, []);

  useEffect(() => {
    if (tab === "history") loadStats();
  }, [tab, loadStats, updatedAt]);

  // Launch at login is owned by macOS (SMAppService); the native shell reports its status.
  useEffect(() => {
    const onLoginItem = (event) => setLoginItem({ status: event.detail?.status ?? "notRegistered", error: event.detail?.error ?? null });
    // Updates are checked and installed by the native shell (macos/Updater.swift).
    const onUpdate = (event) => setUpdate((current) => ({ ...current, ...event.detail }));
    window.addEventListener("usage-monitor:login-item", onLoginItem);
    window.addEventListener("usage-monitor:update", onUpdate);
    return () => {
      window.removeEventListener("usage-monitor:login-item", onLoginItem);
      window.removeEventListener("usage-monitor:update", onUpdate);
    };
  }, []);

  useEffect(() => {
    // Re-read on every visit: the user can change it in System Settings at any time.
    if (tab === "settings" && nativeBridge) {
      postNative({ type: "getLoginItem" });
      postNative({ type: "getUpdate" });
    }
  }, [tab]);

  const updateAction = (type, enabled) => {
    if (type === "setAutoUpdate") setUpdate((current) => ({ ...current, autoUpdate: enabled }));
    postNative(enabled === undefined ? { type } : { type, enabled });
  };

  /** Runs the tool's sign-in command in a terminal window (macOS Terminal, Windows console). */
  const signIn = (tool) => {
    signingInRef.current = true;
    postNative({ type: "signIn", tool });
  };

  const changeLoginItem = (enabled) => {
    setLoginItem({ status: "checking", error: null });
    postNative({ type: "setLoginItem", enabled });
  };

  useEffect(() => writeStoredJson(SETTINGS_KEY, settings), [settings]);

  // Settings and the quota trend from the old port's origin, delivered once by the service.
  useEffect(() => {
    if (readStoredJson(MIGRATION_KEY, false)) return;
    fetch("/api/migration", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!body?.state) return;
        setSettings((current) => mergeMigratedSettings(current, body.state.settings, DEFAULT_SETTINGS));
        setHistory((current) => mergeMigratedHistory(current, body.state.history, HISTORY_LIMIT));
        if (body.state.history?.length) hadDataRef.current = true;
        writeStoredJson(MIGRATION_KEY, true);
        postNative({ type: "storageMigrated" });
      })
      .catch(() => {})
      .finally(() => setMigrationChecked(true));
  }, []);

  // A fresh install has nothing new to show: record the running version as seen.
  useEffect(() => {
    if (migrationChecked && APP_VERSION && !settingsRef.current.lastSeenVersion && !hadDataRef.current) {
      setSettings((current) => ({ ...current, lastSeenVersion: APP_VERSION }));
    }
  }, [migrationChecked]);

  // The menu-bar readout lists the shown tools and follows the setting right away.
  useEffect(() => {
    if (!updatedAt) return;
    // Tools without a quota (DeepSeek) have no percentage to show there.
    const shown = providers.filter((provider) => isShownProvider(provider, settings.hiddenProviders) && !isUsageOnly(provider));
    postNative({
      type: "summary",
      items: shown.map((provider) => ({
        label: PROVIDER_META[provider.id]?.short ?? provider.id,
        name: PROVIDER_META[provider.id]?.name ?? provider.id,
        remaining: getPrimaryRemaining(provider),
      })),
      low: shown.some((provider) => isLow(provider)),
      style: settings.menuBarStyle === "compact" ? "compact" : "detailed",
    });
  }, [providers, updatedAt, settings.hiddenProviders, settings.menuBarStyle]);

  // The native shell uses the same language for its menu, tooltips, and loading screens.
  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    postNative({ type: "setLanguage", language });
  }, [language]);
  useEffect(() => writeStoredJson(HISTORY_KEY, history), [history]);

  // The native panel sizes itself to the rendered content.
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("is-native", Boolean(nativeBridge));
    document.documentElement.classList.toggle("is-windows", IS_WINDOWS);
    const panel = panelRef.current;
    if (!panel || !nativeBridge) return undefined;
    const report = () => postNative({ type: "resize", height: Math.ceil(panel.getBoundingClientRect().height) });
    const observer = new ResizeObserver(report);
    observer.observe(panel);
    report();
    return () => observer.disconnect();
  }, []);

  const hiddenProviders = settings.hiddenProviders;
  const visibleProviders = providers.filter((provider) => isShownProvider(provider, hiddenProviders));
  const connectedCount = visibleProviders.filter((provider) => provider.connected).length;
  const initialLoading = loading && !updatedAt;
  const updateSetting = (key) => (value) => setSettings((current) => ({ ...current, [key]: value }));
  // "What's new" after an update: once per version that has release notes.
  const showWhatsNew =
    hasReleaseNotes(APP_VERSION) &&
    (settings.lastSeenVersion
      ? isNewerVersion(APP_VERSION, settings.lastSeenVersion)
      : migrationChecked && hadDataRef.current);
  const markNotesSeen = () => updateSetting("lastSeenVersion")(APP_VERSION);
  const openChangelog = () => {
    setShowChangelog(true);
    markNotesSeen();
  };
  const { t } = i18n;
  // A low-quota notice only names tools that are still shown.
  const bannerLow = banner?.lowProviders?.filter((provider) => !hiddenProviders.includes(provider.id));
  const shownBanner = bannerLow && bannerLow.length === 0 ? null : banner;
  const bannerText = !shownBanner
    ? null
    : bannerLow
      ? describeLow(bannerLow, language)
      : banner.key
        ? t(banner.key)
        : banner.text;

  return (
    <I18nContext.Provider value={i18n}>
    <main className="panel" ref={panelRef}>
      <header className="panel-header">
        <div className="tabs" role="tablist" aria-label={t("tabs.label")}>
          {["quota", "history", "settings"].map((id) => (
            <button
              key={id}
              className="tab"
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => {
                setTab(id);
                setShowChangelog(false);
              }}
            >
              {t(`tabs.${id}`)}
            </button>
          ))}
        </div>
        <div className="header-actions">
          <span className="connection-summary">
            <span className={`status-dot ${connectedCount === visibleProviders.length ? "" : "is-warning"}`} />
            {initialLoading ? t("header.checking") : t("header.connected", { connected: connectedCount, total: visibleProviders.length })}
          </span>
          <button
            className={`icon-button ${loading ? "is-spinning" : ""}`}
            type="button"
            onClick={() => {
              refresh({ force: true });
              if (tab === "history") loadStats({ force: true });
            }}
            disabled={loading}
            title={t("header.refresh")}
            aria-label={t("header.refresh")}
          >
            <img src="/assets/refresh.svg" alt="" />
          </button>
        </div>
      </header>

      <div className="panel-body">
        {showChangelog ? (
          <ChangelogView
            version={APP_VERSION}
            onBack={() => setShowChangelog(false)}
            onOpenReleases={() => postNative({ type: "openReleases" })}
          />
        ) : tab === "quota" ? (
          <>
            {showWhatsNew ? (
              <div className="banner banner-info whats-new" role="status">
                <NotesIcon />
                <span>
                  {t("whatsNew.updated", { version: APP_VERSION })}
                  <button className="link-button" type="button" onClick={openChangelog}>{t("whatsNew.view")}</button>
                </span>
                <button className="banner-close" type="button" onClick={markNotesSeen} aria-label={t("banner.close")}>
                  <CloseIcon />
                </button>
              </div>
            ) : null}
            <div className="providers">
              {visibleProviders.map((provider) => (
                <ProviderBlock key={provider.id} provider={provider} loading={initialLoading} now={now} onSignIn={signIn} />
              ))}
            </div>

            {shownBanner ? (
              <div className={`banner banner-${banner.tone}`} role="status">
                <AlertIcon />
                <span>{bannerText}</span>
                <button className="banner-close" type="button" onClick={() => setBanner(null)} aria-label={t("banner.close")}>
                  <CloseIcon />
                </button>
              </div>
            ) : null}
          </>
        ) : tab === "history" ? (
          <div className="history">
            <UsageStats
              stats={stats}
              error={statsError ? (statsError.key ? t(statsError.key) : statsError.text) : null}
              provider={settings.statsProvider}
              range={settings.statsRange}
              view={settings.statsView}
              hiddenProviders={hiddenProviders}
              onChange={(key, value) => updateSetting(key)(value)}
              now={now}
              onReload={() => loadStats({ force: true })}
              reloadInterval={intervalMinutes(settings.statsInterval, STATS_INTERVALS, 30)}
            />
            <QuotaHistory history={history} hiddenProviders={hiddenProviders} onClear={() => setHistory([])} />
          </div>
        ) : (
          <SettingsView
            settings={settings}
            providers={providers}
            onSettingChange={(key, value) => updateSetting(key)(value)}
            loginItem={loginItem}
            onLoginItemChange={changeLoginItem}
            onOpenLoginItems={() => postNative({ type: "openLoginItems" })}
            update={update}
            onUpdateAction={updateAction}
            onOpenChangelog={openChangelog}
            showMenuBarStyle={Boolean(nativeBridge) && !IS_WINDOWS}
            onDeepseekKeyChange={() => refresh({ force: true })}
          />
        )}
      </div>

      <footer className="panel-footer">
        <span className="footer-status">
          <img className="brand-mark" src="/assets/tokentide-mark.svg" alt="" />
          <span className="brand-name">TokenTide</span>
          <span className="separator" aria-hidden="true">·</span>
          <span className="updated-label">{timeAgo(updatedAt, now, language)}</span>
        </span>
        {nativeBridge ? (
          <button className="footer-button" type="button" onClick={() => postNative({ type: "quit" })}>
            <PowerIcon />
            {t("footer.quit")}
          </button>
        ) : (
          <span className="footer-hint">{t("footer.hint")}</span>
        )}
      </footer>
    </main>
    </I18nContext.Provider>
  );
}
