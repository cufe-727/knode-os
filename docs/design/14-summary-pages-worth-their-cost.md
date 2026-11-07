# 14 — Summary pages worth their cost: a size threshold, the document's language, the graph's names, whole documents

> Status: **implemented** (2026‑10‑23). Config keys `extraction.summaryMinChars` and `extraction.summaryMaxSegments`,
> schema v15 (`documents.chars`), `knode-os wiki prune-summaries`.

## 0. What the pages looked like

A quality review of the finance workspace (≈22,000 Chinese stock-blog digests, 13,606 summary pages) on 2026‑10‑21:

1. **Pages longer than their documents.** 32% of the documents are under 1 KB — a day with one post — and each got a
   1.3–1.5 KB summary page that restated the post. Every page is indexed again as a `view` document, so each of those
   posts counted twice in search, the second time in a worse paraphrase.
2. **An English scaffold on Chinese pages.** The prompt was English, so 13,605 Chinese pages carried `## Key points`
   and `## Entities`, and 3,237 ended with boilerplate such as `[[雪球]]：内容发布平台` — the platform the digest came
   from, listed as an entity of every page.
3. **Links to names the graph does not have.** The summary never saw the document's extraction, so its `[[wikilinks]]`
   used whatever the model felt like: `[[懂王]]` where the graph has 特朗普, `[[融资杠杆]]` for 保证金交易, the
   traditional-character `[[管我財]]` beside 管我财. `wiki lint` reported 194,818 broken links over 13,617 pages.
4. **Long documents read to 14,000 characters and no further.** A 134 KB weekly digest of 260 posts got a page that
   claimed to cover the week and had read about 10% of it. 17% of the documents, 71% of the bytes, are over 36 KB.
   Extraction, by contrast, cuts a long document into `extraction.segmentChars` segments and reads all of them
   (docs/design/10 §3).

## 1. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 Size threshold, no page below it | A document under `extraction.summaryMinChars` (default 1,500 characters of indexed text) gets **no summary page** — not a pointer page either. It is never "due", the sources index marks it `short`, search finds the document itself | A pointer page would be indexed as a view like any page, so it would keep the search noise the threshold is meant to remove and say nothing the sources index does not. Characters, not bytes, because every other size in the pipeline (`segmentChars`, `LLM_WIKI_INPUT_CHARS`) is characters and a Chinese character is three bytes |
| D2 The scaffold in the document's language | The language is detected from the text (or declared as `lang:` / `language:` in frontmatter); the prompt names it and gives the two section headings in it (zh 要点 / 实体, en Key points / Entities, ja, ko). The page's `description` follows. The answer's headings are normalized to the scaffold whatever the model wrote | The instruction stays English — models follow it well — but the output's shape is fixed in the reader's language |
| D3 The channel is not an entity | Frontmatter `platform:` / `source:` / `author:` / `channel:` name the document's own channel (platform ids map to their names: `xueqiu` → 雪球). The prompt says not to list them; a link to one becomes plain text; a bullet in the entities section that only names one is dropped | The digests' boilerplate was the channel listed on every page |
| D4 Links only to the graph's names | Each call carries the document's entities **as the graph names them**: from `entity_mentions`, following `canonical_id` to the survivor of a merge, with the graph's aliases and the spelling the document was extracted under. The model may link those names only; in the answer a link under an alias becomes `[[Name\|alias]]`, a link to anything else becomes text | A summary written before resolution would link the pre-merge spelling; `entity_mentions` after resolution is what the graph actually has. Tier-0's mined concept placeholders are left out — they are not names anyone links and tier-1 retires them |
| D5 Long documents, segment by segment | A document over `LLM_WIKI_INPUT_CHARS` is cut with the extraction segmenter (`min(segmentChars, 14,000)`), each segment summarized in its own call, and the parts merged in one more call. Past `extraction.summaryMaxSegments` (default 12) the segments are sampled evenly, first and last included, and the page says so: `分段摘要：全文约 134,000 字、12 段，本页只读了其中 8 段（约 65%，260 节中的 170 节）。` plus a `coverage` frontmatter block | Calls are bounded (at most `summaryMaxSegments + 1` per document) and honest: a page that read part of a document says which part. Same segments as extraction, so a part call sees the entities extracted from exactly that text |
| D6 Parts cached by segment hash | Part summaries live in the sidecar's `views/source-summary.parts.json`, keyed by the segment's text hash like tier-1's `segments`. The final summary keeps its content-hash cache (`views/source-summary.md`), now with the language and the coverage | A digest for the current week changes every day: only the changed segment and the merge are paid again; an interrupted document resumes with the parts it has |
| D7 Leased work, one call per lease | The summary source hands out **calls**, not documents: a long document's parts may be out to several workers at once; once every part is in, the merge goes out. A part's answer goes to the part cache and puts the document back in line; the merge's answer goes to the summary cache and the page is written from it, as before | Fits the broker's model (docs/design/12) without a new kind; remote workers need no change — a task is still messages, a prompt and `maxTokens` |
| D8 Existing pages: a sweep, and attrition | `knode-os wiki prune-summaries` archives the summary pages of documents under the threshold through `archivePage` (to `wiki/.archive/`, search projection dropped), and rewrites the sources index. Independently, the generator's `plan` returns null for a short document, so a stale page is archived when its document next changes. Cached summaries are kept: lowering the threshold restores the pages without a model call | Archiving 7,000 pages is the user's call, not a sync's side effect — the command is run by hand (`--dry-run` lists first). The existing 13,606 pages are **not** re-summarized: their cached bodies stand until their documents change |

