// The in-app "What's new" reads the changelog sections of the READMEs (README.md for English,
// README.zh-CN.md for Chinese), so release notes are written once. vite.config.mjs runs this at
// build time and bundles only the result (`virtual:changelog`).

export const CHANGELOG_HEADINGS = { en: "Changelog", zh: "更新日志" };

/** Compares dotted numeric versions (`0.10.0` > `0.9.2`). */
export function isNewerVersion(candidate, current) {
  const parts = (version) => String(version ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(candidate), parts(current)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return false;
}

/**
 * `[{ version, items }]`, newest first, from the `## <heading>` section: one entry per
 * `### x.y.z` heading with its `- ` bullets. Unreleased sections are left out.
 */
export function parseChangelog(markdown, heading) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return [];
  const releases = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    const version = line.match(/^###\s+v?(\d+\.\d+\.\d+)\s*$/);
    if (version) {
      current = { version: version[1], items: [] };
      releases.push(current);
    } else if (/^###\s/.test(line)) {
      current = null; // Unreleased / 未发布
    } else if (current && /^\s*-\s+/.test(line)) {
      current.items.push(line.replace(/^\s*-\s+/, "").trim());
    }
  }
  return releases.filter((release) => release.items.length);
}
