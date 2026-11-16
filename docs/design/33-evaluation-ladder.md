# 33 — The evaluation as a ladder: what search adds, what the wiki adds, what knode's tools add

Status: design (2026-11-14); stage 1 built 2026-11-15 (§10). Stages 2–5 are not.

## 0. Why

The separation benchmark (design 28) ran at 1× and 10× on 2026-11-14 (`~/knode-eval/runs/separation-2026-11`). What it showed, and why it cannot answer the question it was built for:

- **The arms do not isolate anything.** Six systems differ in several things at once: agent or single call, files or tools, sources or wiki. `agent-knode-wiki-sources` has everything `agent-grep` has plus the wiki and scored the same (0.89 against 0.90) — the one clean comparison in the set, found by accident.
- **Most questions cannot tell agents apart.** Of 261 questions at 10×, all four agents were fully right on 168 and none on 56. Only 37 (14%) discriminate. Each type has 18 questions, so a type's minimum detectable difference is 0.15–0.3.
- **The corpus suits grep.** 1,420 reports under 800 characters each, one folder per team with 44 files, the team's name in the folder name. 94% of questions name the division and 79% carry an exact name or id. The first grep hits a gold document in 81% of answers.
- **Artifacts moved the numbers.** A question prefix ("（第N事业部）") that occurs only in monthly summaries; claim dates exported without a year; `knode-ask`'s retrieval scored from a list that drops wiki hits; update questions that say "平台组" when ten divisions have one. Of the 67 answers `agent-grep` got less than right, most were scoring or format, not retrieval.
- **Tool outputs are not recorded**, so every diagnosis needed a replay.

The user's proposal, which this design adopts: compare four agent setups that each add one thing to the one before, and rebuild the questions and datasets around what each addition should buy.

## 1. Decisions

| | Decision | Why |
| --- | --- | --- |
| D1 | The headline is a ladder of four agent arms, each a superset of the one before | A paired difference between neighbours measures one addition |
| D2 | `knode-ask` and `rag-hybrid` leave the headline and become a single-call track | They are not comparable to agents, but `knode-ask` is the product's own answer path and the only place retrieval quality shows directly |
| D3 | `agent-knode` (tools, no files) and `agent-knode-wiki` (wiki, no sources) become optional diagnostics | Their questions are answered more cleanly by the ladder; each stays useful for one narrow question |
| D4 | Fewer question families, each aimed at one capability, with at least 60 questions | A family must be able to detect a difference of 0.1 |
| D5 | The same questions are asked at every corpus size | A scale curve needs like-for-like questions |
| D6 | Find the size where grep degrades with the cheap arms before paying for a knode build at that size | A knode build at 100× is about ten times the 10× build: roughly 55 hours of model time and $500 at API prices |
| D7 | Every pack passes a lint before it is run, and every answer records what its tools returned | Both would have caught or shortened today's diagnoses |

## 2. The arms

Same model, effort, question prompt, step budget and backend for all four. The brief differs only by the sentence that says what is available.

| Arm | Has | Id | State |
| --- | --- | --- | --- |
| A | shell over the raw sources | `agent-grep` | exists |
| B | A, plus one tool: `search(query, k)` over a plain chunk index of the sources (the `rag-hybrid` index: 1,200-character chunks, BM25 and bge-m3, fused) | `agent-rag` | new |
| C | A, plus the generated wiki as files beside the sources | `agent-knode-wiki-sources` | exists |
| D | C, plus knode's retrieval tools: `knode_search`, `knode_graph_search`, `knode_claims`, `knode_query`, `knode_resolve`, `knode_survey` | `agent-knode-full` | new |

D does not get `knode_grep`, `knode_read` or `knode_ls`: the shell does that, and leaving them out means every knode tool call in D is a use of something grep cannot do.

Comparisons, declared before a run (paired over the same questions, Holm-corrected):

| Difference | What it measures |
| --- | --- |
| B − A | semantic search over the sources |
| C − A | the wiki itself |
| D − C | knode's retrieval: hybrid search, graph, claims, SQL |
| D − A | the product as a whole |
| D − B | the product against an agent with plain RAG |

Each difference is reported for correctness and for cost (tokens, USD at API prices, latency, tool calls). A tie in correctness at lower cost is a result.

**Outside the ladder**

- **Single-call track:** `knode-ask` and `rag-hybrid`, with retrieval metrics scored from the contexts actually sent. Cheap (13 s and $0.04 a question), run on every pack as a regression check on the product's Ask.
- **Diagnostics, off by default:** `agent-knode` when the question is "what can an agent do through MCP alone, with no file access"; `agent-knode-wiki` when the question is "does the wiki alone hold the answer".
- **Reference:** `long-context` where the corpus fits a context window.