## 2. The flow

```
planSummary(store, dataDir, config, doc)                      src/wiki/summary.ts
  text        ← loadSourceText; under summaryMinChars → { kind: 'none', reason: 'short' }
  language    ← frontmatter lang/language, else script of the text
  channels    ← frontmatter platform / source / author / channel (+ platform id names)
  vocabulary  ← entity_mentions of the document → entities, canonical_id followed, aliases + mentioned spelling
  fits one call → { kind: 'single', segments: [whole text] }
  else          → segments = segmentText(text, min(segmentChars, 14,000)), sampled to summaryMaxSegments
                  coverage = { chars, parts, read, share, sections, sectionsRead }
                  cached   = part summaries the sidecar holds for these segments (by hash)

pendingSteps(work)   single → [single]; segmented → parts without a cached summary, else [reduce]
summaryStepRequest   the messages of one step (system: scaffold, language, link rule, channel rule; user: the text,
                     the segment, or the parts); `summary.request` hooks see every step with { step, language, entities, channels, segment? }
finishSummary        unwrap a code fence · headings → scaffold · links → vocabulary (alias → [[Name|alias]], unknown → text,
                     channel → text) · channel bullets out of the entities section · coverage line for a segmented page

one-shot (ensureSourceSummaries → render → produceSummary):   parts in turn, each written to the part cache, then the merge
leased   (SummarySource.lease):                               one WorkTask per pending step; parts to any worker; merge once all are in
```

`dueSummaryDocuments` takes `minChars`: the SQL leaves out rows whose `chars` is under it, and a row from before the
column (`chars IS NULL`) is settled by `bytes` where that can (a character is 1–4 bytes) or by reading the text once,
after which the column is filled in (`documentChars`, a `SKIP LOCKED` update that yields to an apply in flight). The
sources index marks a document under the threshold `` `short` `` instead of showing it as still unsummarized.

## 3. Config, schema, CLI

```jsonc
"extraction": {
  "summaryMinChars": 1500,      // no summary page under this many characters of indexed text; 0 = every document
  "summaryMaxSegments": 12,     // segments one summary reads at most; past it, sampled evenly and the page says so
  "summaryAfterExtraction": true // false: summarize documents still queued for extraction (their pages link only what the graph has)
}
```

