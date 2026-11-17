# 20 — Explore and Tasks: one place to look things up, one place to see what runs

> **Record status (2026-11-17): Built.** This is a decision record, not the description of the system. What the code does now is in [ARCHITECTURE.md](../ARCHITECTURE.md) §6.1, §9. Stale here: six stages (Evaluation is a seventh, 32); the scheduled-check list; processing now starts with the service.

> Status: **implemented** (2026‑10‑30). Server: `GET /api/search/explore` and `GET /api/search/suggest`
> (src/search/explore.ts), `searchExplained` (src/search/search.ts), `GET /api/tasks` (src/server/tasks.ts),
> the activity log (src/activity.ts). Web: web/index.html, web/app.js, web/style.css. Mac app:
> ExploreSearchView.swift, TopSearch.swift, TasksView.swift, and the navigation in Models.swift / RootView.swift.

## 0. What was there

Five sections: **Library** (Files, Search, Traces), **Ask**, **Research** (Studies, and Sources on the web),
**Knowledge** (Graph, Entities, Wiki, Dream) and **Settings**.

- Search was a list of passages with a fused score and the names of the signals that found each one. It did
  not say *how well* each channel ranked a passage, which entities the query named, or what the graph holds
  around them — so it could not answer the question people opened it with: *why do the agents get this
  context for this question?*
- Ask and Research were two sections for one intent — a question about the workspace — differing in how much
  work the answer takes.
- What the workspace was doing showed as one toolbar switch (Processing) and its popover: queued documents,
  summaries due, a count of remote workers. Nothing listed the calls out right now, who held them, which
  research jobs or Ask turns were running, what the watcher was syncing, or when Dream would run next.
- Library carried Search and Traces as tabs, and uploads hid under ＋ next to New file.

