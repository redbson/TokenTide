import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, nativeTheme, screen, shell, utilityProcess } from "electron";
import { renderTrayIcon } from "./tray-icon.mjs";
import { RELEASES_PAGE, createUpdater } from "./updater.mjs";

// TokenTide for Windows: a tray icon with a borderless panel above it, the counterpart of
// macos/AppDelegate.swift. The panel is the same page as on macOS, served with the local API
// by server/main.mjs, which runs in an Electron utility process (Electron's own Node.js, so
// Node does not need to be installed).

// TOKENTIDE_PORT lets development run beside an installed copy.
const PORT = Number(process.env.TOKENTIDE_PORT) || 4173;
const ADDRESS = `http://127.0.0.1:${PORT}/`;
const PANEL_WIDTH = 360;
const PANEL_GAP = 8;
const SERVICE_RESTARTS = 3;

const here = path.dirname(fileURLToPath(import.meta.url));
// Packaged (scripts/build-windows.mjs): server/ and client/ sit next to this file. In
// development (`npm --prefix windows start`) they come from the repository.
const packagedLayout = existsSync(path.join(here, "server", "main.mjs"));
const serverEntry = packagedLayout ? path.join(here, "server", "main.mjs") : path.join(here, "..", "server", "main.mjs");
const clientDir = packagedLayout ? path.join(here, "client") : path.join(here, "..", "dist", "client");
const version = packagedLayout ? app.getVersion() : JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")).version;
const smokeDir = process.argv.find((value) => value.startsWith("--smoke-test="))?.slice("--smoke-test=".length) ?? null;

app.setName("TokenTide");
if (process.platform === "win32") app.setAppUserModelId("io.github.redbson.tokentide");

// MARK: Settings kept by the shell (the page keeps its own in localStorage)

const settingsFile = () => path.join(app.getPath("userData"), "shell-settings.json");
let shellSettings = {};

function loadShellSettings() {
  try {
    shellSettings = JSON.parse(readFileSync(settingsFile(), "utf8")) ?? {};
  } catch {
    shellSettings = {};
  }
}

function saveShellSettings(changes) {
  shellSettings = { ...shellSettings, ...changes };
  try {
    mkdirSync(path.dirname(settingsFile()), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify(shellSettings, null, 2));
  } catch {
    // Settings still apply for this run.
  }
}

/** "zh" or "en", as chosen in the panel; before that, Chinese when Windows' first language is Chinese. */
function language() {
  if (["zh", "en"].includes(shellSettings.language)) return shellSettings.language;
  return app.getPreferredSystemLanguages()[0]?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

const tr = (chinese, english) => (language() === "zh" ? chinese : english);

// MARK: State

let tray = null;
let panel = null;
let service = null;
let serviceRestarts = 0;
let quitting = false;
let contentHeight = 520;
let lastHidden = 0;
let summary = null;
let lightTaskbar = false;
let updater = null;

// MARK: Tray

/** Windows' taskbar follows "Choose your default Windows mode", separate from the app theme. */
function readTaskbarTheme() {
  if (process.platform === "darwin") return true; // development: a template image, drawn dark
  if (process.platform !== "win32") return !nativeTheme.shouldUseDarkColors;
  const result = spawnSync(
    "reg",
    ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", "/v", "SystemUsesLightTheme"],
    { encoding: "utf8", windowsHide: true },
  );
  return /SystemUsesLightTheme\s+REG_DWORD\s+0x1\b/.test(result.stdout ?? "");
}

function trayImage(items) {
  const image = nativeImage.createEmpty();
  for (const scaleFactor of [1, 1.25, 1.5, 2]) {
    const size = Math.round(16 * scaleFactor);
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: renderTrayIcon({ items, size, light: lightTaskbar }) });
  }
  if (process.platform === "darwin") image.setTemplateImage(true);
  return image;
}

function trayTooltip() {
  if (!summary?.items?.length) return "TokenTide";
  const lines = summary.items.map((item) => {
    const percent = Number.isFinite(item.remaining) ? `${Math.round(item.remaining)}%` : "—";
    return tr(`${item.name ?? item.label} 剩余 ${percent}`, `${item.name ?? item.label} ${percent} left`);
  });
  return ["TokenTide", ...lines].join("\n");
}

