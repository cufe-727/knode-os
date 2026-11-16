# 35 — Evaluation workspaces: a run's knowledge bases open in the app

Status: design (2026-11-17). Nothing built.

## 0. Why

An evaluation builds a knowledge base for every pack it runs, and nobody can look at one. When a system scores badly the only ways in are the run's records and a replay script: the pages the build wrote, the entities it merged and the claims it kept cannot be browsed, searched or asked the way a real workspace can.

The gap is small. What a run builds is already a workspace folder:

- `<run>/work/<pack>/knode/ws` holds `knode.config.json`, `raw/`, `wiki/`, `ledger/`, `playbooks/`, `purpose.md` and `schema.md`, made by the product's own `createContext` (`src/eval/systems/knode.ts`).
- Its index is an embedded PGlite database inside that folder (1.0 GB for the 10× build of 2026-11-14), or a schema `eval_…` in the database `knode_eval` on PostgreSQL (design 31 D1). No run has used PostgreSQL yet: `knode_eval` does not exist on this machine's server.

What stops it being opened:

- `serve` lists only `users/<user>/workspaces/<id>` and `teams/<team>` under its own data root (`src/global-settings.ts` `workspaceDirs`, `src/server/workspaces.ts`). A run's folder is outside every root.
- Opening one in `serve` as it is would change it. `serve` writes the root's shared settings into each workspace it opens (`syncWorkspaceSettings`), starts processing, the folder watch, feeds and the nightly pass, and counts search hits. A build must stay as the run scored it (design 31 D3).
- The build's config names the run's shim for every model and for embeddings. After the run that port is closed.

The packs today (`~/knode-eval/packs`, 31 folders):

| Group | Packs | Documents each | Questions each |
| --- | --- | --- | --- |
| Domain and public pilot packs | 11 | 48–448 | 25–155 |
| Synthetic life v1–v3 | 3 | 95–168 | 52–114 |
| Synthetic reports zh/en v1–v2 | 4 | 141–142 | 93–210 |
| Synthetic reports v3 zh/en | 2 | 473 | about 565 |
| Synthetic reports at scale (zh ×10, v3 ×10, v3 ×100) | 3 | 1,420 / 4,730 / 47,300 | 1,896 / 607 / 607 |
| Real documents (Loong finance, MuDABench, wiki hops, CRUD news) | 4 | 574 / 397 / 4,025 / 92,044 | 624 / 107 / 1,120 / 2,394 |
| 300-question samples of three real packs | 3 | same corpora | 300 |
| Test fixture | 1 | 7 | 9 |

The two largest are the size of the live finance workspace (45,795 documents, 23 GB in PostgreSQL) or larger.

The user's proposal (2026-11-17), which this design adopts: make each evaluation build a knowledge-base workspace that can be inspected like any other, built from scratch by the run that owns it, so that evaluation and the product use the same thing.

## 1. Decisions

| | Decision | Why |
| --- | --- | --- |
| D1 | Evaluation builds live in an **evaluation root**: a data root of their own (`~/knode-eval/server` by default), never the live root | Settings are server-wide since 2026-11-12; a build needs its run's pinned models. A build in the live root would also share the six-call limit, the background floor, feeds and the nightly pass with real workspaces |
| D2 | One workspace per run and pack, created by the run through the product's own workspace path | A run's score is about one build. Two runs of one pack stay side by side, which is how a fix is checked |
| D3 | A run that builds, builds from scratch. A resume, a re-score or a re-answer of the same run uses the workspace it has | The build is the expensive part: hours of model calls at 10×, 50–150 times that for the real-document packs |
| D4 | `serve` on an evaluation root is a **viewer**: it changes no workspace | Answers must not depend on whether somebody looked |
| D5 | The viewer opens the index the build recorded, on the backend it was built on | A name derived again from where the folder was found could open an empty schema |
| D6 | Only the run process writes a build | One writer, as design 31 D2 requires on PGlite and as update batches need on either backend |
| D7 | Gold, holdout and task files never enter a workspace folder or its index | The agent arms read the folder |
| D8 | Running evaluation through `serve` itself (design 32 §6) is a later stage on the same root, not part of this change | This design makes the place; that one moves the work |

## 2. The evaluation root

An ordinary data root with its own `knode.config.json`, made by `knode-os eval root init` and on first use by `eval run`.

- **Where.** `$KNODE_EVAL_HOME/server`, default `~/knode-eval/server`. `eval run --root <dir>` and `KNODE_EVAL_ROOT` name another.
- **What marks it.** `server.evaluation: true` in the root's config. Commands that write an evaluation workspace refuse a root without it, and `serve` enters viewer mode with it (§4).
- **Database.** The rules of design 31 D1, unchanged: PGlite inside each workspace, or one schema per workspace in `knode_eval` with the prefix `eval`. The root's config holds no credential; a password stays in the environment as now. `eval root init` and `eval run` refuse a root whose database is the server and database of a live root (`--config-from`'s, else the default data root's).
- **What it never has.** Feeds, datasources, a nightly schedule (`dream.schedule: "off"`), a folder watch (`ingest.watch: false`), remote workers' API, shared settings pushed into workspaces. `eval root init` writes these; the viewer does not rely on them (§4).
- **Accounts.** The root has its own `.knode/accounts.json`. Sign-in stays on. The user creates the account (`knode-os user add <name> --admin --data <root>`); no command of this design creates one or stores a password.

