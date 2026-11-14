# 31 — Evaluation on PostgreSQL, and knode answers in parallel

Status: being implemented (2026-11-14) on branch `claude/eval-postgres-parallel-a83957`, one commit per step: D1, D2's harness half (single-flight open), D3 and D4 done. The running 10× separation run is unaffected: it executes from its own checkout's build.

## Problem

In the 10× separation run (`run-10x`, design 28), two of the six systems answered one task at a time while ten worker slots were online:

| System | 300 answers took | Per answer | Why |
| --- | --- | --- | --- |
| agent-grep | 21 min | parallel | — |
| knode-ask | 74 min | 16.5 s, of which 16.1 s is the model call and 0.4 s the index | `serial: true` |
| agent-knode | 3.5–5 h expected (42 s each at 1×) | one session at a time | `serial: true` |

Both restrictions trace back to the evaluation's index being embedded PGlite.

## Findings

### F1. The evaluation hard-codes PGlite; the product has defaulted to PostgreSQL since 2026-09

`evalWorkspaceConfig` (`src/eval/systems/knode.ts`) sets `database: { ...base.database, kind: 'pglite' }`. It has since the first commit of the suite (b04f6b4, 2026-11-04), for a workspace that needs nothing installed. `defaultConfig()` itself answers `postgres` unless `KNODE_DATABASE_KIND=pglite` (which the test suite sets in `vitest.config.ts`). So every benchmark number so far was measured on a backend the live service does not run, and both `serial` flags exist only because that backend is single-process.

### F2. The stall under "overlapping queries" is several PGlite instances on one directory

Commit 42f3e89 made knode-ask serial with "the cause is not confirmed". It is this:

- `open()` in `src/eval/systems/knode.ts` is `if (!s.ctx) s.ctx = await createContext(s.ws)`. It is not single-flight.
- Before a system answers, `runEval` releases the other members of its build group (`src/eval/run.ts`, `other.release?.(env)`), which closes the group's shared context. Answers that then start together each see no context and each call `createContext`.
- PGlite takes no lock on its data directory: three instances opened on one directory in one process, without error, in 0.5 s (measured). Each is an independent single-user Postgres with its own memory over the same files.
- `ask()` writes: `search` records chunk hits for heat (`recordChunkHits`). One instance then meets rows another instance wrote and waits for a transaction no backend of its own will ever finish. In WASM that wait is a busy sleep on the main thread.

Evidence (2026-11-14, this machine):

- The pre-serial test (b582cfd, `a run on the fixture pack`) stalled on run 6 of 6 at 97% CPU. A debugger attached to the stalled process shows `execProtocolRawSync → PostgresMainLoopOnce → ExecutorRun → … → pg_usleep → nanosleep`: the executor sleeping in a wait loop inside PGlite.
- A simulation of the harness (three workers, the unguarded `open`, 90 `ask` calls on a copy of the 1× reports index) stalled the same way in 1 round of 3; all three rounds opened three contexts.
- One instance under overlap is fine: 320 `ask` calls at 8 and 16 at once on the same index finished with no stall. Throughput of the index part does not rise (PGlite runs one statement at a time, on the main thread), but nothing blocks.

That the wait is on another instance's transaction is inferred from the stack and the reproduction; the frames between `ExecutorRun` and `pg_usleep` are unnamed.

### F3. agent-knode is serial because each session opens the index itself

Each session starts `knode-os --data <ws> mcp` as a stdio child (for a remote session, behind `startMcpBridge`, still one child per session). The harness closes its own context first (`close(s)`), and the system is `serial`. With F2 in mind this is the same hazard guarded by hand: two processes on one PGlite directory.

### F4. Answering changes the index it is measuring

`ask()` and the search tools record hits, and `boostByHeat` adds up to `heat.searchWeight` (0.05) to later scores. So a question's ranking depends on which questions were asked before it. Serial answering hid this as a fixed order; parallel answering would make it vary between runs.

## Design

### D1. Evaluation workspaces use the product's backend

- `evalWorkspaceConfig` stops forcing `pglite`. The database comes from the config the run is given (`--config-from`, else `defaultConfig()`), so `KNODE_DATABASE_KIND=pglite` keeps the test suite and zero-setup runs on PGlite.
- A run's indexes live in a database of their own, **never the one the live workspaces use**: default name `knode_eval` on the server `--config-from` names; `--database-url` (or `KNODE_EVAL_DATABASE_URL`) points a run at another server. `eval run` refuses to start when the evaluation database is the same server and database as the `--config-from` workspace's.
- One schema per build, named by `schemaNameFor` from the build's work directory (already unique per run, pack and group). The schema name is recorded in the build's notes.
- One pool per open workspace, sized for the run (`poolSize` ≈ answer concurrency, capped at 16). The live server on this machine allows 100 connections and holds about 20; with D4 only the harness process opens the index, so a run adds one pool.
- `run.json` records the backend (`database: postgres|pglite`), and the report prints it. Results on the two backends are not pooled.

*As built (src/eval/database.ts):*

