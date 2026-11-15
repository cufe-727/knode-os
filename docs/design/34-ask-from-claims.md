# 34 — Ask: sets and states computed from the claims, and a second round when the first is thin

Status: implemented on branch `claude/bold-liskov-1cde71` (2026-11-15), measured without a model on a fresh no-model rebuild of the 10× reports benchmark. No model-backed run yet.

## Problem

`ask` (design 30) does one retrieval and one completion. On the 10× reports benchmark (1,420 documents, `run-10x`) it scored 0.50 against 0.90 for the agents. Two kinds of question it gets wrong:

- **A set, a count or a state.** "Which weeks was availability below 99.917%", "how many incidents did each team report per quarter", "what was the pool limit as of 7 November" need every matching claim of a scope, and the value that held on a day. `ask` answered them from 8 chunks and the 24–150 facts a ranking reached: the full gold set was in the facts for 0.40 of the pack's structured tasks, 0.38 of the aggregate ones; exact-set structured answers were 0 of 8 in the run.
- **A step past what the question names.** A chain question's intermediate entity reaches the facts, its final attribute does not; a named entity's claims may not be retrieved at all.

## 1. Sets, counts and state from the claims (`src/search/claimset.ts`)

For a question routed list, aggregate or lookup, `readSetQuestion` reads by rules what it asks of the claims, and `computeClaimSet` computes it over **every live claim of the scope**, in code:

| Part | Read from | Examples |
| --- | --- | --- |
| scope | the organisations the question names; one holding another named one gives way to it (a division named beside its team scopes to the team); members are organisations `part_of` it or named as it and more ("第一事业部平台组" under "第一事业部"), two levels down. "全公司", "所有事业部", "company-wide" scope to the whole knowledge base | team, division, company |
| documents in scope | a document belongs to the organisation most of its claims are about | a team's weekly report; a division's monthly summary |
| what | attribute keys sharing the longest run of characters with the question (CJK) or all of their words (Latin), the question's words held by the scope's statements (longest substring first, plural to singular), a value it names among the scope's attribute values ("P1"), named entities that are not the scope ("T1-C1", "R-01") | 事故等级 / 事故级别 = P1; 服务可用性; "离职" |
| operation | 平均/average → mean; 最高/highest → max; 最低 → min; 总额/sum → sum; 几起/多少个/一共/how many → count; a day asked as of with no list cue → value; 哪些/which/list → list | |
| grouping | 按/每个/各/by/per/each + 组/team (member), 事业部/division (parent), 季度/quarter, 月/month, 周/week | 按组和季度 |
| filters | a threshold (低于/below 99.917), a least count (两起及以上/at least two), a period (a year from the router; a quarter, half or month without a year in the year of the latest report; "截至第44周": the reports' own week numbering, read off their titles), a state not reached (没有关闭: the item's latest statement of it is negated) | |

Items are the entities the claims are about, or of the kind the question asks for (人/谁/who → person, 客户/customers → organisation, 事故/incidents → event, 项目 → project: a claim's object or a person named in its statement). Two names with one identifier ("INC-001-T1") are one item; when most items carry an identifier, one without is listed apart and not counted (a description of one that does); an identified item most of whose claims are reported outside the scope is dropped (a mislinked mention brought it in). Numeric operations read *readings*: one value a subject states on a date, one per subject and ISO week; a statement that only recalls an earlier value ("最初定为200", "originally") is no reading; a correction or a stated change is. A value as of a day is the latest reading on or before it, a correction over what it corrects on the same day.

The computed lines (counts, groups, extremes, means, the value then, each with its source's date and title) go to the prompt as `# Computed from the claims`, its rows as known facts tagged `set` with every source, before the ranked facts. The model still writes the answer. `AskResult.computed` and `route.computed` say what was computed.

Cost: no model call; 9–11 statements a question that asks for a set, bounded by `SET_SCAN_CAP` (20,000 live claims) and `SCOPE_DOCS_CAP` (5,000 documents). A company-wide question reads the distinct attribute keys (a scan of `claims`) and then only the claims of the matched keys or holding the question's words.

Where rules end, and a model would be needed (none is added):

- Words of what is counted that share nothing with the claims: "离职" against "已离开公司", "新招" against "加入". An attribute vocabulary shared with the extractor, or a model mapping the question to attribute keys, would close it.
- A grouping or a filter in words the closed classes miss, a scope named only by description ("负责结算的那个组").
- Entity resolution: the merged `T1-C1` entity holds ten divisions' settings, and incidents mislinked across divisions inflate a company-wide count (132 P1 incidents computed, 120 in the gold). Scope by document keeps a team's set right; the company count needs the entity fix (`src/graph/`).

## 2. A second round when the first is thin (`src/search/second.ts`)

See the second commit on this branch.
