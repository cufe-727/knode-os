# 32 — One work queue: producers publish, work waits, workers decide where it runs

> **Record status (2026-11-17): Stages 1 and 2 built and merged; stage 3 not built.** This is a decision record, not the description of the system. What the code does now is in [ARCHITECTURE.md](../ARCHITECTURE.md) §7. Stale here: "not merged or deployed" for stage 2; `serve`'s "own six" calls is one machine's setting (`processing.maxLocalCalls` defaults to 2).

Status: stage 1 (D1–D5, §2–§4) built on 2026-11-14 and merged (§11). Stage 2 (D6, §5) built on 2026-11-15 on branch `claude/work-queue-stage-2`, not merged or deployed; §12 says what was built and decided. Stage 3 is a design.

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
| D5 | Tasks carry a class, `kb` or `eval`; a slot that takes both serves `kb` first by weight (decided 2026-11-14: no slot takes both, §4) | Knowledge-base work is the product; a benchmark should not slow it, and should not be starved by it forever |
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

**Decided 2026-11-14: slots stay separate.** `server.remote.shares.eval` orders work only for a slot that asks for both classes, and no slot the worker starts does: its evaluation slots (`--eval`) take only evaluation work, its model slots (`--backends`) only knowledge-base work, and `serve`'s own slots take no evaluation work. So a benchmark and the knowledge base do not share slots. They still share an account's quota when their slots run on one account, with no ordering between them. The broker keeps the weight and its tests, for a slot that would ask for both; none is to.

Weights order work inside a slot. They do not ration an account: two slots on one plan still spend the same quota. The quota floor (`processing.minQuotaPercent`) keeps applying per backend, wherever the slot runs.

## 5. Durable tasks (stage 2)

For the kinds whose pieces do not depend on each other (single-shot answers, judge calls, file-agent sessions), `serve` keeps the task and its result in a store of its own:

- published tasks, by `key`, with their state (`waiting`, `leased`, `done`, `stuck`, `dropped`);
- results until the producer collects them, or for seven days;
- leases are not durable: after a restart a leased task is waiting again.

The producer becomes a client that publishes what its records lack and collects what is done. The open HTTP request per piece goes; the run polls or holds one stream for all its pieces. A run can then exit and resume without losing work in flight.

A knowledge-base build stays as it is: each extraction pass depends on what the pass before found, so its calls are published as the build goes, by something that is alive.

**Where the store lives (decided 2026-11-15): the root data folder, `<root>/.knode/eval-queue/`, one folder per run.**

