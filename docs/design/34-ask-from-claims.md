# 34 — Ask: sets and states computed from the claims, and a second round when the first is thin

Status: implemented on branch `claude/bold-liskov-1cde71` (2026-11-15), merged in main 7a299bf; reworked after an independent review on branch `claude/ask-computed-safety` (2026-11-16, §3). Measured without a model on a fresh no-model rebuild of the 10× reports benchmark. No model-backed run yet.

**Switches.** Computed sets are **off by default** (`retrieval.router.computedSets`, absent: off) until a model-backed run has checked them; the second round is on (`retrieval.router.secondRound`, absent: on). `ask(…, { computed, second })` overrides either per call; `ask(…, { now })` sets the day relative periods are read from (default today; an evaluation of a past corpus sets its own); `retrieval.router.computedBudgetMs` (default 1,000) bounds a computed set's time.

## Problem

`ask` (design 30) does one retrieval and one completion. On the 10× reports benchmark (1,420 documents, `run-10x`) it scored 0.50 against 0.90 for the agents. Two kinds of question it gets wrong:

- **A set, a count or a state.** "Which weeks was availability below 99.917%", "how many incidents did each team report per quarter", "what was the pool limit as of 7 November" need every matching claim of a scope, and the value that held on a day. `ask` answered them from 8 chunks and the 24–150 facts a ranking reached: the full gold set was in the facts for 0.40 of the pack's structured tasks, 0.38 of the aggregate ones; exact-set structured answers were 0 of 8 in the run.
- **A step past what the question names.** A chain question's intermediate entity reaches the facts, its final attribute does not; a named entity's claims may not be retrieved at all.

## 1. Sets, counts and state from the claims (`src/search/claimset.ts`)

For a question routed list, aggregate or lookup, `readSetQuestion` reads by rules what it asks of the claims, and `computeClaimSet` computes it over **every live claim of the scope**, in code:

| Part | Read from | Examples |
| --- | --- | --- |
| scope | the organisations the question names, each resolved to the survivor of its merges first; one holding another named one gives way to it (a division named beside its team scopes to the team); members are the organisations **recorded** as its parts (`part_of`, `subsidiary_of`, `belongs_to`, `member_of`), three levels down — never a name that begins with its name ("中信建投" is no part of "中信"). "全公司", "所有事业部", "company-wide" scope to the whole knowledge base, read only by the attributes or entities the question names | team, division, company |
| documents in scope | a document belongs to the organisation most of its claims are about | a team's weekly report; a division's monthly summary |
| what | attribute keys sharing the longest run of characters with the question (CJK) or all of their words (Latin), the question's words held by the scope's statements (longest substring first, plural to singular), a value it names among the scope's attribute values ("P1"), named entities that are not the scope ("T1-C1", "R-01") | 事故等级 / 事故级别 = P1; 服务可用性; "离职" |
| operation | 平均/average → mean; 最高/highest → max; 最低 → min; 总额/sum → sum; 几起/多少个/一共/how many → count; a day asked as of, with a quantity or setting asked (多少 / 上限 / how much) and no event (发布 / announce) → value; 哪些 / 列出, or an English plural after which → list ("Which company acquired X?" asks for no set) | |
| grouping | 按/每个/各/by/per/each + 组/team (member), 事业部/division (parent), 季度/quarter, 月/month, 周/week | 按组和季度 |
| filters | a threshold (低于/below 99.917), a least count (两起及以上/at least two), a period (the router's explicit range; else 去年 / 前年 / 今年, 本季度 / 上季度, 本月 / 上月, 近N个月 read from `now`; a fiscal year as the calendar year; a quarter, half or month in the year the question names, else `now`'s, "截至三季度" from the year's start; "截至第44周": the reports' own week numbering, read off their titles; words no rule reads, "最近", compute nothing), a state not reached (没有关闭: the item's latest statement of it is negated) | |

A set is computed only when what is asked is tied to the claims with confidence: an attribute of the scope's claims it names, an entity it names that is not its scope, or words that cover everything it asks about (or the kind of item it asks for and words that reach claims) — a match on part of it ("需要注意" of "风险需要注意") computes nothing. An empty result (no item, no reading, none past a threshold) is not computed, never a zero.

Items are the entities the claims are about (as their survivors), or of the kind the question asks for (人/谁/who → person, 客户/customers → organisation, 事故/incidents → event, 项目 → project: a claim's object, or a person its own passage mentions and its statement names); the scope's own organisations are never items. An item no claim states as fact (only forecast, rumoured, suspected) is named apart and not counted. Two names with one identifier ("INC-001-T1") are one item; when most items carry an identifier, one without is listed apart and not counted (a description of one that does); an identified item most of whose claims are reported outside the scope is dropped (a mislinked mention brought it in). Numeric operations read *readings*: one figure a subject states for a period — its validity window, else 一季度 / 上半年 / 全年 / 本周 in its statement — one per subject and period. Only claims stated as fact; a statement that only recalls an earlier value ("最初定为200", "originally") is no reading; a claim replaced by a claim **of the scope** that corrects it (更正 / 撤回…以…为准 / 有误), states the same period, or — neither period known, a setting — is of the same day, never held, while one replaced by a later change (a revert the extractor flags as a correction included) is history. The commonest unit is kept ("万" and "万用户" are one; "亿元" and "亿美元" two) and the commonest period length; a tie computes nothing, and a sum over periods not all of one known length computes nothing (no part summed with its whole). What was left out — not stated as fact, replaced, another unit or period length, no number recorded — is said in the block. A value as of a day is the latest reading on or before it, a correction over what it corrects on the same day.

The computed lines (counts, groups, extremes, means, the value then, each with its source's date and title) go to the prompt as `# Computed from the claims`, at most 6,000 characters (item lines are cut first, and a last line says how many), its rows (at most 100) as known facts tagged `set` with every source and their own kind and status, before the ranked facts; all the facts together stay within `enumerateLimit`. The prompt's rule tells the model to use the figures only where the listed match is what the question asks. The model still writes the answer. `AskResult.computed` and `route.computed` say what was computed; `computeClaimSet(…, { skipped })` says why nothing was.

Cost: no model call; about 15 short statements over id arrays (`= ANY($ids)`, each through its index — PGlite, without statistics, turns a correlated form into an index scan per row), bounded by `SET_SCAN_CAP` (20,000 live claims), `SCOPE_DOCS_CAP` (5,000 documents; past it the set says it may be incomplete) and the time budget. A question naming no scope exits after one lookup of its named organisations. A company-wide question reads the distinct attribute keys off the partial index of attributed live claims, then only the claims of the matched keys: no scan of statements. An index on `claims (attribute)` would make that a lookup; it needs a migration, not added here.

Where rules end, and a model would be needed (none is added):

- Words of what is counted that share nothing with the claims: "离职" against "已离开公司", "新招" against "加入". An attribute vocabulary shared with the extractor, or a model mapping the question to attribute keys, would close it.
- A grouping or a filter in words the closed classes miss, a scope named only by description ("负责结算的那个组").
- Entity resolution: the merged `T1-C1` entity holds ten divisions' settings, and incidents mislinked across divisions inflate a company-wide count (132 P1 incidents computed, 120 in the gold). Scope by document keeps a team's set right; the company count needs the entity fix (`src/graph/`).

## 2. A second round when the first is thin (`src/search/second.ts`)

After the first round, and only when no computed set answers the question and it is no timeline, `secondRound` decides by rules whether the round was thin:

- a **chain question** (`isChainQuestion`, or routed multihop) with a word the first round missed: one round answered steps the question asks one after another;
- a **named entity** none of whose spellings (its survivor and everything merged into or with it) a fact is about, a passage mentions or a passage writes;
- **half the question's words** in none of the passages and facts (CJK pairs that are pieces of grammar — "的人", "复过" — and the names it gives are not words it asks about).

It looks further from the uncovered named entities and from up to four entities the first round reached — its facts are about them, its passages mention them — that the question does not name, weighted by how often they appear and how many of the question's words the facts about them hold. An entity mentioned in more than 15 documents (a team in every weekly report, a person every report lists) is looked from only through passages that also hold a word the first round missed ("调到", "接手"), and never one in more than 80. One round, no model call: candidates from at most 2,000 mentions, ranked in SQL (most of those entities first, then nearness to the question, else most missing words; an uncovered hub with no question vector only through passages holding a missing word), at most 4 passages (one a document) and 12 facts about those entities, ranked as the first round's are. `route.second` says what it found and why it ran; `retrieval.router.secondRound: false` or `ask(…, { second: false })` turns it off.

Measured on the 312 tasks the 10× run asked (fresh no-model rebuild, the run's bge-m3 vectors): it runs for 57 (every deep-hop, nonlexical-hop and cross-lingual question, 3 others), costs 3.7 statements and 49 ms on average (86 ms at most; the machine was under heavy load), adds 1.25 passages and 12 facts. A gold document in the prompt: 0.86 → 0.88 over all tasks (cross-lingual 0.39 → 0.56, nonlexical-hop 0.61 → 0.72, style 0.41 → 0.47); every gold document: 0.49 unchanged. Deep-hop chains need four or five documents; one more round reaches one of the missing ones at best, and the step it most often misses is a fix written without the incident's code ("上周那起缓存击穿已由方杰修复"), which only entity resolution can link.

## 3. After the review of 2026-11-16 (branch `claude/ask-computed-safety`)

An independent review of main 7a299bf found confident wrong figures on finance-style questions and seconds of work on every list question. One commit per item, each with its test first (tests/claim-set-safety.test.ts, tests/second-round.test.ts):

| Item | What was wrong | Now |
| --- | --- | --- |
| switch | no way to turn computed sets off | `computedSets` off by default, `secondRound`, per-call overrides |
| 1 | 最高营收 8470 (a typo a later claim replaced), 营收总额 15665 (typo + Q1 + H1 + US dollars + a forecast), value as of 2025-12-31 4500 (the forecast, shown `[fact; set]`) | factual readings of one unit and period length; no max over a quarter and a half-year, no sum of a part with its whole; value 1789; rows carry their kind |
| 2 | "风险需要注意" matched on "需要注意" and listed CATL, 比亚迪, 特斯拉 | nothing computed without a confident match; rule softened |
| 3 | the merged spelling CATL listed as 宁德时代's customer, and as "what is asked" | every id resolved to its survivor |
| 4 | "截至三季度" read off the latest report's year, answered 0; 去年 / 2025财年 ignored | periods from `now` and the question's own year; empty is not computed |
| 5 | 1.2–13.8 s per list question at 10,000–40,000 organisations; 3.6–18 s for "有哪些人" | SQL from relations; people from mentions; 1 s budget |
| 6 | 49,000- and 248,000-character blocks; 240 rows beside 150 facts | 6,000 characters, said when cut; facts within the limit |
| 7 | 中信 scoped with 中信建投 by its name | recorded relations only |
| 8 | a second round for "宁德时代的董事长是谁？" because CATL was absent; every multihop route; a hub's first 240 chunks by id | coverage per entity; chains need a missing word; candidates ranked in SQL from a bounded pool |
| 9 | "Which company acquired X?" read as a list; "…那天发布了什么公告" as a value | singular which and events stay lookups |
| 10 | company-wide ILIKE over every statement; the document cap unreported | attribute-only company reads; capped said |

Replaying the 10× pack with computed sets on showed the first numeric fix had lost a setting's history (a later change superseding a period-less value, a revert flagged as a correction, supersession chained across divisions by a merged setting code) and split "万" from "万用户"; fixed in b7e8682 with tests. The timeline cue 最早…最后 / first…last that routes "When did the first quarter results come out last year?" to the timeline came from 114f0c7 (route.ts) and is left to the routing work.

At 113,000 entities (60,000 organisations, 40,000 people; one company with 400 reports and 10,000 claims, 2,000 customers; PGlite): a scoped list question computes its set in 350–440 ms, `ask` takes about 590 ms with computed sets on and 230 ms off; a question naming no scope exits in about 1 ms.

## 4. After the re-check of 2026-11-16 (same branch, from 79793bf)

The default (computed sets off, second round on) was judged safe to deploy; computed sets on were not. Fixed, one commit each with its test:

- **Second round, words** (e147c30, d0b9d2e): missing words are `Intl.Segmenter`'s words (`questionWords`), less stop words, interrogatives, deictics, counting words, dates and numbers, and the kind of answer an interrogative asks for ("哪家公司"); never pairs of characters across a word boundary ("度毛"). A lookup reads further only from the entities it names, taking only what holds a word it missed; a chain also from the entities its first round reached, and only when it misses a word or its step has no passage or fact of its own.
- **Second round, hubs** (39eb1a5): a hub's passages are ranked by the question (vector index) and by its missing words (keyword index) before any cut; the bounded pool of other mentions comes after.
- **A figure is its claim's subject's** (eb4b34a): another organisation's figure stated in the scope's report is left out and said; a document whose organisations tie has no owner.
- **Units** (0ee8e55): a unit is a scale and a base; one base compares across scales; a bare scale never merges two currencies.
- **Periods** (9e13edc, c99b9a7): a window is tested on the period a figure covers, groups are by that period with its year, the scope's own figure keeps its parts' out, figures of one period that disagree are left out, and a total says how many of its window's periods it covers.
- **Budget** (bb7d1bf): pre-emptive per statement; the sources read is indexed (5,000 customers: 1.1 s -> 0.33 s); today is the local date.
- **Evaluation** (e435265): `KNODE_EVAL_ASK_COMPUTED` and `KNODE_EVAL_ASK_NOW` turn computed sets on for a run.

`multihopAnswer` keeps the computed-sets gate; what a chain's set is scoped to is the relation walk's to decide.


## 5. After the third check of 2026-11-16 (same branch, from 36f6ea5)

Default config (computed sets off, second round on):

- **Second round** (08c8705, 7341ceb): word statistics are read only once the keyword index (`chunks_match_grams_idx`) is ready; on a ready index they are a bitmap scan of it. A chain step counts as covered only by a passage or claim of its own, not by the one that led to it.
- **Cross-lingual questions** (no change): the narrow rule (an English name with no linked entity read in its own language) cannot fire on the 10x pack — none of its 18 asked cross-lingual questions names a linked entity, so it recovers none. The earlier gain came from lookups reading entities the passages happen to mention, which item 2 of the re-check ruled out.
- **Segmenter** (no change): a word `Intl.Segmenter` cuts wrongly is in no passage (df 0) and is ignored; an uncut long run is dropped. Both fail safe: the round does not fire.
- **Evaluation** (b5c8bf0): an empty variable is unset, an unreadable one is an error naming it, and the options are recorded in the run's metadata (`askOptions`).

Computed sets (still off by default), one commit each with its test:

- **合计 is a sum; a peer is no item** (d5a96ba, narrowed in 6c44915): only a peer's own figure (a number, no object, not naming the scope) is left out; what it did ("客户甲升级了事故") still lists it — the first rule lost 9 of the 10x pack's customer-escalation tasks.
- **Scale after the currency** (a220f77): "HK$ bn", "USD billion".
- **Threshold in its own unit** (5c61ebe): "超过1万亿元" is compared in the base; a bare figure in the unit shown.
- **Running totals** (07f6707): "前三季度", "1-9月", "Q3 YTD" and a validity window from 1 January through another month than June or December are `ytd`, never the third quarter; a sum or mean of running totals is not computed. A question's "前三季度" is the window from 1 January.
- **Fiscal quarters** (760d0ec): a quarter or half of a fiscal year with no days recorded is in no calendar window, and is said.
- **Disagreeing figures** (2fc56af): a period with two figures, neither recorded as replacing the other, gives an answer only where either figure gives the same one: a maximum it cannot reach, a threshold both figures pass or fail. Otherwise nothing is computed, and a value as of a day whose period disagrees is not computed either — the two paths agree.
- **Time budget** (f0537e8): a set asked for and left uncomputed past its budget is said in the prompt ("Not computed: its time budget of N ms ran out"), in `route.computedSkipped` and in the gaps ("the answer may be incomplete"). On PGlite no timer fires while a statement runs (WASM on the event loop's thread), so the budget is overrun by the statement under way when it passes (a 50 ms budget returned after 509–567 ms on the 113k-entity store). On PostgreSQL the race ends at the budget and the statement finishes on the server, unwaited; a `statement_timeout` per statement would end it there too.

Measured on the 10x no-model replay (`--now 2025-11-07`). Default config, 312 asked: gold document in the prompt 0.81, as at 36f6ea5. The second round ran for 46 and added something to 20; against the same questions without it, it brought a gold document into the prompt for 3 (0.07; all three are lookups) and pushed none out. Computed sets on, 482 set tasks: set in facts 0.83, computed correct 0.83, no task changed against 36f6ea5 (the C2–C7 cases do not occur in the pack); 498 sets computed, mean 57 ms, p95 84 ms, none over budget.