- `evalDatabase` turns the run's database config into the evaluation's: PGlite stays PGlite with the default's fields (a live workspace's `database.path` or password never reaches a run's workspace); PostgreSQL keeps the server and moves to `knode_eval` with the schema prefix `eval`, so a build's schema is `eval_ws_<hash of its workspace path>` and can never be a live workspace's (`ws_…`); a URL (`--database-url`, else `KNODE_EVAL_DATABASE_URL`) means PostgreSQL on that server, in the database it names or `knode_eval`. Any other `database.kind` (a storage plugin) is refused.
- The refusal compares host (loopback names folded), port and database of the evaluation's config and the `--config-from` workspace's (or the default config's when there is none), before anything is spent.
- No credential is written into a run's workspace config: a password, or a URL carrying one, goes into the run process's environment and the file names the variable. A resumed run sets it again from its own options; `eval drop` takes `--database-url` for the same reason.
- Pool: `answerConcurrency` (default 3), plus the online worker slots with `--remote`, at most 16. A build's passes share the same pool (they queue in it).
- A resumed run refuses to continue on another backend than its `run.json` names; a run from before has none and counts as PGlite.
- The harness hands a context out only after the store's background upkeep after opening (`store.indexing`, `store.retype`) has settled. Found while testing on PostgreSQL: until the substring indexes are marked ready the keyword channel takes a scanning path whose keyword scores differ from the indexed one (1.97 vs 4.02 for the same chunk, same matches), so the first answers after an open were ranked differently from later ones. On PGlite the upkeep ran before the first query anyway. That the two paths score differently is a product question left open here (src/search/search.ts, `matchIndexReady`).

*Lifecycle as built:*

- Each build writes `.knode/eval-index.json` beside its workspace (`kind`, `schema`, the workspace it belongs to) and labels its schema with a comment naming the workspace directory; the schema is in the build's notes (`schema`, `database`). A build drops its workspace's schema first, so a rebuild in the same run never inherits an old one.
- Reuse: `reuseBuilds` still copies the work directory; the clone happens when the knode system reopens the copy (`adoptIndex`), since that is where the database config and the store are at hand. `cloneSchema` creates the target with the store's own migrations, empties it, copies every table parents first (no triggers or generated columns in the schema today; identity columns overridden; sequences set after) in one transaction, and labels it. It refuses when the source schema is gone, or the tables differ from what this version creates; a build whose index is on another backend is refused too. `buildGroup` then builds afresh and logs why (`reused build rebuilt`) — only for a reused build: a resumed run's own build that fails to reopen still fails its pack.
- `knode-os eval drop <run-dir>` drops each build workspace's index through `dropBackend` (on PostgreSQL only a schema with the `eval` prefix: one this run's workspace names). The schema name's hash cannot be read back, so the stale sweep goes by the schema comments: at the start of a run on PostgreSQL the evaluation schemas whose workspace directory is gone are *listed* (progress line and the run's log), and `knode-os eval drop --orphaned` drops them. Listing rather than dropping at a run's start, because a run directory that was moved, not deleted, would lose its indexes. Schemas without the comment (none are made so) are left alone.

Lifecycle, which the directory copy no longer covers:

- **Reusing builds** (`--reuse-builds-from`): `reuseBuilds` copies the work directory; on PostgreSQL it also clones the schema into the new run's schema, since update batches change an index in place. A build that cannot be cloned is built afresh, with the reason logged.
- **Dropping**: `knode-os eval drop <run-dir>` drops the run's schemas (through `dropBackend`), and the existing sweep of stale temp directories also lists evaluation schemas whose work directory is gone. Nothing drops a schema outside the evaluation database.

Open, for the user: whether evaluation uses the existing server on 5434 (separate database, no new service; shares CPU, disk and the connection limit with the live workspaces and AgentMux) or a PostgreSQL cluster of its own on a port from the knode-os block. The code is the same either way (`--database-url`). Recommendation: start on the existing server; move to a cluster of its own if a build is seen to slow the live service.

### D2. One open per index, enforced

- Harness: `open()` and `close()` in `src/eval/systems/knode.ts` become single-flight (the promise is stored, not the result), so concurrent answers share one context. This is the bug behind F2.
- Product: the PGlite backend refuses a second open of a data directory instead of corrupting it. In the same process, a registry of open directories in `openPglite`; across processes, a lock file beside the database holding the pid, taken on open, removed on close, and reclaimed when its process is gone. The error names the holder ("already open in this process" / "open in process 12345: knode-os serve").
- With both in place `serial` goes from knode-ask on either backend.

### D3. Answering does not write to the index