All three are accepted by `PUT /api/config`. `summaryAfterExtraction` (2026‑11‑08) is for a library whose extraction
would take far longer than its summaries: its summaries go first, and since a summary is cached by the document's
content, extraction landing later does not redo one. Schema **v15** adds `documents.chars` (the indexed text's length), written by
every apply; rows from before it are filled in lazily by the Summarize stage's scan.

```
knode-os wiki prune-summaries [--dry-run] [--min-chars n]
```

Lists (`--dry-run`) or archives the summary pages whose document is under the threshold (the configured one, or
`--min-chars`), then rewrites `wiki/sources/index.md`. Reversible: `wiki/.archive/sources/*.md` holds the pages,
the sidecars hold the summaries, and a lower threshold restores both on the next pass or `wiki generate`.

For the finance workspace: run `knode-os wiki prune-summaries --dry-run` first to see the count (about 7,000 of
13,606 pages at the default 1,500), then without the flag. Nothing about the other pages changes until their
documents change; a re-summary of all of them would cost one call per document plus `summaryMaxSegments + 1` per
long one.

## 4. Where the changes go

| File | Change |
| --- | --- |
| `src/wiki/summary.ts` (new) | language detection and scaffolds, the link vocabulary from `entity_mentions`, channel names, the plan (`planSummary`), steps and their prompts (`summaryStepRequest`), the answer's finishing (`finishSummary`), the one-shot runner (`produceSummary`), the threshold helpers (`shortByRow`, `documentChars`, `isShortDocument`) |
| `src/wiki/pages.ts` | `source_summary.plan` returns null under the threshold; `render` goes through `produceSummary` and writes the language-specific `description` and `coverage`; `dueSummaryDocuments(minChars)`; the sources index's `short` badge; `pruneShortSummaries` |
| `src/work/summarize.ts` | leases per step; parts to the part cache and the document back in line; the merge to the summary cache; `totals.parts` and a `label` per lease in the status |
| `src/fs/sidecar.ts` | `views/source-summary.parts.json` (`readSourceSummaryParts`, `writeSourceSummaryPart`); `language` and `coverage` in `views/source-summary.md` |
| `src/config.ts`, `src/server/app.ts` | `summaryMinChars`, `summaryMaxSegments` and their validation |
| `src/store/migrations.ts`, `src/lineage/writer.ts`, `src/ingest/apply.ts`, `src/types.ts` | `documents.chars` |
| `src/plugins/types.ts`, `docs/plugins.md` | `summary.request` context: `step`, `language`, `entities`, `channels`, `segment?` |
| `src/cli.ts`, `README.md` | `wiki prune-summaries` |
| `tests/summaries.test.ts` | the threshold, the language, the links, the coverage, leasing a long document, the sweep |

## 5. Known limits

1. Only four scaffolds (zh, ja, ko, en). Latin-script text of any other language gets the English headings; a
   `summary.request` hook can rewrite them.
2. A part failure counts as one of the document's three attempts, like any bad answer. A document whose model
   fails one part three times gets no page until its content changes — the parts it has are kept for then.
3. The vocabulary is what the graph holds *when the summary is planned*. A merge made after the page is written
   leaves the page's links at the old spelling until the document changes; entity pages redirect, so the links
   still resolve where a stub exists.
4. Entity stub pages are still written only by `wiki generate` (`ensureEntityStubs`, 30 at a time), so a link to a
   graph name may still have no page behind it. The link is now at least a name the graph has; writing stubs for
   every linked entity is a separate change. Since 2026‑10‑25 such a link opens the entity panel, and `wiki lint`
   counts it apart from broken links (06 §7).
5. Existing pages keep their English scaffold and free-form links until their documents change. Re-summarizing
   them is a model-call budget decision, not taken here.
