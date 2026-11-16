# 12 — Remote processing: embeddings, summaries and reviews on remote workers

> Status: **phases 1 and 2 implemented** (2026‑10‑18): the work broker, summaries as leased work, `work/*` with
> `work/config`, worker kinds and hints, and the Judge stage's review calls fanned out to `serve`'s judge slots and
> remote workers (§9). **Phases 3 and 4 implemented except lent keys** (2026‑11‑06, `src/work/embed.ts`): the
> `deferred` embedding mode with the chunk backlog and audit requests as `embed` work, `serve`'s embed slots, the
> identity filter in vector queries, the `embed` scope, and own endpoints with calibration and spot checks — on a
> remote worker (`--backends embed:N`) and on `serve`'s own machine (`ingest.embedEndpoint`, set and checked in
> Settings). Lent keys (§4.2) are not built: the `embed-keys` scope exists and grants nothing yet. What differs from
> the plan is in §12. Extends [remote labeling](../remote-labeling.md),
> which leased only tier-1 extraction, to the Index stage's vectors, the Summarize stage and the Judge stage's review
> calls. Workers read the embedding configuration, and hints for the LLM stages, from the server instead of being
> configured by hand.

## 0. Where things stand

What calls a model, and where (code as of a6c93a2):

| Step | Runs in | Calls | At once |
| --- | --- | --- | --- |
| Extract | leased segments (`src/labeling/scheduler.ts`): serve's slots or remote workers | Extract route, or the worker's own model | one per slot |
| Index: chunk vectors | sync, per document (`applyDocScope`, `src/ingest/apply.ts`) | `ctx.embedder` | `ingest.concurrency` documents; each document's batches one after another |
| Entity vectors | the duplicate-entity audit (`src/graph/dedupe.ts`) | `ctx.embedder`, 32 per batch | one batch; stops at the first failure |
| Claim vectors | the duplicate-claim audit (`ensureClaimEmbeddings`, `src/graph/claim-dedupe.ts`) | `ctx.embedder`, 32 per batch | one batch; stops at the first failure |
| Summarize | the summary loop (`src/labeling/followup.ts` → `ensureSourceSummaries`) | Summarize route | `summaryConcurrency` (default `concurrency`) |
| Entity judge | the duplicate-entity audit, step 3b | Judge route | one call at a time, at most `maxJudgedPerRun` |
| Claim judge | `judgeBatch` in the duplicate-claim audit | Judge route | one call (12 pairs) at a time |
| Claim review, nightly entity audit | the tier-2 pass (`refineWiki`, daily) | Judge route | one call at a time |
| Query vectors | search, SAG, Ask | `ctx.embedder` | one per query |
| Convert, Ask, Chat, Research, Dream | serve | their routes | — |

Only extraction can leave the Mac mini. On finance it already has: both entries in `extraction.workers` have 0 slots,
so every extraction call runs on a remote worker. Summaries (3 at a time) and reviews (one call at a time) still run on
the Mac mini, on `connection-3`.

Finance, read-only queries against the local Postgres and the usage ledger (2026‑10‑17):

| Item | Value |
| --- | --- |
| Embedding pool | bge-m3, 1024 dimensions; 12 keys (9 Cloudflare, 2 SiliconFlow, 1 OpenRouter), 2 requests in flight per key → **24** at most |
| Daily caps, summed | **50 M** tokens |
| Ledger (all workspaces) | 10‑13: 6,339 requests, **49,999,079** tokens · 10‑14: 9,555, 32.8 M · 10‑15: 3,572, 7.4 M · 10‑16: 5,244, **49,997,678** · 10‑17 so far: 3,655, 39.6 M |
| Chunk vectors | 3,919 of 3,919 chunks (151 documents indexed, 110 waiting for extraction) |
| Entity vectors | 6,985, for 45,030 entities |
| Claim vectors | 45,615, for 175,792 claims |

The other two workspaces hold 18 chunks between them, so the ledger's volume is finance's. Three things follow:

1. **Lending the pool's keys to other machines adds no capacity.** The daily caps were reached on 10‑13 and 10‑16,
   and a call on a lent key counts against the same cap wherever it runs. Remote embedding adds capacity only on
   endpoints the server does not have: a model on the worker's own hardware (bge-m3 on a GPU has no quota), or the
   worker's own accounts.
2. **Between those days the pool sits mostly idle.** Sync keeps at most 4 requests in flight and the audits keep 1,
   against the pool's 24. Reaching the cap is a scheduling problem on the server, and it doesn't need remote workers.
3. **The audits do their embedding inline.** They embed what each review needs, one batch at a time inside the review.
   When the pool runs dry they stop embedding and carry on with fewer candidates, and nothing reports it beyond a log line.

## 1. Decisions

1. **One lease protocol, several kinds.** The extraction lease (lease / complete / renew / release) becomes the lease
   for every kind of work: `extract`, `summarize`, `judge` and `embed`. A worker says which kinds each slot takes. The
   server says which kinds it offers.