## 3. A build as a workspace

**Placement.** The knode group's workspace moves from `<run>/work/<pack>/knode/ws` to the evaluation root, in the layout `serve` already lists. The run directory keeps `work/<pack>/knode/workspace.json` (`dir`, `kind`, `schema`) in its place, and everything else it has today: answers, scores, events, the RAG and grep groups' folders.

**Name.** `<run id>--<pack id>`, and `--<group>` when a run has more than one knode group. Slugged by `workspaceSlug`. The run id is the run directory's name with its parent when that is not `runs` (`separation-2026-11/run-10x` gives `separation-2026-11-run-10x`).

**Who sees it.** Every account of the evaluation root sees every evaluation workspace, grouped by run, newest first. The cheapest way to get there is to file them under one owner (`evaluation.owner` in the root's config, default `eval`) and list that owner's workspaces to every signed-in account of a root marked `evaluation`; the implementer may choose another as long as the list is the same.

**Manifest.** `.workspace.json` gains an `evaluation` object, written by the run and shown by the viewer:

```json
{
  "id": "…", "name": "separation-2026-11-run-10x · synthetic-reports-zh-x10", "kind": "personal", "owner": "eval", "createdAt": "…",
  "evaluation": {
    "run": "/Users/…/runs/separation-2026-11/run-10x", "runId": "…", "pack": "synthetic-reports-zh-x10", "packVersion": 1,
    "group": "knode", "fraction": 1, "seed": "0", "fingerprint": "…",
    "state": "building | built | updating | failed",
    "batchesApplied": ["01", "02"],
    "builtWith": { "version": "0.1.0", "commit": "2b1e43c", "schema": 21 },
    "models": { "build": "…", "embedding": "pool:bge-m3:1024:l2-v1" },
    "writer": { "pid": 12345, "since": "…" }
  }
}
```

`writer` is set while a run holds the workspace and removed when it lets go; a stale one (its process gone) is cleared by the next run or viewer that reads it.

**Index.** `.knode/eval-index.json` stays as design 31 wrote it (`kind`, `schema`, the workspace it belongs to). On PostgreSQL the schema is still named by `schemaNameFor` from the workspace's directory, which is now its directory in the root; the schema's comment still names that directory, so `eval drop --orphaned` works as before.

**Lifecycle.**

- *Build.* A run creates the workspace, drops any index the name still has, and builds. A second build in the same run (after `--rebuild`, or a failed attempt) replaces it.
- *Resume, re-score, re-answer* (`--run-dir`, `eval score`). The run reads `workspace.json` and opens what is there. It refuses when the manifest's `runId` is not its own.
- *Reuse* (`--reuse-builds-from <run>`). The new run gets a workspace of its own: the folder copied, the schema cloned (`cloneSchema`) or the PGlite directory copied, the manifest rewritten. The source is not touched.
- *Update batches.* Applied in place, as now. The manifest's `batchesApplied` says what state the workspace is in; the viewer shows it in the workspace's header. A workspace shows the state after its last batch, not the state each update question was asked against. Snapshots per batch are not built (§9).
- *Drop.* `knode-os eval drop <runDir>` removes the run's workspaces from the root, folder and index, through `dropBackend` as now. It never removes a workspace whose manifest names another run.
- *Old runs.* A run made before this change keeps its layout and resumes as it was (`run.json` gains `workspaces: "root"`; absent means the run directory). `knode-os eval adopt <runDir>` copies an old run's knode builds into the root as workspaces without changing the run directory, so the builds of 2026-11 can be opened.

**What must not be in it (D7).** The run copies only the staged corpus. A check after staging and after every update batch fails the build when the workspace folder holds a file whose content hash matches a file under the pack's `gold/`, `holdout/` or `tasks/`.

## 4. The viewer

`knode-os serve --data <evaluation root>` on a root marked `evaluation`. Loopback only.

What it does not do, for any workspace of such a root:

- write the root's settings into the workspace (`shareSettings` is skipped);
- start processing, embedding slots, the folder watch, feeds, conversations, codebases, research, translation, labeling, the nightly schedule or heat flushing;
- count hits: every search, graph and Ask call of the viewer runs with `track: false`;
- migrate. A workspace whose schema version differs from the viewer's is listed with what built it (`builtWith`) and does not open;
- accept a write. Every route that changes a workspace answers `409` with `evaluation workspaces are read-only`, and `/mcp` exposes only the reading tools.

How that is enforced, not only intended:

- On PostgreSQL the viewer's pool for an evaluation workspace sets `default_transaction_read_only = on`, and `Store.open` takes a `readOnly` option that skips migrations and every upkeep step after opening (`cleanup`, `retype`, `relationSources`, `indexing`), reading which match indexes exist instead of building them.
- On PGlite there is one opener at a time (design 31 D2). The viewer opens a build only when no run holds it and says who does otherwise. It opens with the same `readOnly` option; PGlite has no read-only transaction setting, so there the option and the refused routes are the whole guarantee.
- A workspace whose manifest has a live `writer` on PGlite, or whose `state` is `building`, is listed and not opened. On PostgreSQL a workspace in `updating` opens read-only and its header says a batch is being applied.

What works in the viewer at stage 2: the file tree, pages, documents, entities, the graph, claims, the suggestions and disputes lists, keyword search, and the workspace's numbers (`stats`, `survey`). Vector search and Ask need a model the build's config can no longer reach; they come at stage 3.

**Port.** `12040`, in knode-os's block of `/Users/ning/Projects/service-config/services.json`, bound to `127.0.0.1`, not published through the tunnel, started by hand, not a LaunchAgent. It fails on a conflict. The registry gains `eval_view_port` when stage 2 lands. (`12030` is taken: the separation run's evaluation broker has listened there since 2026-11-14 and is not in the registry; `12020` is the benchmark embedder.)

