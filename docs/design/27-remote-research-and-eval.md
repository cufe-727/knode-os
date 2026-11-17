# 27 — Research sessions on remote workers, and evaluation runs on other machines

> **Record status (2026-11-17): Phase 1 and evaluation leasing built; phase 2 not built.** This is a decision record, not the description of the system. What the code does now is in [ARCHITECTURE.md](../ARCHITECTURE.md) §7. Stale here: §8's held offers and `evalOfferSeconds` (replaced by the durable queue, 32); the per-session MCP bridge child (removed by 31); D15's first plan.

> Status: **phase 1 implemented** (2026‑11‑10): Codex and Claude sessions of the `single` and `team` pipelines and
> of a study's collectors go to remote workers — `src/work/session.ts` (the session source), `src/research/remote.ts`
> (placement), `src/remote/session-mcp.ts` (the session's route), `worker/knode-worker.mjs --sessions`; tests in
> `tests/remote-sessions.test.ts`. **Evaluation on remote workers implemented** (2026‑11‑13, §8): an evaluation run's
> model calls, agent sessions and judge calls are leased like any other work while the run itself stays here —
> `src/work/eval.ts` (the sources), `src/remote/eval-producer.ts` (the run's loopback channel), `src/eval/remote.ts`
> (placement in the run), `worker/knode-worker.mjs --eval`; tests in `tests/remote-eval.test.ts`. Phase 2 is not
> built. Extends [design 12](12-remote-processing.md)'s lease protocol from one-shot model calls to the agent sessions
> research jobs and studies run ([06](06-wiki-research-agent.md), [15](15-research-studies.md),
> [22](22-research-pauses-and-housekeeping.md)) and to the model work of an evaluation run ([23](23-knowledge-benchmarks.md)).

## 0. What was there

Remote workers take five kinds of work: `extract`, `summarize`, `judge`, `translate` and `embed`
(src/work/kinds.ts). Each is one prompt and one reply, or one batch of vectors. The server builds the input and
checks the answer ([remote-labeling.md](../remote-labeling.md)).

Research never leaves the Mac mini. A research job is a series of agent **sessions**, multi-turn runs of
`claude -p`, `codex exec` or `cursor-agent`, each started by `launchSession` (src/research/launch.ts) in the job's
run folder `.runs/<job>/`:

| job | sessions |
|---|---|
| page, `single` pipeline | one |
| page, `team` pipeline | one per role, in phases (src/research/pipeline.ts) |
| page, `native` pipeline (the default when neither the profile nor `research.pipeline` names one) | one orchestrator with the roles as the CLI's own sub-agents |
| study, collect stage | one collector per planned page, `research.study.collectors` at a time |
| study, pages and report | a `section` job per page, then the report: each a page job as above |

Everything around the sessions is server work. That covers claiming, the context seed, the brief, validation,
finalizing, filing a collector's notes and indexing captures. All of it needs the index and the files. A session
needs three things from the Mac mini:

1. knode's tools over `/mcp`, which answers this machine only (src/auth/http.ts);
2. Read / Grep / Glob over `raw/docs`, `raw/codebase`, `wiki` and `.sidecar`, mounted with `--add-dir`;
3. this machine's Codex, Claude or Cursor login.

The third is what runs out. On the night of 2026‑11‑03 two xhigh studies spent the five-hour limit and everything
queued after them failed ([22](22-research-pauses-and-housekeeping.md) §0). Since 2026‑11‑08 the processing floor
holds research jobs whenever the plan runs low, and the rest of this machine's processing draws on the same plan. A laptop with its own Codex or
Claude account could run sessions, but nothing can send them there. `research export` / `research reclaim` write a
run folder for a hand-run session. They assume the same machine: the export points the agent at local folders
and at `/mcp`, and `reclaim` reads the folder back from the server's disk.

Evaluation is a separate harness. `knode-os eval run` builds its own knode workspaces and other systems; their indexes
are on the product's backend, in a database of their own (`knode_eval` on PostgreSQL, PGlite when the run's config is
on it — design 31 D1).
It answers model calls through a shim on 127.0.0.1 that exists only during the run, and judges with Claude Code.
Packs and runs live in `~/knode-eval`. Until 2026‑11‑13 it never touched `serve`; a run resumes record by record
from keyed JSONL (src/eval/runstore.ts).

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| D1 The session leaves, the job stays | Claiming, the brief, team phases, validation, finalizing and every study stage stay in `serve`. Only `launchSession` gains a second way to run a session: on a remote worker | Everything around a session needs the index, the files and the trust rules. A session needs only a prompt, a schema file and knode's tools. Team phases and a study's collectors then spread across workers with no change of their own |
| D2 A new kind, `session`, pushed and awaited like a judge call | `launchSession` offers the session to a session source (src/work/session.ts) and awaits its outcome. The source keeps the offer, the lease, renewals and the answer. A slot that takes sessions takes nothing else, and sessions are not in `server.remote.shares` | The judge source already pushes, awaits and has a deadline, with local and remote slots side by side (design 12 §9). The research queue stays the one queue of jobs; there is no second queue of sessions to keep in step with it |
| D3 A worker first when one is there, here otherwise | With `server.remote.offer.session` on, a session that may leave (D8) goes to a remote slot that takes its CLI and asked in the last two minutes. It waits for that slot up to `server.remote.sessionOfferSeconds` (30), then runs here as today. With no such slot online it runs here at once | The point of a worker is another account. When one is online it should get the sessions; when none is, nothing gets slower. Off by default, like judge calls |
| D4 The floor moves from the claim to the session | While a worker that takes a job's CLI is online, the claim no longer holds the job for this machine's floor (`processing.minQuotaPercent`). Each session checks it instead: under the floor, or with `research.localSessions: 0`, a session does not run here and keeps waiting for a worker | Holding the job at the claim, as today, would idle the worker exactly when this machine's plan is low |
| D5 A session that can run nowhere ends its run as design 22 says | A session that waited `server.remote.sessionWaitMinutes` (30) with no slot to take it ends the run. The job gets a quota hold (`holdJobForQuota`) if the floor kept it from running here, and a transient pause otherwise | A worker that went offline mid-study should leave the study paused and resumable, not failed |
| D6 The session reaches knode through `/remote/v1`, never `/mcp` | A lease mints a session token (`kms_…`), kept in memory and revoked when the lease completes, is released or lapses, or the job is cancelled. It opens `/remote/v1/w/<owner>/<workspace>/sessions/<id>/mcp` (§4): knode's tools (`registerKnodeTools`, caller `agent`), filtered to the session's set, with writes bound to the job's output paths. Leasing sessions needs a new token scope, `research` | `/mcp` stays loopback-only (the machine's service rules, `~/Projects/AGENTS.md`). Its tokens open a whole workspace (`kmw_`) or every workspace (the data root's) for as long as `serve` runs. A session token opens one session's tools for as long as that session holds its lease, so a leaked one stops working when the session ends |
| D7 No files on a worker | A remote session gets no Read / Grep / Glob over the data folder, and nothing is copied to the worker. Its brief says so and points to `knode_ls`, `knode_read` and `knode_grep` | `knode_read` already returns a PDF's or web page's derived Markdown and reads a long document by section, and `knode_grep` covers wiki, raw/docs (derived text), raw/skills and raw/codebase. A copy of the base would carry private material, such as the finance workspace, off the machine. The cost is an HTTPS round trip per read |
| D8 What stays here | Not offered to workers: the built-in agent and OpenCode (they run on this server's connections and keys); a study's sessions that attach its MCP sources (a stdio source is a command on this machine, an HTTP one carries its secrets); deep-research mode (one Responses API call on this server's key); a study's refinement call; Ask and chat (a person is waiting); and, until phase 2, the `native` pipeline | Each of these needs a key or a command that is this machine's, or a quick answer. Native sub-agents are structured (`NativeAgentSpec`), so a worker can build `claude --agents` and Codex's agent layers from them, but that is a second step |
| D9 The worker builds the command; the server sends a spec | A task carries the CLI family, model, effort, speed, turn cap, timeout, tool set (`read` / `write`), web on or off, the schema text and the prompt. It never carries argv, environment or a config layer. The worker checks each field against a fixed pattern and builds the invocation from its own recipe, as it already does for one-shot calls | A server that could send argv could make every worker run any command; `codex -c mcp_servers.x.command=…` is one way. A field-by-field spec cannot. The cost is a second copy of the session recipes, kept in step with `sessionArgs` by a test |
| D10 Raw output back, parsed here | Each renewal carries the stdout received since the last one, which the server appends to the run folder's `transcript-<label>.jsonl`, so the live activity view works as for a local session. `complete` brings the rest, the exit code, stderr's tail and Codex's last message. The server derives text, turns, cost and error with the code a local session uses (the parse at the end of `launchCliSession` becomes a function) | One parser, and the worker stays a runner, as design 12 wants |
| D11 A worker's failure is the worker's, not the job's | A session the worker could not serve goes back in line with the job's attempt untouched, and that backend rests as for the other kinds. That covers a usage or rate limit, a lost login, a missing CLI, a lapsed lease and a stopped worker. After three in a row a session stops waiting for workers: it runs here if it may (D4), or waits (D5). Only a session that ran here can pause its job and its account's queue | A spent limit on a laptop's account says nothing about the Mac mini's, and pausing the job would idle the machine that could run it |
| D12 Short leases, for cancellation | A session lease lasts 120 s and is renewed every 30 s. A renewal answered `lost` (cancelled, restarted, lapsed) kills the CLI. Cancelling revokes the session token at once, so the agent's next tool call fails before the worker hears | A session runs for 20 minutes or more. A 15-minute lease would let a cancelled session go on writing for 15 minutes |
| D13 Keep long tool calls alive | The session route answers a tool call as an event stream, with a comment every 20 s, as design 23's shim keeps its replies alive | A capture of a filing can take over a minute, and Cloudflare drops a response that sends nothing for 100 s (to verify in phase 1) |
| D14 Where it ran is on record | Each phase record gets `worker` and `backend`. The lineage of what a session wrote names the worker's token, as the remote API's writes do. Tasks lists sessions out, with their worker. Trust is unchanged: an agent's page lands quarantined wherever the agent ran | So a page that went wrong can be traced to the machine and account that wrote it |
| D15 Evaluation's model work is leased; the run stays (2026‑11‑13, replacing "evaluation moves whole, by pack, and is merged") | `eval run` and `eval score` stay on this machine with the run directory, the keyed records, resume, the quota guard and the report. Only model work leaves, through `serve`: each model call of a build or a single-shot answer (`eval-call`), each judge call (`eval-call` on the judge's CLI), each read-only agent session (`eval-session`). The run offers a piece over a loopback channel of `serve` and awaits what became of it; workers lease it like any other kind, with the same tokens (scope `eval`), audit and Tasks. Pack export / import / merge stays a possible later phase | The run's records, resume and quota guard are where its results are compared, and splitting a run by pack would split them. A piece of model work is what a worker can do without the pack: a prompt, or a folder and a prompt. The same workers then raise a run's parallelism the way they raise processing's, with no second copy of the harness on each machine |

## 2. The flow

```
 research loop (serve) ─ claim ─ brief ─ pipeline ─▶ launchSession(spec)
                                                       │
           offer.session off, or the session stays (D8) ┼──▶ spawn here, as today
                                                       ▼
                               session source: offered
                                 a remote slot for its CLI asked < 2 min ago?
                                   no  ─▶ spawn here; if it may not (floor, localSessions 0): wait (D4, D5)
                                   yes ─▶ wait ≤ sessionOfferSeconds for a lease, then as "no"
                                                       │ leased
                                                       ▼
 worker ── POST work/lease { kinds: [session], backend: codex } ──▶ { spec, schema, prompt, mcp: { url, kms_ token } }
   fresh temp dir: AGENTS.md / CLAUDE.md / .mcp.json ── codex exec … (knode's tools only, no data files)
     │ tool calls ──HTTPS──▶ /remote/v1/w/<owner>/<ws>/sessions/<id>/mcp   (kms_; tool set; writes bound)
     │ every 30 s: work/renew { ids, stdout } ──▶ .runs/<job>/transcript-<label>.jsonl
     ▼
   work/complete { exitCode, stdout, stderrTail, lastMessage } ──▶ parsed here ──▶ SessionResult ──▶ the pipeline goes on
```

## 3. The session task

A lease answer for `kinds: ["session"]`:

```jsonc
{
  "id": "3f9c0a1e-…", "kind": "session", "label": "r_6f406e239a collect-3 · HBM roadmaps",
  "job": "r_6f406e239a", "leaseExpiresAt": "…",
  "agent": { "family": "codex", "model": "gpt-6.1-sol", "effort": "xhigh", "speed": null },
  "maxTurns": 150, "timeoutMs": 1200000,
  "tools": "read",                       // "write": also knode_write / knode_checkout / knode_commit; the route enforces it
  "web": true, "webFreshness": "live",
  "schema": "…",                         // written as AGENTS.md and CLAUDE.md
  "prompt": "…",                         // stdin
  "mcpToken": "kms_…"                    // for <the worker's own --server>/remote/v1/w/<workspace>/sessions/<id>/mcp
}
```

The task names no URL: the worker builds the session's MCP address from the server it already talks to, so a
task cannot point an agent anywhere else. `work/renew` takes `{ worker, backend, ids, output: { <id>: "<stdout
since the last renewal>" } }`. At most 256 KB per session per renewal; beyond that the server writes a line
marking the gap. It answers `{ renewed, lost }`. `work/complete` takes `{ worker, backend, id, ok: true, session:
{ exitCode, output, stderr, lastMessage } }` and answers `{ accepted, failure? }`: `failure` (`transient` or
`fatal`) says the server read the answer as the worker's own failure (D11), and the worker rests that CLI.
`ok: false` with an `error` is a worker that could not start the CLI at all. Anything else is a result, however
poor, and goes to the parser.

The brief's line on readable folders is written per placement: the folders for a session that runs here, and
"none: read through knode_ls / knode_read / knode_grep" for one that leaves. The run folder is prepared as
today, so a session that falls back to this machine runs exactly as it does now.

## 4. The session route

`/remote/v1/w/<owner>/<workspace>/sessions/<id>/mcp` is Streamable HTTP, stateless, like `/mcp`, with these
differences:

- **Auth**: the session token only. It is minted with the lease, held in memory, compared in constant time and
  dropped when the session ends (D6, D12). A request from another machine must come over HTTPS (the existing
  rule), and the lockout after ten failed authentications applies.
- **Tools**: `tools/list` and `tools/call` see the session's set only. A reader or collector gets `READ_TOOLS`
  (src/research/launch.ts), which includes `knode_capture`. A writer also gets `knode_write`, `knode_checkout`
  and `knode_commit`, and none of the rest of the agent surface (sync, forget, queuing research …).
- **Writes**: `knode_write` takes the job's output path and its companions (an init job's guide) only;
  `knode_commit` takes the job's own workset only, to the default notes folder (no `path`). `knode_capture` keeps its own rules: the study folder and the
  fetch guard of design 15 D6. The server fetches; the worker never does.
- **Audit**: every call is a line in `remote-audit.jsonl` with the worker's token name, the session, the tool and
  the path it touched, never the content.
- **Keepalive**: answers come as an event stream with a comment every 20 s (D13).

The agent's own web tools (Claude's WebSearch / WebFetch, Codex's `web_search`) run on the worker's network, as
they run on this machine's today. `knode_web_fetch` and `knode_capture` fetch from this machine.

## 5. Placement

| situation | where the session runs |
|---|---|
| `offer.session` off, or the session stays (D8) | here, as today |
| no remote slot for its CLI seen in two minutes | here at once |
| a slot is online and leases it within `sessionOfferSeconds` | that worker |
| a slot is online but busy for `sessionOfferSeconds` | here |
| this machine may not run it (under the floor, `localSessions: 0`) | waits for a worker up to `sessionWaitMinutes`, then D5 |
| three worker failures in a row (D11) | here if it may, else waits as above |

`research.concurrency` still counts jobs. A worker adds sessions to the jobs in flight, such as a team's phases
or a study's collectors, but does not start more jobs. To use two workers fully, raise the concurrency.

## 6. The worker

```bash
KNODE_TOKEN=knr_… node knode-worker.mjs --server https://knode-os.lemoncheese.cc --workspace admin/finance \
  --backends codex:2 --sessions codex:1,claude:1
```

- `--sessions` adds session slots beside the call slots (with `--sessions` alone, the worker runs no call slots).
  The token needs the `research` scope; `--check` shows whether the server offers sessions and whether each CLI
  is installed. `--session-timeout-ms` caps a session below the server's timeout (at most 6 h), and
  `--session-renew-ms` sets how often it renews and sends its output (default 30 s).
- A task's fields are checked before anything runs: the CLI family against the slot's, the model against a
  pattern a flag cannot match, the effort against the known levels, the token's form, the turn cap and the
  timeout. A task that fails a check is handed back as a fatal failure and that CLI rests.
- Each session runs in a fresh temporary folder, removed afterwards, that holds the schema and the MCP
  configuration only.
  - Codex runs as `codex exec --ignore-user-config --ephemeral --sandbox read-only`, plugins, apps and analytics
    off, the model catalog from the worker's own copy, and knode's server as its only MCP server, pre-approved.
  - Claude runs with `--strict-mcp-config`, `--allowedTools mcp__knode-os__*` (plus WebSearch / WebFetch when
    `web`), and Read, Grep, Glob, Write, Edit and Bash disallowed.
  - Cursor (phase 2) will run with `.cursor/cli.json` allowing knode's tools and denying writes and the shell,
    as a local session does.
- The token for knode's MCP route goes to the CLI through an environment variable (Codex) or the 0600 config
  file in the temp folder (Claude, Cursor). It is never logged.
- Codex's read-only sandbox still reads the worker's own files. A page an agent reads can carry instructions,
  and an agent that followed them could copy a worker file into a quarantined page. The same is true on the Mac
  mini today. Run a session worker as a user with nothing to hide, or in a container.

## 7. Settings, scopes and routes

| setting | default | meaning |
|---|---|---|
| `server.remote.offer.session` | `false` | remote workers may take research sessions (D3) |
| `server.remote.sessionOfferSeconds` | `30` | how long a session waits for an online worker before it runs here |
| `server.remote.sessionWaitMinutes` | `30` | how long a session that may not run here waits for a worker (D5) |
| `server.remote.offer.eval` | `false` | remote workers may take an evaluation run's calls and sessions (§8) |
| `server.remote.evalOfferSeconds` | — | no longer read (docs/design/32): a piece waits until a slot takes it, at most `eval run --wait-minutes` while none online does |
| `server.remote.shares.eval` | `1` | evaluation work's weight beside extraction's 3 on a slot that takes both; `0`: only when no knowledge-base work waits (docs/design/32 §4) |
| `research.localSessions` | unset | research sessions this machine runs at once while sessions are offered: unset, no limit beyond the jobs' own; `0`, workers only; `n`, at most n here |

These live in `knode.config.json`; Settings has no field for them yet. New token scope `research`: lease
`session` tasks and hand back their output. `work/config` gains `kinds.session` and `leaseSeconds.session` (120).
`GET /api/tasks` lists sessions out with their job, phase, worker and age (stage "Research"), in the web UI and
the app. `knode-os remote token create --scope research` makes such a token. A job whose single session ran on a
worker keeps `payload.worker`; a team's or a study's phases each keep their `worker`.

## 8. Evaluation on remote workers

Since 2026-11-14 (docs/design/32, stage 1) a run only publishes: every piece below waits for a slot that leases it —
a remote worker's, or one of the run's own (`--local`) — and never falls back to running in the run's process.
"Placement", "Parallelism" and "What stays" say what is now the case; the rest of this section is unchanged.

```
 eval run (this machine: run dir, records, quota guard, report)
   │ shim ─ PublishedChatBackend ─┐  runAgent ─ publishAgent ─┐  judge ─ remoteJudgeClient ─┐
   │                           ▼                          ▼                              ▼
   │        POST 127.0.0.1:<serve>/eval/v1/offer {spec}   (data root's MCP token; held open, whitespace every 10 s)
   │        PUT  …/eval/v1/archives/<sha256>               (a file agent's folder, before its session)
   │                                                       ▼
 serve ── EvalSource eval-call / eval-session (src/work/eval.ts), behind every workspace's broker
   │  worker ── POST /remote/v1/w/<ws>/work/lease { kinds: [eval-call, eval-session], backend: codex } (knr_, scope eval)
   │            GET  …/eval-archives/<sha256>               once per archive, cached by id, unpacked fresh per session
   │            POST …/eval-sessions/<id>/mcp  (kes_)  ──▶ serve ──▶ the build's tool host on 127.0.0.1 (in the run, design 31 D4)
   │            POST …/work/renew { output } · …/work/complete { text | session: { exitCode, output, lastMessage, capped, cwd, home } }
   ▼
 the outcome goes back on the held request: answered | error | stuck | cancelled
 the run's own slots (--local) lease the same pieces over POST …/eval/v1/slots/lease|complete|renew|release
```

**What leaves.** Three kinds of model work, each only while the run names its CLI and model:

- *Builds and single-shot answers* go through the shim's `ChatBackend`, which is always `PublishedChatBackend`
  (src/eval/remote.ts): a `ChatRequest` (messages, json, schema, effort, model) becomes an `eval-call`. On a run on
  the Codex CLI with a named `--model` its prompt is the stdin `codex exec` would get (`renderCliPrompt`), with the
  effort in Codex's terms and the strict output schema, and any slot may take it. A chain (`--chat-chain`), a
  connection (`--chat-connection`) or a run with no `--model` publishes its calls `local`: a CLI default may be
  another model on another machine.
- *Scoring*: the judge's client is wrapped (`remoteJudgeClient`) when the judge is a CLI with a named
  `--judge-model`: each call is an `eval-call` on that family. `eval score --remote` does the same.
- *Agent answers*: inside a run `runAgent` publishes the session (`publishAgent`); the run's own slot runs it with
  `runAgentHere`. A read-only session with a named model may leave as an `eval-session`: family, model, effort, sandbox, step cap, timeout and prompt, never argv or environment (D9).
  - A *file agent* (agent-grep, the wiki agents) gets its staged folder as an archive (src/work/eval-archive.ts:
    gzip over `KPA1\n` and, per file in path order, a JSON line `{p, n}` and the bytes; its id is the SHA-256 of the
    stream before compression). The run uploads it unless `serve` holds it (`HEAD` first), so a corpus every question
    reads is uploaded and downloaded once; the worker keeps it by id and unpacks a fresh read-only copy per session.
    `serve` lets a worker download an archive only while a session that reads it is offered or out.
  - An *MCP agent* (agent-knode) keeps its knode tools here, on the index the run built: since 2026-11-14 (design 31
    D4) the run serves each build's tools itself on 127.0.0.1 (src/eval/toolhost.ts), one host for every session of
    the build, local or remote, answering only `KNODE_AGENT_TOOLS` (before, a bridge per session started a
    `knode-os mcp` child). The lease mints a `kes_` token, held in memory and
    dropped when the lease ends; the worker's agent calls `/remote/v1/w/<ws>/eval-sessions/<id>/mcp` with it, and
    `serve` proxies to the host with the host's own secret, refusing a `tools/call` outside the set (403) and
    auditing each call (tool and path, never content). No workspace is copied, and query embeddings stay here, so
    vectors match.
  - Its renewals carry stdout (D10, every `--session-renew-ms`, default 30 s; leases last 120 s, D12); the worker
    counts the step cap itself and stops the CLI past it. The run parses the whole stdout with `AgentTrace`, the code
    `runAgentOnce` uses: the trace, the step cap, and the leak audit, with the worker's folder read as this run's copy
    and its home as the home a path must not reach.
  - A session that writes (the llm-wiki build and update, `workspace-write`) stays here.

**What stays.** A piece that may not leave is published `eligible: local` (docs/design/32 §2): only a slot on this
machine takes it — in practice the run's own `--local` slots — and with none it waits like any other. That is a pack
with any source whose license starts with `private:` (finance-cn: its calls go through a second shim whose backend
publishes them `local`, packs sharing the caches; its sessions are published `local`; a run that holds one judges on
`local` pieces), a run routed over an agent chain (`--agent-chain`: its sessions), a session that writes, and every
call of a run on a chain, a connection, a stand-in or with no `--model`. Embeddings always stay (the run's own
embedder and vector cache): they are not leased work.

**Placement** (D3, D11; since docs/design/32). Every piece is published, to `serve`'s broker with `--remote` or to
a broker in the run's own process otherwise, and done only by a slot that leases it: a remote worker's, or one of the
run's own (`--local codex:6,claude:1`), which leases like a worker and runs the piece with the run's own backends. A
slot takes a piece only if it runs its CLI, is in its pool when the run names one (`--pool`; a worker's pool is its
`--pool`, default its token's name), is on this machine when the piece is `local`, and — a run's own slot — belongs to
its run. A piece waits until such a slot takes it; there is no offer window and no withdrawal (`--offer-seconds` is
accepted with a warning). When no slot online meets a waiting piece's requirements for `--wait-minutes` (30; 0 = no
limit), the run stops cleanly, records nothing for what still waits, and exits non-zero naming the CLI, model and
pool it waited for; a resume continues. While waiting it logs once a minute what waits and for what. A worker's
failure is the worker's: a usage limit, a lost login, a missing CLI, a refused task, a lapsed lease, a session that
exited with such an error, or a worker that reports another model than the one named puts the piece back in line and
rests that worker; a machine that failed a piece gets it again only when nothing else waits. A piece three different
machines could not serve is `stuck`: logged, kept in the run's events and run.json, listed in the report, left
unanswered (its answer or build is not recorded), and the run ends incomplete. A model's own error on a call
(`kind: model`) is the call's, thrown as the run's backend would throw it. The quota guard holds what this machine's
plan pays for: a run's own Codex slot waits in `waitLocal` before it runs a piece, and with no Codex slot of its own a
run's batches no longer wait on this machine's plan.

**Parallelism** (F; since docs/design/32). A system answers as wide as the slots online that could take its work —
the run's own and the workers' that meet its pieces — re-read as they come and go; `--answer-concurrency`, when
given, bounds it (an old command line has it at 3). `--slots` only sizes an old command line's own slots (no
`--remote`, no `--local`: `--local codex:<slots>,claude:<slots>`). A knode build's document passes send as many calls
at once as there are call slots online when the build starts, never fewer than `KNODE_EVAL_KNODE_CONCURRENCY` (6), and
a pass's batch grows in the same proportion above that (`evalPassSettings`); the build's notes record both. The
reviews inside a build (duplicate entities and claims, after every pass and in refine) send their judge calls as wide
as a pass does (`review.directConcurrency`, recorded as `judgeConcurrency`): in the 2026-11 10× run they went one at a
time, 743 judge calls against 123 extraction calls, with 19 of 20 worker slots idle. The verdicts are applied after
all of a review's calls return, so the width changes the time, not the result. Sync, embedding and wiki generation
run in the run's process at their own pace.

