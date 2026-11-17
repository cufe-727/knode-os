# 18 — Estimates before a task starts: time, tokens, transfer, cost, and each plan's share

> **Record status (2026-11-17): Built.** This is a decision record, not the description of the system. What the code does now is in [ARCHITECTURE.md](../ARCHITECTURE.md) §7. Stale here: D7 "Claude Code's plan windows are not readable" (`src/estimate/claude-limits.ts` records them).

> Status: **implemented** (2026‑10‑28). `src/estimate/{estimate,processing,study,ledger,codex,quota,services,format}.ts`,
> `src/llm/usage.ts`; `GET /api/labeling/estimate`, `GET /api/research/studies/:id/estimate`, `GET /api/usage`;
> `knode-os estimate [processing | study <id>]`; the web UI's Start processing / Start research dialog, the Mac app's
> Processing panel and study sheet. No migration: the measured side lives in `.knode/usage.json` per workspace and
> `~/.knode-os/codex-limits.json` per machine.

## 0. What was missing

Starting the processing, or a research study, spends model calls on somebody's plan — on the Mac mini a ChatGPT Pro
login through Codex and a Cursor Ultra login — and until now nothing said how much. The finance workspace had 2,777
documents waiting (10,604 extraction segments) and 6,161 summary pages due (34,688 calls) on 2026‑10‑28; pressing Start
would have used about six weeks of the Codex plan's weekly window (+620%, 330–1,130%) and, on the way, downloaded about
45 GB — a one-shot `codex exec` then fetched ~1.5 MB of its own on every call (↓58 KB since 2026‑11‑06, D9). A person
should see that, and what a task
of theirs takes of Codex, Claude Code, Cursor or an API key, before they press Start.

