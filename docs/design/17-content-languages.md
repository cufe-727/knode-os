# 17 — Content languages: a primary language to read in, translations kept beside the originals

> Status: **implemented** (2026‑10‑28). Config block `languages`, Translate stage `extraction.translateLlm`,
> work kind `translate`, schema v17 (`documents.language`, `translations`), `GET /api/languages`,
> `GET /api/file?lang=`, `POST /api/file/translate`, `knode-os translate`.

## 0. What was there

A workspace collects documents in whatever language they were written in. The finance workspace on 2026‑10‑28:
22,624 Chinese documents (273 M characters, mostly stock-blog digests), 189 English ones (5.8 M characters: SEC
filings, company pages and research captures under `raw/docs/research/`, quant notes) and 2 Korean ones. A Chinese
reader opened an English filing and read English; the summary page beside it was English too, because summaries were
written in the document's language (docs/design/14 D2).

Two smaller findings on the way:

1. **The language detector counted URLs.** Summaries detected a document's language from its script, letters of every
   kind counted. A digest with an image URL per post read as English: 1,138 of the finance workspace's Chinese
   documents did, so their summaries would have been written with English headings.
2. **An interface language existed only in the Mac app**, as a client-side preference (System / English / 中文) that
   expressly leaves content alone. The web UI is English only.

