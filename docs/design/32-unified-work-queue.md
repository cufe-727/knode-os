# 32 — One work queue: producers publish, work waits, workers decide where it runs

Status: design (2026-11-14), approved for stage 1; stage 1 in progress on branch `claude/work-queue-stage-1-d8ecd2` (see §11).

## Problem

Knowledge-base work and evaluation work are leased through one broker and one lease protocol (design 12, design 27 §8), but they are queued and placed in two different ways, and the difference caused most of what went wrong in the 2026-11 10× separation run:

- An evaluation run executes its own model work when no worker takes it. A piece waits `--offer-seconds` (30) for a lease and then runs on this machine; with no worker online it runs here at once; a worker that fails three times also sends it here (design 27 D3, D11).
- On 2026-11-14 the workers went offline mid-run. The run fell back to this machine's Codex, whose route to the workers' gateway was down. Sessions hung, or failed with 502 and were recorded against their tasks. The benchmark had to stay on one backend, so "run it here" was never a valid answer.
- The same model name (`gpt-6.1-sol`) existed on two backends: this machine's Codex and the workers' gateway. Nothing in a task says which one it needs.
- Evaluation offers live in memory, as one open HTTP request per piece. A restart of the run or of `serve` loses them.
- Evaluation slots take nothing else, and evaluation is not in the broker's shares. There is no rule for which goes first when both want the same accounts.

The user's proposal, which this design adopts: one task system; a producer only publishes a task with what it requires; work waits until a worker takes it; whether it runs on this machine or another is decided by where workers are started and how many.

## 0. What is there

| Kind | Producer | Where the queue lives | Survives a restart | Runs on this machine as | With no slot for it |
| --- | --- | --- | --- | --- | --- |
| `extract`, `summarize`, `translate` | `serve`, from the workspace's database | the database (`extraction_queue`, pages owed) | yes | `serve`'s own slots (`src/labeling/local.ts`) | waits |
| `embed` | `serve` | the database (chunks without vectors) | yes | embed slots | waits |
| `judge` | a review, pushed and awaited | memory, inside the review | the review restarts | `serve`'s judge slots | waits |
| `session` (research) | a research job (durable queue of jobs) | memory, inside the job | the job resumes | the job's own launcher | waits, then pauses the job (design 27 D4, D5) |
| `eval-call`, `eval-session` | the `eval run` process | memory in `serve`, one open request per piece | no | **the run itself, outside any slot** | **runs in the run process** |

Everything but evaluation already follows the proposal: `serve`'s local execution is a set of slots that lease from the same broker as remote workers, and the broker never chooses between local and remote. The broker serves judge calls first, then the shared kinds by weight (`server.remote.shares`, extraction 3 : summaries 1 : translation 1). `embed`, `session` and the evaluation kinds go only to slots that name them (`ASKED_ONLY_KINDS`).

## 1. Decisions

| | Decision | Why |
| --- | --- | --- |
| D1 | A producer only publishes. No kind of work runs outside a slot | One placement rule for every kind; removes the fallback, the offer window and the three-strikes-to-local rule from evaluation |
| D2 | Local capacity is a worker started on this machine | Where work runs follows from where workers run and how many, as the user asked; the run no longer needs this machine's CLI to be the right backend |
| D3 | A task waits until a slot takes it; a producer may bound the wait and then pauses, never substitutes | A worker that is offline is a reason to wait, not to change backend |
| D4 | A task names what it requires: CLI family, model, effort, and optionally a pool | The same model name on two backends must not be interchangeable inside one benchmark |
| D5 | Tasks carry a class, `kb` or `eval`; a slot that takes both serves `kb` first by weight | Knowledge-base work is the product; a benchmark should not slow it, and should not be starved by it forever |
| D6 | Tasks and their results become durable in `serve` for the kinds whose pieces are independent | A run or `serve` can restart without losing or repeating work |
| D7 | Evaluation becomes a job in `serve`, with `serve` hosting a build's tools, once its indexes are on PostgreSQL | The last reason the run process must stay alive is the index it holds (design 31) |

## 2. The task

What a producer publishes, for every kind (today's fields for each kind stay as they are; these are added or made uniform):

| Field | Meaning |
| --- | --- |
| `class` | `kb` or `eval`. Decides order (§4), reporting, and which settings bound it |
| `requires` | `{ family, model, effort, speed }`, as an `EvalAgent` is today; `null` for kinds that run on a slot's own route (extraction on `extraction.workers`) |
| `pool` | Optional. Only a slot of this pool may take the task. Absent: any slot that meets `requires` |
| `eligible` | `any` or `local`. `local` replaces the second shim for packs with private sources: such work is leased only to slots on this machine |
| `key` | The producer's own key for the piece (a run's record key). Publishing a key again returns the task that exists, or its stored result |
| `inputs` | References that must stay reachable while the task waits: an archive id (stored in `serve` by content hash), a tools endpoint (§6) |
| `deadline` | When the producer no longer wants it; then it is dropped, never run |

A worker never receives argv, environment or a config layer (design 27 D9); that does not change.

**Pools.** A worker declares one pool (`--pool <name>`; default: the name of its token). A run names the pool its work requires (`eval run --pool <name>`). The model check stays: a worker that reports another model than the one named is the worker's failure. Pools are how "this benchmark runs on the SpaceX gateway and nothing else" is said once, instead of through a wrapper on each worker that refuses other model names.

## 3. Publishing and waiting