## 1. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 Five sections: Library, Explore, Knowledge, Tasks, Settings | **Library** is Files alone. **Explore** has three modes — **Search**, **Ask**, **Research** — as its tabs (`search`, `ask`, `studies`). **Knowledge** keeps Graph, Entities and Wiki. **Tasks** is new: **Queue** and **Dream**. Research's Sources page (web only) moves to Settings, after Research. Old stored tabs land somewhere: `traces` → Dream | Material comes in (Library), you look things up (Explore), knowledge grows (Knowledge), work runs (Tasks). Search, Ask and Research are one intent at three depths: what matches, an answer, a set of pages |
| D2 Search explains itself | `GET /api/search/explore` runs the agents' own retrieval asked to explain: every passage carries its rank in each channel that found it — **semantic** (vectors), **keyword** (full text, a substring fallback for CJK), **entity** (chunks mentioning an entity the query names) — and each channel says how many chunks it returned, how long it took, and whether it failed. Beside it the graph read (one hop of `graphSearch`) returns the entities the query names — with *where* it named them: name, alias or description — the entities one relation away, the relations between them and the claims about the strongest | The fused score is a sum of reciprocal ranks; the ranks are what a person can reason about ("first by keyword, nowhere semantically"). Naming the matched field shows an alias doing the work (`AURL` → Aurora Labs) or a description dragging in an unrelated entity |
| D3 Two reads, either may fail, neither counted as use | Passages and the graph read run side by side; each reports its own error and the other's results stand. In hybrid mode a semantic channel that cannot answer (a spent embedding quota) is shown failed, not hidden. Neither read records hits in the usage ledger (`track: false`) | A search page that goes blank when one provider is out of quota teaches nothing. Every recorded hit raises its document's heat, and heat multiplied the fused score without a ceiling (src/stats/heat.ts; since 2026‑10‑31 it adds at most `heat.searchWeight`): on the check server a few dozen inspections lifted a many-chunk `schema.md` from nowhere to first. An inspection must not move the ranking it was opened to look at |
| D4 A search box above every screen | The toolbar (Mac) and the header (web) carry one search field, centred at the level of the workspace switcher. Typing offers entities (name or alias, exact first, then prefix, then by mentions) and indexed documents (title or path) from `GET /api/search/suggest` — substring reads, no model — and three actions: **Search**, **Ask**, **Research** the text. Return searches; ⌘K (web: ⌘K or `/`) focuses it | Search is the most frequent thing done in the app; it should not take two clicks into a section. The three actions are the same intent at three depths, as in Explore |
| D5 Ask and Research keep their flows | A question sent from the box starts a new Ask conversation; a topic sent to Research fills the study composer and waits there (refining spends a model call; starting stays a person's decision) | Nothing that spends model calls starts from a keystroke in a search field |
| D6 Tasks → Queue is a view of everything under way | `GET /api/tasks`: the pipeline by stage — **Index** (documents pending or failed), **Embed** (chunks waiting for a vector of the current model, and why the backfill is waiting), **Extract**, **Summarize**, **Translate** and **Review** (judge calls) — with what waits, what is out now and what was done in the last hour; every lease out now with its document, part and the worker holding it; this machine's backends (slots, busy, paused and why) and every remote worker the broker has seen (online when it asked in the last two minutes); research jobs, studies and Ask turns running (and those finished in the last 24 h); background syncs from the activity log; and what runs on a clock: Dream, the tier‑2 pass, trace collection, datasource refresh, linked folders | The question "is anything processing, and where?" had no answer short of the service log |
| D7 Processing is started and stopped in Tasks | The toolbar keeps a small status pill (running or stopped, with the in-flight count); clicking it opens Tasks → Queue, which holds Start (with the estimate, docs/design/18) and Stop | One place to watch work and one to switch it; the pill stays as the glanceable state |
| D8 Dream belongs to Tasks | Dream is a scheduled job whose output waits for review. Tasks → Dream shows when it runs next, Dream now, the suggestions to accept or reject, and the agent traces it reads (what was Library → Traces) | It is work the system does on a clock, like the tier‑2 pass; its suggestions are about agent behaviour, not knowledge content |
| D9 An activity log, in memory | src/activity.ts records background work that is not leased model work — watcher syncs, uploads indexed, folder imports and links catching up, trace collection, datasource refresh, Dream, the tier‑2 pass — while it runs and the last 30 after it ends, per workspace, until the service restarts | The broker already reports leased work; the rest ran silently. Only a view: nothing reads it to decide what runs |
| D10 Import data is one menu | Library's tree pane has **Import**: files, a folder (uploaded), a folder linked from the service's machine (kept in sync; an administrator's, as before), and agent traces (Claude Code and Codex sessions collected into `raw/traces`). ＋ keeps New file and New folder | Bringing material in is one intent with four sources; creating a note is another |
| D11 Toolbar stays small | The Mac toolbar holds the workspace switcher, the search field, notices and the processing pill; the document / chunk / entity counts move to the Tasks header (the web header's stats line likewise). The Tasks sidebar row shows Dream suggestions waiting | The search field needs the centre; the counts are read when checking on the workspace, which is what Tasks is for |

## 2. API

`GET /api/search/explore?q=&mode=hybrid|sag|vector|keyword&k=20&sources=&kinds=` (group `search`):

```jsonc
{
  "query": "宁德时代 储能", "mode": "hybrid",
  "terms": ["宁德时代", "储能", "宁德", "德时", "时代"],
  "passages": [{ "chunkId": "…", "documentId": "…", "path": "wiki/concepts/储能.md", "title": "储能",
                 "content": "…", "docDate": null, "score": 0.0422,
                 "signals": { "vector": 0.81, "keyword": 0.12, "graph": 2 },
                 "ranks": { "vector": 2, "keyword": 1, "graph": 2 },      // hybrid, vector, keyword
                 "trace": { "route": "sag", "hop": 1, "bridgeEntities": ["A", "B"] } }],   // SAG only
  "channels": { "vector": { "hits": 26, "ms": 5, "error": "…" }, "keyword": { "hits": 7, "ms": 5 }, "graph": { "hits": 8, "ms": 3 } },
  "entities": [{ "id": "…", "name": "宁德时代", "type": "organization", "description": "…", "aliases": ["300750"],
                 "mentionCount": 8, "degree": 5, "wikiPath": null, "score": 2,
                 "match": { "field": "name", "term": "宁德时代", "text": "宁德时代" } }],   // match null: reached via a relation
  "relations": [{ "source": "<entity id>", "target": "<entity id>", "type": "competes_with", "description": "", "weight": 1 }],
  "claims": [{ "id": "…", "subject": "宁德时代", "statement": "…", "status": "disputed", "kind": "fact", "path": "raw/docs/…" }],
  "ms": { "total": 20, "passages": 19, "graph": 13 },
  "errors": { "passages": "…", "graph": "…" }   // only the reads that failed
}
```

`GET /api/search/suggest?q=&limit=6` (group `search`):
`{ "entities": [{ "id", "name", "type", "mentionCount", "wikiPath", "alias" }], "documents": [{ "path", "title" }] }` —
`alias` is the spelling that matched when the name did not.

`GET /api/tasks` (group `ingest`, like the labeling status):

```jsonc
{
  "at": "…", "serving": true,                       // false outside `serve`: no processing, broker or slots
  "processing": { "running": false, "since": null, "by": null },
  "stages": [{ "id": "index|embed|extract|summarize|translate|review", "enabled": true,
               "unit": "documents|chunks|translations|calls", "waiting": 0, "inFlight": 0,
               "doneLastHour": 0, "callsLastHour": 0, "failed": 0, "note": "waits for processing to start" }],
  "inFlight": [{ "id", "kind": "extract|summarize|translate|judge", "subject": "raw/docs/a.md", "detail": "part 2 of 5",
                 "worker", "backend", "remote": true, "ageSeconds": 40, "expiresInSeconds": 860 }],
  "workers": [{ "id", "label", "remote", "kinds": [], "slots": 4, "busy": 2, "ok": 10, "failed": 1, "lastSeen": "…",
                "online": true, "pausedUntil": null, "pauseReason": null, "lastError": null }],
  "jobs": [{ "id", "kind": "study|research|init|ask", "title", "status", "stage", "createdAt", "startedAt", "finishedAt",
             "error", "outputPath" }],
  "activity": { "running": [ActivityItem], "recent": [ActivityItem] },   // { id, kind, label, startedAt, finishedAt?, ok?, detail? }
  "scheduled": [{ "id": "dream|tier2|traces|datasources", "at": "03:00", "everyMinutes": null, "next": "…", "enabled": true, "running": false }],
  "folders": [{ "dest", "source", "watching", "lastSyncAt", "lastError", "lastChange": { "copied", "removed", "at" } }],
  "dream": { "pendingSuggestions": 0, "lastSuggestionAt": null, "lookbackDays": 7 },
  "documentErrors": [{ "path", "error" }]
}
```

Keys are camelCase throughout (the Mac client decodes snake_case keys into camelCase; dictionary keys here
carry no underscores). The pending-vector count reads every chunk, so one count is shared for 20 s.

## 3. Screens

**Explore → Search.** A query bar (mode: hybrid, multi-hop, semantic, keyword; scope: the whole base or a
folder). Under it one line says what matched — passages in documents, entities, relations, the time — and
three channel chips with their hit counts (a failed channel shows its error); a chip filters the passages to
that channel. The terms keyword and entity matching used are shown too. The passages column lists each
passage with its title and path, date, a snippet with the terms marked, and its channel ranks (`semantic #2 ·
keyword #1 · entity #4`, or `via A → B` for multi-hop); it can group by document. The side column holds the
entities the query names (type colour, the matched field, mentions and relations, description; open in the
graph, open the wiki page, search for it), the relations among them and their neighbours (co-occurrence
apart), and the claims (disputed ones marked).

**Tasks → Queue.** Processing (state, Start with its estimate, Stop) and the workspace counts; the six stage
cards in pipeline order; In flight; Workers; Jobs; Background (running, then recent); Schedule (and linked
folders); documents that failed to index. Polled every 3 s while shown.

**Tasks → Dream.** When Dream runs next and over how many days, Dream now, Collect agent traces, the
suggestions, and the traces it reads.
