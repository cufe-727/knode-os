# Remote workers and the remote API

`knode-os serve` runs tier-1 extraction ("labeling"), summary pages and the duplicate reviews' judge calls as
**leased work** ([design 12](design/12-remote-processing.md)). Per workspace, a scheduler
(`src/labeling/scheduler.ts`) takes documents off the extraction queue, cuts them into segments and hands segments
out one at a time; a summary source (`src/work/summarize.ts`) hands out the documents due a summary page; and a
judge source (`src/work/judge.ts`) hands out the calls a review is waiting on. A work broker (`src/work/broker.ts`)
puts all three behind one lease protocol. Whoever holds a lease runs the call on its own model and hands back the
raw reply. That can be one of `serve`'s own worker slots or a worker on another machine. The server checks every
reply and keeps it in the document's sidecar. It writes a document to the graph once its last segment is in,
and a summary page as soon as its summary is in.

The same port also serves a **remote API** under `/remote/v1`, authenticated by per-machine tokens. It covers
leased work, reading and writing documents, search, the graph and claims, and read-only SQL over the catalog views.

```
             ┌──────────────────── Mac mini: knode-os serve (127.0.0.1:12000) ─────────────────────┐
             │  extraction queue → scheduler ─┐                                                     │
             │  due summaries → summary source ┴─ broker ──lease──▶ local slots (codex × 2, summarize × 2) │
             │                                     ▲                                                 │
             │   /remote/v1 (tokens) ──────────────┘◀── lease / complete / renew / release          │
             └──────────▲─────────────────────────────────▲─────────────────────────────────────────┘
                        │ SSH tunnel (Cloudflare Access)    │ HTTPS (Cloudflare Tunnel, tokens)
                  laptop worker                       Linux worker (API keys)
```

## Failures and backoff

A reply is only as good as its content. Failures fall into three kinds (`src/labeling/failures.ts`):

| kind | examples | the segment or summary | the backend |
|---|---|---|---|
| model | unparseable or empty reply, refusal | uses one of its 3 attempts | rests 30 min after 5 in a row (doubling, ≤ 4 h) |
| transient | rate or usage limit, 429/5xx, network, timeout, `spawn EBADF` | keeps its attempts, goes back in line | pauses 1 min, doubling to 10 min |
| fatal | CLI missing, not logged in, 401/403 | goes back in line | parks 30 min (doubling, ≤ 6 h), then tries again |

Five transient or fatal failures (or lapsed leases) in a row on one segment or one summary count as one attempt,
so work that no model can finish cannot circle forever. A summary's attempts count against the document's current
content; a changed document starts over.

A lease lasts `server.remote.leaseMinutes` (default 15) and is renewed while a call runs. When a worker
disappears, its segment or summary goes back in line once the lease lapses. A document's first segment goes out
alone (it names the subject). The rest then go out in parallel, possibly to different workers. If a document
changed while its segments were out, it is not written over its new text: the new text goes back in the
queue, and unchanged segments are reused from the sidecar. A summary of a document that changed while it was out
is dropped; the new text gets a summary of its own after its extraction.

A summary is due once a document's extraction is done (documents still in the extraction queue wait), the ones
extracted most lately first. The reply goes to the summary cache in the document's sidecar, and the page is written
from that cache, in turn with the reviews below and without a model call of the server's own. A page that could
not be written is written from the cache later, so nothing a worker sent is lost to a restart.

The duplicate-entity and duplicate-claim audits run over what was written every `extraction.intervalMinutes`. Each
builds all its judge calls first and offers them at once, so `serve`'s judge slots (and remote workers, where offered)
answer them side by side. A call waits at most `server.remote.callDeadlineMinutes` (default 20); one nobody answered
fails, and its pair simply goes unjudged this round. A reply that is no JSON object goes out again, up to three times.
Every verdict records the model that gave it. A remote verdict merges or rejects nothing by itself unless
`server.remote.judgeModels` names its model: it is filed as a suggestion with the verdict attached, for a person to
decide. The nightly pass and `knode-os extract` call the Judge route themselves.

## Local worker slots

`extraction.workers` lists the extraction slots `serve` itself runs. Each entry names a route target (a connection
id, or an agent from `playbooks/agents/`) and how many calls run at once. Summaries run on the Summarize stage's
own route, `summaryConcurrency` at a time:

```jsonc
"extraction": {
  "workers": [
    { "use": "connection-3", "slots": 2, "effort": "medium" },   // the Codex agent
    { "use": "cursor-cli-1", "slots": 2 }                         // the Cursor agent
  ],
  "summaryConcurrency": 2
}
```

Without `workers`, the Extract stage's own route runs with `extraction.concurrency` slots. Workers listed with
`"slots": 0` turn this machine's extraction slots off, and `"summaryConcurrency": 0` its summary slots: it then
only hands that work to remote workers. Judge calls run on the Judge stage's route, `review.concurrency` at a time
(default 2); 0 leaves them to remote workers. Saving settings
(`PUT /api/config`) takes effect within a minute. No restart is needed. Codex runs as
`codex exec --ignore-user-config --ephemeral` for every pipeline call, so your `~/.codex/config.toml` (MCP
servers, memory, default model) stays out of extraction prompts. It also keeps tens of thousands of
sessions out of `~/.codex/sessions`.

