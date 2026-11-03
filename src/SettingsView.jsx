import { useI18n } from "./i18n-context.js";
import { LANGUAGE_NAMES } from "./i18n.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatMoney } from "./stats-format.js";
import {
  BellIcon,
  ChartIcon,
  ClockIcon,
  CloseIcon,
  DownloadIcon,
  GlobeIcon,
  KeyIcon,
  LockIcon,
  LoginIcon,
  MenuBarIcon,
  MoreIcon,
  NotesIcon,
  PlugIcon,
} from "./icons.jsx";
import {
  LOW_USAGE_THRESHOLD,
  PROVIDER_META,
  QUOTA_INTERVALS,
  STATS_INTERVALS,
  STATS_PROVIDERS,
  ACCOUNT_PROVIDERS,
  formatAccount,
  isVisibleProvider,
} from "./usage-format.js";

function Toggle({ checked, onChange, label, disabled = false }) {
  return (
    <button
      className={`switch ${checked ? "is-on" : ""}`}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

/** A settings row; rows without `onChange` have no switch (their control goes in `action`). */
function SettingRow({ icon, title, detail, checked, onChange, disabled, action }) {
  return (
    <div className="settings-row">
      <span className="settings-icon">{icon}</span>
      <div className="settings-text">
        <span className="settings-title">{title}</span>
        <span className="settings-detail">{detail}</span>
        {action}
      </div>
      {onChange ? <Toggle checked={checked} onChange={onChange} label={title} disabled={disabled} /> : null}
    </div>
  );
}

// Status names come from SMAppService.Status in macos/AppDelegate.swift.
function loginItemDetail(loginItem, t) {
  switch (loginItem.status) {
    case "enabled":
      return t("login.enabled");
    case "requiresApproval":
      return t("login.requiresApproval");
    case "checking":
      return t("login.checking");
    case "unavailable":
      return t("login.unavailable");
    default:
      return loginItem.error ? t("login.failed", { error: loginItem.error }) : t("login.off");
  }
}

// Status names and error codes come from Updater in macos/Updater.swift.
function updateDetail(update, t) {
  const version = update.currentVersion || "—";
  switch (update.status) {
    case "unavailable":
      return t("update.unavailable");
    case "checking":
      return t("update.checking");
    case "upToDate":
      return t("update.upToDate", { version });
    case "available":
      return t(update.autoUpdate ? "update.availableAuto" : "update.available", { version: update.latestVersion });
    case "downloading":
      return t("update.downloading", { version: update.latestVersion });
    case "installing":
      return t("update.installing");
    case "failed":
      return t("update.failed", {
        error: t(`updateError.${update.error ?? "unknown"}`, update.errorParams ?? {}),
      });
    default:
      return t("update.idle", { version });
  }
}

function UpdateActions({ update, onCheck, onInstall, onOpenRelease }) {
  const { t } = useI18n();
  if (["unavailable", "checking", "downloading", "installing"].includes(update.status)) return null;
  const installable = update.latestVersion && (update.status === "available" || update.status === "failed");
  return (
    <span className="settings-actions">
      {installable ? (
        <>
          <button className="link-button" type="button" onClick={onInstall}>
            {t("update.installNow", { version: update.latestVersion })}
          </button>
          <button className="link-button" type="button" onClick={onOpenRelease}>{t("update.notes")}</button>
        </>
      ) : (
        <button className="link-button" type="button" onClick={onCheck}>{t("update.check")}</button>
      )}
    </span>
  );
}

function LanguagePicker({ value, onChange }) {
  const { t } = useI18n();
  const options = [
    ["system", t("settings.languageSystem")],
    ["zh", LANGUAGE_NAMES.zh],
    ["en", LANGUAGE_NAMES.en],
  ];
  return (
    <div className="segmented settings-segmented" role="radiogroup" aria-label={t("settings.language")}>
      {options.map(([id, label]) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

// A choice of minutes, e.g. how often quota is read while the panel is closed.
function IntervalPicker({ label, choices, value, onChange }) {
  const { t } = useI18n();
  return (
    <div className="segmented settings-segmented" role="radiogroup" aria-label={label}>
      {choices.map((minutes) => (
        <button key={minutes} type="button" role="radio" aria-checked={value === minutes} onClick={() => onChange(minutes)}>
          {t("settings.minutes", { count: minutes })}
        </button>
      ))}
    </div>
  );
}

const pick = (value, choices, fallback) => (choices.includes(Number(value)) ? Number(value) : fallback);

// The macOS menu-bar readout: labeled percentages, or one thin bar per tool.
function MenuBarStylePicker({ value, onChange }) {
  const { t } = useI18n();
  return (
    <div className="segmented settings-segmented" role="radiogroup" aria-label={t("settings.menuBar")}>
      {["detailed", "compact"].map((id) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} onClick={() => onChange(id)}>
          {t(`settings.menuBar.${id}`)}
        </button>
      ))}
    </div>
  );
}

// What the Shown tools row says about a tool: its plan when connected, or why it has no data.
function providerDetail(provider, t, language) {
  if (!provider) return t("provider.checking");
  if (!isVisibleProvider(provider)) return t("settings.providerNotInstalled");
  if (!provider.connected) return t("provider.unavailable");
  return formatAccount(provider.account, language) ?? t("provider.connected");
}

function ShownTools({ providers, hiddenProviders, onChange }) {
  const { t, language } = useI18n();
  const byId = Object.fromEntries(providers.map((provider) => [provider.id, provider]));
  // At least one installed tool stays on, so the panel and the menu bar never go blank.
  // API accounts join the list once they are set up.
  const ids = [...STATS_PROVIDERS, ...ACCOUNT_PROVIDERS.filter((id) => isVisibleProvider(byId[id] ?? { installed: false }))];
  const shownInstalled = ids.filter((id) => !hiddenProviders.includes(id) && isVisibleProvider(byId[id]));
  const toggle = (id) => (shown) =>
    onChange(shown ? hiddenProviders.filter((item) => item !== id) : [...hiddenProviders, id]);
  return (
    <section className="settings-group" aria-labelledby="settings-tools">
      <h3 id="settings-tools">{t("settings.tools")}</h3>
      <div className="settings-list">
        {ids.map((id) => {
          const shown = !hiddenProviders.includes(id);
          return (
            <SettingRow
              key={id}
              icon={<img className="settings-provider-icon" src={PROVIDER_META[id].icon} alt="" />}
              title={PROVIDER_META[id].name}
              detail={providerDetail(byId[id], t, language)}
              checked={shown}
              onChange={toggle(id)}
              disabled={shown && shownInstalled.length === 1 && shownInstalled[0] === id}
            />
          );
        })}
      </div>
      <p className="settings-note" title={t("settings.toolsNote")}>{t("settings.toolsNote")}</p>
    </section>
  );
}

async function sendKeyRequest(endpoint, method, body) {
  const response = await fetch(endpoint, {
    method,
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? "failed");
  return payload;
}

/**
 * One API key: saved in Settings (checked with the provider first, kept in the Keychain or with
 * DPAPI) or picked up from an environment variable. Only a masked hint ever comes back.
 */
function KeyRow({ endpoint, icon, title, offText, placeholder = "sk-…", errorText, onChanged = () => {} }) {
  const { t } = useI18n();
  const [state, setState] = useState(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    sendKeyRequest(endpoint, "GET").then(setState, () => setState({ configured: false, hint: null }));
  }, [endpoint]);

  const run = async (method, body) => {
    setBusy(true);
    setError(null);
    try {
      setState(await sendKeyRequest(endpoint, method, body));
      setEditing(false);
      setValue("");
      onChanged();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };

  const fromEnv = state?.source === "env";
  const detail = !state?.configured
    ? offText
    : fromEnv
      ? t("key.fromEnv", { variable: state.variable, hint: state.hint })
      : t("key.saved", { hint: state.hint });
  const showForm = state && (!state.configured || editing);
  return (
    <>
      <SettingRow
        icon={icon}
        title={title}
        detail={detail}
        action={
          showForm ? (
            <form
              className="key-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (value.trim()) run("PUT", { key: value.trim() });
              }}
            >
              <input
                className="key-input"
                type="password"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={placeholder}
                aria-label={title}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
              <button className="key-button" type="submit" disabled={busy || !value.trim()}>
                {t(busy ? "deepseekKey.checking" : "deepseekKey.save")}
              </button>
              {editing ? (
                <button className="link-button" type="button" onClick={() => setEditing(false)} disabled={busy}>
                  {t("deepseekKey.cancel")}
                </button>
              ) : null}
            </form>
          ) : state?.configured ? (
            <span className="settings-actions">
              <button className="link-button" type="button" onClick={() => setEditing(true)}>
                {t(fromEnv ? "key.useOther" : "deepseekKey.replace")}
              </button>
              {fromEnv ? null : (
                <button className="link-button" type="button" onClick={() => run("DELETE")} disabled={busy}>
                  {t("deepseekKey.remove")}
                </button>
              )}
            </span>
          ) : null
        }
      />
      {error ? <p className="settings-error settings-row-error">{errorText(error)}</p> : null}
    </>
  );
}

// Error codes from /api/deepseek-key that have their own message.
const KEY_ERRORS = new Set(["deepseekKeyInvalid", "deepseekKeyMalformed", "deepseekBalanceUnavailable"]);

// OpenAI has no API for the balance: the user writes down what OpenAI's billing page shows, and
// TokenTide subtracts what was spent after that (server/api-accounts.mjs).
function OpenAiBalanceRow({ onChanged }) {
  const { t, language } = useI18n();
  const [state, setState] = useState(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    sendKeyRequest("/api/openai-balance", "GET").then(setState, () => setState({ set: false }));
  }, []);

  const run = async (method, body) => {
    setBusy(true);
    setError(null);
    try {
      setState(await sendKeyRequest("/api/openai-balance", method, body));
      setEditing(false);
      setValue("");
      onChanged();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };

  const date = state?.set ? new Date(state.at).toLocaleDateString(language === "zh" ? "zh-CN" : "en-US", { month: "numeric", day: "numeric" }) : "";
  const showForm = state && (!state.set || editing);
  return (
    <>
      <SettingRow
        icon={<span className="settings-row-indent" aria-hidden="true" />}
        title={t("openaiBalance.title")}
        detail={state?.set ? t("openaiBalance.on", { amount: formatMoney(state.amount, "USD"), date }) : t("openaiBalance.off")}
        action={
          showForm ? (
            <form
              className="key-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (value.trim()) run("PUT", { amount: Number(value) });
              }}
            >
              <input
                className="key-input"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={t("openaiBalance.placeholder")}
                aria-label={t("openaiBalance.title")}
                disabled={busy}
              />
              <button className="key-button" type="submit" disabled={busy || !value.trim()}>
                {t(busy ? "deepseekKey.checking" : "deepseekKey.save")}
              </button>
              {editing ? (
                <button className="link-button" type="button" onClick={() => setEditing(false)} disabled={busy}>
                  {t("deepseekKey.cancel")}
                </button>
              ) : null}
            </form>
          ) : state?.set ? (
            <span className="settings-actions">
              <button className="link-button" type="button" onClick={() => setEditing(true)}>{t("openaiBalance.update")}</button>
              <button className="link-button" type="button" onClick={() => run("DELETE")} disabled={busy}>{t("openaiBalance.clear")}</button>
            </span>
          ) : null
        }
      />
      {error ? <p className="settings-error settings-row-error">{t(error === "adminKeyMissing" ? "openaiBalance.needKey" : ACCOUNT_ERRORS.has(error) ? `accountError.${error}` : "accountError.failed")}</p> : null}
    </>
  );
}

const ACCOUNT_ERRORS = new Set(["accountKeyInvalid", "adminKeyMalformed", "accountUnreachable", "accountUnavailable"]);

// OpenAI API and Claude API spend need organization admin keys (or OPENAI_ADMIN_KEY /
// ANTHROPIC_ADMIN_KEY); Azure OpenAI uses the signed-in Azure CLI (server/api-accounts.mjs).
function ApiAccounts({ providers, onChanged, deepseekShown = false }) {
  const { t } = useI18n();
  const azure = providers.find((provider) => provider.id === "azure-openai");
  const errorText = (code) => t(ACCOUNT_ERRORS.has(code) ? `accountError.${code}` : "accountError.failed");
  const azureDetail = !azure
    ? t("provider.checking")
    : azure.installed === false
      ? t("account.azureOff")
      : azure.connected
        ? t("account.azureOn", { via: azure.account === "Azure CLI" ? "Azure CLI" : t("account.servicePrincipal") })
        : t(`accountError.${ACCOUNT_ERRORS.has(azure.errorCode) || /^azure/.test(azure.errorCode ?? "") ? azure.errorCode : "failed"}`);
  return (
    <section className="settings-group" aria-labelledby="settings-accounts">
      <h3 id="settings-accounts">{t("settings.accounts")}</h3>
      <div className="settings-list">
        <KeyRow
          endpoint="/api/keys/openai-admin"
          icon={<img className="settings-provider-icon" src="/assets/openai.svg" alt="" />}
          title={t("account.openai")}
          offText={t("account.openaiOff")}
          placeholder="sk-admin-…"
          errorText={errorText}
          onChanged={onChanged}
        />
        {/* Only with an admin key: spend since the entered balance comes from the costs API. */}
        {providers.find((provider) => provider.id === "openai-api")?.installed ? <OpenAiBalanceRow onChanged={onChanged} /> : null}
        <KeyRow
          endpoint="/api/keys/anthropic-admin"
          icon={<img className="settings-provider-icon" src="/assets/claude.svg" alt="" />}
          title={t("account.anthropic")}
          offText={t("account.anthropicOff")}
          placeholder="sk-ant-admin…"
          errorText={errorText}
          onChanged={onChanged}
        />
        {/* DeepSeek's API key gives the balance on the DeepSeek Harness card. */}
        {deepseekShown ? (
          <KeyRow
            endpoint="/api/deepseek-key"
            icon={<img className="settings-provider-icon" src="/assets/deepseek.png" alt="" />}
            title={t("account.deepseek")}
            offText={t("deepseekKey.off")}
            errorText={(code) => t(KEY_ERRORS.has(code) ? `balanceError.${code}` : "balanceError.failed")}
            onChanged={onChanged}
          />
        ) : null}
        <SettingRow icon={<img className="settings-provider-icon" src="/assets/azure.svg" alt="" />} title="Azure OpenAI" detail={azureDetail} />
      </div>
      <p className="settings-note" title={t("account.note")}>{t("account.note")}</p>
    </section>
  );
}

// Settings → Local API: whether other apps may read usage at /v1/usage (server/local-api.mjs).
function LocalApi() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(null);
  const [error, setError] = useState(false);
  const address = `${window.location.origin}/v1/usage`;

  useEffect(() => {
    fetch("/api/local-api", { cache: "no-store" })
      .then((response) => response.json())
      .then((state) => setEnabled(state.enabled !== false), () => setEnabled(null));
  }, []);

  const change = async (value) => {
    setError(false);
    try {
      const response = await fetch("/api/local-api", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: value }),
      });
      if (!response.ok) throw new Error("failed");
      setEnabled((await response.json()).enabled);
    } catch {
      setError(true);
    }
  };

  return (
    <section className="settings-group" aria-labelledby="settings-local-api">
      <h3 id="settings-local-api">{t("settings.localApi")}</h3>
      <div className="settings-list">
        <SettingRow
          icon={<PlugIcon />}
          title={t("localApi.title")}
          detail={enabled === false ? t("localApi.off") : t("localApi.on")}
          checked={enabled !== false}
          disabled={enabled === null}
          onChange={change}
          action={enabled ? <code className="local-api-address">{address}</code> : null}
        />
      </div>
      {error ? <p className="settings-error">{t("localApi.failed")}</p> : null}
      <p className="settings-note" title={t("localApi.note")}>{t("localApi.note")}</p>
    </section>
  );
}