| Weighed | Root data folder | A schema of its own in the server's database |
| --- | --- | --- |
| `serve` on PGlite or PostgreSQL | the same code either way | two code paths; on PGlite the database is a workspace's, opened by `serve` alone, and evaluation work is the server's, not a workspace's |
| What is already there | the archives sessions read are files beside it (`.knode/eval-archives/`); a run directory keeps its records as keyed files too | nothing evaluation keeps is in a database today |
| Results of megabytes (a session's stdout, up to 32 MB) | a file each, written once, read only when collected, removed with `rm` | rows of megabytes held in a table, vacuumed after; PGlite keeps them in this process's memory |
| Surviving a restart | each task is a file written whole (a temporary file renamed over it); a result written before its task's state is still read as the result | transactions |
| Two `serve` processes | one owner at a time: the store takes `owner.json` (process id and a nonce, created exclusively); a second process that finds a live owner does not open it, keeps its evaluation work in memory as stage 1 did, and says so in `/eval/v1/status` and its log | row locks, but two processes leasing from one table would also need leases shared through it, which this design keeps in memory |
| Size | one bound in bytes, counted from the files | a bound counted in the database |

A transaction is the one thing the database would give that the files do not, and a task changes state at most three times (published, finished, collected), each by one owner. So the files: no migration, no second path, and `eval drop` can remove a run's tasks with `serve` stopped.

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

- A run started with `--remote` and no worker and no `--local` waits, then stops at the wait limit. Before, it would run on this machine. This is the point, and it is the change every `--remote` script feels: scripts that relied on local execution add `--local`. A command line with neither `--remote` nor `--local` (every run before `--remote`, the test suite) still runs on this machine, on slots sized from `--slots` (§11).
- Runs take longer when workers are scarce, instead of quietly finishing on another backend.
- A benchmark and a workspace backlog do not share slots (decided 2026-11-14, §4): evaluation slots take only evaluation work and model slots only knowledge-base work, so `server.remote.shares.eval` orders nothing a worker starts. They still share an account's quota, with no ordering between them.

## 9. Stages

| Stage | What | Size | Depends on |
| --- | --- | --- | --- |
| 1 | Publish only: D1–D5. The run's local slots, pools, class and weights, the wait limit, `stuck` | small to medium; `src/eval/remote.ts`, `src/eval/run.ts`, `src/work/eval.ts`, `src/work/broker.ts`, the worker's `--pool` | — |
| 2 | Durable tasks and results for independent kinds: D6 | medium; a store in `serve`, a collecting client in the run | stage 1 |
| 3 | Evaluation as a job, tools hosted by `serve`: D7 | large | stage 2, design 31 D1 in use |

Two defects found on 2026-11-14 are fixed in stage 1, since they are placement bugs: a worker's failure recorded as the piece's answer, and an agent session killed by a signal recorded as a successful, empty answer that a resume then skips.

## 10. Open items

- ~~Where `serve` keeps durable tasks~~: decided 2026-11-15, the root data folder (§5).
- Whether a local slot started by a run is bound by `processing.maxLocalCalls`, which today covers `serve`'s slots only. A run and `serve` on one account otherwise exceed the limit the user set for the machine. Stage 1 leaves the run's slots outside it (the default this design proposed), so `--local codex:6` beside `serve`'s own six is twelve calls on this machine.
- Whether `judge` calls of a review should carry `requires` too, so a review can be pinned to a pool as a run can.
- How a pool is shown in the Tasks view, next to the worker and backend it already lists. Stage 1 tags a remote worker with its pool and evaluation work with `evaluation`, and puts a piece's required pool in its detail; a better place may come with use.
- Whether a run's own slots should take another run's pieces on the same `serve`. Stage 1 says no (§11).

## 11. Stage 1 as built (2026-11-14)

Commits on `claude/work-queue-stage-1-d8ecd2`, one per step: publish only (`bb88ba9`), waiting (`5fb115e`), failures
(`0dbeb1d`), requirements (`f01fb59`), order (`4f9fe04`), records and report (`7036264`).

**One path.** `eval run` and `eval score` publish every model call, judge call and agent session as a piece
(`PublishedChatBackend`, `remoteJudgeClient`, `publishAgent` in src/eval/remote.ts) to a queue: `serve`'s broker with
`--remote` (the loopback producer channel), or a broker the run starts in its own process (`RemoteEval.own`: the
same `EvalSource`s behind a `WorkBroker`) when there is no `--remote` or `serve` does not answer. The run's own slots
(`--local codex:6,claude:1`) lease from either like a worker — over new loopback routes `/eval/v1/slots/lease |
complete | renew | release` on `serve`, or straight from the run's own broker — and only nothing else does model work.

**Decided where the design left room.**

- *A run's own slots run a piece with the run's own backends*, found by the piece's `key` in the run's process: its
  stand-ins, chains, connections, replay-only backend and agent routing, which exist only inside the run. So they take
  only their own run's pieces (`run` on the slot's identity), and a piece only the run's slots can do — a backend no
  worker has, no `--model`, a session that writes, a stdio MCP server — is published `eligible: local` with nothing
  executable in its spec (`serve` validates it as such and no worker can lease it).
- *A run's own slot's failure is the run's backend's*, not a worker's: what its backend throws is the call's error,
  as before (the shim still retries passing failures), so a local slot never rests and three local slots failing a
  piece never make it stuck. A worker's failure is as §3 says.
- *An old command line keeps working*: no `--remote` and no `--local` means `--local codex:<slots>,<judge CLI>:<slots>`
  (default 6), said in the log and in run.json (`work.legacy`), with `--answer-concurrency` at 3. Its batches, reply
  cache keys and records are what they were; the one difference is that Codex calls and agent sessions now share the
  `<slots>` Codex slots (before, sessions ran beside them, bounded by `--answer-concurrency`), and the judge keeps
  two calls at once (`--judge-concurrency` changes it), whatever `<slots>` is.
- *`--slots`* sizes only that case (a warning with `--local` or `--remote`). *`--answer-concurrency`* is now a bound on
  how wide one system answers; without it a system answers as wide as the slots online for its pieces (at least one,
  so a piece is published and can wait), re-read every second and whenever an answer ends. A knode build is as wide
  as the call slots online when it starts, never narrower than six, so a build on six slots keeps its batches.