`GET /api/labeling/status` (UI headers) shows whether processing runs, the extraction queue, the summaries due,
leases, every worker seen and the local slots' health.

**Starting and stopping.** The local slots and the duplicate reviews spend model calls, so `serve` never starts
them on its own, not at startup and not after a restart. An administrator
starts them from the app (the *Processing* button in the toolbar), from the web UI (the button in the header) or with
`POST /api/labeling/start`. They then run until stopped (`POST /api/labeling/stop`) or until the service stops.
Stopping lets calls in flight finish; a review gives up the judge calls nobody has taken yet and goes on with the
verdicts it has. Importing, watching and embedding go on either way. Remote workers can still
lease segments and summaries while processing is stopped, because they are started by hand on their own machines.
The summary pages they write are written either way; what they extract is reviewed once processing is started.

## What remote workers may take

| setting | default | meaning |
|---|---|---|
| `server.remote.offer.summarize` | `true` | remote workers may take summaries here (extraction is always offered) |
| `server.remote.offer.judge` | `false` | remote workers may take the judge calls a review is waiting on |
| `server.remote.shares` | `{ "extract": 3, "summarize": 1 }` | a slot that takes both kinds gets them by these weights; judge calls go before either |
| `server.remote.judgeModels` | `[]` | remote models whose verdicts may merge or reject without a person: `"codex:gpt-6.1-sol"`, or a prefix like `"codex:*"` |
| `server.remote.callDeadlineMinutes` | `20` | longest a review waits for one judge call |

The share keeps summaries moving while an import's extraction backlog is out, and extraction moving while summaries
pile up. A kind that had nothing to give banks no credit for it: when it has work again, it takes its share from
there, not everything until it has caught up.

## Tokens

```bash
knode-os remote token create --name macbook --scope label --workspace admin/finance
knode-os remote token create --name old-mac --scope label --kinds extract --workspace admin/finance
knode-os remote token create --name analytics --scope read,sql --workspace admin/finance
knode-os remote token list
knode-os remote token revoke macbook
```

