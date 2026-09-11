import assert from "node:assert/strict";
import test from "node:test";

import {
  describeLow,
  findNewlyLow,
  formatAccount,
  formatReset,
  isShownProvider,
  makeSnapshot,
  timeAgo,
} from "../src/usage-format.js";

const NOW = Date.UTC(2026, 8, 10, 4, 0);
const provider = (id, remainingPercent, connected = true) => ({
  id,
  connected,
  limits: [{ id: "window", remainingPercent }],
});

test("formats reset times relative to now", () => {
  const inMinutes = (minutes) => ({ resetsAt: (NOW + minutes * 60_000) / 1000 });
  assert.equal(formatReset(inMinutes(-1), NOW, "zh"), "即将重置");
  assert.equal(formatReset(inMinutes(42), NOW, "zh"), "42 分钟后重置");
  assert.equal(formatReset(inMinutes(125), NOW, "zh"), "2 小时 05 分后重置");
  assert.match(formatReset(inMinutes(3 * 24 * 60), NOW, "zh"), /^\d+月\d+日 \d{2}:\d{2} 重置$/);
  assert.equal(formatReset({ resetLabel: "Sep 15 at 4pm (Europe/Berlin)" }, NOW, "zh"), "Sep 15 at 4pm 重置");
  assert.equal(formatReset({}, NOW, "zh"), "重置时间未知");
});

test("formats last-updated time", () => {
  assert.equal(timeAgo(null, NOW, "zh"), "尚未更新");
  assert.equal(timeAgo(NOW - 5_000, NOW, "zh"), "刚刚更新");
  assert.equal(timeAgo(NOW - 30_000, NOW, "zh"), "30 秒前更新");
  assert.equal(timeAgo(NOW - 5 * 60_000, NOW, "zh"), "5 分钟前更新");
  assert.equal(timeAgo(NOW - 2 * 3_600_000, NOW, "zh"), "2 小时前更新");
});

test("alerts only when a provider newly drops below the threshold", () => {
  const first = [provider("codex", 10), provider("claude", 80)];
  assert.deepEqual(findNewlyLow(null, first).map((item) => item.id), ["codex"]);

  const stillLow = [provider("codex", 5), provider("claude", 80)];
  assert.deepEqual(findNewlyLow(first, stillLow), []);

  const claudeDrops = [provider("codex", 5), provider("claude", 12)];
  assert.deepEqual(findNewlyLow(stillLow, claudeDrops).map((item) => item.id), ["claude"]);

  // Disconnected or unknown values never count as low.
  assert.deepEqual(findNewlyLow(null, [provider("codex", 5, false), provider("claude", null)]), []);
});

test("describes low providers", () => {
  assert.equal(
    describeLow([provider("codex", 0), provider("claude", 12.4)], "zh"),
    "Codex 当前窗口额度已用尽，Claude Code 仅剩 12%",
  );
});

test("localizes account labels", () => {
  assert.equal(formatAccount("team plan", "zh"), "Team 套餐");
  assert.equal(formatAccount("pro lite plan", "zh"), "Pro Lite 套餐");
  assert.equal(formatAccount("max plan", "zh"), "Max 套餐");
  assert.equal(formatAccount("Usage view fallback", "zh"), "/usage 备用读取");
  assert.equal(formatAccount("Local account", "zh"), "本机账户");
  assert.equal(formatAccount(null, "zh"), null);
});

test("snapshots record only connected primary values", () => {
  assert.deepEqual(
    makeSnapshot({ updatedAt: NOW, providers: [provider("codex", 41), provider("claude", 70, false)] }),
    { at: NOW, codex: 41, claude: null, qoder: null },
  );
});

test("tools turned off in Settings or not installed are not shown", () => {
  assert.equal(isShownProvider(provider("codex", 50)), true);
  assert.equal(isShownProvider(provider("codex", 50), ["codex"]), false);
  assert.equal(isShownProvider(provider("claude", 50), ["codex"]), true);
  assert.equal(isShownProvider({ id: "qoder", installed: false, limits: [] }), false);
});