// Settings → More → Agent skill: installs the tokentide-usage skill into Claude Code and Codex
// (server/skill-install.mjs), so they read the local API before big tasks.
const SKILL_AGENT_ICONS = { claude: "/assets/claude.svg", codex: "/assets/openai.svg" };
const SKILL_ERRORS = new Set(["agentMissing", "skillConflict", "skillMissing"]);

function AgentSkill() {
  const { t } = useI18n();
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/skills", { cache: "no-store" })
      .then((response) => response.json())
      .then(setState, () => setState(null));
  }, []);

  const change = async (agent, method) => {
    setBusy(agent);
    setError(null);
    try {
      const response = await fetch(`/api/skills/${agent}`, { method, cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "failed");
      setState(payload);
    } catch (failure) {
      setError(SKILL_ERRORS.has(failure.message) ? failure.message : "failed");
    } finally {
      setBusy(null);
    }
  };

  const detail = (agent) => {
    if (!agent.present) return t("skill.agentMissing", { name: agent.name });
    if (!agent.installed) return t("skill.notInstalled");
    return agent.upToDate ? t("skill.installed", { location: agent.location }) : t("skill.outdated");
  };

  return (
    <section className="settings-group" aria-labelledby="settings-skill">
      <h3 id="settings-skill">{t("settings.skill")}</h3>
      <div className="settings-list">
        {(state?.agents ?? []).map((agent) => (
          <SettingRow
            key={agent.id}
            icon={<img className="settings-provider-icon" src={SKILL_AGENT_ICONS[agent.id]} alt="" />}
            title={agent.name}
            detail={detail(agent)}
            action={
              agent.present && state.bundled ? (
                <span className="settings-actions">
                  {!agent.installed || !agent.upToDate ? (
                    <button className="link-button" type="button" disabled={busy !== null} onClick={() => change(agent.id, "PUT")}>
                      {t(busy === agent.id ? "skill.working" : agent.installed ? "skill.update" : "skill.install")}
                    </button>
                  ) : null}
                  {agent.installed ? (
                    <button className="link-button" type="button" disabled={busy !== null} onClick={() => change(agent.id, "DELETE")}>
                      {t("skill.remove")}
                    </button>
                  ) : null}
                </span>
              ) : null
            }
          />
        ))}
        {state && !state.agents.length ? <div className="settings-row">{t("skill.none")}</div> : null}
      </div>
      {error ? <p className="settings-error">{t(`skill.error.${error}`)}</p> : null}
      <p className="settings-note" title={t("skill.note")}>{t("skill.note")}</p>
    </section>
  );
}