function refreshTray() {
  if (!tray) return;
  tray.setImage(trayImage(summary?.items?.length ? summary.items : null));
  tray.setToolTip(trayTooltip());
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: tr("显示额度", "Show Quota"), click: () => showPanel() },
    { label: tr("立即刷新", "Refresh Now"), click: () => refreshNow() },
    { type: "separator" },
    { label: tr("退出", "Quit"), click: () => quit() },
  ]);
}

function setUpTray() {
  lightTaskbar = readTaskbarTheme();
  tray = new Tray(trayImage(null));
  tray.setToolTip("TokenTide");
  tray.on("click", () => togglePanel());
  tray.on("right-click", () => {
    hidePanel();
    tray.popUpContextMenu(trayMenu());
  });
  nativeTheme.on("updated", () => {
    lightTaskbar = readTaskbarTheme();
    refreshTray();
  });
}

// MARK: Panel

function setUpPanel() {
  panel = new BrowserWindow({
    width: PANEL_WIDTH,
    height: contentHeight,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: "TokenTide",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // WebView languages can differ from Windows', so the page gets the system ones (src/i18n.js).
      additionalArguments: [`--tokentide-languages=${encodeURIComponent(JSON.stringify(app.getPreferredSystemLanguages()))}`],
    },
  });
  panel.setAlwaysOnTop(true, "pop-up-menu");
  panel.setMenu(null);
  panel.on("blur", () => {
    if (!smokeDir) hidePanel();
  });

  const contents = panel.webContents;
  // The panel only ever shows the local service.
  contents.on("will-navigate", (event, url) => {
    if (!url.startsWith(ADDRESS)) event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
    // -3: aborted by a newer navigation.
    if (!isMainFrame || code === -3 || !url.startsWith(ADDRESS)) return;
    showLoading(tr("正在重新连接本机额度服务…", "Reconnecting to the local quota service…"));
    startService();
  });
  contents.on("render-process-gone", () => {
    if (!quitting) setTimeout(() => panel && contents.reload(), 500);
  });
}

function togglePanel() {
  if (panel.isVisible()) hidePanel();
  // A click on the tray icon first hides the panel through blur; don't reopen it.
  else if (Date.now() - lastHidden > 250) showPanel();
}

function showPanel() {
  positionPanel();
  panel.show();
  panel.focus();
  dispatch("usage-monitor:show");
}

function hidePanel() {
  if (!panel?.isVisible()) return;
  panel.hide();
  lastHidden = Date.now();
  updater?.panelDidHide();
}

/** Places the panel next to the tray icon on whichever edge the taskbar is. */
function positionPanel() {
  let anchor = tray.getBounds();
  // An icon in the overflow flyout has no bounds of its own; the click was at the cursor.
  if (!anchor.width || !anchor.height) {
    const cursor = screen.getCursorScreenPoint();
    anchor = { x: cursor.x, y: cursor.y, width: 0, height: 0 };
  }
  const center = { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 };
  const display = screen.getDisplayNearestPoint(center);
  const work = display.workArea;
  const bounds = display.bounds;
  const height = Math.round(Math.min(contentHeight, work.height - PANEL_GAP * 2));
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  let x = center.x - PANEL_WIDTH / 2;
  let y;
  if (work.y > bounds.y) {
    y = work.y + PANEL_GAP; // taskbar (or the macOS menu bar) at the top
  } else if (work.x > bounds.x) {
    x = work.x + PANEL_GAP; // taskbar on the left
    y = center.y - height / 2;
  } else if (work.width < bounds.width) {
    x = work.x + work.width - PANEL_WIDTH - PANEL_GAP; // taskbar on the right
    y = center.y - height / 2;
  } else {
    y = work.y + work.height - height - PANEL_GAP; // taskbar at the bottom
  }
  x = clamp(x, work.x + PANEL_GAP, work.x + work.width - PANEL_WIDTH - PANEL_GAP);
  y = clamp(y, work.y + PANEL_GAP, work.y + work.height - height - PANEL_GAP);
  panel.setBounds({ x: Math.round(x), y: Math.round(y), width: PANEL_WIDTH, height });
}

