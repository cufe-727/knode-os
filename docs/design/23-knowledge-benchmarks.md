# 23 — Knowledge benchmarks: comparing knowledge-base approaches on the same sources

> Status: **implemented** (2026‑11‑04), pilot pending. `src/eval/` (packs, shim, meter, quota, agent runner, judge,
> metrics, systems, runner, report, audit, install), `eval/adapters/*.py`; `knode-os eval pack list|build|validate`,
> `knode-os eval systems list|install`, `knode-os eval run`, `knode-os eval report`, `knode-os eval audit export|import`.
> Data lives outside the repository in `~/knode-eval/` (`$KNODE_EVAL_HOME`): `sources/` (downloads), `packs/`,
> `runs/`, `venvs/`. Tests: `tests/eval-suite.test.ts`.

## 0. What was there

knode-os had `knode-os bench` (src/bench): build timing, synthetic single-chunk QA, retrieval recall and a judged
answer score — on one workspace, against itself. Nothing compared knode with another way of building or using a
knowledge base, and nothing measured what it *generates* or what it can *infer*.

Outside, as of 2026‑11 there is no benchmark for "LLM Wiki" knowledge bases (Karpathy's April 2026 pattern of a wiki
an LLM maintains instead of retrieving afresh). There are pieces:

- Graph RAG: GraphRAG-Bench, WildGraphBench and BenchmarkQED. Their win-rate comparisons are fragile: a debiased re-run took LightRAG's 66.7% over naive RAG to 39.1%.
- Cited article writing: FreshWiki/STORM and Wiki Live Challenge.
- KG fact coverage: MINE.
- Corpus-level synthesis: DeepSynth, CorpusQA, iAgentBench.
- Multi-hop retrieval: HippoRAG 2's protocol on MuSiQue / 2Wiki / HotpotQA.
- Practitioner claims, e.g. "a wiki beats RAG at ~100 articles / 400K words".

None gives several knowledge-base builders the same sources and scores what each built, how well each is used and
at what cost. None scores emergence either: an author's style, a field's open problems, a person's mood or needs.
The 2026‑11‑03 read-only audit of the finance workspace (claims 92% supported, 29% cited the right chunk; summary
pages 98% faithful) showed what such a benchmark can find.

## 1. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 Packs are portable directories | `pack.json`, `corpus/`, `holdout/`, `gold/{facts,links,aliases}.jsonl`, `gold/profile.json`, `tasks/*.jsonl`, `updates/NN/`, validated by zod schemas and `validatePack`. They live in `~/knode-eval/packs`, never in the repo | Packs hold downloaded third-party text and a private finance slice. A pack can be rebuilt from its recipe, and its manifest lists every source with license and sha256 |
| D2 Nothing a system reads sits beside the gold | `stageCorpus` copies the corpus to a fresh temp directory with nothing else in its parent. Agents get a fresh copy per question. Every command an agent runs is audited, and a path into `~/knode-eval` or the home directory voids the answer | Codex's read-only sandbox blocks writes, not reads. An agent in `packs/<id>/corpus` could `cat ../tasks/usage.jsonl` |
| D3 One model for every system, metered in one place | An OpenAI-compatible shim on 127.0.0.1 (OS-assigned port, alive only during a run) answers `/v1/chat/completions` from Codex (`codex exec` per call, fresh temp dir, `--json` usage) and `/v1/embeddings` from knode's embedder. knode workspaces under test, the RAG baselines and the external Python systems all point at it. The bearer token carries the meter tag `sys=…;stage=…;task=…`. Agent sessions run Codex directly and report their own `--json` usage | An in-process knode build records no usage (only `serve`'s broker writes the call ledger). Routing every system through one gateway makes model, effort and accounting identical, with no change to knode |
| D4 Survive minutes-long calls | Headers go out at once and whitespace follows every 20 s, which beats fetch's 300 s timeout. A failure after Codex spent tokens returns 200 with an error body, never a 5xx a client would retry. `tools` and `n>1` are refused with 400; `stream:true` gets one SSE chunk | A slow Codex call paid for twice would double a build's cost and hide it |
| D5 Resumable to the item | Builds, answers and scores are keyed JSONL records. The shim's reply cache and the judge's verdict cache are on disk, and replays are counted at their original cost, marked `replayed` | A pilot spans days of plan windows. A resumed run must neither redo work nor under-report it |
| D6 Same agent, different knowledge | The grep baseline, the agent with knode's MCP retrieval tools, the agent reading knode's generated wiki and the agent reading an LLM Wiki are one runner (`runAgent`) with a different folder or tool set. At most 25 commands, then `capped` | The question is what each knowledge source is worth to the same agent, not which agent harness is better |
| D7 LLM Wiki built faithfully | A schema file plus ingest sessions of ~3 sources in date order (Codex `workspace-write` in a temp dir with `raw/` and `wiki/`). Each session writes source, entity and concept pages, `index.md` and `log.md`. It is read by the same agent, wiki only | That is the pattern as published. Letting the reader open `raw/` would make it the grep baseline |
| D8 Blind, batched, cross-family judge | Claude Code judges Codex's answers, ≤8 items per call. Ids are opaque, system markers are stripped, and systems are shuffled within a batch. Gold-building and the oracle check use Claude too | A judge grading its own family's answers, or one that can tell systems apart, is not a judge. Batching keeps a pilot inside a plan |
| D9 Gold without a model where possible | Synthetic life is scored from its script. CUAD, EnronQA, FinanceBench, LongMemEval and MuSiQue bring their own answers. Law cross-references come from a regex. Style comes from stylometry (log-odds terms, profile directions). Model-drafted gold has an exact quote checked against its document, and an oracle check drops any task its evidence does not answer | Gold an oracle cannot recover is noise. A quote that is not in its document is a hallucinated fact |
| D10 Contamination is measured, not hoped away | Literature names are consistently renamed (map in the holdout), the research forecast uses a 2026 holdout, and a `closed-book` reference answers every task | Models have read the classics. A pack the model answers from memory measures memory |
| D11 Generated units only | `exportKnowledge` returns what a system generated (entities, relations, claims, pages, summaries, communities), never raw passages. Coverage is looked up within a fixed budget (6,000 characters, ≤10 units) by the same BM25 + bge-m3 retrievers for every system | A system that stores chunks would otherwise cover everything by definition, and a verbose one would win by size |
| D12 A quota guard, not a hope | Before each batch `readCodexAccount()` reads Codex's windows (no model call). A run pauses above 92% (five-hour) or 90% (weekly) and resumes after the reset. A refused judge call sleeps and retries | On 2026‑11‑04 the weekly window was 72% used with five days to its reset, and the finance workspace's extraction uses the same plan |

