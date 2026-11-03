import { spawn } from "node:child_process";

// API keys TokenTide can pick up from the environment instead of Settings, e.g. DEEPSEEK_API_KEY
// or OPENAI_ADMIN_KEY. The service's own environment comes first. The macOS app starts the
// service through a login shell (`zsh -lc`), which sources ~/.zprofile but not ~/.zshrc, so a
// variable that is missing there is looked up once in an interactive login shell, the way
// editors resolve the user's shell environment. Only the variables asked for are kept, values
// are never logged, and a key saved in Settings always wins.

const SHELL_TIMEOUT_MS = 8000;
const SHELL_CACHE_MS = 10 * 60_000;
const MARKER = "__TOKENTIDE_ENV__";

/** The given variables as an interactive login shell sees them ({} when there is no such shell). */
export function readShellEnv(names, { shell = process.env.SHELL || "/bin/zsh", platform = process.platform, timeoutMs = SHELL_TIMEOUT_MS } = {}) {
  if (platform === "win32" || !names.length) return Promise.resolve({});
  return new Promise((resolve) => {
    let child;
    try {
      // `env -0` separates entries with NUL, so values may hold newlines; the marker skips
      // whatever the user's rc files print first (prompts, terminal escape codes).
      child = spawn(shell, ["-ilc", `printf '%s' ${MARKER}; /usr/bin/env -0`], {
        stdio: ["ignore", "pipe", "ignore"],
        env: { HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TERM: "dumb" },
      });
    } catch {
      resolve({});
      return;
    }
    const chunks = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", () => {
      clearTimeout(timer);
      resolve({});
    });
    child.once("close", () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString("utf8");
      const start = text.lastIndexOf(MARKER);
      if (start < 0) return resolve({});
      const wanted = new Set(names);
      const found = {};
      for (const entry of text.slice(start + MARKER.length).split("\0")) {
        const equals = entry.indexOf("=");
        if (equals <= 0) continue;
        const name = entry.slice(0, equals);
        if (wanted.has(name) && entry.length > equals + 1) found[name] = entry.slice(equals + 1).trim();
      }
      resolve(found);
    });
  });
}

/**
 * Looks variables up in the service's environment, then (once per SHELL_CACHE_MS) in the
 * user's interactive shell. `refresh()` forgets the shell's answer, for Settings' "read again".
 */
export function createEnvCredentials({ env = process.env, readShell = readShellEnv, names = [] } = {}) {
  let shellValues = null;
  let shellReadAt = 0;
  let inFlight = null;

  async function shell() {
    if (shellValues && Date.now() - shellReadAt < SHELL_CACHE_MS) return shellValues;
    inFlight ??= readShell(names)
      .catch(() => ({}))
      .then((values) => {
        shellValues = values;
        shellReadAt = Date.now();
        return values;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    /** `{ value, variable, from: "env" | "shell" }` for the first of `variables` that is set, or null. */
    async find(variables, accept = () => true) {
      for (const variable of variables) {
        const value = env[variable]?.trim();
        if (value && accept(value)) return { value, variable, from: "env" };
      }
      const values = await shell();
      for (const variable of variables) {
        const value = values[variable];
        if (value && accept(value)) return { value, variable, from: "shell" };
      }
      return null;
    },
    refresh() {
      shellValues = null;
    },
  };
}

/**
 * Where each key comes from: saved in Settings (the secret store) first, then these variables.
 * `accept` keeps a variable only if it holds the right kind of key (an admin key, say).
 */
export const KEY_SOURCES = {
  deepseek: { secret: "deepseek-api-key", variables: ["DEEPSEEK_API_KEY"] },
  "openai-admin": {
    secret: "openai-admin-key",
    variables: ["OPENAI_ADMIN_KEY", "OPENAI_API_KEY"],
    // The costs API takes only organization admin keys; a project key in OPENAI_API_KEY is skipped.
    accept: (value) => value.startsWith("sk-admin-"),
  },
  "anthropic-admin": {
    secret: "anthropic-admin-key",
    variables: ["ANTHROPIC_ADMIN_KEY", "ANTHROPIC_API_KEY"],
    accept: (value) => value.startsWith("sk-ant-admin"),
  },
};

/** Resolves keys by id: `{ value, source: "saved" | "env", variable? }`, or null. */
export function createKeyResolver({ secrets, envCredentials }) {
  return {
    async resolve(id) {
      const source = KEY_SOURCES[id];
      if (!source) return null;
      const saved = await secrets.get(source.secret);
      if (saved) return { value: saved, source: "saved" };
      const found = await envCredentials?.find(source.variables, source.accept);
      return found ? { value: found.value, source: "env", variable: found.variable } : null;
    },
    refresh: () => envCredentials?.refresh(),
  };
}

/** Every variable any key may come from, so the shell is asked once for all of them. */
export const KEY_VARIABLES = [...new Set(Object.values(KEY_SOURCES).flatMap((source) => source.variables)), "AZURE_SUBSCRIPTION_ID", "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];