- *A run's own slots are in the run's pool* (`--pool`), else in pool `local`; a worker that declares no pool is in its
  token's name, filled in by the server. A piece that names a pool goes only to a slot of it, the run's own included.
- *Waiting* counts a slot that holds a lease as online (a slot at work asks for nothing), for every evaluation kind it
  asked for (a Codex slot busy with calls is online for sessions too), and the run's own slots while the queue
  answers (they lease from it: with `serve` gone they count for nothing, so an outage trips the wait limit). A Codex
  slot of the run waits for this machine's plan before it leases, never while it holds a piece. A piece waits for a requirement (kind, CLI, model, pool, eligibility); the limit applies per requirement
  that no slot online meets. The stop is the run's cancel path: pieces are withdrawn, its sessions are stopped,
  nothing in flight is recorded, the report so far is written, and `eval run` exits 1 naming what it waited for.
- *Stuck* counts machines (`<token>/<worker>`), not slots, and a machine that failed a piece gets it again only when
  nothing else waits for it. A piece is stuck when three different machines could not serve it; when every machine
  online that takes it (its CLI, pool, eligibility, run) has failed it three times — two judge workers, or one machine
  with ten slots, would otherwise pass it between them for ever; or after ten failures in all, however machines came
  and went. A lapse of a run's own slot's lease is no strike (its slots are the run's backend), and a piece runs once
  on the run's own slots: a slot that leases a piece another of them is running waits for that result. An answer, build, update batch or generation score one of whose pieces is stuck is not
  recorded (asked again on resume); a stuck judge call leaves the scoring pass for a resume (its verdicts are in the
  judge cache).
- *Cancelled sessions* are recorded with `error: "cancelled: …"` and `cancelled: true` (an answer with an error is
  asked again on resume); when the run itself is stopping, nothing is recorded at all, as before.
- *`server.remote.offer.eval` off* no longer refuses a run's pieces: remote workers see none, and a run's own slots
  still take them through `serve`.
- *What `serve` says*: no answer or a 5xx is waited out (the piece is published again, an archive uploaded again); a
  4xx is final and stops the run with `serve`'s message (`ServeRefusedError`); a `serve` older than the run (no
  `slots` in `/eval/v1/status`, or an outcome the run does not know) is refused at the start. A run directory whose
  name is no producer-channel run id (spaces, CJK) is given one (`queueRunId`: a slug and a hash).
- *Cancelled sessions in the llm-wiki build* stop the build at that batch (resumed there) and leave an update for a
  resume; neither is recorded.

**Behaviour an existing run script feels.**

- `--remote` without `--local`: nothing runs on this machine; pieces wait for workers and the run stops at
  `--wait-minutes` (30) when none meets them. Add `--local` to keep this machine's share.
- `--remote` with no `--model` (or a chain, connection or stand-in), or a pack with private sources: those pieces are
  `local`, so without `--local` they wait and the run stops at the limit (before, they ran here).
- `--offer-seconds` warns and does nothing; `server.remote.evalOfferSeconds` is not read.
- Widths: a `--remote` run answers as wide as the slots online (before, `--answer-concurrency` plus them), and a knode
  build as wide as the call slots (before, six plus them).
- An incomplete run (stuck pieces), a run stopped at the wait limit, or one `serve` refused exits 1.
- `eval run --remote` against a `serve` older than this build refuses to start.
- An old command line without `--remote` behaves as before (above).

**`serve` restarting while pieces wait.** Survivable within the wait limit, not lossless: the held offer requests fail,
the run treats `serve` as unreachable (nothing counts as online, its own slots included) and publishes each waiting
piece again with backoff once `serve` answers; archive uploads wait the same way; a piece one of its own slots had
done or is running keeps that result and is not published again; a piece a worker had out is lost with `serve`'s
memory, done again, and the worker's late answer is refused. An outage longer than `--wait-minutes` stops the run,
which a resume continues. Durable pieces (§5) are stage 2.

**Review fixes (2026-11-14).** After a review of the first eight commits: the stuck rule above (`0337600`); a piece run
twice on the run's own slots (`073d3de`); refusals, outages and archive uploads (`4b31fc9`); the judge re-asking a stuck
piece (`5a05b36`); online across kinds (`1e8c75a`); a run that fails to start leaving its slots running (`ff95008`);
cancelled llm-wiki sessions (`a6c6786`); retrieval scored after a stop or a stuck call (`705760e`).