2. **The server stays the only writer and the only judge of results.** It builds every prompt and every embedding
   input, checks every reply and vector, and writes them. Workers run calls and hand back raw answers, as remote
   labeling does now.
3. **Summaries are pulled; review calls are pushed.** A worker asking for a summary gets the next document due one,
   just as it gets the next segment. A review builds all its judge calls at once and waits for them, each with a deadline.
4. **Sync never waits on a worker.** In the new `deferred` embedding mode, sync writes chunks and their keyword index
   and leaves the vectors to a backlog. `inline`, the current behavior, stays the default.
5. **The server's ledger stays the only quota authority.** A task on a lent key carries a reservation made at lease
   time and is settled when it comes back.
6. **Keys are lent only by opt-in, per key and per token.** A key must be marked *Lend to remote workers*, and the
   token must hold the new `embed-keys` scope.
7. **A worker reads its configuration from the server** (`GET …/work/config`): the embedding identity, lent
   credentials, the kinds offered, and model hints from the stage routes.
8. **Query vectors, Ask, Chat, Research, Dream and Convert stay on the server.** Query vectors, Ask and Chat need
   answers within seconds. Research and Dream run tool-using loops rather than single calls. Convert needs page images
   in the task (§10).

## 2. The flow

```
                       ┌─────────────────────── Mac mini: knode-os serve ───────────────────────┐
  sources              │                                                                         │
   extract   segments ─┤                                                                         │
   summarize documents ┤──▶ work broker ──lease──▶ serve's own slots, per kind                   │
   judge     calls    ─┤       ▲    │                                                            │
   embed     batches  ─┤       │    └── reserve at lease, settle at completion ──▶ quota ledger  │
                       │       │                                      (~/.knode-os/embedding-usage.json)
                       └───────┼─────────────────────────────────────────────────────────────────┘
                               │  /remote/v1/w/<owner>/<workspace>/work/{config,lease,complete,renew,release,status}
                     remote workers: codex:2, cursor:2, embed:4, …
```

- A **source** makes tasks of one kind and knows what a result means.
- The **broker** keeps one lease table, the worker records, the share between kinds, and the status.
- A **slot** is anything that leases: one of serve's own or one on a remote worker. Both kinds of slot get the same tasks.

## 3. Kinds

| Kind | Unit | Source | Checked and written by | Offered to remote workers by default |
| --- | --- | --- | --- | --- |
| `extract` | one segment | the labeling scheduler, unchanged | unchanged: sidecar, then the graph | yes, as now |
| `summarize` | one call: a document, or one segment of a long one, or the merge of its parts (docs/design/14) | documents due a summary page | the part cache or the summary cache, then the page | yes |
| `judge` | one call | a running review | the review that made the call | no |
| `embed` | a batch of texts | the chunk backlog and the audits | the vector tables | yes, on lent keys or a calibrated own endpoint |

### 3.1 summarize

The summary page already caches its body in the document's sidecar, keyed by content hash (`writeSourceSummary`), and
the `source_summary` generator in `src/wiki/pages.ts` reuses the cached body when `contentSha` matches. That cache is the
hand-off:

- Due documents are picked the way `ensureSourceSummaries` picks them now: indexed sources under `raw/docs` not waiting
  for extraction, whose page is missing or dirty and which have failed fewer than 3 times. Documents out on a lease are
  skipped.
- The prompt is the one `render` builds: `SOURCE_SYSTEM` plus the source text, cut at `LLM_WIKI_INPUT_CHARS`. It moves
  into a function that both use.
- A good reply goes to `writeSourceSummary` along with the worker's model. The page is then regenerated on the follow-up
  chain, where the cached body means no model call, so a summary and a review still never write a page at once.
- Failures count as they do now: `recordSourceSummaryFailure` for a bad answer; a transient failure keeps its
  attempts. A reply for a document that changed since the lease is dropped.

The summary loop in `followup.ts` becomes serve's summarize slots: `summaryConcurrency` slots on the Summarize route,
behind the Processing button as now.

### 3.2 judge

Before phase 2 the entity judge and the claim judge called the Judge route one at a time inside the follow-up review.
Each now builds all its prompts first, then hands them to a `JudgeRunner` (`src/work/judge.ts`). In `serve` that is
the judge source, which offers the calls together as leased work and waits for all of them:

- Each call has a deadline (`server.remote.callDeadlineMinutes`, default 20). A call that misses it fails as transient.
  The review handles it as it handles a failed call now: no verdict, and the pair comes up again in a later round.
- serve's own judge slots (`review.concurrency`, default 2, on the Judge route) take these calls while processing runs.
  Even with no remote worker, a review then runs its calls in parallel instead of one after another.
- Each verdict records the model that gave it (`remote:codex:…`), as extraction does.
- A remote verdict merges without a person (`review.llmJudge` or `review.claimMerge` set to `auto`) only when its model
  is in `server.remote.judgeModels`, which is empty by default. Otherwise it is filed as a suggestion with the verdict
  attached. The same holds for the entity judge's automatic rejection: a remote "different" verdict outside the list
  leaves the suggestion open instead of closing it. Verdicts that change nothing (a claim pair judged unrelated) are
  remembered as any verdict is.
