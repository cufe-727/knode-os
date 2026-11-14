# 31 — Evaluation on PostgreSQL, and knode answers in parallel

Status: being implemented (2026-11-14) on branch `claude/eval-postgres-parallel-a83957`, one commit per step: D2's harness half (single-flight open) done. The running 10× separation run is unaffected: it executes from its own checkout's build.

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
- A remote session reaches the same endpoint through `serve`'s existing lease-bound proxy, replacing the per-session bridge child.
- `serial` and the `close(s)` hand-off go. Sessions run as wide as the session slots, on either backend: on PostgreSQL the queries run concurrently through the pool; on PGlite they queue inside the one process for milliseconds while the agents think.

Why not a CLI the agent runs in its shell:

- It does not raise concurrency by itself. The limit is who holds the index, not the protocol: a CLI that opens the index per command has the same exclusivity on PGlite, and on PostgreSQL pays a process start and a store open per call.
- A session on a remote worker has no index to open; a CLI there would have to be a client of this same endpoint.
- The agent's sandbox is read-only without network, so a shell command could not reach a local endpoint, while MCP calls are made by the agent's host outside the sandbox.
- It changes the system under test (tool descriptions, call shapes, output handling). If wanted, it should be a system of its own (`agent-knode-cli`) compared against `agent-knode`, not a replacement.

### D5. Checking the switch

Before any model-backed run:

1. Suite on PGlite as today, plus the Postgres-backed evaluation tests on a throwaway cluster (as `tests/backend-postgres*.test.ts`).
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