const ChevronIcon = () => (
  <svg className="icon settings-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9.5 6 6 6-6 6" />
  </svg>
);

// Less-used settings, in a dialog over the main page. Escape, the close button, or a click
// outside closes it (Escape here never reaches the panel's own Escape, which hides the panel).
function MoreSettings({ settings, providers, onSettingChange, onDeepseekKeyChange, onClose }) {
  const { t } = useI18n();
  const dialogRef = useRef(null);
  const deepseekShown =
    isVisibleProvider(providers.find((provider) => provider.id === "deepseek") ?? { installed: false }) &&
    !settings.hiddenProviders.includes("deepseek");

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="settings-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-more-title" tabIndex={-1} ref={dialogRef}>
        <div className="settings-dialog-heading">
          <h3 id="settings-more-title">{t("settings.more")}</h3>
          <button className="icon-button settings-dialog-close" type="button" onClick={onClose} aria-label={t("settings.close")} title={t("settings.close")}>
            <CloseIcon />
          </button>
        </div>
        <div className="settings settings-dialog-body">
          <section className="settings-group" aria-labelledby="settings-quota">
            <h3 id="settings-quota">{t("settings.quota")}</h3>
            <div className="settings-list">
              <SettingRow
                icon={<ClockIcon />}
                title={t("settings.autoRefresh")}
                detail={
                  settings.autoRefresh
                    ? t("settings.autoRefreshDetail", { minutes: pick(settings.quotaInterval, QUOTA_INTERVALS, 2) })
                    : t("settings.autoRefreshOff")
                }
                checked={settings.autoRefresh}
                onChange={(value) => onSettingChange("autoRefresh", value)}
                action={
                  settings.autoRefresh ? (
                    <IntervalPicker
                      label={t("settings.quotaInterval")}
                      choices={QUOTA_INTERVALS}
                      value={pick(settings.quotaInterval, QUOTA_INTERVALS, 2)}
                      onChange={(value) => onSettingChange("quotaInterval", value)}
                    />
                  ) : null
                }
              />
              <SettingRow
                icon={<ChartIcon />}
                title={t("settings.statsInterval")}
                detail={t("settings.statsIntervalDetail", { minutes: pick(settings.statsInterval, STATS_INTERVALS, 30) })}
                action={
                  <IntervalPicker
                    label={t("settings.statsInterval")}
                    choices={STATS_INTERVALS}
                    value={pick(settings.statsInterval, STATS_INTERVALS, 30)}
                    onChange={(value) => onSettingChange("statsInterval", value)}
                  />
                }
              />
            </div>
          </section>

          <ApiAccounts providers={providers} onChanged={onDeepseekKeyChange} deepseekShown={deepseekShown} />

          <LocalApi />

          <AgentSkill />
        </div>
      </div>
    </div>
  );
}

