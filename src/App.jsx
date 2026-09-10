import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { SettingsView } from "./SettingsView.jsx";
import { UsageStats } from "./UsageStats.jsx";
import { AlertIcon, CloseIcon, PowerIcon } from "./icons.jsx";
import {
  LIMIT_LABELS,
  LOW_USAGE_THRESHOLD,
  PROVIDER_META,
  describeLow,
  findNewlyLow,
  formatAccount,
  formatPercent,
  formatReset,
  getPrimaryLimit,
  getPrimaryRemaining,
  isLow,
  makeSnapshot,
  timeAgo,
} from "./usage-format.js";

const AUTO_REFRESH_MS = 5 * 60 * 1000;
const STALE_ON_SHOW_MS = 60 * 1000;
const CLOCK_TICK_MS = 30 * 1000;
const HISTORY_LIMIT = 72;
const HISTORY_KEY = "usage-monitor-history-v1";
const SETTINGS_KEY = "usage-monitor-settings-v1";
const STATS_STALE_MS = 60 * 1000;
// Injected by vite.config.mjs from package.json.
const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";
const DEFAULT_SETTINGS = {
  autoRefresh: true,
  lowUsageAlert: true,
  statsProvider: "codex",
  statsRange: "all",
  statsView: "overview",
};

// Present when the page runs inside the macOS menu-bar panel (macos/AppDelegate.swift).
const nativeBridge = typeof window === "undefined" ? null : window.webkit?.messageHandlers?.usageMonitor;

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