function showLoading(message, detail = null) {
  const font = `"Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",sans-serif`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:transparent;color:#b4b8c1;font:13px ${font}}
    main{margin:0;padding:40px 24px;text-align:center;background:#232428;border-radius:8px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}
    h2{margin:0 0 8px;font-size:14px;font-weight:600;color:#eceef2}p{margin:0;line-height:1.5;color:#8d929c;font-size:12px}
    </style></head><body><main><h2>${message}</h2>${detail ? `<p>${detail}</p>` : ""}</main></body></html>`;
  contentHeight = detail ? 150 : 110;
  panel.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  if (panel.isVisible()) positionPanel();
}

function refreshNow() {
  // Reloading the page performs a fresh read on mount.
  if (panel.webContents.getURL().startsWith(ADDRESS)) panel.webContents.reload();
}

// MARK: Page bridge

/** Delivers a native state change to the page as a DOM event. */
function dispatch(event, detail = null) {
  if (!panel?.webContents.getURL().startsWith(ADDRESS)) return;
  const init = detail === null ? "" : `, { detail: ${JSON.stringify(detail)} }`;
  panel.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent(${JSON.stringify(event)}${init}))`).catch(() => {});
}

function handleMessage(message) {
  switch (message?.type) {
    case "resize":
      if (Number.isFinite(message.height) && message.height > 0) {
        contentHeight = message.height;
        if (panel.isVisible()) positionPanel();
      }
      break;
    case "summary":
      summary = { items: Array.isArray(message.items) ? message.items.slice(0, 8) : [], low: Boolean(message.low) };
      refreshTray();
      smokeTest?.onSummary();
      break;
    case "hide":
      hidePanel();
      break;
    case "setLanguage":
      if (["zh", "en"].includes(message.language)) {
        saveShellSettings({ language: message.language });
        refreshTray();
      }
      break;
    case "getLoginItem":
      sendLoginItemStatus();
      break;
    case "setLoginItem":
      setLoginItem(Boolean(message.enabled));
      break;
    case "openLoginItems":
      hidePanel();
      shell.openExternal("ms-settings:startupapps");
      break;
    case "signIn":
      hidePanel();
      startSignIn(message.tool);
      break;
    case "getUpdate":
      sendUpdateStatus();
      break;
    case "checkUpdate":
      updater.check();
      break;
    case "installUpdate":
      updater.install();
      break;
    case "setAutoUpdate":
      updater.setAutoUpdate(message.enabled !== false);
      break;
    case "openRelease":
      hidePanel();
      shell.openExternal(updater.latest?.page ?? RELEASES_PAGE);
      break;
    case "quit":
      quit();
      break;
    default:
      break;
  }
}

ipcMain.on("tokentide", (event, message) => {
  // Only the local panel page may drive the shell.
  if (event.sender !== panel?.webContents || !event.senderFrame?.url.startsWith(ADDRESS)) return;
  handleMessage(message);
});

// MARK: Launch at login (the Run key, shown in Windows Settings → Apps → Startup)

function sendLoginItemStatus(error = null) {
  if (!app.isPackaged) {
    // Development runs electron.exe, which must not be registered to start at login.
    dispatch("usage-monitor:login-item", { status: "unavailable" });
    return;
  }
  const settings = app.getLoginItemSettings();
  const status = settings.openAtLogin
    ? settings.executableWillLaunchAtLogin === false
      ? "requiresApproval"
      : "enabled"
    : "notRegistered";
  dispatch("usage-monitor:login-item", error ? { status, error } : { status });
}

function setLoginItem(enabled) {
  let error = null;
  try {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: enabled });
  } catch (failure) {
    error = failure.message;
  }
  sendLoginItemStatus(error);
}

// MARK: Sign in

