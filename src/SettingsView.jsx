import { useI18n } from "./i18n-context.js";
import { LANGUAGE_NAMES } from "./i18n.js";
import { BellIcon, ClockIcon, DownloadIcon, GlobeIcon, LoginIcon } from "./icons.jsx";
import { LOW_USAGE_THRESHOLD } from "./usage-format.js";

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

export function SettingsView({
  settings,
  onSettingChange,
  loginItem,
  onLoginItemChange,
  onOpenLoginItems,
  update,
  onUpdateAction,
  version,
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
        </div>
      </section>

      <section className="settings-group" aria-labelledby="settings-quota">
        <h3 id="settings-quota">{t("settings.quota")}</h3>
        <div className="settings-list">
          <SettingRow
            icon={<ClockIcon />}
            title={t("settings.autoRefresh")}
            detail={t("settings.autoRefreshDetail")}
            checked={settings.autoRefresh}
            onChange={(value) => onSettingChange("autoRefresh", value)}
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

      <p className="settings-about">{t("settings.about", { version })}</p>
    </div>
  );
}
