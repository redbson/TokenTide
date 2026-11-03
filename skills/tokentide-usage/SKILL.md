---
name: tokentide-usage
description: Read how much Codex, Claude Code, and Qoder quota is left, and DeepSeek Harness token use, estimated cost, and API balance, from TokenTide's local API (http://127.0.0.1:46173/v1/usage). Use it whenever remaining quota matters to the work — before starting a long or token-heavy task, when choosing which coding agent or model to hand work to, when a run might hit a rate limit, when the user asks how much quota/额度/用量/余额 is left or when it resets — and when building anything that reads that usage (a script, status bar item, router, dashboard, or CI check). Use it even if the user never says "TokenTide".
---

# TokenTide usage API

TokenTide is a menu-bar (macOS) / tray (Windows) app that reads the user's remaining quota from the locally signed-in coding tools and serves it as JSON on this computer. Asking it is free: it costs no tokens and no quota, and it never starts the tools more than about once a minute however often you call it.

## Quick check

```bash
node <skill-dir>/scripts/tokentide-usage.mjs            # one line per tool
node <skill-dir>/scripts/tokentide-usage.mjs --tool claude
node <skill-dir>/scripts/tokentide-usage.mjs --min 15   # exit 3 if a tool is under 15% left
node <skill-dir>/scripts/tokentide-usage.mjs --json     # the full JSON
```

Without Node: `curl -s http://127.0.0.1:46173/v1/usage` (all tools) or `/v1/usage/{codex|claude|qoder|deepseek}`.

The script's exit codes tell you what happened, so you can branch on them: `0` ok, `1` TokenTide is not running, `2` its local API is turned off, `3` a tool is under `--min`, `4` anything else.

## Reading the answer

Each tool has:

- `status`: `ok`; `stale` (a refresh failed, so this is the last good reading, from `readAt`); `unavailable` (`error` says why).
- `remainingPercent`: the number the user sees in TokenTide. `headline` says which limit it is: `window` (the current short window, e.g. Codex's 5 hours), `weekly` (plans with no 5-hour window, on Claude Code or Codex), or `total` (Qoder credits). It is `null` for DeepSeek, which has no quota.
- `limits`: every limit with `remainingPercent`, `usedPercent`, and `resetsAt` (ISO time). A tool can have plenty in its window and little in its weekly limit; the lower one is what will stop it.
- DeepSeek only: `usage.today|week|month` with `tokens`, `messages`, and `estimatedCost` (CNY at DeepSeek's published prices, an estimate, not the bill), and `balance` (`total`, `currency`, `available`) once the user has saved an API key in TokenTide.

Field-by-field details and an example are in `references/schema.md`; read it when you are writing code against the API.

## Using it to decide

- **Before a big task**, check the tool you are running on. If its tightest limit is low (say under 15%) or will not reset before the work is likely to finish, tell the user before you start, with the number and the reset time, rather than finding out halfway through.
- **When choosing an agent** to delegate to, prefer one with `status: "ok"` and room in every limit. For example, Codex at 100% window / 69% weekly beats Claude Code at 8% weekly for a long refactor.
- **When reporting**, give the percentage left and when it resets in the user's time zone ("Claude Code: 22% left this week, resets Mon 16:00"). Say which limit it is, because "22% left" for a week and for 5 hours mean very different things.
- **DeepSeek** is pay-as-you-go: talk about tokens, estimated cost, and balance, not percentages. Call the cost an estimate.

## When it doesn't answer

| What you see | What it means | What to do |
|---|---|---|
| Connection refused (exit 1) | TokenTide is not running | Tell the user. Don't guess the quota. |
| `403 {"error":"disabled"}` (exit 2) | The user turned the local API off | They can turn it on in TokenTide → Settings → More settings → Local API. |
| `status: "stale"` | The last refresh failed | Use the numbers, say how old they are (`readAt`). |
| `error: "claudeSignedOut"` | Claude Code is signed out | The user runs `claude auth login`. |
| `error: "claudeNoPlan"` | Claude Code uses an API key, so there is no plan quota | Nothing to read; say so. |
| `error: "claudeTemporary"` / `"unavailable"` | The tool couldn't be read just now | Try again in a minute or two. |
| `error: "qoderCliMissing"` | Qoder CLI isn't installed | Optional; the user installs `qodercli`. |
| A tool is missing from `tools` | It isn't installed on this computer | Don't treat it as 0%. |

Never invent a number when the API can't tell you. Say it is unknown.

## Writing code against it

- Read `/v1/usage` and check `schema === "tokentide.usage.v1"`. New fields may appear; existing ones keep their meaning under this schema name.
- To follow usage over time, subscribe to `GET /v1/events` (Server-Sent Events) instead of polling: it sends the current reading at once, then a `usage` event with the same JSON after every new reading, `: ping` comments every 25 s, and a `disabled` event before closing if the user turns the API off. Reconnect after a drop (the stream asks for 10 s).
- If you do poll, once a minute at most. The data only changes when TokenTide refreshes (every minute while its panel is open, every 1–10 minutes otherwise, as the user set it), so faster polling just returns the same reading. `?maxAge=<seconds>` asks for a fresher reading, but never fresher than a minute.
- It answers only on `127.0.0.1`, and it refuses requests that carry a browser `Origin` header, so call it from a script, a native app, or a server process, not from a web page's JavaScript.
- It's read-only. Don't try to drive the coding tools' own CLIs to read quota yourself; that is exactly the work TokenTide already does without spending tokens.

```js
// Node 18+ / Deno / Bun
const usage = await fetch("http://127.0.0.1:46173/v1/usage").then((r) => r.json());
const claude = usage.tools.find((t) => t.id === "claude");
const tightest = Math.min(...claude.limits.map((l) => l.remainingPercent));
```

```js
// Pushed updates (Node 18+): one JSON reading per `usage` event.
const res = await fetch("http://127.0.0.1:46173/v1/events");
let buffer = "";
for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
  buffer += chunk;
  for (let end; (end = buffer.indexOf("\n\n")) >= 0; buffer = buffer.slice(end + 2)) {
    const block = buffer.slice(0, end);
    if (!block.includes("event: usage")) continue;
    const usage = JSON.parse(block.split("\n").find((line) => line.startsWith("data: ")).slice(6));
    // react to usage.tools …
  }
}
```

```python
import json, urllib.request
usage = json.load(urllib.request.urlopen("http://127.0.0.1:46173/v1/usage", timeout=30))
left = {t["id"]: t["remainingPercent"] for t in usage["tools"] if t["status"] != "unavailable"}
```
