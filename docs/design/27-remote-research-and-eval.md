# 27 — Research sessions on remote workers, and evaluation runs on other machines

> Status: **phase 1 implemented** (2026‑11‑10): Codex and Claude sessions of the `single` and `team` pipelines and
> of a study's collectors go to remote workers — `src/work/session.ts` (the session source), `src/research/remote.ts`
> (placement), `src/remote/session-mcp.ts` (the session's route), `worker/knode-worker.mjs --sessions`; tests in
> `tests/remote-sessions.test.ts`. Phases 2 and 3 are not built. Extends [design 12](12-remote-processing.md)'s
> lease protocol from one-shot model calls to the agent sessions research jobs and studies run
> ([06](06-wiki-research-agent.md), [15](15-research-studies.md), [22](22-research-pauses-and-housekeeping.md)).
> Evaluation ([23](23-knowledge-benchmarks.md)) gets pack transfer and a run merge, not leases.

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

Evaluation is a separate harness. `knode-os eval run` builds its own knode workspaces (PGlite) and other systems.
It answers model calls through a shim on 127.0.0.1 that exists only during the run, and judges with Claude Code.
Packs and runs live in `~/knode-eval`. It never touches `serve`, and a run resumes record by record from keyed JSONL
(src/eval/runstore.ts).

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
| D15 Evaluation moves whole, by pack, and is merged | No leases for eval. A pack moves as an archive (`eval pack export` / `import`). The other machine runs `eval run` on it with the same settings, and `eval merge` adds its keyed records to one run once both runs' settings agree. `export` refuses a pack whose sources say `private:` (finance-cn) | An eval agent reads a staged corpus folder, and its calls go through a shim that lives only during the run, so neither fits a lease. A pack's build is shared by all its tasks, which makes a pack the natural piece to split. The same model on another Codex account is the same backend, so the results compare. A run on another backend, such as an API endpoint instead of Codex, does not, and `merge` refuses it |

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
| `research.localSessions` | unset | research sessions this machine runs at once while sessions are offered: unset, no limit beyond the jobs' own; `0`, workers only; `n`, at most n here |

These live in `knode.config.json`; Settings has no field for them yet. New token scope `research`: lease
`session` tasks and hand back their output. `work/config` gains `kinds.session` and `leaseSeconds.session` (120).
`GET /api/tasks` lists sessions out with their job, phase, worker and age (stage "Research"), in the web UI and
the app. `knode-os remote token create --scope research` makes such a token. A job whose single session ran on a
worker keeps `payload.worker`; a team's or a study's phases each keep their `worker`.

## 8. Evaluation on another machine

- `knode-os eval pack export <pack> --out <file>.tar.gz` writes the pack directory and a checksum list. It refuses
  a pack with any source whose license starts with `private:`. `eval pack import <file>` checks the checksums and
  validates the pack (`validatePack`).
- The other machine runs `eval run --pack <its packs>` with the same `--model`, efforts, `--judge`,
  `--judge-model`, `--seed`, `--limit` and `--fraction`. It needs Codex and Claude Code logged in, the external
  systems installed (`eval systems install`) and an embedder that reproduces the run's vectors:
  `--embedding-endpoint` with a bge-m3 of its own. `--config-from` names a workspace on this machine only.
- `knode-os eval merge <into> <from>…` refuses runs whose `run.json` differs in model, efforts, judge, embedding,
  fraction, seed, limit, suites or system versions. Otherwise it appends the records the target lacks, key by key,
  and fails on a key both runs have with different content. `eval report <into>` then reports the merged run, and
  `eval status` shows which packs came from where.
- The quota guard (design 23 D12) reads the Codex account of the machine it runs on, so each machine pauses on
  its own windows.

## 9. Phases

1. **Built 2026‑11‑10.** Sessions on Codex and Claude for the `single` and `team` pipelines and a study's
   collectors: the session source, the session route and token, D4's floor change, transcript streaming, the
   shared parser, worker session slots for codex and claude, the settings and Tasks. Tested end to end with the
   fake claude CLI through a worker on loopback (`tests/remote-sessions.test.ts`). Not yet checked: a real Codex
   or Claude session on another machine, and the keepalive through Cloudflare with a slow `knode_capture`.
2. Cursor; the `native` pipeline (the worker builds sub-agents from `NativeAgentSpec`); a worker-side floor
   (`--min-quota-percent`: the worker reads its own Codex windows through `codex app-server`, as `serve` does,
   and leases no session under it).
3. Evaluation: `eval pack export` / `import`, `eval merge`, the report over a merged run.

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