- Remote workers get `judge` calls only when `server.remote.offer.judge` is on.
- A reply that is no JSON object is a bad answer: the call goes out again, up to three times. Stopping processing gives
  up the calls nobody has taken yet; the review goes on with the verdicts it has.
- The judge counts as available when this machine has judge slots on a Judge route with a model, or when remote
  judging is offered and a worker asked for judge calls in the last two minutes. Otherwise a review files its
  candidates unjudged, as it does with no Judge model, instead of waiting out the deadline.

The nightly tier-2 pass (`refineWiki`: the claim review and the nightly duplicate-entity audit) runs whether or not
processing is started, so it can't count on serve's slots. It keeps calling the Judge route itself, one call at a time
(§10), as do `knode-os extract` and an initialization.

### 3.3 embed

One queue fed from two places:

- **The chunk backlog** (in `deferred` mode only): chunks of indexed documents that have no vector for the current
  identity, newest documents first. The query is an anti-join on `embeddings`' primary key. Chunk ids out on a lease
  are held in memory.
- **Audit requests**: a `BrokeredEmbedder` implements `EmbeddingProvider`. Its `embed(texts)` cuts the texts into
  batches, offers them, and waits (deadline 5 min). The follow-up hands it to the audits as their `embedder`, so
  `dedupe.ts` and `claim-dedupe.ts` stay as they are. A missed deadline is an embedding failure, which the audits
  already handle.

The server cuts batches the way the pool does now: no more than the smallest member's `batchSize`, within the smallest
minute-token allowance, each input cut to `EMBED_INPUT_CHARS` (8,000).

When a batch comes back, the server:

1. checks the count, the dimension, that every value is finite and that the norm isn't zero, as
   `PooledEmbeddingProvider` does now;
2. post-processes as the identity says (the pool L2-normalizes). Workers return raw vectors, so a vector from a remote
   worker ends up identical to one serve made itself;
3. drops the batch if the identity changed since the lease;
4. writes the rows in one transaction. It skips chunks and claims that no longer exist, and entities whose `fold_sha`
   changed since the lease;
5. settles the reservation (§4.2).

serve's own embed slots (`ingest.embedSlots`, default 8) lease from the same queue. They run whether or not
processing is started, as embedding does now.

#### The `deferred` mode (`ingest.embedding: "inline" | "deferred"`)

`inline` is what sync does now. `deferred` changes three things:

- A new or changed document becomes keyword-searchable as soon as sync writes it. It becomes vector-searchable once its
  batch lands.