## 5. Asking and searching by meaning (stage 3)

The viewer may lend a workspace models without writing them into it:

- An **overlay**, in memory only: the evaluation root's own connections stand in for the build's shim for Ask, chat and query embedding. The workspace's `knode.config.json` is not rewritten.
- Query embedding is used only when the root's embedder carries the model label the build's vectors have (`models.embedding` in the manifest). Otherwise search stays keyword and graph, and the page says so.
- Ask in the viewer is for looking, not for scoring: its answers are not written to any run.

The root's connections are the user's to set, and spending on them is the user's choice; nothing here turns one on.

## 6. What does not change

- What a run measures. The arms, the packs, the scoring, the records in the run directory.
- Which systems have a workspace: the knode group only. `agent-grep` reads the staged corpus and the RAG group keeps its index in the run directory; neither is a knowledge base.
- The rules of design 31: the evaluation database is never the live one, one open per PGlite index, answering does not write.
- `eval run`'s options. `--pglite`, `--database-url` and `--config-from` mean what they meant.

## 7. Sizes to expect

| Build | Workspace on disk |
| --- | --- |
| A 1× pack (100–500 documents) | tens of MB |
| Synthetic reports zh ×10 (1,420 documents), measured | 1.0 GB on PGlite |
| Synthetic reports v3 ×10 (4,730 documents) | a few GB |
| v3 ×100, CRUD news (47,300 and 92,044 documents) | about what finance takes: 20 GB or more |

The viewer's list shows each workspace's size, and `eval drop` is how space comes back. Nothing is dropped on its own.

## 8. Stages

| Stage | What | Done when |
| --- | --- | --- |
| 1 | The evaluation root; builds placed in it as workspaces with the manifest; resume, reuse, update batches and drop on the new layout; the leak check of D7; old runs resume unchanged | The suite passes; a fixture run on PGlite and one on PostgreSQL build, resume, reuse and drop with the same answers and scores as before the change; an old-layout fixture run resumes |
| 2 | Viewer mode in `serve`; `Store.open` read-only; the listing; `eval adopt`; the port in the registry | A fixture build opened in the viewer: every reading page works; a write route answers 409; row counts and a content hash of every table are the same before and after browsing, on both backends; a workspace held by a run is listed and not opened on PGlite |
| 3 | The model overlay for Ask and vector search | Ask answers in the viewer with the root's connection; the workspace's files and index are byte-identical afterwards |
| 4 | Design 32 §6 on the evaluation root: a run is a job in the evaluation server, which hosts the build's tools | See design 32 |

Stages 1 and 2 are one piece of work. Stage 3 is small once 2 is in. Stage 4 is design 32's.

## 9. Open items

- **Snapshots per update batch.** Cloning the schema before each batch would let every update question's state be opened, at one more copy of the index per batch. Not built; say if it is wanted.
- **Keeping only the newest build of a pack.** Runs accumulate. A `--supersede <runDir>` that drops the older run's workspaces once the new one is built would cap it. Not built.
- **The Mac app.** It talks to one server. The viewer is reached in a browser at `http://127.0.0.1:12040`.
- **The port.** 12040 is a proposal inside knode-os's block; any free port of the block will do. The broker on 12030 should be entered in the registry or stopped, whichever the user prefers.

## 10. Decided by the user (2026-11-17)

- Evaluation builds become workspaces that can be inspected, served from a root of their own, not the live one.
- A run builds its workspaces from scratch; one workspace per run and pack.
- Evaluation and the knowledge base should run on the same thing, which is where stage 4 goes.
