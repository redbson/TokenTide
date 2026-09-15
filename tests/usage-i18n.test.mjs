import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MESSAGES, PLATFORM_MESSAGES, detectLanguage, resolveLanguage, translate } from "../src/i18n.js";
import { compareToBook } from "../src/stats-format.js";
import { describeLow, formatAccount, formatReset, limitLabel, timeAgo } from "../src/usage-format.js";

const NOW = Date.UTC(2026, 8, 10, 4, 0);
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

test("both languages define the same keys with the same placeholders", () => {
  // English may add `.one` singular variants that Chinese does not need.
  const base = (keys) => keys.filter((key) => !key.endsWith(".one")).sort();
  assert.deepEqual(base(Object.keys(MESSAGES.zh)), base(Object.keys(MESSAGES.en)));
  for (const key of Object.keys(MESSAGES.en).filter((key) => key.endsWith(".one"))) {
    assert.ok(key.slice(0, -4) in MESSAGES.en, `${key} has a plural base`);
  }
  for (const key of base(Object.keys(MESSAGES.en))) {
    // reset.date uses {month} in Chinese and {monthName} in English; both are always passed.
    if (key === "reset.date") continue;
    assert.deepEqual(placeholders(MESSAGES.zh[key]), placeholders(MESSAGES.en[key]), key);
  }
});

test("every key used in the UI exists in the dictionary", () => {
  const sources = ["App.jsx", "UsageStats.jsx", "SettingsView.jsx", "usage-format.js", "stats-format.js"]
    .map((file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"))
    .join("\n");
  const literal = [...sources.matchAll(/\bt(?:ranslate\(language,)?\(\s*"([a-zA-Z]+\.[a-zA-Z0-9]+)"/g)].map((match) => match[1]);
  assert.ok(literal.length > 40, "found the t() calls");
  for (const key of literal) assert.ok(key in MESSAGES.en, `missing key ${key}`);
  // Keys built from ids.
  for (const id of ["quota", "history", "settings"]) assert.ok(`tabs.${id}` in MESSAGES.en);
  for (const id of ["overview", "models", "quota"]) assert.ok(`stats.${id}` in MESSAGES.en);
  for (const id of ["all", "90d", "30d", "7d"]) assert.ok(`range.${id}` in MESSAGES.en);
  for (const code of ["qoderCliMissing", "claudeSignedOut", "claudeNoPlan", "claudeTemporary"]) assert.ok(`providerError.${code}` in MESSAGES.en, code);
  for (const code of ["network", "response", "checksumFile", "download", "checksum", "package", "tool", "permission", "unknown"]) {
    assert.ok(`updateError.${code}` in MESSAGES.en, code);
  }
});

test("follows a Chinese system language, English otherwise", () => {
  assert.equal(detectLanguage(["zh-Hans-CN", "en-US"]), "zh");
  assert.equal(detectLanguage(["zh-Hant-TW"]), "zh");
  assert.equal(detectLanguage(["en-US", "zh-Hans-CN"]), "en");
  assert.equal(detectLanguage(["ja-JP"]), "en");
  assert.equal(detectLanguage([]), "en");
  assert.equal(resolveLanguage("system", ["zh-CN"]), "zh");
  assert.equal(resolveLanguage("en", ["zh-CN"]), "en");
  assert.equal(resolveLanguage("zh", ["en-US"]), "zh");
  assert.equal(resolveLanguage(undefined, ["en-US"]), "en");
});

test("fills placeholders and falls back to English for unknown languages", () => {
  assert.equal(translate("en", "header.connected", { connected: 1, total: 2 }), "1/2 connected");
  assert.equal(translate("fr", "tabs.quota"), "Quota");
  assert.equal(translate("en", "no.such.key"), "no.such.key");
  assert.equal(translate("en", "update.upToDate", {}), "Version {version} is up to date");
  assert.equal(translate("en", "trend.caption", { count: 1 }), "Last check · current window remaining");
  assert.equal(translate("en", "trend.caption", { count: 3 }), "Last 3 checks · current window remaining");
  assert.equal(translate("zh", "trend.caption", { count: 1 }), "最近 1 次检查 · 当前窗口剩余");
});

test("formats quota text in English", () => {
  const inMinutes = (minutes) => ({ resetsAt: (NOW + minutes * 60_000) / 1000 });
  assert.equal(formatReset(inMinutes(-1), NOW, "en"), "Resets soon");
  assert.equal(formatReset(inMinutes(42), NOW, "en"), "Resets in 42 min");
  assert.equal(formatReset(inMinutes(125), NOW, "en"), "Resets in 2 h 05 min");
  assert.match(formatReset(inMinutes(3 * 24 * 60), NOW, "en"), /^Resets [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}$/);
  assert.equal(formatReset({ resetLabel: "Sep 15 at 4pm (Europe/Berlin)" }, NOW, "en"), "Resets Sep 15 at 4pm");
  assert.equal(timeAgo(NOW - 5 * 60_000, NOW, "en"), "Updated 5 min ago");
  assert.equal(formatAccount("team plan", "en"), "Team plan");
  assert.equal(formatAccount("Usage view fallback", "en"), "/usage fallback");
  assert.equal(limitLabel({ id: "weekly" }, "en"), "Weekly");
  assert.equal(limitLabel({ id: "weekly" }, "zh"), "每周");
  assert.equal(
    describeLow(
      [
        { id: "codex", connected: true, limits: [{ id: "window", remainingPercent: 0 }] },
        { id: "claude", connected: true, limits: [{ id: "window", remainingPercent: 12.4 }] },
      ],
      "en",
    ),
    "Codex has used up its current window; Claude Code has only 12% left",
  );
  assert.equal(compareToBook(30_000, "", "en"), "Your input and output are about as many tokens as The Little Prince.");
  assert.match(compareToBook(46_000_000, "seed", "en"), /^Your input and output are about \d+× the tokens in .+\.$/);
});

test("Windows wording overrides existing keys with the same placeholders", () => {
  for (const [language, table] of Object.entries(PLATFORM_MESSAGES.windows)) {
    for (const [key, text] of Object.entries(table)) {
      assert.ok(key in MESSAGES[language], `${language} ${key}`);
      assert.deepEqual(placeholders(text), placeholders(MESSAGES[language][key]), key);
      assert.ok(!/\bMac\b|菜单栏|系统设置/.test(text), `${language} ${key} still mentions the Mac`);
    }
  }
  assert.equal(translate("en", "settings.providerNotInstalled", {}, "windows"), "Not installed on this PC");
  assert.equal(translate("en", "settings.providerNotInstalled", {}, "mac"), "Not installed on this Mac");
  assert.equal(translate("zh", "login.off", {}, "windows"), "登录 Windows 后自动启动 TokenTide");
  // Every English string that names the Mac has a Windows version.
  for (const [key, text] of Object.entries(MESSAGES.en)) {
    if (/\bMac\b|menu bar|System Settings|Login Items/.test(text)) assert.ok(key in PLATFORM_MESSAGES.windows.en, key);
  }
  for (const [key, text] of Object.entries(MESSAGES.zh)) {
    if (/Mac|菜单栏|系统设置|登录项/.test(text)) assert.ok(key in PLATFORM_MESSAGES.windows.zh, key);
  }
});
