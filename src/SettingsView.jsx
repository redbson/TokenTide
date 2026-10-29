import { useI18n } from "./i18n-context.js";
import { LANGUAGE_NAMES } from "./i18n.js";
import { useEffect, useState } from "react";
import { BellIcon, ChartIcon, ClockIcon, DownloadIcon, GlobeIcon, KeyIcon, LockIcon, LoginIcon, MenuBarIcon, NotesIcon } from "./icons.jsx";
import {
  LOW_USAGE_THRESHOLD,
  PROVIDER_META,
  QUOTA_INTERVALS,
  STATS_INTERVALS,
  STATS_PROVIDERS,
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
  const shownInstalled = STATS_PROVIDERS.filter((id) => !hiddenProviders.includes(id) && isVisibleProvider(byId[id]));
  const toggle = (id) => (shown) =>
    onChange(shown ? hiddenProviders.filter((item) => item !== id) : [...hiddenProviders, id]);
  return (
    <section className="settings-group" aria-labelledby="settings-tools">
      <h3 id="settings-tools">{t("settings.tools")}</h3>
      <div className="settings-list">
        {STATS_PROVIDERS.map((id) => {
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

// Error codes from /api/deepseek-key that have their own message.
const KEY_ERRORS = new Set(["deepseekKeyInvalid", "deepseekKeyMalformed", "deepseekBalanceUnavailable"]);

async function sendKeyRequest(method, body) {
  const response = await fetch("/api/deepseek-key", {
    method,
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? "failed");
  return payload;
}

// The DeepSeek API key for the balance. The service checks it with DeepSeek before saving it in
// the Keychain (Windows: DPAPI) and only ever hands back a masked hint.
function DeepseekKey({ onChanged }) {
  const { t } = useI18n();
  const [state, setState] = useState(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    sendKeyRequest("GET").then(setState, () => setState({ configured: false, hint: null }));
  }, []);

  const run = async (method, body) => {
    setBusy(true);
    setError(null);
    try {
      setState(await sendKeyRequest(method, body));
      setEditing(false);
      setValue("");
      onChanged();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };

  const showForm = state && (!state.configured || editing);
  return (
    <section className="settings-group" aria-labelledby="settings-deepseek">
      <h3 id="settings-deepseek">{t("settings.deepseek")}</h3>
      <div className="settings-list">
        <SettingRow
          icon={<KeyIcon />}
          title={t("deepseekKey.title")}
          detail={state?.configured ? t("deepseekKey.on", { hint: state.hint }) : t("deepseekKey.off")}
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
                  placeholder="sk-…"
                  aria-label={t("deepseekKey.title")}
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
                <button className="link-button" type="button" onClick={() => setEditing(true)}>{t("deepseekKey.replace")}</button>
                <button className="link-button" type="button" onClick={() => run("DELETE")} disabled={busy}>
                  {t("deepseekKey.remove")}
                </button>
              </span>
            ) : null
          }
        />
      </div>
      {error ? <p className="settings-error">{t(KEY_ERRORS.has(error) ? `balanceError.${error}` : "balanceError.failed")}</p> : null}
      <p className="settings-note" title={t("deepseekKey.note")}>{t("deepseekKey.note")}</p>
    </section>
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
        </div>
      </section>

      <ShownTools
        providers={providers}
        hiddenProviders={settings.hiddenProviders}
        onChange={(value) => onSettingChange("hiddenProviders", value)}
      />

      {/* Only with DeepSeek Harness installed and shown. */}
      {isVisibleProvider(providers.find((provider) => provider.id === "deepseek") ?? { installed: false }) &&
      !settings.hiddenProviders.includes("deepseek") ? (
        <DeepseekKey onChanged={onDeepseekKeyChange} />
      ) : null}

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
          <SettingRow
            icon={<BellIcon />}
            title={t("settings.lowAlert")}
            detail={t("settings.lowAlertDetail", { percent: LOW_USAGE_THRESHOLD })}
            checked={settings.lowUsageAlert}
            onChange={(value) => onSettingChange("lowUsageAlert", value)}
          />
        </div>
      </section>

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