- `eval run` and `eval score` always work through a broker. With `serve` on this machine, `serve`'s; without one (a laptop, the test suite), the run starts a broker in its own process, as `serve` does, and its local slots lease from that. One code path either way.
- Local slots: `--local codex:6,claude:1` starts slots in the run's process that lease from the broker like any worker, in pool `local` unless `--pool` says otherwise. Without `--local` and without a worker, nothing runs: the run waits.
- `--answer-concurrency` and `--slots` stop meaning "how much runs here". A system answers as wide as the slots online that could take its work, re-read as workers come and go; pieces beyond that wait in the queue.
- `--offer-seconds` goes. `--wait-minutes <n>` (default 30, 0 for no limit) bounds how long a run waits while **no** slot online meets a piece's requirements. Past it the run stops cleanly: nothing is recorded for the pieces still waiting, the exit is non-zero with a message naming what it waited for, and a resume continues. While waiting it logs once a minute what waits and for which family, model and pool.
- A worker's failure (usage limit, lost login, missing CLI, lapsed lease, refused task) puts the piece back in line, and that worker rests, as today. It never becomes the piece's answer. A piece that three **different** workers could not serve is marked `stuck` and reported; the run goes on with the rest and ends incomplete rather than answering it another way.
- A model's own error on a call stays the call's, as today.

## 4. Order

Within one slot's request, in this order: judge calls (a review is waiting); then the kinds the slot named, by weight. Evaluation joins the weights with its own entry, `server.remote.shares.eval`, default 1 against extraction's 3: a slot that takes both gives knowledge-base work most of its turns, and evaluation is not starved by a long backlog. `shares.eval: 0` means evaluation gets a turn only when no knowledge-base work is waiting. A slot that names only evaluation kinds (as `--eval` slots do today) is unaffected.

Weights order work inside a slot. They do not ration an account: two slots on one plan still spend the same quota. The quota floor (`processing.minQuotaPercent`) keeps applying per backend, wherever the slot runs.

## 5. Durable tasks (stage 2)

For the kinds whose pieces do not depend on each other (single-shot answers, judge calls, file-agent sessions), `serve` keeps the task and its result in a store of its own:

- published tasks, by `key`, with their state (`waiting`, `leased`, `done`, `stuck`, `dropped`);
- results until the producer collects them, or for seven days;
- leases are not durable: after a restart a leased task is waiting again.

The producer becomes a client that publishes what its records lack and collects what is done. The open HTTP request per piece goes; the run polls or holds one stream for all its pieces. A run can then exit and resume without losing work in flight.

A knowledge-base build stays as it is: each extraction pass depends on what the pass before found, so its calls are published as the build goes, by something that is alive.

## 6. Evaluation as a job (stage 3)

Three systems need the knowledge base a run built, not only a model: `agent-knode` (its sessions call knode's tools on that index), `knode-ask` (retrieval before its model call) and the build itself. Today that index is opened by the run process and its tools are served from inside it (design 31 D4), so those pieces can only be served while the run is alive; on PGlite no other process could open the index at all.

With evaluation indexes on PostgreSQL (design 31 D1) a build's index is a schema any process can open. Then:

- `serve` hosts a build's tools itself, from the build's schema, for as long as tasks that need them exist;
- a run is a job in `serve`: staged, built, answered, scored, with its records in the run directory as now, resumable and pausable like a research study (design 22);
- `knode-os eval run` submits the job and follows it; closing the terminal changes nothing.

Runs whose indexes are on PGlite keep the run-held host and need the run process alive.

## 7. What does not change

The lease protocol, tokens and scopes (`eval` for evaluation kinds), the session token and tool proxy, the audit of tool calls, short leases with renewals for sessions, the spec-not-argv rule, embeddings staying with the producer, and the run directory with its keyed records and reports.

## 8. Behaviour changes to expect

- A run started with no worker and no `--local` waits, then stops at the wait limit. Today it would run on this machine. This is the point, and it is the one change every existing script feels: scripts that relied on local execution add `--local`.
- Runs take longer when workers are scarce, instead of quietly finishing on another backend.
- A benchmark and a workspace backlog on the same slots share them 1 : 3 instead of evaluation having slots to itself.

## 9. Stages

| Stage | What | Size | Depends on |
| --- | --- | --- | --- |
| 1 | Publish only: D1–D5. The run's local slots, pools, class and weights, the wait limit, `stuck` | small to medium; `src/eval/remote.ts`, `src/eval/run.ts`, `src/work/eval.ts`, `src/work/broker.ts`, the worker's `--pool` | — |
| 2 | Durable tasks and results for independent kinds: D6 | medium; a store in `serve`, a collecting client in the run | stage 1 |
| 3 | Evaluation as a job, tools hosted by `serve`: D7 | large | stage 2, design 31 D1 in use |

Two defects found on 2026-11-14 are fixed in stage 1, since they are placement bugs: a worker's failure recorded as the piece's answer, and an agent session killed by a signal recorded as a successful, empty answer that a resume then skips.

## 10. Open items

- Where `serve` keeps durable tasks: the root data folder, or a schema of its own in the server's database.
- Whether a local slot started by a run is bound by `processing.maxLocalCalls`, which today covers `serve`'s slots only. A run and `serve` on one account otherwise exceed the limit the user set for the machine.
- Whether `judge` calls of a review should carry `requires` too, so a review can be pinned to a pool as a run can.
- How a pool is shown in the Tasks view, next to the worker and backend it already lists.
- Whether `shares.eval` should default to 1 or to 0 (only when idle). The user asked for knowledge-base work first "when all other conditions are equal"; 1 reads that as a preference, 0 as a strict order.