/** Opens a command window on the tool's own sign-in command. */
function startSignIn(tool) {
  const command = { claude: "claude auth login", codex: "codex login", qoder: "qodercli" }[tool];
  if (!command) return;
  const done = tr("登录完成后可以关闭这个窗口，回到 TokenTide 刷新。", "When you are done, close this window and refresh TokenTide.");
  // `start` opens its own console window; `/k` keeps it open for the sign-in prompts.
  const child = spawn("cmd.exe", ["/c", "start", "TokenTide", "cmd", "/k", `${command} & echo. & echo ${done}`], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

// MARK: Updates

function sendUpdateStatus() {
  dispatch("usage-monitor:update", updater.snapshot());
}

function setUpUpdater() {
  updater = createUpdater({
    currentVersion: version,
    getAutoUpdate: () => shellSettings.autoUpdate !== false,
    setAutoUpdate: (enabled) => saveShellSettings({ autoUpdate: enabled }),
    // Never replace the app under an open panel.
    canInstallNow: () => !panel?.isVisible(),
    onChange: () => sendUpdateStatus(),
    // The per-user installer replaces the app silently and starts it again (--force-run).
    launchInstaller: async (file) => {
      const child = spawn(file, ["/S", "--updated", "--force-run"], { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      setTimeout(() => quit(), 300);
    },
  });
  // Development builds are never replaced by a release.
  if (app.isPackaged && !smokeDir) updater.start();
}

// MARK: Local service

function startService() {
  if (service) return;
  const logs = app.getPath("logs");
  mkdirSync(logs, { recursive: true });
  const log = createWriteStream(path.join(logs, "service.log"), { flags: "a" });
  const child = utilityProcess.fork(serverEntry, ["--port", String(PORT), "--client", clientDir], {
    stdio: "pipe",
    serviceName: "TokenTide service",
    cwd: path.dirname(serverEntry),
  });
  service = child;
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  child.on("message", (message) => {
    if (message?.type === "listening") {
      panel.loadURL(ADDRESS);
    } else if (message?.type === "error") {
      showLoading(
        tr("无法启动本机额度服务", "Couldn't start the local quota service"),
        message.code === "EADDRINUSE"
          ? tr(`端口 ${PORT} 被其他程序占用，请关闭它后重新打开 TokenTide。`, `Port ${PORT} is used by another program. Close it and open TokenTide again.`)
          : tr(`日志：${path.join(logs, "service.log")}`, `Log: ${path.join(logs, "service.log")}`),
      );
    }
  });
  child.on("exit", (code) => {
    if (service === child) service = null;
    if (quitting) return;
    if (code === 0 || serviceRestarts >= SERVICE_RESTARTS) return;
    serviceRestarts += 1;
    setTimeout(startService, 1000 * serviceRestarts);
  });
}

function stopService() {
  const child = service;
  service = null;
  if (!child) return;
  child.postMessage({ type: "shutdown" });
  setTimeout(() => child.kill(), 1000).unref?.();
}

function quit() {
  quitting = true;
  app.quit();
}

// MARK: Smoke test (CI): `TokenTide.exe --smoke-test=<folder>` captures the panel and quits.

let smokeTest = null;

function setUpSmokeTest() {
  if (!smokeDir) return;
  mkdirSync(smokeDir, { recursive: true });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const capture = async (name) => {
    const image = await panel.webContents.capturePage();
    writeFileSync(path.join(smokeDir, `${name}.png`), image.toPNG());
  };
  const click = (index) => panel.webContents.executeJavaScript(`document.querySelectorAll(".tab")[${index}]?.click()`);
  const finish = (result) => {
    writeFileSync(path.join(smokeDir, "smoke.json"), JSON.stringify({ version, platform: process.platform, arch: process.arch, ...result }, null, 2));
    app.exit(result.ok ? 0 : 1);
  };
  const timeout = setTimeout(() => finish({ ok: false, error: "The panel did not report a summary within 120 s." }), 120_000);
  let started = false;
  smokeTest = {
    async onSummary() {
      if (started) return;
      started = true;
      clearTimeout(timeout);
      try {
        showPanel();
        await wait(1500);
        await capture("quota");
        await click(2);
        await wait(800);
        await capture("settings");
        await click(1);
        await wait(4000);
        await capture("history");
        const text = await panel.webContents.executeJavaScript("document.body.innerText");
        finish({ ok: true, summary, bounds: panel.getBounds(), update: updater.snapshot(), text });
      } catch (error) {
        finish({ ok: false, error: String(error?.stack ?? error) });
      }
    },
  };
}

// MARK: Lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showPanel());
  app.on("window-all-closed", () => {
    // The app lives in the tray; closing the panel never quits it.
  });
  app.on("before-quit", () => {
    quitting = true;
    updater?.stop();
    stopService();
  });
  app.whenReady().then(() => {
    if (process.platform === "darwin") app.dock?.hide();
    loadShellSettings();
    setUpTray();
    setUpPanel();
    setUpUpdater();
    setUpSmokeTest();
    showLoading(tr("正在启动本机额度服务…", "Starting the local quota service…"));
    startService();
  });
}