## 1. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 Count the work, cost the calls | A task builder counts the work in calls of a kind (an extraction segment, a summary part, a judge call, an agent session) with the prompt knode itself sends; the routes that will take them come from the config and the workers the broker saw. Each call is then costed on its route | Counting is exact and cheap (the queue's segment counts, each chunk's token count from indexing); what a call costs is the uncertain part, and it belongs to the route |
| D2 Measure every call | The work broker records every answered lease in the workspace's call ledger: kind, route, lease-to-answer time, prompt and reply size, and the provider's own count. Codex runs with `--json` (its `turn.completed` usage), Claude Code's wrapper and Cursor's `result` event carry usage, an OpenAI-compatible answer has `usage` and its body sizes; a remote worker sends its count with the answer | A CLI wraps every prompt in ~15k tokens of its own (Codex 15,428 with 12,032 cached; Cursor 15,144 written to cache — 2026‑10‑28) and a reasoning model writes far more than its answer: neither shows in the text. After three measured calls a route's averages replace the defaults, and the estimate says which it rests on |
| D3 Ranges, and what they rest on | Every figure is `{ low, expected, high }`; the spread is narrow for measured figures and wide for defaults; the dialog's "How this was estimated" says, per route, measured or default | An estimate that hides how sure it is would be read as a promise |
| D4 Codex's windows as Codex reports them | `codex app-server` answers `account/rateLimits/read` (each window's used percent and reset, the plan, the credits past it) and `account/usage/read` (the account's tokens per day) without a model call. Plugins, apps and analytics off, as for a one-shot (16 MB → none); Codex's model catalog from a local copy (src/llm/codex-catalog.ts), since the app-server downloads all 650 KB of it as it starts (a read took ↓19 KB with the copy, 2026‑11‑06) | The plan's state is the account's, not a guess; reading it costs nothing. A read that fails (a dropped connection) falls back to the last good read, dated, kept per machine |
| D5 Calibrate a window on the account | Per life of a window (one `resets_at`), the first and last reading under 99% at least 18 h apart and 3 points apart: the percent it moved against the account's tokens between them (daily totals spread over the hours). Tokens are weighted as API prices weigh them — a cached input token ×0.1, an output token (reasoning included) ×8 — with this machine's session mix, so a task's own mix converts. Readings come from the sessions Codex keeps (`~/.codex/sessions`, every turn records the windows) and knode's own reads | One machine's sessions held a tenth of the account's tokens (59.5M of 635M on 2026‑10‑27); calibrating on them alone made every task 24× dearer. Over the four to five weekly lives of October the account's rate held within ±12% (0.51–0.66% of the weekly window per million weighted tokens). Past 100% a window stops moving and credits take over, so those readings say nothing |
| D6 A short window through the long one | A five-hour window's rate is the weekly one's scaled by how far each moved over the same stretch, from readings that carry both | Daily totals are too coarse for five hours |
| D7 Other plans by what they include | Cursor's tier comes from `cursor-agent about` (`subscriptionTier`, nothing else of the account); its share is the task's cost at API prices against what the plan includes per month (published, mid-2025: Pro $20, Pro+ $70, Ultra $400 — `usage.allowances.cursor.monthlyUsd` overrides). Claude Code reports a price per call; its plan windows are not readable, so a share needs `usage.allowances.claude` | Neither CLI reports its plan's use. A price is known only for models in the table (Anthropic's 2026‑10 list, OpenAI's 2025 list) or `usage.prices`; for others — gpt-6.x, Cursor's own models — the estimate says "no price known" instead of guessing |
| D8 Refusals are signals | A call turned away for a limit (`usage limit`, Cursor's `out of usage`) is counted per route with its message; the estimate shows the latest. Cursor's `out of usage` is now a transient failure, as Codex's limit was | On 2026‑10‑28 Cursor refused every non-Auto call on this machine; until now that cost each segment one of its three attempts |
| D9 Transfer from the wire | One-shot calls and agent sessions apart (`SERVICE_PROFILES`: `bytesUp`/`bytesDown`, `catalogBytes`, `session`). Per call: an endpoint's own bodies; for Codex ↓58 KB ↑37 KB beside the prompt (2026‑11‑06, plugins, apps and analytics off, the model catalog from knode's copy; ↓1.5 MB until then), and the catalog's 650 KB for the first call of a day on each slot (that call moved ↓706 KB). Per Codex research session (plugins, apps and analytics off since 2026‑11‑06, the copy pinned): ↓20 KB ↑10 KB to start and ↓34 KB a model request beside its output (one request ↓43 KB ↑41 KB, four ↓160 KB ↑111 KB), the requests counted from what Codex logged per run folder (50 a session until one has run). Each request re-sends its conversation; the range spans how much the wire compresses it (a four-request session sent 1.51 bytes a token). A remote worker's leases (messages and prompt) and answers on this machine's link, its model traffic on its own | "Data transfer" is mostly what a CLI adds around the text. With plugins, apps and analytics on, as research sessions ran until 2026‑11‑06, a one-word session downloaded 11–15 MB (the plugin catalog, still downloading when it ended: 29 MB in two minutes) and uploaded 0.7–1.3 MB of analytics |
| D10 Studies from studies | A study is a collector per page (`research.study.collectors` at once), a page job per page (`research.concurrency` at once), then the report. Times come from finished studies here (the collectors' own times, the page jobs', the report from the last page to the study's end); tokens and model requests from what Codex logged per run folder (`.runs/<job>`); Claude Code's prices from the jobs; captured sources' size from earlier studies' folders | An agent session's size cannot be read off its prompt. On the finance workspace a six-page study came out at ≈63 min (43–124) and ≈4% of the weekly window (2–8%) |
| D11 It never blocks Start | The web dialog and the Mac app show the estimate while it loads and Start stays available; an older server (404) shows "No estimate" | An estimate is advice; a person who knows what they want should not wait three seconds for it |

## 2. One call

`perCall` (src/estimate/estimate.ts), for a kind of work on a route:

- **input** = knode's prompt (estimated with `estimateTokens`) + what the route adds: learned as
  `(measured input − estimated prompt) / calls`, else the service's default (Codex 15.4k, 12k of it cached;
  Cursor 15.15k; Claude Code 15k assumed; an endpoint 0).
- **output** = measured average (reasoning included), else the larger of the kind's default (extraction 4,500 —
  the finance workspace's Codex answers average ~9.8k characters of JSON before reasoning — summaries 900–1,500,
  judge 400) and the route's visible replies.