- Changing the embedding model no longer re-applies every document. The backlog refills for the new identity and drains.
- Vector queries must filter on the identity. Today `search.ts` and `sag.ts` read `embeddings` without
  `WHERE e.model = …`. The filter belongs there in both modes, because the current re-embed sync also mixes two models'
  vectors until it finishes. While a migration is under way, the HNSW walk returns fewer than `k` rows, because the
  filter applies after the index scan.

  **Since 2026‑11‑15 (src/search/search.ts `vectorSearch`).** The same effect starved search of sources where
  generated pages are the nearest vectors, so a search's vector statement turns on pgvector's iterative index scan
  for itself (`hnsw.iterative_scan = relaxed_order`, with `hnsw.max_scan_tuples` set to 2,000): the walk goes on
  until `k` rows pass the filter. Since the same day it does so only where it must: one walk of the nearest 40
  chunks serves both sides, and the walk is carried on for the sources only when those 40 hold fewer than `k` of
  them. (Forty for the 24 candidates a search for 8 asks of each channel; since 2026‑11‑16 five thirds of the
  candidates beyond that — 100 for a search for 20 — with `hnsw.ef_search` raised to as many for the statement,
  never lowered: held at forty, every search for 14 or more walked on. The pages' side stays the pages among the
  first forty, however wide the walk.) Carried on for each side, it made a search three to five times slower on a copy of the finance index
  (562,563 chunks, an eighth of them generated pages, seldom among the nearest): 192 to 272 ms at the median with
  nothing in memory, against 76 to 81 before any of this and 48 to 56 now. No server setting is involved, and
  none needs changing.

  A search its caller narrowed — to kinds or places (`kinds`, `sources`), to a trust tier or an actor's reading
  (`trust`, `actor`), or to a date (`asOf`) — is costed for itself (since 2026‑11‑16;
  `scopedRows`): the side is the caller's choice and may lie anywhere from the question, so the 2,000 rows a search
  of everything spends on a side are not its bound. Its measure is √(8 · k · chunks) rows, 10,000 at the most (the
  finance index is at that limit). Each side is judged on its own: one that holds half as many chunks again at the
  most (`scopedReadRows`: 15,000 there) is ranked by reading its vectors, a larger one by walking the index for the
  measure's rows, half each where both sides are walked. The two were equal for a day, and a folder a little over
  them and away from the question (12,383 chunks) was walked for 10,000 rows in most of a second and came back
  short for 17 questions of 30, where reading it takes 153,000 blocks and a tenth of a second. (For a day the two sides shared one budget, the smaller read first: a folder read beside pages left
  the pages a walk of a few hundred rows that found none and said nothing.) Each walk is a step of its own in the
  statement, that many rows of the index at the most, each row looked up as it is pulled: the planner cannot answer
  by reading the side instead (left to choose, it ranked 34,000 chunks of four folders without the index, 420,000
  blocks), and a side near the question ends its walk in a few dozen rows. A side counted past the measure, or
  empty, is not counted again for a minute by a search with the same conditions — unless this process has written
  documents, chunks, pages or scopes since (`Store.contentVersion`), which puts every remembered count out of date
  at once; and where all a search could return was remembered as empty, the sides are counted before it answers
  with nothing (a write by another process does not show here). A walk that ends short of `k` is all such a side gets: what it found is returned, nearest
  first, and the channel is marked partial (`SearchChannel.partial`, in `channels.vector` of an explained search)
  with what stopped it and how many it has; so is the walk that looks for pages beside the sources, when it ends at
  its limit before it has its forty rows. Nothing is read after a walk: for a day a side the walk found nothing of
  was read as far as four times the walk's rows, and of a larger side that was its first so-many chunks in no
  order, returned as if they were its nearest. The 2,000 had bounded narrowed searches too, and a folder of 2,500
  chunks away from the question returned nothing.

  That scan exists from pgvector 0.8.0. What decides is the **library** the
  server has loaded, not `pg_extension.extversion`: knode-os asks whether the setting exists
  (`current_setting('hnsw.iterative_scan', true)`), once per store, and `serve` logs one line per workspace it opens
  saying which behaviour is in effect and why (`describeVectorScan`). knode-os never alters the extension. What an
  operator runs:

  - *The log says "one walk of the index per search".* The library is older than 0.8.0. Install pgvector 0.8.0 or
    later on the database server (the package, or `make install` of the release), restart PostgreSQL, then in each
    database that has the extension: `ALTER EXTENSION vector UPDATE;`. Until then the sources' side of a search
    gets what the nearest 40 rows hold, as before this change, and so does a narrowed search of a side too large to
    read, its vector channel marked partial.
  - *The log says "the catalog is behind the library".* The library was upgraded and `ALTER EXTENSION vector UPDATE`
    was not run. Search already uses the iterative scan; run the statement, as the extension's owner, to bring the
    catalog (and the SQL objects of later versions) in line.
  - Check by hand: `SELECT extversion FROM pg_extension WHERE extname = 'vector';` for the catalog, and
    `SELECT '[1]'::vector, current_setting('hnsw.iterative_scan', true);` for the library (NULL: no iterative scan).

## 4. Embedding configuration and credentials

### 4.1 What a worker reads: `GET …/work/config`

```jsonc
{
  "version": "3f9a…",                       // a hash of everything below
  "leaseSeconds": { "llm": 900, "embed": 120 },
  "kinds": { "extract": true, "summarize": true, "judge": false, "embed": true },
  "hints": {                                // from the stage routes, resolved as serve resolves them
    "extract":   { "codex": { "model": "gpt-6.1-sol", "effort": "medium" } },
    "summarize": { "codex": { "model": "gpt-6.1-sol", "effort": "low" } }
  },
  "embedding": {
    "vectorModel": "pool:bge-m3:1024:l2-v1",
    "model": "bge-m3", "dimensions": 1024, "batchSize": 16, "inputChars": 8000, "postprocess": "l2",
    "ownEndpoints": true,                   // pool identities only: §4.3
    "credentials": [                        // embed-keys scope only; keys marked "Lend to remote workers" only
      { "id": "cloudflare-main", "baseUrl": "https://api.cloudflare.com/client/v4/accounts/…/ai/v1",
        "model": "@cf/baai/bge-m3", "sendDimensions": false, "upstream": null, "apiKey": "…" }
    ]
  }
}
```

- Every lease answer carries `version`, and a worker refetches the config when it changes. A rotated key, a new model
  or a kind switched off reaches every worker within one lease round.
- `hints` apply to a CLI backend of the same family, and only when the worker didn't pin a model itself
  (`--codex-model` and the like win). An `api` backend ignores them, since model names differ between endpoints.
- `credentials` lists only keys marked *Lend to remote workers*, and only for a token with `embed-keys`. Entries carry
  ids, never labels, because labels hold account e-mail addresses and phone numbers. A key stored as `env:` is
  resolved on the server and lent as its value.

### 4.2 Lent keys

- The broker reserves on the ledger at lease time, over the lendable keys only, exactly as `PooledEmbeddingProvider`
  reserves before a call. The task names the key (`credential.id`) and the reservation, and the worker must use that key.