| scope | allows |
|---|---|
| `label` | lease extraction segments, summaries and judge calls and hand back replies; `--kinds` narrows it to some of them |
| `read` | list/read documents under raw/docs, raw/skills, wiki and playbook content; search; graph; claims |
| `write` | write or delete documents under raw/docs, wiki and playbooks/packs (never a linked folder's mirror); trigger a sync |
| `sql` | read-only SQL over the `v_*` catalog views |

A token's workspaces can be `<user>/<workspace-id>`, `team/<name>` or `*`. Tokens live hashed in
`<data root>/.knode/remote-tokens.json` (0600). Only the secret's SHA-256 is stored, and a token is shown
once. The running service picks up created and revoked tokens immediately. Every authenticated request is
logged to `<data root>/.knode/remote-audit.jsonl`. Ten failed authentications from one client within
10 minutes lock that client out for 15 minutes.

## Reaching the service

**Over SSH.** Forward the port through the existing Cloudflare Access SSH endpoint and talk to loopback:

```bash
ssh -o ProxyCommand="cloudflared access ssh --hostname %h" -N -L 12000:127.0.0.1:12000 ning@ssh.lemoncheese.cc
node worker/knode-worker.mjs --server http://127.0.0.1:12000 --workspace admin/finance --backends codex:2
```

An SSH-forwarded request is local to the Mac mini. The remote API still requires a token.

**Over public HTTPS.** In Cloudflare Zero Trust, add a public hostname to the Mac mini's tunnel:
`knode-os.lemoncheese.cc` → `http://localhost:12000`. Following the service registry's rule for public
application domains, do not put Cloudflare Access in front of it: the server authenticates every request
itself — per-machine tokens here, accounts for the web UI, the app and `/api`
([remote-access.md](remote-access.md)). Turn on *Always Use HTTPS*. A request counts as coming from another
machine when it names a non-loopback host, carries a proxy's headers (`cf-*`, `x-forwarded-*`) or arrives on a
non-loopback connection (src/server/public-guard.ts); such a request must arrive over HTTPS, and `/mcp` does not
answer it.

## Running a worker

`worker/knode-worker.mjs` is one dependency-free file for Node 20+. Copy it to any machine, or download it with the token itself:

```bash
curl -fsS -H "Authorization: Bearer $KNODE_TOKEN" https://knode-os.lemoncheese.cc/remote/v1/worker.mjs -o knode-worker.mjs
```

Then run it:

```bash
# a Mac with Codex and Cursor logged in: kinds, models and efforts come from the server
KNODE_TOKEN=knr_… node knode-worker.mjs --server https://knode-os.lemoncheese.cc --workspace admin/finance \
  --backends codex:2,cursor:2

# a Linux server with an OpenAI-compatible endpoint, summaries only
KNODE_TOKEN=knr_… OPENAI_API_KEY=… node knode-worker.mjs --server https://knode-os.lemoncheese.cc \
  --workspace admin/finance --backends api:4 --api-base-url https://api.example.com/v1 --api-model some-model \
  --kinds summarize

node knode-worker.mjs … --check     # what the token may do, what the server offers, the queues, which CLIs are installed
```

At start, and whenever a lease answer says it changed, the worker reads `GET …/work/config`: the kinds this token
may take here, how long a lease lasts, the shares, and **hints** — how the server itself runs each kind on codex,
claude and cursor (the model, and the effort and speed in that CLI's terms), taken from `extraction.workers` and the
Extract stage's route for extraction, from the Summarize stage's route for summaries, and from the Judge stage's
route for judge calls. A CLI backend follows the
hints unless it was given a model of its own (`--codex-model`, `--claude-model`, `--cursor-model`; `--codex-effort`,
`--codex-speed` and `--claude-effort` override single fields). An `api` backend ignores them: model names differ
between endpoints. Without `--kinds`, the worker takes every kind the server offers it. Against a server from
before `work/*`, it takes extraction over `labeling/*`.

The worker renews its leases while calls run. It backs off per backend under the rules above. On Ctrl-C or
SIGTERM it kills its calls and hands its leases back. It refuses to send a token over plain HTTP to anything
but loopback. Run it under launchd or systemd for a permanent worker.

The models a worker uses count against that machine's own accounts. A worker on a machine that shares an
account with another job (rookie-trade's review runner uses Codex and Cursor too) shares that account's limits.

## API

All paths are under `/remote/v1`, and every route except `/health` needs `Authorization: Bearer knr_…`.
Workspace routes are `/w/<owner>/<workspace>/…`, where `<owner>` is a username or `team`.

| method & path | scope | body / query → answer |
|---|---|---|
| `GET /health` | — | `{ ok }` |
| `GET /whoami` | any | the token's name, scopes, workspaces, kinds |
| `GET /worker.mjs` | any | the worker script |
| `GET …/work/config` | label | `{ version, leaseSeconds: { llm }, kinds: { extract, summarize, judge }, shares, hints: { <kind>: { codex?, claude?, cursor? } } }` |
| `POST …/work/lease` | label | `{ worker, backend, kinds?, max }` → `{ configVersion, leaseSeconds, tasks: [{ id, kind, label, messages, prompt, json, maxTokens, leaseExpiresAt, document? }] }` |
| `POST …/work/complete` | label | `{ worker, backend, id, ok, text \| error, kind?, model? }` → `{ accepted, documentWritten? }` (409 when the lease moved on) |
| `POST …/work/renew` | label | `{ worker, backend, ids }` → `{ renewed, lost }` |
| `POST …/work/release` | label | `{ worker, backend, ids }` → `{ released }` |
| `GET …/work/status` | label / read | per kind (queue, due or waiting; leases; totals), shares, workers |
| `POST …/labeling/lease` | label (extract) | the same as `work/lease` with `kinds: ["extract"]`, answered `{ leaseSeconds, tasks }` |
| `POST …/labeling/complete`, `…/renew`, `…/release` | label | the same as `work/*` |
| `GET …/labeling/status` | label / read | extraction's queue, leases, workers, totals |
| `GET …/documents?prefix=&limit=&offset=` | read | document rows |
| `GET …/document?path=` | read | `{ path, content, bytes, truncated, derived }` |
| `PUT …/document?path=` | write | `{ content }` → written and synced |
| `DELETE …/document?path=` | write | removed and disposed |
| `POST …/sync` | write | `{ only? }` → sync counts |
| `GET …/search?q=&mode=&k=` | read | hybrid / vector / keyword / sag results |
| `GET …/graph?q=&depth=`, `…/claims?subject=&text=`, `…/entities?q=` | read | graph, claims, entities |
| `GET …/sql/views`, `POST …/sql { sql, maxRows }` | sql | catalog views; read-only rows |

A task's `json` says whether the answer must be a JSON object (extraction) or Markdown (a summary); `prompt` is
`messages` flattened for a one-shot CLI, with the JSON directive only when `json` is set. A segment also carries
`document: { path, title, part, parts }`, as `labeling/*` always has.

## Why SQL goes through the API

Postgres on the Mac mini trusts every loopback connection for every role. A forwarded port would let any
holder log in as the superuser, so Postgres is never exposed. Remote SQL runs inside `serve` instead, on the
same path as `knode_query` (`src/store/catalog.ts`), behind four layers:
- the catalog guard: one `SELECT`/`WITH`, and every relation it names a `v_*` view or a CTE in scope;
- a `READ ONLY` transaction that is always rolled back, so a changed setting cannot outlive the query;
- a statement timeout;
- `SET LOCAL ROLE knode_reader_<hash>`, the workspace's own `NOLOGIN` role, which may only `SELECT` that
  schema's catalog views. It is created on first use. One role per schema matters because the guard cannot
  see inside a function call such as `query_to_xml`: a role shared by every workspace would read them all.

Writes go through the API's file routes and a sync, like any other edit. The files stay the record, lineage
names the token, and a rebuild loses nothing.