- **time** = the 25th, mean and 90th percentile of answered calls, else start-up + output ÷ rate
  (Codex 8 s + 60 tokens/s), ×0.6–×2.
- **transfer** = measured bodies + headers, else prompt bytes + the service's start-up traffic, and the answer
  streamed at ~4 bytes a token. A Codex line adds the model catalog once per slot and started day (0 at the low end:
  a copy may be there already).

An agent session (src/estimate/study.ts `sessionTransfer`) is costed as its start-up, its model requests'
downloads, its conversation re-sent with every request, and the catalog for the first phase's sessions only: the
later ones find the copy those made.

Calls of a kind spread over the routes that take it by how many each finishes per second (slots ÷ seconds a call,
a remote slot's share of its time by `server.remote.shares`); work no slot takes is costed on its stage's route and
left out of the time, with a note. Wall time is the slowest kind; summaries of documents still to be extracted
finish one call after extraction.

## 3. A plan's share

`serviceShares` groups the lines by service. For Codex, each window the account reports gets the task's weighted
tokens × the calibrated rate (low and high from the spread of window lives and of the tokens), beside how far it is
used now and when it resets, and a note when the task would run past the limit (and then spend credits — the balance
only for an administrator). For Cursor and Claude Code, the task's cost at API prices against the plan's allowance
when one is known. For an endpoint, the cost.

## 4. Where it is kept

| What | Where | Lost |
| --- | --- | --- |
| Per kind × route: calls, failures, refusals, durations (last 200), prompt/reply estimates, measured tokens, cost, bytes | `<workspace>/.knode/usage.json`, written 5 s after a change and on stop | Averages only: estimates go back to their defaults and learn again |
| Codex window readings knode made, and the last good account read | `~/.knode-os/codex-limits.json` (`KNODE_CODEX_LIMITS_FILE`), 0600 | The calibration still has the session files |
| Copies of Codex's model catalog, per codex binary and model | `~/.knode-os/codex-catalog/` (`KNODE_CODEX_CATALOG_DIR`), renewed after `KNODE_CODEX_CATALOG_HOURS` (24) | The next Codex call downloads the catalog again, and the copy is made anew |
| Codex session scan | memory, per file by size and time | Rebuilt on the next estimate (~0.4 s for a month, 160 MB) |

## 5. Surfaces

- `GET /api/labeling/estimate` (group `ingest`, like the status) — what Start processing would take now.
- `GET /api/research/studies/:id/estimate` (group `knowledge`) — a draft's.
- `GET /api/usage` (group `settings`) — the machine's Codex account and calibration, Cursor's tier, the ledger.
- `knode-os estimate [processing | study <id>] [--json]` — from the CLI the remote workers are unknown (only a
  running `serve` sees them), so it counts this machine's slots.
- The web UI asks before Start processing and Start research; the Mac app shows the estimate in the Processing panel
  and in a sheet before a study starts.

## 6. Configuration

All optional, file-only (`knode.config.json`):

```jsonc
"usage": {
  "prices": { "gpt-6*": { "input": 2.0, "cachedInput": 0.2, "output": 16 } },  // US$ per million tokens
  "allowances": { "cursor": { "monthlyUsd": 400 }, "claude": { "fiveHourUsd": 40, "weeklyUsd": 400 } },
  "codexLimits": true                                                          // false: never ask codex app-server
}
```

## 7. A new kind of work

A kind (translation, say — the Translate stage of the content-languages work) needs a builder that counts its calls
and the prompt each sends, and the routes that take it; costing, measuring (any leased kind goes through the broker,
which records it), time, transfer, cost and shares come with it. A translation call's output is about its input,
scaled by the target language's token density — a better default than extraction's 4,500 — until its route has run.

## 8. What it does not know

- A plan's meter is not published. The weights (×0.1 cached, ×8 output) are API prices' and may not be the meter's;
  the calibration absorbs a constant error, not a different mix's.
- The account's tokens include other machines and cloud tasks; a window life where those were unusual skews the rate.
  Several lives are combined, and the spread shown.
- Cursor's and Claude Code's per-call traffic is not measured; their transfer is a floor.
- Judge calls depend on the duplicates extraction finds; they are counted only once a run here has shown how many an
  extraction call leads to.