**Telemetry (all agent arms):** each tool call's output is kept, cut to its first 2,000 characters with the full length, beside the command. For D the report adds: calls per knode tool, and correctness of answers that used each tool against those that did not.

## 3. Question families

Each family targets one thing a compiled knowledge base should do better than search, or is a control. At least 60 questions per family per pack; controls 20.

| Family | What it asks | Who should win, and how |
| --- | --- | --- |
| Company-wide aggregates | counts, sums, rankings and filters across every team over a period ("which teams had three or more P1 incidents in Q2") | D through `knode_claims` or SQL; grep must read hundreds of files |
| Current state | a setting or metric as of a date, with corrections and a monthly summary that disagrees; the corpus states which source prevails | C and D, if the wiki compiles state; A must find every mention and apply the rule |
| Renames and aliases | an entity renamed once, then referred to only by the new name, a role or a nickname | C and D, if resolution works |
| Hops without shared words | three to five steps across teams where no step shares a keyword with the question | B and D |
| Timelines and diffs | ordered events for an entity; what changed between two weeks | D |
| Look-alikes and unanswerables | same-named people and settings in other teams; questions the corpus cannot answer | whoever does not merge them; abstention is scored |
| Update stream | state questions after each batch of new documents | measures staleness of C and D against A |
| Controls | exact lookup, paraphrase, cross-lingual | expected tie; a difference here means a harness fault |

The emergence suite (themes, planted connections) stays as it is.

Rules for every question:

- It names its team as the documents do ("七部平台组"), never by a qualifier the documents do not use. A third of the questions name no team: they identify their subject by a project, person or customer.
- Its gold is unique under the question's own words. A date convention the gold depends on is stated in the question.
- Exact ids appear in at most a third of the questions outside the controls.
- Division 1's questions are identical at every size (D5).

## 4. Datasets

**Synthetic reports, recipe v3** (`src/eval/packs/reports.ts`; gold from the script, no model):

- **Layout:** files by week, not by team (`周报/2025-W34/<hash>.md`), so the path says nothing about the team. `layout: "by-team"` keeps the old one for comparison.
- **Long documents:** quarterly reviews, incident postmortems and meeting minutes of 5,000–20,000 characters that carry facts found nowhere else, so a match is not the whole document.
- **More than one year:** two or three years of weeks, so a team has 100–150 reports and "latest" needs a date, not a sort of 44 files.
- **Sizes:** 1× (3 teams), 10× (30), 100× (300; the recipe already builds it: 14,200 documents, 8.4M characters).
- No question prefix; update questions name their team in full.

**Real documents:** two packs chosen for the longest documents and the least structure, from those already on disk (`~/knode-eval/packs`) or newly downloaded (the user approved downloading new corpora on 2026-11-15).

**Pack lint** (`eval pack lint <dir>`, run by `eval run` before anything is spent):

- a word of a question that occurs in only one class of document;
- a question whose gold is not unique among documents matching its qualifiers;
- a question answerable from file names alone;
- a family with fewer questions than its minimum;
- two questions with the same text and different gold.

## 5. Scoring and the report