**Comparability** (D). A worker runs exactly the family and model a task names (its own `--codex-model` does not
apply), so a piece's backend is `codex-cli:<model>` (`claude-cli:<model>` for the judge) wherever it ran — another
account on the same model is the same backend. Every meter event carries `worker` (absent here) and `backend`; every
answer, build and score record carries `worker` (`local`, the worker's machine `<token>/<name>`, or `mixed`) and
`backend` (more than one, comma-joined, only if backends mixed). `eval status` shows per pack and system the share of
answers made on workers and flags mixed backends, and the share of model calls per worker.

**Cancelling and restarts.** The offer request is held open; closing it (the run stopped or was killed) cancels the
piece. A run that is cancelled (`signal`, Ctrl-C) also posts `/eval/v1/runs/<run>/cancel`: offers end, `kes_` tokens
die at once, and a worker's next renewal is answered `lost`, which kills its CLI. A cancelled run writes no record for
what it stopped, so a restarted run resumes record by record, asking nothing twice. An agent session killed by a
signal, or one that ended with nothing while the run was stopping, is recorded as cancelled and asked again on resume,
never as an empty answer. `serve` restarting loses what it held in memory (stage 2 of docs/design/32 makes it
durable): the run's held requests fail, and the run publishes those pieces again once `serve` answers, as pieces that
wait (a piece one of the run's own slots had already done keeps that result); a piece a worker had out is done again,
and the worker's late answer is refused. While `serve` does not answer, only the run's own slots count as online, so
the wait limit bounds an outage.

**Repeats** (`eval run --repeat <n> [--repeat-systems …]`). Repeated answers to the same tasks, for run-to-run
variance. Repeat 1 keeps today's keys; repeat r > 1 adds `r<r>` to the answer key and `repeat: r` to the record, is
answered under the task id `<task>~r<r>` (its own meter tag and reply-cache key, so the model is asked again), and is
scored under its own system with `repeat: r` on the score record and in its key (docs/design/28, src/eval/score/keys.ts).

**Access** (G). Token scope `eval` (`knode-os remote token create --scope eval --workspace <user>/<ws>`): eval work is
the server's, leased through whichever workspace the token names. Settings: `server.remote.offer.eval` (default
`false`: remote workers see no eval work; a run's own slots still take its pieces through `serve`) and
`server.remote.shares.eval` (1 against extraction's 3; 0 = only when no knowledge-base work waits for the slot);
`server.remote.evalOfferSeconds` is no longer read. The producer channel `/eval/v1` answers this machine only (a 404
elsewhere) and the data root's `.knode/mcp-token`; it adds no listening port. `GET /api/tasks` lists eval work out
(kind `eval-call` / `eval-session`, class `eval`, its run, model, pool, worker and age) in every workspace, and each
remote worker's pool.

```bash
# on the Mac mini: offer eval work (knode.config.json: server.remote.offer.eval = true), then mint a token
knode-os remote token create --name laptop-eval --scope eval --workspace admin/finance
# on the other machine
KNODE_TOKEN=knr_… node knode-worker.mjs --server https://knode-os.lemoncheese.cc --workspace admin/finance --eval codex:3,claude:2
# a run that publishes its work to serve on this machine; with no --local, nothing of it runs here
knode-os eval run --pack fixture-life --model gpt-6.1-sol --judge-model claude-opus-5-5 --remote
# the same with slots of its own beside the workers, and only workers started with --pool gateway
knode-os eval run --pack fixture-life --model gpt-6.1-sol --judge-model claude-opus-5-5 --remote --local codex:2,claude:1 --pool gateway
```

**Not built.** Leasing a writing session (the llm-wiki build) — its folder would have to come back; external
systems' own processes (they call the shim, whose calls do leave); a worker-side quota floor; pack export / import /
merge (the earlier plan) as a way to run a whole pack elsewhere.

## 9. Phases

1. **Built 2026‑11‑10.** Sessions on Codex and Claude for the `single` and `team` pipelines and a study's
   collectors: the session source, the session route and token, D4's floor change, transcript streaming, the
   shared parser, worker session slots for codex and claude, the settings and Tasks. Tested end to end with the
   fake claude CLI through a worker on loopback (`tests/remote-sessions.test.ts`). Not yet checked: a real Codex
   or Claude session on another machine, and the keepalive through Cloudflare with a slow `knode_capture`.
2. Cursor; the `native` pipeline (the worker builds sub-agents from `NativeAgentSpec`); a worker-side floor
   (`--min-quota-percent`: the worker reads its own Codex windows through `codex app-server`, as `serve` does,
   and leases no session under it).
3. **Built 2026‑11‑13**, as leases rather than pack transfer (D15, §8): an evaluation run's calls, read-only
   agent sessions and judge calls on remote workers; tested end to end with a stand-in CLI through a worker on
   loopback (`tests/remote-eval.test.ts`). Not yet checked: a real Codex or Claude session on another machine, and an
   MCP agent's calls through Cloudflare. Pack export / import / merge remains a possible later phase.

## 10. Open items

- **The `/mcp` rule (settled 2026‑11‑10).** The session route adds no route under `/mcp`, but it does let an
  agent on another machine call knode's tools: one session's tools, behind a token that dies with the lease.
  `~/Projects/AGENTS.md` keeps `/mcp` loopback-only. The machine's owner agreed that this route fits that rule;
  `/mcp` itself stays as it is.
- **Models a worker's account lacks.** A task names the job's model. A worker whose account cannot run it fails
  fatally and rests that backend (D11), which is slow to learn. A worker could instead list the models it
  takes in its lease (`models: […]`).
- **Job concurrency.** Workers add capacity to the jobs in flight, not more jobs (§5). Whether online workers
  should raise `research.concurrency` on their own is left open until the first study runs on two machines.
- **Codex with its user config ignored.** Local sessions rely on the person's `~/.codex/config.toml` for the
  approval policy. A worker ignores it and pre-approves knode's tools, and phase 1 must check that `codex exec`
  makes MCP calls that way.
