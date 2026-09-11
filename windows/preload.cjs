// The panel page's bridge to the Windows shell (windows/main.mjs), the counterpart of the
// macOS `window.webkit.messageHandlers.usageMonitor` handler. The page posts plain messages;
// the shell answers with `usage-monitor:*` DOM events.
const { contextBridge, ipcRenderer } = require("electron");

const argument = process.argv.find((value) => value.startsWith("--tokentide-languages="));
let systemLanguages = [];
try {
  systemLanguages = argument ? JSON.parse(decodeURIComponent(argument.slice("--tokentide-languages=".length))) : [];
} catch {
  systemLanguages = [];
}

contextBridge.exposeInMainWorld("__TOKENTIDE__", { platform: "windows", systemLanguages });
contextBridge.exposeInMainWorld("tokentideNative", {
  postMessage: (message) => ipcRenderer.send("tokentide", message),
});