- List answers are parsed tolerantly: an unclosed JSON array, "1,000" and "135万" for the same number.
- A sample of 5% of judge verdicts is judged twice; disagreements are listed.
- The report opens with the ladder table (five differences, correctness and cost, with each one's minimum detectable difference), then a discrimination table: questions every arm got right, none got right, and the rest.
- Per family: each arm's correctness and the neighbours' differences.
- Scale curve: correctness and cost per arm at each size, on division 1's questions.

## 6. Protocol

1. 1× and 10×: all four arms, the single-call track, 300 questions sampled by family. One backend, pinned by pool (design 32); the index on PostgreSQL (design 31).
2. 100×: arms A and B only. No knode build.
3. If A degrades at 100× (correctness, or cost per correct answer), build knode at 100× and run C and D. If it does not, the result is that this kind of corpus does not need a knowledge base at this size, and the next step is a different kind of corpus, not a larger one.
4. Sixty questions are answered three times by every arm, for run-to-run variance.

Cost at API prices, from the 10× run: an agent answer is $0.08–0.18, so four arms on 300 questions is about $150 per size; the knode build was $5 at 1× and $51 at 10×.

## 7. Stages

| Stage | What | Size | Depends on |
| --- | --- | --- | --- |
| 1 | Arms B and D, tool-output telemetry, the ladder and discrimination tables | small to medium | the evaluation artifact fixes (running, 2026-11-14) |
| 2 | Recipe v3, the families of §3, pack lint | medium to large | — |
| 3 | Scoring changes of §5 | small | — |
| 4 | Runs of §6 steps 1 and 2 | model time | stages 1–3; the entity-resolution and search fixes merged, or the run measures known defects |
| 5 | The 100× decision and, if taken, the build | large | stage 4 |

## 8. Decided by the user (2026-11-15)

- Arm B's index is the plain `rag-hybrid` one, not knode's own search over sources: B measures "any RAG", and D − C stays knode's retrieval alone.
- New corpora may be downloaded for the real-document packs.

## 9. Open items

- Whether the MCP-only diagnostic (`agent-knode`) is a deployment that matters: if agents reach a workspace only through `/mcp`, it belongs in the headline for that product path.
- Which real-document packs: two from those on disk, or new corpora chosen for long, unstructured documents.
- Whether the long documents and extra years should also go into the life recipe, whose documents cost model calls to write.

## 10. Stage 1 as built (2026-11-15)

`eval run --systems ladder` runs `agent-grep`, `agent-rag`, `agent-knode-wiki-sources`, `agent-knode-full`, `knode-ask` and `rag-hybrid` (`--systems single-call`: the last two). The default set no longer has `agent-knode` or `agent-knode-wiki`; both run when named.

**Arm B, `agent-rag`** (`src/eval/systems/rag.ts`). In the rag group, so it shares `rag-hybrid`'s build, and builds it itself when `rag-hybrid` is not in the run. Its one tool, `search(query, k)` (k 8 by default, at most 20), is the hybrid ranking `rag-hybrid` answers from, returned as JSON: each hit's document path (as in the agent's folder), the 1,200-character passage and its RRF score. The run serves it over loopback HTTP behind a per-host secret (`startServedTools`, `src/eval/toolhost.ts`), as it serves knode's tools, so a worker's session reaches it through `serve`'s lease-bound route unchanged. The MCP server is named `knode`, as every evaluation session's is on a worker. Query embeddings are metered under `agent-rag` without a task, so an answer's own usage leaves them out (on a local bge-m3 they cost nothing).

**Arm D, `agent-knode-full`** (`src/eval/systems/knode.ts`). Arm C's folder (`wiki/` and `raw/docs/`, where the pages' links point) and the six tools of §2, on the shared knode build. A build now keeps one tool host per tool set, so the host serves D only its six; `serve`'s route refuses anything else from a worker's session. Its guide is `questionKindGuide` with grep and reading done in the shell, then the catalog schema, without the catalog guide's pointer to `knode_datasources` (a tool D does not have).

**Briefs.** One skeleton (`armBrief`, `src/eval/systems/agents.ts`): the existing agent brief, with each arm's "what you have" in its place and D's guide after it. Arms A and C ask exactly as in the 2026-11 runs. `src/eval/systems/briefs.ts` lists the four; `tests/eval-briefs.test.ts` shows them side by side, and `tests/eval-ladder.test.ts` checks every prompt the arms' sessions got is that brief and the question.

**Telemetry.** An answer record's `outputs` is entry for entry with `commands`: `{ text, chars, failed? }`, the first 2,000 characters of what the command or tool call returned and the full length, or null where nothing came back. It is read from Codex's `item.completed` events (a command's `aggregated_output`; an MCP call's text content, else its structured content, else its error), paired with the start by item id, else by kind in order. A worker sends a longer output cut to that head with `knode_output_chars`, so `serve` keeps less per lease; an older worker's whole outputs are read the same way, and records without `outputs` report as before.

**Report** (`src/eval/report.ts`), first after the run's facts:

- *The ladder*: the five differences of §2 for which the run answered with both arms, paired over the questions both were scored on (first answers; all packs pooled, a question per pack and task). Correctness, weighted tokens, USD at API prices, latency and tool calls each get Δ, a paired-bootstrap interval and p, the MDE (α 0.05, power 0.8, unadjusted) and significance after Holm across the rows shown, metric by metric.
- *Which questions tell the agents apart*: over the questions every agent system of the run was scored on, all fully right (correctness 1), none fully right, and the rest, overall and per task type. On run-10x's records this gives 168, 56 and 37 of 261, the figures of §0.
- USD and tokens per correct answer beside correctness in each pack's answering table.
- *knode tools and correctness*, per pack and every agent that called knode's tools (D, and `agent-knode` when it runs): calls per tool, and mean correctness of the scored answers that called it against those that did not. Descriptive: the groups differ in their questions too.

Not shown without a model-backed run: whether agents use `search` or knode's tools much when grep is beside them, whether Codex's `item.completed` events carry outputs in exactly the fields read here (the reader tolerates missing ones, which leave `outputs` absent), and every number the ladder will report.