## 1. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 Content language ≠ interface language | Two independent settings. The **interface language** is a person's, per device: the Mac app's picker, stored in `UserDefaults`; never part of the workspace. The **content languages** are the workspace's: a `primary` language the knowledge is read in and any `secondary` ones, in `knode.config.json`. Between them sits each reader's **reading language** — which version of a document the switcher shows — remembered per device, defaulting to the workspace's primary | A person may run an English interface over a Chinese knowledge base, or the other way round. Tying the two would translate the workspace whenever someone changes their menus, or force every reader of a shared Team workspace into one interface language |
| D2 Translate the Markdown, never the original | What is translated is a document's **indexed text**: the file itself for Markdown and text, the Markdown knode-os derived for a PDF, a picture or a saved web page. The original is never touched; "original ↗" still opens it | The derived Markdown is what every other stage reads and what readers see; a translated PDF would be a new original to convert, and the source of truth would move |
| D3 Translations live in the sidecar | `.sidecar/<path>/views/translations/<lang>.md` (the whole translation; frontmatter = cache key: `contentSha`, `source`, `language`, `model`, `generatedAt`, `parts`) and `<lang>.parts.json` (one translation per segment, by segment hash). Not under `wiki/`, not indexed | A translation is a derived view of one source, like its summary cache and its converted Markdown: it moves with the source, goes to the attic with it, and is never mistaken for knowledge of its own |
| D4 Segment by segment, cached by hash | The body is cut with the extraction segmenter (content-defined cuts, docs/design/10) — 8,000 characters for Latin script, 4,000 for CJK, about the same amount of text and of answer — one call per segment, each kept under the segment's hash. The frontmatter stays verbatim | A digest that grows every day pays only for its new segment; an interrupted document resumes; several workers can hold one long document's segments at once; a reader sees what is translated while the rest is out |
| D5 Links, anchors and code are held out of reach | Before a segment goes out, fenced and inline code, HTML tags (the `<a id="e-…">` anchors wiki pages cite), URLs, link targets, wikilinks and footnote marks become tokens `⟦1⟧ ⟦2⟧ …`; the answer's tokens are swapped back. An answer that lost a token, is far shorter than the text, or is still in the source language is a **bad answer** | A citation `raw/docs/…md#e-8520909f` must land in the translation too, and a link must keep working; a 150-character image URL per post costs a few characters instead; the checks catch a model that summarized, truncated or refused |
| D6 Primary: everything; secondary: on request | Every document under `raw/docs` written in another language than the primary one is translated into it in the background. A **secondary** language is offered in the switcher; a document is translated into it when someone asks (the switcher's *Translate* button, `POST /api/file/translate`). `languages.maxChars` (default 200,000) leaves longer documents to a request too | Finance: English → Chinese is 189 documents, 5.8 M characters, about 750 calls. Chinese → English for every document would be 273 M characters — tens of thousands of calls for pages nobody may open. A request is one click by the person who wants the page |
| D7 Leased work, a fourth kind | `translate` joins `extract`, `summarize` and `judge` behind the work broker (docs/design/12): this machine's slots run it on the **Translate stage's route** (`extraction.translateLlm` — Codex, Claude Code, Cursor or any model; `translateConcurrency` slots, default `concurrency`), remote workers take it unless `server.remote.offer.translate` is false, and it shares a slot with extraction and summaries by weight (`server.remote.shares.translate`, default 1 against extraction's 3) | No new runner, no new protocol: a task is still messages, a prompt and `maxTokens`. A route from before the stage starts as a copy of the Summarize stage's (`migrateTranslateRoute`): both write prose for people |
| D8 Progress in a table, truth in files | Schema **v17**: `documents.language` — detected on every apply, `''` for a text without letters, filled in once for older rows by the stage's scan — and `translations (document_id, language, content_sha, status, parts, done, attempts, requested, model, error)`. Statuses: `requested`, `partial`, `done`, `failed`, `skipped` | The scan finds what is due with one query instead of opening a sidecar per document (22,000 of them in finance), and a file view says how far a translation got. A rebuild loses the rows; the scan finds the sidecars' translations again without a model call |
| D9 Summaries in the primary language | With content languages on, every new summary page is written in the primary language whatever the document's — the scaffold's headings too (zh 要点 / 实体) | A Chinese reader's English filing gets a Chinese page in `wiki/sources/`, and that page is indexed: a Chinese search finds the filing through it. Existing summaries are not rewritten (docs/design/14 D8): their cache stands until the document changes |
| D10 Detection reads what a reader reads | `src/lang/detect.ts`: frontmatter `lang` / `language` when declared, else the script of the text with frontmatter, code, URLs, link targets, tags and e-mail addresses taken out; Latin script told apart by function words (en, fr, de, es, pt, it), Cyrillic as Russian. The summaries use it too | Fixes the URL miscount; the column and the stage read the same answer |

## 2. Config

```jsonc
"languages": {
  "enabled": true,           // off (default): nothing is translated, summaries keep the document's language, no switcher
  "primary": "zh",           // the language the knowledge base is read in — zh, zh-Hant, en, ja, ko, fr, de, es, pt, it, ru
  "secondary": ["en"],       // offered in the switcher, translated into on request
  "maxChars": 200000         // longer documents are translated only on request; 0 = no limit
},
"extraction": {
  "translateLlm": { "use": "connection-3", "model": "", "effort": "default", "speed": "fast" },  // the Translate stage
  "translateConcurrency": 2  // this machine's translation slots; default `concurrency`, 0 = remote workers only
},
"server": { "remote": { "offer": { "translate": true }, "shares": { "translate": 1 } } }
```

`PUT /api/config` takes `languages` (an unknown language is refused; on without a primary is refused) and the two
`extraction` keys; saving wakes the stage. Settings → Ingest shows a sixth stage, **Translate**, with the languages and
the route, in the web UI and the Mac app.

## 3. The flow

```
apply (sync)              documents.language ← detectLanguage(indexed text, frontmatter)

TranslateSource.scan      backfillLanguages (500 older rows a look)
                          dueTranslations:  requested rows (any offered language), oldest request first
                                            + primary: docs/source, language ≠ primary, chars ≤ maxChars,
                                              no done/skipped row and < 3 failed attempts for this content;
                                              translations under way first, then the latest documents
lease                     planTranslation: frontmatter | body → segments (8 k / 4 k) → cached parts by hash
                          one task per pending segment: protectSpans → messages (system: rules, user: the text)
complete                  finishSegment: unwrap, restoreSpans (all tokens back), length and language checks
                          storeSegment → <lang>.parts.json; all in → <lang>.md; translations row partial | done
failure                   bad answer: an attempt (3 per content); rate limit / lost connection / lapsed lease:
                          a strike, five strikes = one attempt
```

## 4. Reading

`GET /api/file?path=…&lang=zh` — the file as before, plus, for an indexed document under `raw/docs` in a workspace
with content languages on:

```jsonc
"languages": {
  "source": "en",                    // the language the document is written in (null: no letters)
  "primary": "zh",
  "offered": ["zh", "en"],           // the workspace's, and the document's own when it is neither
  "shown": "zh",                     // the language `content` is in
  "translations": {
    "zh": { "status": "partial", "parts": 12, "done": 5, "model": "codex-cli:gpt-6.1-sol", "requested": false },
    "en": { "status": "source", "parts": 0, "done": 0 }
  }
},
"translation": { "language": "zh", "done": 5, "parts": 12, "model": "…" }   // only when `content` is a translation
```

A translation under way reads as its translated segments with the original standing in for the rest. Without a
translation the original comes back (`shown` = `source`). `status` is `source`, `none`, `requested`, `partial`,
`done`, `failed` or `skipped`.

`POST /api/file/translate { path, lang }` asks for one: `{ ok, status: "requested" | "done", processing }` — the
stage takes it next; `processing: false` says this machine's slots are stopped (a remote worker may still take it).
`{ cancel: true }` withdraws a request. Both belong to the `files` API group. `GET /api/languages` lists the languages
knode-os knows (`code`, `english`, `native`, `prompt`) and the workspace's settings, for pickers.
`GET /api/labeling/status` carries `translations`: `enabled`, `primary`, `due`, the leases, totals (`calls`, `ok`,
`failed`, `documents`, …) and the last hour.

The switcher (web Files view, Mac file browser) lists the offered languages, the document's own marked as the
original. Picking one sets the reader's reading language for every document; a document without that translation
shows its original with a line saying so and, for a language the stage does not translate by itself, a *Translate*
button. A translation is read-only: an edit belongs to the original.

## 5. CLI

```
knode-os translate <path…> [--lang zh] [--retries n]   translate now on the Translate route, segment by segment
knode-os translate --status                          translations by language and status
```

## 6. Known limits

1. **Simplified and traditional Chinese are one language to detection.** A traditional-Chinese document in a `zh`
   workspace is not translated; a `zh-Hant` primary does not convert simplified documents. A frontmatter `lang:` says
   which one a document is.
2. **Latin-script detection is by function words** (en, fr, de, es, pt, it); a Dutch or Swedish text reads as
   English unless it declares `lang:`.
3. **Translations are not indexed.** Search finds a document by its own words — and by its summary page, which is in
   the primary language (D9) — and the embedding model decides how well a query in one language finds text in
   another (bge-m3, finance's, is multilingual). Indexing translations as views would double those documents' chunks.
4. **Extraction still writes in the document's language**: claim statements and entity descriptions of an English
   filing are English. An instruction to write them in the primary language is one line in the extraction prompt,
   but it changes what every later extraction writes and deserves its own measurement.
5. **Only `raw/docs` sources.** Wiki pages, traces and skills are not translated.
6. **No glossary yet.** A translation names companies the way the model knows them, not necessarily as the graph
   does; summaries hold their links to the graph's names (docs/design/14 D4), translations do not.

## 7. Where the changes go

| File | Change |
| --- | --- |
| `src/lang/languages.ts` (new) | the language catalog, tags normalized (`zh-TW` → `zh-Hant`), the `languages` config and `contentLanguages` |
| `src/lang/detect.ts` (new) | `detectLanguage` / `detectTextLanguage`: what a reader reads, its script, function words |
| `src/lang/protect.ts` (new) | `protectSpans` / `restoreSpans`: the tokens |
| `src/lang/translate.ts` (new) | plan, request, finish, assemble; the `translations` table; the due scan; the file view's languages; `translateNow` |
| `src/work/translate.ts` (new) | `TranslateSource`, the leased work |
| `src/work/kinds.ts`, `src/work/broker.ts`, `src/work/config.ts`, `src/labeling/local.ts`, `src/server/serve.ts` | the `translate` kind: shares, remote offer, CLI hints, local slots, wiring |
| `src/fs/sidecar.ts` | `views/translations/`: read, write, parts, list, clear; counted as paid work |
| `src/store/migrations.ts`, `src/lineage/writer.ts`, `src/ingest/apply.ts`, `src/types.ts` | schema v17, `documents.language` |
| `src/config.ts`, `src/server/app.ts`, `src/auth/apis.ts` | the `languages` block, the Translate route, the file and language routes |
| `src/wiki/summary.ts` | the detector; summaries in the primary language |
| `src/cli.ts` | `knode-os translate` |
| `worker/knode-worker.mjs` | takes `translate` tasks |
| `web/*`, `macos/Sources/KnodeOSApp/*` | the switcher, the Translate stage in Settings → Ingest, processing status |
| `tests/languages.test.ts` | detection, tokens, plans and the cache, the leased source, the file API, config |