**The judge's width (2026-11-14, after the merge).** The judge asked two calls at once whatever was online: a fixed
default in `src/eval/judge.ts` that no run set. On the 10× separation run ten judge slots were online and two were in
use for the whole scoring pass; when it moved from grading (12 s a call at the median) to the list checks (54 s) the
calls per minute halved, which read as concurrency dropping. Now the judge is as wide as the slots online that take
its calls — the same rule as a system's answers — re-read as calls end and once a second while some wait, bounded by
`--judge-concurrency` (2 for an old command line, as before); one gate bounds every call of a judge, and the three
scorers of a pass (usage, lists, emergence) ask it together instead of one after the other. A call that fails stops
the calls of its batch that have not started.

**Not verified.** No model-backed run, no real worker on another machine, no restart of a real `serve` with pieces
waiting (the republish path is covered only by reading the code), and no run with both `serve`'s own slots and the
run's competing for one account.

## 12. Stage 2 as built (2026-11-15)

Commits on `claude/work-queue-stage-2`: the decision (`cd1619f`), the store and serve's side (`308e262`), the run's
side (`66b59b6`), `eval drop` and Tasks (`3f7eec0`). Tests in `tests/work-queue-durable.test.ts` (the store, a
restart of serve with a run waiting, a run that exits and resumes, two producers, compatibility) and a Tasks case in
`tests/explore-tasks.test.ts`.