## 2. Packs (`src/eval/packs/`)

| Recipe | Sources (license) | Gold and tasks |
| --- | --- | --- |
| `fixture` | Template-written (no network, no model) | Every task kind once, gold by construction. For tests and smoke runs |
| `synthetic-life-zh` / `-en` | A seeded hidden script rendered by Claude | Planted facts with exact phrases, aliases, links, weekly moods (never named), latent needs, holdout future, an update batch, an injection message |
| `literature-zh` / `-en` | Gutenberg: the four classics; Austen, Dickens, Twain (public domain), renamed | Plot QA, characteristic terms (precision@10), style directions, attribution of unseen passages |
| `research-ai` | arXiv cs.CL/AI/MA 2025-H2 (abstract, introduction, conclusion via arXiv HTML); 2026 holdout | QA; recurring open problems (≥2 papers each); next-half-year themes from the holdout |
| `law-cn` / `law-us` | twang2218/chinese-law-and-regulations; CUAD (CC BY 4.0) | Article QA, model-free cross-reference links, effective dates; CUAD clause answers |
| `medicine-us` / `-zh` | PubMed abstracts + openFDA labels (public domain); Huatuo encyclopedia QA (Apache-2.0) | Published QA where present, drafted QA otherwise |
| `finance-us` / `-cn` | FinanceBench open set (CC BY-NC); a frozen local slice of the `finance` workspace (private, never shared) | FinanceBench questions; drafted QA, view-vs-fact, temporal |
| `personal-email` / `-chat` / `-diary` | EnronQA (Dasovich mailbox); LongMemEval oracle (MIT); Pepys' diary (Gutenberg) | Published QA; memory types; drafted QA |
| `public-musique` / `-multihoprag` | HippoRAG 2 MuSiQue release; MultiHop-RAG (ODC-BY) | Published multi-hop questions with supporting passages, bridge links |

Every recipe ends in `finishDocpack`: write the documents, draft facts and tasks (`gold.ts`), add the recipe's own
model-free tasks, validate.

## 3. Systems (`src/eval/systems/`)

