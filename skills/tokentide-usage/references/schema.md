# `tokentide.usage.v1`

`GET http://127.0.0.1:46173/v1/usage` → every installed tool. `GET /v1/usage/<id>` → `{ schema, updatedAt, tool }` for one tool (404 `{"error":"unknownTool"}` if it isn't installed). `GET /v1` lists the endpoints.

## Top level

| Field | Type | Meaning |
|---|---|---|
| `schema` | string | `"tokentide.usage.v1"` |
| `updatedAt` | ISO time | When TokenTide last read the tools |
| `tools` | array | One entry per installed tool, in the order codex, claude, qoder, deepseek |

## A tool

| Field | Type | Meaning |
|---|---|---|
| `id` | `codex` \| `claude` \| `qoder` \| `deepseek` | |
| `name` | string | Display name |
| `status` | `ok` \| `stale` \| `unavailable` | `stale`: last good reading after a failed refresh |
| `plan` | string \| null | e.g. `team`, `max`, `teams` |
| `remainingPercent` | number \| null | The headline percentage left; null for DeepSeek and when unavailable |
| `headline` | `window` \| `weekly` \| `total` \| null | Which limit `remainingPercent` is |
| `limits` | array | Every limit (empty when unavailable) |
| `readAt` | ISO time | When this tool's numbers were read (older than `updatedAt` when stale) |
| `error` | string \| null | Code only: `stale`, `unavailable`, `claudeSignedOut`, `claudeNoPlan`, `claudeTemporary`, `qoderCliMissing` |

## A limit

| Field | Type | Meaning |
|---|---|---|
| `id` | `window` \| `weekly` \| `total` \| `plan` \| `addon` \| `org` | `window` = current short window (5 h), `weekly` = 7 days, Qoder: `total` (own credits), `plan`, `addon`, `org` (team package, not counted in `total`) |
| `usedPercent`, `remainingPercent` | number | 0–100 |
| `resetsAt` | ISO time \| null | |
| `remainingAmount`, `totalAmount`, `unit` | number, number, string | Credit pools only (Qoder), e.g. `2118`, `3000`, `"credits"` |

## API account extras (`openai-api`, `anthropic-api`, `azure-openai`)

```json
"spend": {
  "currency": "USD", "today": 0.75, "week": 4.5, "month": 4.5, "calendarMonth": 4.5,
  "limit": { "amount": 50, "currency": "USD", "enforced": true },
  "readAt": "2026-11-03T15:00:00.000Z", "delayed": false
}
```

`today`, `week` (last 7 days), and `month` (last 30 days) are by UTC day; `calendarMonth` is this UTC calendar month. `limit` is OpenAI's monthly spend limit (null elsewhere); with one, `remainingPercent` / `headline: "monthly"` give what is left of it. `delayed: true` for Azure, whose cost data lags by hours. Error codes: `accountKeyInvalid`, `accountUnreachable`, `accountUnavailable`, `azureNoAccess`, `azureNoSubscription`, `azureThrottled`.

## DeepSeek extras

```json
"usage": {
  "currency": "CNY",
  "today": { "tokens": 6100000, "messages": 114, "estimatedCost": 0.55 },
  "week":  { "tokens": 6100000, "messages": 114, "estimatedCost": 0.55 },
  "month": { "tokens": 7300000, "messages": 156, "estimatedCost": 0.70 }
},
"balance": {
  "currency": "CNY", "total": 28.92, "available": true,
  "readAt": "2026-11-03T11:21:07.410Z", "error": null,
  "spent": { "today": 0, "week": 5.87, "month": 5.87 }
}
```

`usage` covers DeepSeek Harness sessions on this computer; `estimatedCost` uses DeepSeek's published prices (peak and off-peak). `balance` appears only after the user saved a DeepSeek API key in TokenTide; `spent` is worked out from balance drops TokenTide has seen and covers the whole account. Balance `error` codes: `deepseekKeyInvalid`, `deepseekBalanceUnavailable`.

## Example

```json
{
  "schema": "tokentide.usage.v1",
  "updatedAt": "2026-11-03T11:21:07.410Z",
  "tools": [
    {
      "id": "codex", "name": "Codex", "status": "ok", "plan": "team",
      "remainingPercent": 100, "headline": "window",
      "limits": [
        { "id": "window", "usedPercent": 0, "remainingPercent": 100, "resetsAt": "2026-11-03T16:21:02.000Z" },
        { "id": "weekly", "usedPercent": 31, "remainingPercent": 69, "resetsAt": "2026-11-09T12:28:41.000Z" }
      ],
      "readAt": "2026-11-03T11:21:07.410Z", "error": null
    },
    {
      "id": "claude", "name": "Claude Code", "status": "ok", "plan": "max",
      "remainingPercent": 94, "headline": "weekly",
      "limits": [{ "id": "weekly", "usedPercent": 6, "remainingPercent": 94, "resetsAt": "2026-11-10T08:00:00.000Z" }],
      "readAt": "2026-11-03T11:21:07.410Z", "error": null
    }
  ]
}
```

## Events (`GET /v1/events`)

Server-Sent Events (`text/event-stream`):

| Event | Data | When |
|---|---|---|
| `usage` | the same object as `GET /v1/usage`; the event `id` is the reading time in ms | at once on connecting, then after every new reading |
| `disabled` | `{"reason":"disabled"}` | the user turned the local API off; the stream then closes |
| `closing` | `{"reason":"closing"}` | TokenTide is quitting |
| `: ping` (comment) | — | every 25 s |

`retry: 10000` asks clients to reconnect after 10 s. 403 `{"error":"disabled"}` if the API is off, 503 `{"error":"tooManyStreams"}` past 32 streams.

## Errors

| HTTP | Body | Meaning |
|---|---|---|
| 403 | `{"error":"disabled"}` | Local API turned off in TokenTide → Settings → More settings → Local API |
| 403 | empty | The request carried a browser `Origin` (web pages are refused) |
| 404 | `{"error":"unknownTool"}` | No such installed tool |
| 405 | empty | Only `GET` is accepted |
| — | connection refused | TokenTide isn't running |
