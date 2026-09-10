# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Current product direction

- The product is named TokenTide. Earlier names (Usage Monitor, Tandem, TokenBar) are retired; TokenBar in particular is already used by many public projects. The logo is a "T" (for Token) monogram built from two quota bars (blue top bar = Codex, orange stem = Claude Code) on a dark rounded square. Avoid concentric rings — they read as Apple's Activity rings; keep the icon, favicon, and menu-bar glyph consistent with `branding/tokentide-icon.svg`. The bundle identifier stays `local.usage-monitor` so WebKit local storage survives.
- The product is a menu-bar widget: a borderless dark dropdown panel (360px wide) under the status item, modeled on compact macOS menu-bar utility panels such as Tencent Lemon. Do not bring back a standalone window or full-page layout.
- The 历史 tab starts with usage records modeled on Claude Code's `/stats` (provider switch, 概览 / 模型 / 使用率, 全部 / 90 天 / 30 天 / 7 天, eight stat cards, a 26-week heatmap, a book comparison), followed by the quota trend. 使用率 shows weekly quota utilization: one bar per weekly window (peak usage before reset), average / peak / full weeks / this week. Codex weeks come from rollout `rate_limits`; Claude Code weeks come from TokenTide's own log (`server/quota-weeks.mjs`); weeks before it are estimated from local transcript usage weighted by API prices and calibrated on recorded weeks, drawn as hollow bars with "≈" figures. Never present estimates as recorded values.
- Panel anatomy: tabs (额度 / 历史) with an orange underline, compact provider blocks (icon, name, connection line, large remaining %, thin progress bar, per-window rows), an inline dismissible banner for low quota or errors, two toggle cards, and a darker footer bar. UI copy is Chinese.
- The status item shows a two-line readout of each provider's current-window remaining percentage (`CX` / `CC`).
- Keep the product focused on the remaining local quota for Codex and Claude Code. Do not add agent workflows, logs, CPU/memory telemetry, or a navigation sidebar.
- Quota values must come from the locally signed-in tools. Show an unavailable state instead of invented fallback numbers.
- Never return or log tokens, credentials, or unmasked account identifiers from the local usage bridge.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