| id | Group (built once) | What answers |
| --- | --- | --- |
| `closed-book`, `long-context` | — | The model alone; the model with the whole corpus in its prompt (only where it fits) |
| `agent-grep` | — | A Codex agent in a copy of the sources, shell tools, read-only. **The baseline** |
| `rag-hybrid` (`rag-bm25`, `rag-vector` retrieval only) | `rag` | Top-8 chunks by BM25 (CJK bigrams) + bge-m3, RRF, one answer call |
| `knode-ask` (`knode-sag` retrieval only), `agent-knode`, `agent-knode-wiki` | `knode` | knode's `ask`; the agent with knode's MCP retrieval tools (`knode_search`, `knode_graph_search`, `knode_claims`, `knode_read`, `knode_grep`, `knode_ls`); the agent in the generated wiki |
| `agent-wiki` | `llm-wiki` | The agent in the LLM Wiki |
| `graphrag`, `lightrag`, `hipporag` | each | Their own query through `eval/adapters/<id>.py` (JSON lines), in a uv venv, by default on 3 packs (`KNODE_EVAL_EXTERNAL_PACKS`) |

The knode build is the one `serve` runs: `sync`, document passes until the queue and summaries are done (tier-1,
dedupe audits, summaries), `generateWiki`, `refineWiki`, then `sync` again so generated pages are searchable. PGlite
admits one process, so the in-process context closes before an MCP agent opens the index.

## 4. Metrics (`src/eval/score/`, `src/eval/metrics/`)

Each suite has one pre-registered primary metric (in bold). The rest are reported descriptively.

**Generation.** Same sources, compare what each system built:
- **Coverage within budget**: share of gold facts recoverable from the KB.
- Precision: atomic claims sampled uniformly, judged against cited sources plus the top-5 corpus passages. Verdicts: supported, valid inference, unsupported, contradicted.
- Attribution precision.
- Link precision on a sample; link recall against model-free gold.
- Duplicate rate and over-merge rate against gold aliases.
- Contradiction rate between same-subject units.
- Structure: links per page, dangling links, orphan pages.
- Compression (unit chars / corpus chars).

**Use:**
- **Correctness** (judge 0–2 scaled to 0–1), keypoint recall, EM/F1 on the `Final answer:` line (CJK as characters).
- Citation precision/recall against task evidence; N/A for systems that do not cite.
- Abstention on unanswerable tasks, false refusals, truthfulness (+1 / 0 / −1), hallucination.
- Injection success.
- Retrieval Recall@k, All@5, MRR@10, nDCG@10 over multiple gold documents.
- Latency, tool calls, weighted tokens and USD per query.

**Emergence.** Every system answers the same probes in the same JSON (items with confidence and evidence). Items are matched one-to-one against fixed gold, by the judge for themes and needs and without a model for terms, labels and attribution:
- set precision, **recall**, F1;
- recall split by signal (explicit / implicit / latent);
- grounded share (≥ `minEvidence` corpus documents cited);
- Brier calibration;
- **label accuracy** for moods and attribution.

**Ops**, per build:
- wall time, time inside model calls, calls;
- input / cached / output tokens, Codex-weighted tokens, embedding tokens;
- USD at API prices where a price is known;
- disk bytes, peak RSS;
- incremental update cost;
- **break-even queries** = build weighted tokens ÷ (agent-grep's per-query weighted tokens − the system's).

**Statistics:**
- Wilson intervals for rates and bootstrap intervals for means.
- Paired bootstrap of correctness against `agent-grep`, pooled over packs, Holm-corrected across systems.
- Per-type splits are descriptive.
- `eval audit export|import` measures the judge against a person (agreement, Cohen's κ).

## 5. Running

```
knode-os eval pack build synthetic-life-zh            # Claude drafts, ~15 calls
knode-os eval systems install lightrag                # uv venv, pinned
knode-os eval run --pack synthetic-life-zh,law-cn --config-from ~/.knode-os/users/admin/workspaces/finance \
                  --model gpt-6.1-sol --limit 50
knode-os eval report ~/knode-eval/runs/<stamp>
```

- `--config-from` names the workspace whose embedder (the bge-m3 pool) the run borrows. Its config is only read.
- Build effort defaults to low and answer effort to medium.
- Agents answer at most 30 stratified tasks per pack (`--agent-limit`).
- `--fraction` and `--seed` give scale curves and run-to-run variance.
- `--embedding-cap` bounds what a run takes from the shared pool.
- `--embedding-daily-cap` bounds what it takes per UTC day, since the live service shares the pool and its free quotas reset at 00:00 UTC. Past the cap, or when the pool itself refuses, a pack waits for the next day and then resumes.

## 6. Not done

- External systems' adapters are written against the versions installed on 2026‑11‑04. A new release may need an adapter change.
- No second-model κ for the judge yet; the human audit stands in.
- No HTML export of the report: Markdown with chart blocks, plus JSON.
- The research forecast's gold is the author model's reading of the 2026 holdout. It is a weak target, reported with the closed-book control.
- Scale curves, variance runs and noise injection exist as flags; the pilot does not run them.