function ProviderBlock({ provider, loading, now }) {
  const meta = PROVIDER_META[provider.id];
  const primary = getPrimaryLimit(provider);
  const remaining = getPrimaryRemaining(provider);
  const low = isLow(provider);

  return (
    <section className={`provider provider-${provider.id}`} aria-labelledby={`${provider.id}-title`}>
      <div className="provider-heading">
        <img className="provider-icon" src={meta.icon} alt={meta.iconAlt} />
        <div className="provider-identity">
          <h2 id={`${provider.id}-title`}>{meta.name}</h2>
          <div className="connection-line">
            <span className={`status-dot ${provider.connected ? "" : "is-offline"}`} />
            <span>{provider.connected ? "已连接" : loading ? "检查中" : "不可用"}</span>
            {provider.connected && provider.account ? (
              <>
                <span className="separator" aria-hidden="true">·</span>
                <span className="account-label">{formatAccount(provider.account)}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className={`primary-usage ${low ? "is-low" : ""} ${loading ? "is-loading" : ""}`}>
          <strong>{loading ? "—" : formatPercent(remaining)}</strong>
          <span>剩余</span>
        </div>
      </div>

      <div
        className="progress-track"
        role="progressbar"
        aria-label={`${meta.name} 当前窗口剩余额度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining ?? undefined}
      >
        <div className="progress-value" style={{ width: `${remaining ?? 0}%` }} />
      </div>

      {provider.error ? (
        <p className="provider-error">{provider.error}</p>
      ) : (
        <dl className="limit-list">
          {(provider.limits ?? []).map((limit) => (
            <div className="limit-row" key={limit.id}>
              <dt>{LIMIT_LABELS[limit.id] ?? limit.label}</dt>
              <dd className="limit-value">{formatPercent(limit.remainingPercent)}</dd>
              <dd className="limit-reset">{formatReset(limit, now)}</dd>
            </div>
          ))}
          {!loading && primary == null ? <div className="limit-row is-empty">暂无额度数据</div> : null}
        </dl>
      )}
    </section>
  );
}

function HistoryChart({ history }) {
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
    <svg className="history-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="当前窗口剩余额度趋势">
      <line className="grid-line" x1="0" x2={width} y1={y(50)} y2={y(50)} />
      <line className="grid-line" x1="0" x2={width} y1={y(LOW_USAGE_THRESHOLD)} y2={y(LOW_USAGE_THRESHOLD)} />
      {renderSeries("codex")}
      {renderSeries("claude")}
    </svg>
  );
}

function QuotaHistory({ history, onClear }) {
  return (
    <section className="quota-history" aria-labelledby="quota-history-title">
      <div className="history-heading">
        <h3 id="quota-history-title">额度趋势</h3>
        {history.length ? <button className="link-button" type="button" onClick={onClear}>清空</button> : null}
      </div>
      {history.length === 0 ? (
        <p className="empty-history">刷新后会在这里记录当前窗口的剩余额度。</p>
      ) : (
        <QuotaHistoryDetails history={history} />
      )}
    </section>
  );
}

function QuotaHistoryDetails({ history }) {
  return (
    <>
      <div className="legend">
        <span className="legend-item legend-codex">Codex</span>
        <span className="legend-item legend-claude">Claude Code</span>
      </div>
      <HistoryChart history={history} />
      <p className="history-caption">最近 {history.length} 次检查 · 当前窗口剩余</p>
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
  const [history, setHistory] = useState(() => readStoredJson(HISTORY_KEY, []));
  const [settings, setSettings] = useState(() => ({
    ...DEFAULT_SETTINGS,
    ...readStoredJson(SETTINGS_KEY, {}),
  }));
  const [banner, setBanner] = useState(null);
  const [loginItem, setLoginItem] = useState({ status: nativeBridge ? "checking" : "unavailable", error: null });
  const [update, setUpdate] = useState({
    status: nativeBridge ? "idle" : "unavailable",
    currentVersion: APP_VERSION,
    autoUpdate: true,
  });
  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState(null);
  const statsRequestRef = useRef(null);
  const statsLoadedAtRef = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  const panelRef = useRef(null);
  const settingsRef = useRef(settings);
  const updatedAtRef = useRef(null);
  const previousProvidersRef = useRef(null);
  const inFlightRef = useRef(null);

  settingsRef.current = settings;

  const applyPayload = useCallback((payload) => {
    const lowProviders = payload.providers.filter((provider) => isLow(provider));
    const newlyLow = findNewlyLow(previousProvidersRef.current, payload.providers);
    previousProvidersRef.current = payload.providers;
    updatedAtRef.current = payload.updatedAt;

    setProviders(payload.providers);
    setUpdatedAt(payload.updatedAt);
    setNow(Date.now());
    setBanner((current) => {
      if (settingsRef.current.lowUsageAlert && newlyLow.length) {
        return { tone: "warning", text: describeLow(lowProviders) };
      }
      if (current?.tone === "error") return null;
      if (current?.tone === "warning" && lowProviders.length === 0) return null;
      return current;
    });

    const snapshot = makeSnapshot(payload);
    if (snapshot.codex !== null || snapshot.claude !== null) {
      setHistory((current) => [snapshot, ...current.filter((item) => item.at !== snapshot.at)].slice(0, HISTORY_LIMIT));
    }

    postNative({
      type: "summary",
      items: payload.providers.map((provider) => ({
        label: PROVIDER_META[provider.id]?.short ?? provider.id,
        remaining: getPrimaryRemaining(provider),
      })),
      low: lowProviders.length > 0,
    });
  }, []);

  // Concurrent callers (StrictMode, auto-refresh, the refresh button) share one request.
  const refresh = useCallback(() => {
    if (inFlightRef.current) return inFlightRef.current;
    setLoading(true);
    const request = (async () => {
      try {
        const response = await fetch("/api/usage", { cache: "no-store" });
        if (!response.ok) throw new Error("本机额度服务没有响应。");
        applyPayload(await response.json());
      } catch (error) {
        const message = error instanceof TypeError ? "无法连接本机额度服务。" : error.message;
        setBanner({ tone: "error", text: message || "额度刷新失败。" });
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

  useEffect(() => {
    if (!settings.autoRefresh) return undefined;
    const timer = window.setInterval(refresh, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh, settings.autoRefresh]);

  // Keep relative times ("3 分钟前更新", "2 小时后重置") current between refreshes.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Refresh stale data when the panel is opened again.
  useEffect(() => {
    const onShow = () => {
      // WebKit focuses the first control when the panel becomes key; don't show a focus ring for that.
      window.setTimeout(() => document.activeElement?.blur?.(), 0);
      setNow(Date.now());
      if (!updatedAtRef.current || Date.now() - updatedAtRef.current > STALE_ON_SHOW_MS) refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") onShow();
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") postNative({ type: "hide" });
    };
    window.addEventListener("usage-monitor:show", onShow);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("usage-monitor:show", onShow);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [refresh]);

  const loadStats = useCallback(() => {
    if (statsRequestRef.current || Date.now() - statsLoadedAtRef.current < STATS_STALE_MS) return;
    statsRequestRef.current = (async () => {
      try {
        const response = await fetch("/api/stats", { cache: "no-store" });
        if (!response.ok) throw new Error("本机使用记录读取失败。");
        setStats(await response.json());
        setStatsError(null);
        statsLoadedAtRef.current = Date.now();
      } catch (error) {
        setStatsError(error instanceof TypeError ? "无法连接本机额度服务。" : error.message);
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

  const changeLoginItem = (enabled) => {
    setLoginItem({ status: "checking", error: null });
    postNative({ type: "setLoginItem", enabled });
  };

  useEffect(() => writeStoredJson(SETTINGS_KEY, settings), [settings]);
  useEffect(() => writeStoredJson(HISTORY_KEY, history), [history]);

  // The native panel sizes itself to the rendered content.
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("is-native", Boolean(nativeBridge));
    const panel = panelRef.current;
    if (!panel || !nativeBridge) return undefined;
    const report = () => postNative({ type: "resize", height: Math.ceil(panel.getBoundingClientRect().height) });
    const observer = new ResizeObserver(report);
    observer.observe(panel);
    report();
    return () => observer.disconnect();
  }, []);

  const connectedCount = providers.filter((provider) => provider.connected).length;
  const initialLoading = loading && !updatedAt;
  const updateSetting = (key) => (value) => setSettings((current) => ({ ...current, [key]: value }));

  return (
    <main className="panel" ref={panelRef}>
      <header className="panel-header">
        <div className="tabs" role="tablist" aria-label="视图">
          {[
            ["quota", "额度"],
            ["history", "历史"],
            ["settings", "设置"],
          ].map(([id, label]) => (
            <button
              key={id}
              className="tab"
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="header-actions">
          <span className="connection-summary">
            <span className={`status-dot ${connectedCount === providers.length ? "" : "is-warning"}`} />
            {initialLoading ? "检查中" : `${connectedCount}/${providers.length} 已连接`}
          </span>
          <button
            className={`icon-button ${loading ? "is-spinning" : ""}`}
            type="button"
            onClick={refresh}
            disabled={loading}
            title="立即刷新"
            aria-label="立即刷新"
          >
            <img src="/assets/refresh.svg" alt="" />
          </button>
        </div>
      </header>

      <div className="panel-body">
        {tab === "quota" ? (
          <>
            <div className="providers">
              {providers.map((provider) => (
                <ProviderBlock key={provider.id} provider={provider} loading={initialLoading} now={now} />
              ))}
            </div>

            {banner ? (
              <div className={`banner banner-${banner.tone}`} role="status">
                <AlertIcon />
                <span>{banner.text}</span>
                <button className="banner-close" type="button" onClick={() => setBanner(null)} aria-label="关闭提示">
                  <CloseIcon />
                </button>
              </div>
            ) : null}
          </>
        ) : tab === "history" ? (
          <div className="history">
            <UsageStats
              stats={stats}
              error={statsError}
              provider={settings.statsProvider}
              range={settings.statsRange}
              view={settings.statsView}
              onChange={(key, value) => updateSetting(key)(value)}
            />
            <QuotaHistory history={history} onClear={() => setHistory([])} />
          </div>
        ) : (
          <SettingsView
            settings={settings}
            onSettingChange={(key, value) => updateSetting(key)(value)}
            loginItem={loginItem}
            onLoginItemChange={changeLoginItem}
            onOpenLoginItems={() => postNative({ type: "openLoginItems" })}
            update={update}
            onUpdateAction={updateAction}
            version={APP_VERSION}
          />
        )}
      </div>

      <footer className="panel-footer">
        <span className="footer-status">
          <img className="brand-mark" src="/assets/tokentide-mark.svg" alt="" />
          <span className="brand-name">TokenTide</span>
          <span className="separator" aria-hidden="true">·</span>
          <span className="updated-label">{timeAgo(updatedAt, now)}</span>
        </span>
        {nativeBridge ? (
          <button className="footer-button" type="button" onClick={() => postNative({ type: "quit" })}>
            <PowerIcon />
            退出
          </button>
        ) : (
          <span className="footer-hint">仅读取本机账户</span>
        )}
      </footer>
    </main>
  );
}