**The store** (`src/work/eval-store.ts`, decided in §5): `<root>/.knode/eval-queue/<run>/<key>.json` holds a task
(kind, the run's scope, state, publish time, deadline, the spec while it waits) and `<key>.result.json` its outcome.
Every write is whole (a temporary file renamed); a result is written before the state, so a task that reads `waiting`
beside a result that parses is done at load. `owner.json` (pid and nonce, created exclusively) makes one process the
owner; a second `serve` keeps its evaluation work in memory and says why in its log, in `/eval/v1/status`
(`tasks.durable: false, reason`) and on the Tasks card; an owner whose process is gone is taken over.

**The task's life** (`EvalSource` in `src/work/eval.ts`, with the store):

- *Published* by run and key. A key waiting or out is that task: the newer spec (a resumed run's tools endpoint) and
  the later deadline win. A key done is its stored result, and counts as collected. A key stuck or dropped waits
  again: publishing it again is a resume asking again, as stage 1's resume did. A key done by one of the run's own
  slots (`local: true` on the outcome) also waits again: its value lived in the process that ran it, and the process
  that ran it never publishes it again (it has the value).
- *Leased* in memory only. After a restart every task the store holds waiting is waiting, strikes counted afresh; the
  old lease is unknown, so its late answer is refused (`unknown or expired lease`) and the piece is done once, by the
  lease that is current.
- *Waiting for its run*: a session that calls the run's tools (its MCP bridge lives in the run) is leased only while
  its run is attached — it published, polled or read its status within 60 s, or holds a stage-1 offer. Everything
  else is leased whether or not the run is there.
- *Deadline*: 24 h from its publish unless the producer names one (`deadlineMs`, at most seven days); each poll that
  asks after it pushes it on by the same span (written to the store when within half of it). A task still waiting at
  its deadline is dropped, never run; one out finishes and its result is kept.
- *Kept*: a result for seven days after it was done, or a day after it was first collected; a dropped task a day.
  Pruned every ten minutes and at load. Collecting does not delete: a run that collected and died before recording
  collects it again.
- *Bounded*: `server.remote.evalQueueMB` (default 2048) over tasks and results. A publish past it first removes
  results already collected, oldest first; still past it, it is refused with 507 and a message naming the setting and
  `eval drop`, and the run stops with that word (`ServeRefusedError`). A result of a task out now is always stored.
- *Archives* (`.knode/eval-archives/`) a waiting session needs are kept however old they are.

**The producer channel** gains `POST /eval/v1/tasks` ({run, scope, deadlineMs, specs}, at most 200: each answer is
the task's state or its stored result), `POST /tasks/poll` ({run, keys, waitMs}: held up to 25 s until one is done;
keys serve does not have come back `missing`), `POST /runs/<run>/detach` and `DELETE /runs/<run>?scope=`. `/status`
says `tasks: {version: 2, durable, reason, tasks, bytes, maxBytes}`. `/offer` and `/runs/<run>/cancel` stay.

**The run** (`ServeQueue` and `RemoteEval` in `src/eval/remote.ts`):

- *Keys*. Stage 1's keys were random; now a piece's key is a digest of what it is — the run directory (so two run
  directories of one name never share pieces), kind, CLI, model, effort, speed, eligibility, pool, label, the system
  and task it is for (a repeat's task carries `~r<n>`), the caller's content (a call's messages, JSON flag, schema,
  effort and stage; a judge call's messages; a session's prompt, sandbox, steps and label) and the spec's (prompt,
  schema, archive, tools) — with `-<n>` for the n-th piece just like it in this process. That is the reply cache's
  identity (src/eval/shim.ts) plus the occurrence. A resume that asks what its records lack in the order it asks
  finds the same keys. The known limit: two identical pieces under one tag (a judge audit asking one prompt twice)
  where a resume asks only the second get the first's result, as the reply cache would.
- *Publishing*: pieces join a batch (100, every 20 ms) and one poll waits for all those published; a new batch
  restarts the poll with the larger set. Serve not answering ends every published piece `unreachable`: as in stage
  1 the run counts serve as gone (nothing online, its own slots included, the wait limit running) and publishes them
  again with backoff, and serve answers with the same tasks or their results.
- *A run that stops* (a signal, `--wait-minutes`, a refusal, its caller's cancel) detaches: only what it alone can
  serve is withdrawn — its own slots' pieces and sessions on its tools, whose tokens end — and the rest stays for a
  worker, its results kept for the resume. Before, every piece was withdrawn. `eval drop <run-dir>` withdraws the
  rest.
- *The run's own slots* lease as before, through serve's queue or the run's own broker. The run's own broker
  (`OwnQueue`, no `--remote` or no serve) stays in memory: an `EvalSource` with no store, as in stage 1; nothing of it
  outlives the run, and going away cancels everything.

**What is not durable, and why.** A knowledge-base build's model calls (knode's extraction passes, the llm-wiki
builder's sessions) are published like any piece, so each call out survives a restart of serve and its result waits
for the build; but the build itself is the run's process, which publishes the next pass only once it has the one
before. Across a restart of serve the build waits and goes on; across an exit of the run it resumes where its own
checkpoints say (`eval-build-resume`), and the calls it asks again with the same content get the stored results
(a call it asks with other content — a pass that depends on a different earlier answer — is a new piece). Its
sessions that write (the llm-wiki builder) are the run's own slots' and are asked again. Pieces only the run can
serve, and leases, are not durable by design.

**Behaviour an existing run script feels.**

- Stopping a `--remote` run (Ctrl-C, the wait limit) leaves its pieces that workers can do in serve: workers may
  finish them while it is stopped, and a resume within a day (their deadline) collects them instead of asking again.
  `eval drop <run-dir>` removes them, and the run's results in serve.
- Running a run directory again after clearing its records gets the results serve kept for it (seven days), as
  its reply cache would; `eval drop` first to ask again.
- A restart of serve while a run waits loses nothing that was waiting or done; a piece a worker had out is done
  again from the start by the next lease.
- Nothing changes without `--remote` (the run's own broker).

**Compatibility.** A run from stage 1 against this serve uses `/offer` as before (its piece is kept in the store
while its request is open and dropped when it closes it); its random keys never meet. This run against a serve from
stage 1 (no `tasks` in status) uses `/offer`, logs that pieces are one request each, and on stopping cancels its pieces
as stage 1 did. A serve restarted onto stage 1 mid-run refuses `/tasks` with 404 and the run stops with that. Workers
need no change: the lease protocol, tasks and outcomes are as they were (outcomes gain an optional `local`).

**Not verified.** No restart of the live serve, no real worker on another machine (the tests' worker leases through
the sources as `/remote/v1` does; the spawned-worker suite in `tests/remote-eval.test.ts` runs against the durable
store), no model-backed run, no run large enough to meet the size bound, and no two serve processes as separate
processes (two owners in one process and a dead owner's file are tested; the pid check across processes is read, not
run).

**What stage 3 now needs.** Durable pieces let a run die and come back; what still needs the run alive is what only
it can serve: the knode tool host and its index (design 31 D4: on PostgreSQL serve could host a build's tools from
its schema, and the sessions that call them stop waiting for the run), the run's own backends behind `eligible:
local` pieces (stand-ins, chains, connections, replay), and the build's progress (its passes). So: (1) serve hosts a
build's tools, (2) a run becomes a job in serve that holds its records' directory and its producer state (the
occurrence counts above are the producer's state today), (3) `eval run` submits and follows it, (4) the judge and the
run's own slots become serve's slots, bounded by `processing.maxLocalCalls` (§10). The store needs nothing more: a job
is one more producer on the same channel.