- A reservation is held as long as the lease (120 s for embed tasks); today every reservation is held a fixed 120 s.
- On completion the server settles it: with the provider's reported usage when the worker sends it, the estimate
  otherwise. A failure gets the same cooldowns as now: 401/402/403/404 → 15 min, otherwise `Retry-After`, otherwise
  30 s. A lease that lapses settles as a failure without a cooldown.
- When no key can take a reservation (every key at a limit), there is no embed task: `lease` comes back empty for
  `embed`, and the worker waits as it does on an empty queue.

Quotas stay exact across machines, and the ceiling stays where §0 puts it.

### 4.3 Own endpoints

A worker may embed on an endpoint of its own: `--embed-base-url http://127.0.0.1:8080/v1 --embed-model BAAI/bge-m3`,
which can be a local TEI, vLLM or Ollama, or an account of its own. The server accepts its vectors only when:

- the identity is a pool identity, and the worker's model has the same canonical name (`canonicalEmbeddingModel`: the
  BGE-M3 aliases);
- the worker passes calibration. Before its first embed task, and after every config change, it embeds the server's
  probe set: 16 fixed texts, Chinese and English. The server compares the result with reference vectors from its own
  pool, stored per identity in `.knode/embedding-probe.json`. Every cosine must be at least 0.98
  (`server.remote.embedProbeCosine`);
- spot checks keep passing. One batch in 100 carries a probe text, and a miss parks that worker's embed slots and logs
  the reason.

Tasks for an own endpoint carry no reservation, and the usage the worker reports is shown, not counted. This is the
only way remote embedding raises the ceiling.

### 4.4 Scopes and safety

- `label` now covers every LLM kind: `extract`, `summarize` and `judge`. A token can be narrowed with
  `--kinds extract`. An old worker only asks for `extract`, so existing tokens change nothing until an upgraded worker
  asks for more.
- `embed` (new): lease embed tasks, and read the embedding section without credentials (enough for own endpoints).
- `embed-keys` (new): receive lent credentials.
- Credentials travel only over HTTPS or loopback. The worker already refuses plain HTTP to another host, and the public
  guard already requires HTTPS from other machines. Answers that carry credentials are sent with
  `cache-control: no-store`, and their audit line names the token and the key ids sent.
- The worker keeps credentials in memory only, never on disk, in logs or in `--check`. It discards upstream error
  bodies, which may echo the key, as the server already does.
- Lending a key means trusting the machine. A machine that holds a lent key can use it outside its leases, and the
  ledger won't see those calls. When a token that held `embed-keys` is revoked, the keys it received should be rotated.
  `remote token list` shows which keys those were, from the audit log.

## 5. Lease protocol

Routes under `/remote/v1/w/<owner>/<workspace>/`:

| Method & path | Scope | Body → answer |
| --- | --- | --- |
| `GET work/config` | `label` or `embed` | §4.1 |
| `POST work/lease` | per kind | `{ worker, backend, kinds, max }` → `{ configVersion, leaseSeconds, tasks }` |
| `POST work/complete` | per kind | per kind, below → `{ accepted, … }`; 409 when the lease moved on |
| `POST work/renew`, `POST work/release` | per kind | as now |
| `GET work/status` | `label`, `embed` or `read` | per kind: ready, out, done in the last hour, failures; the workers |

`labeling/*` stays and means `kinds: ["extract"]`, so current workers keep working. Lease ids are global. The broker
sends each `complete`, `renew` and `release` to the source that issued the lease.

LLM tasks keep today's payload, plus `kind` and `json`:

```jsonc
{ "id": "…", "kind": "summarize", "label": "raw/docs/…", "messages": [ … ], "prompt": "…", "json": false,
  "maxTokens": 1200, "leaseExpiresAt": "…" }
// complete: { "id", "ok": true, "text", "model" }  or  { "id", "ok": false, "error", "kind", "model" }
```

Embed tasks:

```jsonc
{ "id": "…", "kind": "embed", "vectorModel": "pool:bge-m3:1024:l2-v1",
  "credential": { "id": "cloudflare-main", "reservation": "…" },     // null for an own endpoint
  "inputs": [ "…", "…" ], "leaseExpiresAt": "…" }
// complete: { "id", "ok": true, "vectors": "<base64, little-endian float32, n × dimensions>", "dimensions": 1024,
//             "usage": { "promptTokens": 5321 }, "model": "@cf/baai/bge-m3" }
//       or  { "id", "ok": false, "error", "kind", "http": { "status": 429, "retryAfterMs": 20000 } }
```

Vectors travel as base64 float32. A batch of 16 × 1024 is about 87 KB this way, against about 300 KB as JSON numbers.
The store keeps `halfvec`, so float32 loses nothing that would be kept.

### 5.1 Sharing slots between kinds

An LLM slot that takes several kinds is served in this order:

1. `judge` calls, because a review is waiting on them and a round has only a bounded number;
2. `extract` and `summarize` by weight (`server.remote.shares`, default 3 : 1), skipping a kind with nothing ready.

