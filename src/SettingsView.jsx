import { BellIcon, ClockIcon, LoginIcon } from "./icons.jsx";
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

function SettingRow({ icon, title, detail, checked, onChange, disabled, action }) {
  return (
    <div className="settings-row">
      <span className="settings-icon">{icon}</span>
      <div className="settings-text">
        <span className="settings-title">{title}</span>
        <span className="settings-detail">{detail}</span>
        {action}
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} disabled={disabled} />
    </div>
  );
}

// Status names come from SMAppService.Status in macos/UsageMonitor.swift.
function loginItemDetail(loginItem) {
  switch (loginItem.status) {
    case "enabled":
      return "登录 Mac 后自动出现在菜单栏";
    case "requiresApproval":
      return "已添加，需要在系统设置里允许";
    case "checking":
      return "正在读取系统设置…";
    case "unavailable":
      return "仅在 TokenTide app 中可用";
    default:
      return loginItem.error ? `设置失败：${loginItem.error}` : "登录 Mac 后自动启动 TokenTide";
  }
}

export function SettingsView({ settings, onSettingChange, loginItem, onLoginItemChange, onOpenLoginItems, version }) {
  const loginEnabled = loginItem.status === "enabled" || loginItem.status === "requiresApproval";
  return (
    <div className="settings">
      <section className="settings-group" aria-labelledby="settings-general">
        <h3 id="settings-general">通用</h3>
        <div className="settings-list">
          <SettingRow
            icon={<LoginIcon />}
            title="开机时启动"
            detail={loginItemDetail(loginItem)}
            checked={loginEnabled}
            onChange={onLoginItemChange}
            disabled={loginItem.status === "unavailable" || loginItem.status === "checking"}
            action={
              loginItem.status === "requiresApproval" ? (
                <button className="link-button settings-action" type="button" onClick={onOpenLoginItems}>
                  打开「登录项」设置
                </button>
              ) : null
            }
          />
        </div>
      </section>

      <section className="settings-group" aria-labelledby="settings-quota">
        <h3 id="settings-quota">额度</h3>
        <div className="settings-list">
          <SettingRow
            icon={<ClockIcon />}
            title="自动刷新"
            detail="每 5 分钟读取一次额度"
            checked={settings.autoRefresh}
            onChange={(value) => onSettingChange("autoRefresh", value)}
          />
          <SettingRow
            icon={<BellIcon />}
            title="低额度提醒"
            detail={`当前窗口剩余低于 ${LOW_USAGE_THRESHOLD}% 时提示`}
            checked={settings.lowUsageAlert}
            onChange={(value) => onSettingChange("lowUsageAlert", value)}
          />
        </div>
      </section>

      <p className="settings-about">TokenTide {version} · 所有数据只在本机读取和保存</p>
    </div>
  );
}