Evaluation answers and tool calls run with hit tracking off (`track: false` through `ask`, and a tool option for the agent's tools). Every question then sees the index as built, in any order and at any width. This changes knode-ask's and agent-knode's inputs slightly against earlier runs, which carried hits from earlier questions; the report notes it.

### D4. agent-knode: one tool host per build, shared by all sessions

The harness serves the build's knode tools itself: `registerKnodeTools(…, { caller: 'agent' })` over its open context, on a loopback Streamable-HTTP endpoint with a per-run secret, limited to `KNODE_AGENT_TOOLS`.

- A local session gets it as an HTTP MCP server (`mcp_servers.knode.url`, bearer token from an environment variable; Codex 0.166 supports both). If that proves unusable in `codex exec`, a stdio command that forwards to the endpoint replaces it; the tools and their descriptions stay identical.
  - *As built:* verified with the installed `codex exec` 0.166.0 on 2026-11-14 without model tokens — a fake Responses endpoint on loopback as the model provider and an isolated `CODEX_HOME`. Codex initialized the server with the bearer token from `bearer_token_env_var`, listed only the `enabled_tools`, offered them to the model as the namespace `mcp__knode`, called `knode_search` over HTTP when the model asked, and reported it as the same `mcp_tool_call` event (server `knode`) the trace audit reads. No forwarding command was needed. The env var is `KNODE_EVAL_MCP_TOKEN`, the one the remote worker already uses for the same server.
  - *As built:* the host is `mountMcp` (src/server/mcp-http.ts) in single-context mode on a Hono app the run serves on 127.0.0.1 (src/eval/toolhost.ts), with two small additions: the context may be a function opened on the first request (the build's single-flight `open`), and single-context mode takes the tool options (`caller: 'agent'`, `only: KNODE_AGENT_TOOLS`, `track: false`). Its listing, server instructions and server info equal those of `knode-os mcp` narrowed to the same tools (tests/eval-parallel.test.ts).
- A remote session reaches the same endpoint through `serve`'s existing lease-bound proxy, replacing the per-session bridge child.
  - *As built:* `startMcpBridge` is gone; `remoteAgent` passes the host's URL and secret as the session's `mcp`. A session given a stdio command instead (nothing in the harness does that now) stays on this machine. `RemoteEval.cancel()` now returns the one withdrawal to every caller, so a cancelled run ends after `serve` has revoked the session tokens; before, the second call returned at once, which is what made "revokes a session's token … when the run is cancelled" flaky.
- `serial` and the `close(s)` hand-off go (`serial` is gone from `SystemUnderTest` too: no system sets it). The host closes with the build's context, on `release` and when a run ends early (`closeKnodeStates`). Sessions run as wide as the session slots, on either backend: on PostgreSQL the queries run concurrently through the pool; on PGlite they queue inside the one process for milliseconds while the agents think.

Why not a CLI the agent runs in its shell:

- It does not raise concurrency by itself. The limit is who holds the index, not the protocol: a CLI that opens the index per command has the same exclusivity on PGlite, and on PostgreSQL pays a process start and a store open per call.
- A session on a remote worker has no index to open; a CLI there would have to be a client of this same endpoint.
- The agent's sandbox is read-only without network, so a shell command could not reach a local endpoint, while MCP calls are made by the agent's host outside the sandbox.
- It changes the system under test (tool descriptions, call shapes, output handling). If wanted, it should be a system of its own (`agent-knode-cli`) compared against `agent-knode`, not a replacement.

### D5. Checking the switch

Before any model-backed run:

1. Suite on PGlite as today, plus the Postgres-backed evaluation tests on a throwaway cluster (as `tests/backend-postgres*.test.ts`).
   - *As run:* `tests/eval-postgres.test.ts` is switched on as the backend tests are (`KNODE_TEST_PG_HOST/_PORT/_USER/_PASSWORD`, skipped when no PostgreSQL with pgvector answers) and uses a database of its own per run, dropped after. It runs the fixture pack end to end (every native knode system, both update batches, scoring and the report), a reuse with the schema cloned and the update landing in the clone only, a reuse whose source schema is gone (built afresh), the refusal to resume on another backend, `eval drop`, and the orphan listing.
2. Retrieval equivalence, no model calls: build the 1× reports pack once per backend with the reply cache of `run-1x` and compare `knode-ask` retrieval metrics (recall@k, MRR, nDCG). Differences beyond tie order are investigated before the backend is switched.
3. A parallel smoke test: knode-ask and agent-knode at width 8 with the scripted backend, on both backends, 20 repetitions, no stall.

## Decisions

| | Decision | Why |
| --- | --- | --- |
| D1 | Evaluation follows `database.kind`; its own database | Measures what production runs; cannot touch live schemas |
| D2 | Single-flight open; PGlite refuses a second open | The stall is two instances on one directory, not overlapping queries |
| D3 | No hit tracking while answering | Results independent of order and width |
| D4 | One tool host per build over HTTP | One open, any width, local and remote alike; a CLI would not help |
| D5 | Equivalence check before spending on a run | A backend switch must not move the numbers unnoticed |

## Not in scope

- Re-running the separation benchmark. Earlier runs stay as measured (PGlite, serial).
- Pass size and review cadence inside a build (see design 27 §8).
- The harness defects noted on 2026-11-13: a worker's refusal recorded as the answer's error, and a failed leased call surfacing as "Cannot read properties of undefined".