The weight keeps summaries moving while an import's extraction backlog is out. On 2026‑10‑15 summaries waited behind
reviews and went nine hours without a turn. Sharing slots creates the same risk between extraction and summaries, so
the share is set explicitly.

Embed slots take only `embed`, audit requests before the chunk backlog.

## 6. The Processing switch

| Work | serve's slots | Remote workers |
| --- | --- | --- |
| extract | while processing runs | any time (as now) |
| summarize | while processing runs | any time |
| judge | while processing runs (reviews only run then) | while a review is waiting |
| embed: chunk backlog | always (as embedding is now) | any time |
| embed: audit vectors | while a review runs | while a review runs |

"Any time" follows the rule remote extraction already has: someone started the worker by hand, and it spends its own
machine's accounts. Lent keys are the exception, since they spend the server's quota, but embedding has never been
behind the switch.

Since 2026‑11‑07 the switch has limits (`processing`; [remote labeling](../remote-labeling.md#local-worker-slots)):
serve's LLM slots run at most `maxLocalCalls` calls at once (default 2, judge calls first in line), and a slot on a
Codex or Claude plan with less than `minQuotaPercent` left (default 20%) rests until the window resets.

Since 2026‑11‑08 the switch is on from the start, in every workspace: `serve` opens every workspace at startup and
starts its processing, with no setting to say otherwise (`autoStart` is gone; an old file's is read past). The
button stays as a pause: it stops one workspace's processing until someone starts it again or the service restarts.

### 6.1 Server-wide settings (2026‑11‑08; every setting since 2026‑11‑12)

Every workspace on a machine spends the same plans, so what processing may spend is the machine's to say, not each
workspace's. On 2026‑11‑08 that was `processing`, the five stage routes, `extraction.workers` and the stage
concurrencies. Since 2026‑11‑12 it is **every setting** in `knode.config.json`: the connections and default model,
embedding (providers, pool, mode, embed slots and the endpoint on this machine), every stage, research, Ask,
languages, retrieval, the graph, review, Dream and `server`. One administrator's change is everyone's, so a
workspace no longer needs its own copy configured (finance needed its embedding switched by hand while two other
workspaces already ran on the local bge‑m3). Only what a workspace *contains* stays its own (`OWN_PATHS` in
`src/global-settings.ts`): `datasources`, `ingest.linkedFolders` and `ingest.codebases`. Those import content, and
sharing them would pull one workspace's (or one account's) sources into all the others.

- **Where they live.** The server root's `knode.config.json` is the source. Each workspace's file keeps a copy, so
  whatever reads a workspace's config — `serve`, the CLI, a test — reads the shared values. The copy is written when
  the workspace opens (`WorkspaceContextRegistry.open`, before `createContext`; a new workspace is made from the
  root's config and takes it then too) and, when an administrator changes a setting through `PUT /api/config` or
  edits an agent a setting names, in the root, in every workspace folder (`users/*/workspaces/*`, and a Team that
  is a folder of its own; a shared Team is a symlink to its owner's) and in every open context, which reloads
  (`ctx.config`, `ctx.llm`, and `ctx.embedder` when the embedding model changed). The response says how many
  workspaces took it.
- **A new embedding model elsewhere.** An open workspace moved onto another embedding model by someone else's save
  gets a new vector width if needed (`setEmbeddingDimension`), then its vectors as its own save would: the deferred
  backlog refills, or (inline) every document is re-applied in the background. A closed one does the same when it
  opens. An endpoint on this machine (`ingest.embedEndpoint`) is calibrated per workspace against that
  workspace's pool reference (`.knode/embedding-probe.json`); until it passes, the slots embed on the pool.
- **What travels with them.** Settings name agent files by id (the stages, the slots, the default model, research's
  and Ask's agents, the study refiner). Those files are copied before the workspace's config is read: `loadConfig`
  pins a route whose target it cannot find back to the default. Connection rows travel inside `connections`, which
  is shared whole, so an id means the same row everywhere and the old clash handling (`<id>-server`, `<id>-own`) is
  gone.
- **One cap for the machine.** `serve` makes one `CallLimiter` and hands it to every workspace's slots, so
  `maxLocalCalls` counts every workspace's calls together. Its waiters belong to an owner (a workspace's slots), so
  a workspace that stops turns away only its own; judge calls stay first in line. `calls()` reports the machine's
  calls out and the workspace's share.
- **One floor for all background work.** The plan readings are shared too (`PlanReadings`, each plan read at most
  every two minutes for the machine). Under `minQuotaPercent` the processing slots take nothing, a research job on
  that plan goes back in line with a `quota` pause until the window resets (with every job queued on the same
  account), and the nightly Dream (Judge route) and tier-2 pass (Judge and Summarize routes) skip the night with a
  log line. Ask is not held, and nor are an import's image conversions.

Not counted under the cap: remote workers, research sessions, Dream, the tier-2 pass and Ask.

## 7. The worker (`worker/knode-worker.mjs`)

- `--backends codex:2,cursor:2,embed:4`: `embed` is a new backend whose slots take only embed tasks.
- `--kinds extract,summarize,judge` limits what the LLM slots ask for. The default is every LLM kind the server offers
  this token.
- Embed slots use lent keys (the token needs `embed-keys`), unless `--embed-base-url`, `--embed-model` and
  `--embed-key-env` name an own endpoint.
- It reads `work/config` at startup and whenever `configVersion` changes, and applies `hints` unless a model is pinned.
- Against an older server (where `work/config` returns 404) it falls back to `labeling/*`, extraction only.
- It stays one dependency-free file. The embed call (`/embeddings` with `encoding_format: "float"`, `dimensions` when
  the key sends them, and OpenRouter's `provider.only` pin when the key has an upstream) is a copy of the server's code.
  A new test keeps the two in step. It should also cover the worker's copy of the failure classifier, which no test
  checks today.
- `--check` also shows the kinds offered, the embedding identity, how many keys are lent (ids only), and the own
  endpoint's calibration result.

## 8. Config, API and UI

```jsonc
"server": { "remote": {
  "offer": { "summarize": true, "judge": false, "embed": true },   // extract is always offered
  "shares": { "extract": 3, "summarize": 1 },
  "callDeadlineMinutes": 20,
  "judgeModels": [],                     // models whose remote verdicts may merge without a person
  "embedProbeCosine": 0.98
} },
"ingest": { "embedding": "inline", "embedSlots": 8 },
"review": { "concurrency": 2 },
"embeddingProviders": [ { "id": "cloudflare-main", "lendToWorkers": false, … } ]
```

- `/api/labeling/status` becomes `/api/work/status`, with the old path kept. It reports ready, out, done and failed per
  kind, the embed backlog per table, and for each worker its kinds and the lent keys it is using.
- The Processing panel, in the app and in the web UI, gets a row per kind and shows each worker's kinds.
- Settings → Providers & Agents gets a *Lend to remote workers* switch per embedding key, and the embedding mode.
- Settings → Remote gets the kinds offered, the shares, and the judge models allowed to merge.
- `knode-os remote token create … --scope label,embed,embed-keys [--kinds …]`. `remote token list` shows the keys each
  token has received.
- `docs/remote-labeling.md` becomes the guide to remote processing. `docs/embedding-pools.md` gets a section on lending.

## 9. Phases

1. **Broker and summaries** — *implemented* (`src/work/`). The broker with `extract` (the scheduler as it is) and
   `summarize`; `work/*` and `work/config` without the embedding section; worker kinds and hints; tokens narrowed
   with `--kinds`. The summary loop becomes summarize slots, and `summaryConcurrency: 0` leaves summaries to remote
   workers. Hints for extraction come from `extraction.workers` (listed with 0 slots or not), then the Extract route.
   *Done when* a worker started with only `--server`, `--workspace` and `--backends codex:2` writes summary pages, an
   unchanged worker still extracts, and the share rule is covered by `labeling.test.ts` and `followup.test.ts`. The
   end-to-end worker test in `remote-api.test.ts`, which runs the real worker against a fake model endpoint, grows
   a summary case.
2. **Judge calls** — *implemented* (`src/work/judge.ts`). The entity and claim judges hand all their calls to a
   `JudgeRunner` at once; serve's judge slots (`review.concurrency`); remote judging off by default
   (`server.remote.offer.judge`), with `judgeModels` deciding whether a remote verdict may merge or reject on its own.
   *Done when* a review runs its calls in parallel with no remote worker, and a remote verdict from a model outside
   `judgeModels` is filed as a suggestion instead of merging. `tests/judge.test.ts` covers both against a model
   endpoint that counts the calls it has in flight, and `remote-api.test.ts` has the real worker answer a judge call.
3. **Embedding.** `PooledEmbeddingProvider` split into reserve, call, check and settle; the embed source with audit
   requests and the chunk backlog; `deferred` mode; the identity filter in vector queries; serve's embed slots; lent
   keys with the two scopes and the per-key switch; the worker's `embed` backend.
   *Done when* a `deferred` sync returns before any vector is made and the backlog then drains to zero, a lent-key
   worker's calls show up in the ledger, and dropping the scope stops its next lease.
4. **Own endpoints.** The probe set, calibration, spot checks and `--embed-base-url`.
   *Done when* a bge-m3 TEI on another machine passes calibration and its vectors land, and an endpoint serving a
   different model is refused.

Phases 1 and 2 cover the steps that can't leave the Mac mini at all today. Phase 3 brings the pool up to its cap with
serve's own slots; remote workers on lent keys change only where the calls run. Phase 4 is where remote embedding adds
capacity.

## 10. Known limits and open questions

- **Are the daily totals real tokens?** The ledger settles to the provider's reported `usage` when a response includes
  it. Otherwise it keeps its estimate of UTF-8 bytes plus 32 per input, which counts each Chinese character as about 3
  tokens. If Cloudflare or SiliconFlow leave out `usage`, the caps bind on estimates well before the providers' own
  limits. Check this before deciding how much capacity is needed.
- **A lent key can be used outside its leases** (§4.4).
- **The nightly tier-2 pass** keeps calling the Judge route itself. It runs whether or not processing is started,
  while serve's judge slots only run while it is. Moving it needs a rule for serve's slots outside the switch.
- **Convert** would need the rendered page images in the task (several MB per document) and a backend that accepts
  images. The `api` backend can send image parts; the CLIs would need the files on the worker. Later.
- **Lending LLM keys** (`connections`) could reuse the same mechanism. Not now: workers bring their own CLIs and keys.
- **State kept only in memory.** Pending judge calls, audit embed requests and held chunk ids live in serve's memory,
  and a restart drops them. Reviews run again on the next round, and the chunk backlog is rebuilt from the tables.
- **Write load.** Every vector still lands in the same Postgres through serve, one transaction per batch. HNSW inserts
  cost what they cost now; only the rate changes.

## 12. Phases 3 and 4 as built (2026‑11‑06)

- **`inline` was already half deferred.** Since 8cf2d66 (2026‑10‑18) `serve` applies a document without its
  vectors and a background embedder (`src/ingest/embed-backfill.ts`) fills them in; only the CLI embeds while it
  applies. `inline` keeps exactly that. `deferred` makes the same backlog leased work, the CLI's sync included, and
  the background embedder stands aside.
- **Embed work exists only in `deferred` mode.** `work/config` offers `embed` (and an `embedding` section) only
  there, to a token with the `embed` scope, unless `server.remote.offer.embed` is off. The audits' vectors go through
  the `BrokeredEmbedder` only in `deferred` mode, and only while someone can take them — embed slots here, or a
  remote worker that asked for embed work in the last two minutes; otherwise they are embedded directly, as before.
- **An own endpoint on `serve`'s machine** (not in the plan): `ingest.embedEndpoint { baseUrl, model, apiKey? }`.
  `serve`'s embed slots calibrate it like a remote worker's endpoint and embed there, spot-checked; while it is
  refused or parked they embed on the pool. Settings (web and app) guides setting one up, checks it with the probe
  set (`POST /api/config/embedding-endpoint/check`), and a save checks it again.
- **Calibration** is a route of its own, `POST work/calibrate`, answered with a calibration id the worker leases
  with. A worker is `<token>/<name>`; its slots share the calibration. A spot-check miss ends it and parks the
  worker for 30 minutes, calibrations included. A lease answer says `embed: { calibrate: true, reason, parkedUntil? }`
  when the slot must calibrate again.
- **Model names.** An endpoint's model must have the pool's canonical name (`canonicalEmbeddingModel`, an
  Ollama-style `:tag` aside), both as the worker names it and as the endpoint answers.
- **Not built:** lent keys (§4.2) and with them reservations at lease time, the per-key *Lend to remote workers*
  switch's effect (`lendToWorkers` is in the config type only), `PooledEmbeddingProvider`'s split into reserve, call,
  check and settle, and showing the keys a token received in `remote token list`. §0 explains why lending adds no
  capacity.
- **Tested on 2026‑11‑06** against a local bge-m3 (PyTorch on MPS, fp16, 127.0.0.1:12020): a scratch `serve` in
  deferred mode, the real worker with `--backends embed:2` calibrated at cosine 1.0000 and embedded the backlog; a
  worker naming `nomic-embed-text` and an endpoint answering as bge-m3 from another vector space (lowest cosine −0.05)
  were refused and wrote nothing; `serve`'s own slots drained the backlog through the pool and, once Settings had
  checked and saved the endpoint, on it.

## 11. Where the changes go

| Area | Files |
| --- | --- |
| Broker and sources | `src/work/broker.ts`, `src/work/summarize.ts`, `src/work/judge.ts`, `src/work/embed.ts` (new); `src/labeling/scheduler.ts` (behind the broker, unchanged inside); `src/labeling/local.ts` (slots per kind); `src/labeling/followup.ts`; `src/labeling/processing.ts` |
| Summaries | `src/wiki/pages.ts` (one request builder for `render` and the source) |
| Reviews | `src/graph/dedupe.ts`, `src/graph/claim-dedupe.ts` (build the calls, then `runCalls`) |
| Embedding | `src/ingest/embedding-router.ts` (reserve, call, check, settle; reservations held as long as the lease); `src/ingest/apply.ts` (`deferred`); `src/search/search.ts`, `src/search/sag.ts` (identity filter) |
| Remote API | `src/remote/api.ts` (`work/*`, `work/config`); `src/remote/tokens.ts` (`embed`, `embed-keys`, kinds) |
| Config and server | `src/config.ts`; `src/server/app.ts` (status, settings); `src/server/serve.ts` |
| Worker | `worker/knode-worker.mjs` |
| App | `macos/Sources/KnodeOSApp/` (Processing panel, key switch, remote settings) |
| Tests | `tests/labeling.test.ts`, `tests/followup.test.ts`, `tests/remote-api.test.ts`, `tests/embedding-router.test.ts`; new broker and worker tests |