export function SettingsView({
  settings,
  providers,
  onSettingChange,
  loginItem,
  onLoginItemChange,
  onOpenLoginItems,
  update,
  onUpdateAction,
  onOpenChangelog,
  showMenuBarStyle = false,
  onDeepseekKeyChange = () => {},
}) {
  const { t } = useI18n();
  const [moreOpen, setMoreOpen] = useState(false);
  const closeMore = useCallback(() => setMoreOpen(false), []);

  const loginEnabled = loginItem.status === "enabled" || loginItem.status === "requiresApproval";
  return (
    <div className="settings">
      <section className="settings-group" aria-labelledby="settings-general">
        <h3 id="settings-general">{t("settings.general")}</h3>
        <div className="settings-list">
          <SettingRow
            icon={<GlobeIcon />}
            title={t("settings.language")}
            detail={t("settings.languageDetail")}
            action={<LanguagePicker value={settings.language} onChange={(value) => onSettingChange("language", value)} />}
          />
          {showMenuBarStyle ? (
            <SettingRow
              icon={<MenuBarIcon />}
              title={t("settings.menuBar")}
              detail={t(settings.menuBarStyle === "compact" ? "settings.menuBarDetail.compact" : "settings.menuBarDetail.detailed")}
              action={
                <MenuBarStylePicker
                  value={settings.menuBarStyle === "compact" ? "compact" : "detailed"}
                  onChange={(value) => onSettingChange("menuBarStyle", value)}
                />
              }
            />
          ) : null}
          <SettingRow
            icon={<LoginIcon />}
            title={t("settings.launch")}
            detail={loginItemDetail(loginItem, t)}
            checked={loginEnabled}
            onChange={onLoginItemChange}
            disabled={loginItem.status === "unavailable" || loginItem.status === "checking"}
            action={
              loginItem.status === "requiresApproval" ? (
                <button className="link-button settings-action" type="button" onClick={onOpenLoginItems}>
                  {t("login.openSettings")}
                </button>
              ) : null
            }
          />
          <SettingRow
            icon={<BellIcon />}
            title={t("settings.lowAlert")}
            detail={t("settings.lowAlertDetail", { percent: LOW_USAGE_THRESHOLD })}
            checked={settings.lowUsageAlert}
            onChange={(value) => onSettingChange("lowUsageAlert", value)}
          />
        </div>
      </section>

      <ShownTools
        providers={providers}
        hiddenProviders={settings.hiddenProviders}
        onChange={(value) => onSettingChange("hiddenProviders", value)}
      />

      <section className="settings-group" aria-labelledby="settings-update">
        <h3 id="settings-update">{t("settings.update")}</h3>
        <div className="settings-list">
          <SettingRow
            icon={<DownloadIcon />}
            title={t("settings.autoUpdate")}
            detail={updateDetail(update, t)}
            checked={update.status !== "unavailable" && update.autoUpdate !== false}
            onChange={(value) => onUpdateAction("setAutoUpdate", value)}
            disabled={update.status === "unavailable"}
            action={
              <UpdateActions
                update={update}
                onCheck={() => onUpdateAction("checkUpdate")}
                onInstall={() => onUpdateAction("installUpdate")}
                onOpenRelease={() => onUpdateAction("openRelease")}
              />
            }
          />
          <SettingRow
            icon={<NotesIcon />}
            title={t("settings.changelog")}
            detail={t("settings.changelogDetail")}
            action={
              <button className="link-button settings-action" type="button" onClick={onOpenChangelog}>
                {t("settings.changelogOpen")}
              </button>
            }
          />
        </div>
      </section>

      <div className="settings-list settings-more-link">
        <button className="settings-row settings-row-button" type="button" onClick={() => setMoreOpen(true)} aria-haspopup="dialog">
          <span className="settings-icon"><MoreIcon /></span>
          <span className="settings-text">
            <span className="settings-title">{t("settings.more")}</span>
            <span className="settings-detail">{t("settings.moreDetail")}</span>
          </span>
          <ChevronIcon />
        </button>
      </div>

      {moreOpen ? (
        <MoreSettings
          settings={settings}
          providers={providers}
          onSettingChange={onSettingChange}
          onDeepseekKeyChange={onDeepseekKeyChange}
          onClose={closeMore}
        />
      ) : null}

      <footer className="settings-about">
        {/* HETERONTO's minimal mark and wordmark in single white ink, kept quiet. */}
        <span className="settings-about-by">
          by
          <img className="settings-about-mark" src="/assets/heteronto-mark-white.svg" alt="" />
          <img className="settings-about-wordmark" src="/assets/heteronto-wordmark-white.svg" alt="HETERONTO" />
        </span>
        <span className="settings-about-privacy">
          <LockIcon />
          {t("settings.aboutPrivacy")}
        </span>
      </footer>
    </div>
  );
}
