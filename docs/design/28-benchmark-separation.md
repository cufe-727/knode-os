# 28 — Benchmark separation: tasks a compiled knowledge base should win

> Status: **implemented** (2026‑11‑13) on branch `claude/eval-benchmark-separation-5b403e`, not run against a model.
> Recipe `synthetic-reports-{zh,en}` version 2, `synthetic-life-{zh,en}` version 3. Code:
> `src/eval/packs/reports.ts`, `life-ledger.ts`, `separation.ts`; scoring in `src/eval/score/{usage,lists,values,keys}.ts`
> and `src/eval/metrics/entities.ts`; report in `src/eval/report.ts`. Tests: `tests/eval-separation.test.ts`.
> Extends [design 23](23-knowledge-benchmarks.md) (the suite, packs, scoring and report), which this document does not
> restate.

## 0. Why

The phase 4 run (`~/knode-eval/runs/corpus-2026-11/run-1x-ranking`, 2026‑11‑12) found the knode agents tie an agent
that greps. The diagnosis on 2026‑11‑13 found the benchmark could not have told them apart:

- **Small corpora.** The reports pack held 141 documents and 74k characters (zh). An agent-grep session reads 70–150k
  input tokens, so it can read most of the corpus for every question. The two agents scored the same on 107 of 128
  paired tasks.
- **Dates in file names.** Update tasks asked for "the latest week's value", and each file name carried its week and
  date. Every agent scored 1.0 on them.
- **One exact token per fact.** Every incident, project and risk was written with the same template, so one regex had
  perfect recall.
- **Wrong month-end gold.** A month's last report was taken by the week's Friday, but reports are dated by their
  Monday. On `t-prog-T2-p1`, 5 of 8 months had the wrong gold.

This design adds task families where a knowledge base that compiles current state should beat a lookup. It also
fixes the gold and lets the pack grow to a size grep cannot read whole. All gold comes from the recipe, with no model.

## 1. The month-end fix

A report belongs to the calendar month of its own date: its Monday. That date is in its path (with `datedPaths`),
its corpus date and the first day of its range. `monthOf(week)` in `reports.ts` now uses the Monday. Before, it used
the Friday. Every user of `monthOf` now shares that meaning: month-end weeks (`monthEndWeeks`, the `t-metric-*` and
`t-prog-*` timelines), the PMO's months, the months a contradiction looks back over, and the month a hop question
names.

The corpus date of a weekly report is now its Monday (it was the Friday). Test: every month-end gold item's document
is the last weekly report of that team whose corpus date falls in that month.

The other recipes were checked for the same bug:

- `life-ledger.ts` takes months from each event's own date, so it is consistent.
- `synthetic.ts` assigns a week's mood to the month of its Thursday. That is a definition of the month's mood, not a
  document's month, so it is left as it is.
- `personal.ts` has no month arithmetic.

## 2. Corpus changes (reports v2)

- **No dates in file names.** Weekly reports are `周报/<team>/<10 hex>.md`, a seeded hash of team and week. Week and
  date stay in the body: the title says "第N周" and the first line gives the date range. `--options
  '{"datedPaths":true}'` restores `NN-YYYY-MM-DD.md`. With opaque names, "the latest week" has to be found from the
  reports' bodies.
- **Several phrasings per fact.** The seed picks one of 2–3 templates (`PHRASES`) for each fact: progress, launch,
  delay, rename, takeover, metric, incident, escalation, postmortem, each kind of risk line, join, leave, transfer,
  headcount, overtime, and the setting lines below. One postmortem phrasing names the incident only by what happened
  ("上周那起缓存击穿已由…修复"). A regex for the old template now finds only part of the incident lines (test).
- **Filler that carries distractors.** A new `回顾 / Recap` section repeats old values of the same entities, and each
  is true for its own time:
  - the metric two weeks earlier;
  - a project's progress four weeks earlier;
  - a setting's first value, recalled by its name.

  Grep finds these beside the current values. None of them changes any gold.
- **Native scale.** `size` sets the number of divisions. Each division is the whole 1× structure, generated from the
  same script code: three teams, twins, renames, transfers, PMO summaries and settings. Names are unique
  company-wide: more surnames, then three-character or initialled names. Project names for later divisions come
  from a pool in which no name contains another. At `size > 1`, questions say which division they ask about in the
  words the weekly reports name teams with (pack version 3, 2026‑11‑14): by a team they name ("二部平台组…"), else
  by the division's scope in front ("（二部）…", "二部的三个组"; "一部" for the first division, whose teams carry no
  prefix; in English the three team names, "(Platform 2, Payments 2 and Growth 2) …"). Version 2 opened every
  question with the PMO's name for the division ("（第二事业部）…"), which is in the monthly summaries and in no
  weekly report: a keyword search then ranked the summaries first (the harness's BM25 over the 1,409 usage
  questions of the 10× pack: hit@5 0.02, and 0.45 with the scope; the top five all summaries for 89% of them, and 18%).
  Task ids of division *d* > 1 are prefixed `d<d>-`. The pack id gains `-x<size>`.
- **Deep hops are sampled by chain.** Each deep hop names its chain in `meta.stratum` (`h4`, `h5`, `h5r`), and a
  limited run takes a type's tasks in proportion to their strata (`selectTasks`). Before, primaries went first and
  the four-hop chains have none: the 10× run at a limit of 300 took 8 `h5`, 10 `h5r` and no `h4`, the unlimited 1×
  run 2, 2 and 3.
- **Padding** (`scale`, `padTeams`) is unchanged. Padding teams still name nothing a closed-world task lists.
  Padding reports now use the new phrasings.

## 3. The families

Each family is its own task type, listed in `SEPARATION_TASK_TYPES` in `types.ts`. The report has a column for each
type and a separation table over all of them.

### a. Stale traps (`stale`)

Each team tracks three settings, for example the 订单库连接池上限 / order DB connection pool cap. A setting is
introduced once by its **name**, together with its code (`T1-C1`) and a short alias ("池上限"). Every later change
uses only the code, only the alias, or a pronoun. A pronoun line follows a line that names the short alias in
another context ("复查了超时线的执行情况。" / "这个值自本周起改为1200毫秒").

Three kinds of history, chosen by team, setting and division:

1. **Correction:** the first value was wrong ("…此前写的200个连接有误，应为240个连接", "…撤回原先的…").
2. **Change, then revert:** the value changes and later returns to the first one.
3. **Two changes.**

Rules:

- No report names the setting beside any value but its first. The recap of the first value never appears in a report
  that changes the setting. Both are tested.
- Questions ask, by the setting's name, for the current value (as of week 44's Friday) and for its value on a date
  between two changes. A correction is never asked "as of": a correction says the earlier value was never right.
- Scoring is `value`, model-free (§4). Gold carries `meta.stale`, every other value the setting has held, so an
  answer that gives one counts as **stale** apart from **wrong**.
- The update stream's tasks carry the previous week's figure as their stale value (reports), or the date, drug or
  start date they replaced (life).

### b. Look-alikes and renames (`lookalike`)

Planted in every division:

- **Three namesake pairs:** two people in two teams, two in two other teams, and two hires.
- **Two near-identical customer pairs** (华鼎零售/华顶零售, 远景银行/远境银行; Brightmart/Brightmark Retail, Vista/Vesta
  Bank) and one near-identical project pair (结算平台/结算中台; Settlement Hive/Hub). In each pair, neither name
  contains the other, so alias matching cannot credit one for the other.
- **Renames.** Each team renames one project (Atlas→Orion, 风控引擎→天秤, 推荐系统改版→千人千面). One customer
  renames itself in week 23 (易达出行→易达科技, Swift Mobility→Swift Labs). After a rename, documents use only the new
  name.

Tasks:

- what a namesake *of a given team* fixed and raised;
- which incidents a near-named customer escalated;
- a renamed customer's escalations, asked by its old name (the post-rename ones count);
- a renamed project's launch week or progress, asked by its old name;
- a near-named project's planned week.

Gold names the look-alike's items or values (`meta.distractors`, `meta.stale`).

`gold/aliases.jsonl` holds one cluster per real entity: people, teams (with their other-language name), projects
(with renames), customers and settings (name, code, alias). A namesake's canonical name carries its team, its alias
is the shared name, and `context` lists its team and role. That is what entity resolution is scored against.

### c. Structured queries (`structured`)

Questions that filter, group and aggregate, with gold computed exactly. Validation requires evidence spread over at
least `STRUCTURED_MIN_DOCS` = 21 documents. Each division gets:

- incidents per team per quarter (non-zero groups);
- who fixed two or more incidents, with counts;
- per team, the weeks the metric fell below its 20th-percentile value;
- per team, each quarter's highest weekly value;
- per team, the mean weekly value over the first half of the year, as a `value` with a tolerance of one last digit.

At `size > 1`, two more cover the whole company: P1 incidents across every division, and incidents per division in
Q2. Set answers are matched by **fields** (`list.match: 'fields'`): every gold item lists groups of terms (a team, the
ways to write a quarter, a count), and one predicted label must name a term of each group. A query is right only when
the whole set is right (`list.primary: 'exact'`). Set F1 is still recorded beside it.

The life ledger adds total distance per month, runs with the running partner versus alone, and total distance. Each
is kept only when its runs landed in at least 21 documents.

### d. Non-lexical hops (`nonlexical-hop`)

Each chain has three or four hops, and the question uses none of the words its bridges are written in:

- The team is named by what it does: 管收款的那个组, "the group that moves the money".
- The incident is named by its rank: 今年第二起最严重一档的故障.
- Each bridge is said in other words than the reports use: 处理好 for 修复, 预警过的隐患 for 提出的风险, 盯着 for 负责人,
  投产 for 上线; "sorted out", "flagged a hazard", "minding", "go live".

The chains run incident → fixer → the risk they raised → its owner now, and incident → fixer → the project they run
→ its launch week.

The recipe renders the bridge lines and drops any chain that shares a token with them. A token is a two-character
sequence in Chinese, and a content word of four letters or more in English (`lexicalOverlap`). The recipe also drops
any chain whose question names a bridge. `meta.overlap` records the check, and it is empty for every kept task.

### e. Emergence: planted connections (`connection`, emergence suite)

Causes come in five kinds, with six phrasings per kind. No two phrasings of one kind share a token, and the
incidents of one cause kind in a division get different phrasings. Risks come in four kinds, written in each team's
own words. Two kinds of question:

- "Which other incidents come down to the same kind of root cause as INC-…?"
- "Which risks in other teams are really the same problem as R-…?"

Gold is the set of IDs, matched by alias. The test checks every linked pair is lexically disjoint. A division yields
33 connection tasks (21 incidents, 12 risks). The emergence suite now holds 53 tasks at 1×; before, n was 4–19.

### f. Paraphrased and cross-lingual questions (`paraphrase`, `cross-lingual`)

Copies of existing tasks with the same gold, evidence and scoring. `meta.of` names the original:

- **Paraphrased:** incident counts, P1 and hire counts, and the stale "now" questions. The seed picks one of two
  rewordings.
- **Cross-lingual:** the same questions in the other language. Team and setting names are translated (平台组 ↔ the
  Platform team), people's names are not, and answers are IDs or numbers.

The life ledger copies four of its counts the same way.

## 4. Scoring and the report

Scoring:

- **`value` scoring** (`score/values.ts`) needs no model. The `Final answer:` line is right when it names `answer`
  or one of `answers` as a whole term (`containsTerm`), or, for numbers, any number within `meta.tolerance`. It is
  **stale** when it names a stale value and not the gold. It **declines** when it says the sources do not tell.
  Per answer this gives `correctness`, `em`, `false_refusal`, `confident_wrong` and `stale_answer`.
- **`confident_wrong`**, per answer:
  - judged tasks: the judge gave 0 and the answer did not abstain;
  - `value` tasks: wrong and not declining;
  - lists: correctness below 0.5 while the items' mean stated confidence is at least 0.7. An item with no stated
    confidence counts as confident.
- **`stale_answer`**:
  - judged tasks with `meta.stale`: the answer names a stale value and not the gold, and the judge did not give full
    marks;
  - look-alike lists: any predicted item is the look-alike's;
  - `distractor_rate` is the share of those items.
- **Entity resolution** (generation suite, `metrics/entities.ts`) scores B‑cubed precision and recall of the exported
  entity units against the gold alias clusters. An item is one (real entity, name) pair, held by the system entity
  that claims that name in its title, a parenthesis or an alias line. A shared name goes to the claimant whose text
  names the entity's context. Results are averaged over the real entities the system found at all; `er_found` is
  that share. A merged namesake lowers precision, and a split rename lowers recall.
- **Repeats.** An answer record's `repeat` (non-zero) is added to its score keys and judge item ids
  (`score/keys.ts`). The first answer keeps the keys runs had before. `scoreAnswers` checks "already scored" with
  `scoreKey` (the one line changed in `run.ts`).

Report (`report.ts`), new sections. Old runs still render: sections with no data are left out.

- **MDE beside every paired delta.** The pooled table, a new per-pack *Paired against agent-grep* table and the
  per-type table all show the minimum detectable effect, (z₀.₉₇₅ + z₀.₈)·sd/√n of the paired differences. Repeats
  are averaged per task before pairing.
- **Correctness by task type, per pack,** with the separation families first, every system, and each system's Δ
  against the baseline with its MDE.
- **Separation table:**
  - over the families: correctness, stale answers, confident wrong, look-alike items and citation precision;
  - over all tasks: stale and confident-wrong rates;
  - cost: tool calls per answer, and weighted tokens and USD per correct answer (all answer cost divided by summed
    correctness).
- **Run-to-run variance**, when one system's answers carry two or more repeat indexes: each repeat's mean over the
  tasks every repeat answered, the SD across repeats, the mean within-task SD, and the share of tasks whose score
  changed.
- **Generation:** `er_bcubed_precision/recall/f1` and `er_found`.

## 5. Sizes and task counts

Built with seed 0 (`tests/eval-separation.test.ts` builds the 1× packs and a 10× pack):

| pack | documents | characters | tasks | build time |
|---|---|---|---|---|
| synthetic-reports-zh, 1× | 142 | 79k | 208 | 0.07 s |
| synthetic-reports-en, 1× | 142 | 180k | 210 | 0.07 s |
| synthetic-reports-zh, `size` 10 | 1,420 | 816k | 1,896 | 0.4 s |
| synthetic-reports-zh, `size` 100 | 14,200 | 8.4M | 1,895 | 2.2 s, 210 MB RSS, 71 MB on disk |

A 100× pack keeps per-division tasks for its first 10 divisions (`taskDivisions`) and adds the two company-wide
queries.

Tasks per type at 1× (zh / en):

| suite | type | zh | en |
|---|---|---|---|
| usage | aggregate | 16 | 16 |
| usage | timeline | 12 | 12 |
| usage | profile | 11 | 12 |
| usage | contradiction | 4 | 4 |
| usage | temporal | 6 | 6 |
| usage | deep-hop | 7 | 7 |
| usage | ambiguous | 7 | 7 |
| usage | **stale** | 15 | 15 |
| usage | **lookalike** | 14 | 14 |
| usage | **structured** | 11 | 11 |
| usage | **nonlexical-hop** | 11 | 12 |
| usage | **paraphrase** | 14 | 14 |
| usage | **cross-lingual** | 15 | 15 |
| emergence | **connection** | 33 | 33 |
| emergence | affect / style / forecast / attribution | 9 / 4 / 1 / 6 | 9 / 4 / 1 / 6 |
| update | update | 12 | 12 |

The life recipe gains, when its runs land in enough documents:

- `sq-km-month`, `sq-runs-company` and `sq-km-total`;
- four paraphrased and four cross-lingual counts;
- stale values on the seven update tasks that replace an earlier value;
- alias clusters for the whole cast.

## 6. Building the packs

Pass `--out` so a sized pack does not overwrite the 1× pack in its recipe's default directory:

```bash
knode-os eval pack build synthetic-reports-zh --out ~/knode-eval/packs/synthetic-reports-zh-v2 --options '{"scale":10}'
knode-os eval pack build synthetic-reports-zh --out ~/knode-eval/packs/synthetic-reports-zh-x10 --options '{"size":10}'
knode-os eval pack build synthetic-reports-zh --out ~/knode-eval/packs/synthetic-reports-zh-x100 --options '{"size":100}'
```

- The first command is the 1× pack with padding for scale curves (`--fraction` up to 10), as phase 4 had.
- The second is 10× native: 30 teams, 1,420 documents and every family in every division.
- The third is 100× native: 300 teams, 14,200 documents, with tasks from the first 10 divisions.
- `--options '{"datedPaths":true}'` adds week and date to file names, for comparison with v1.
- `taskDivisions` sets how many divisions get their own tasks.

Packs built by v1 still load and validate; their tasks keep their meaning.

## 7. Not done

- **Weeks do not scale.** The year is fixed at 52 weeks (44 corpus, 4 updates, 4 holdout). `size` scales teams and
  people only. A multi-year recipe would have to make months year-aware.
- **The life pack gets only part of the families.** It has stale values on its update stream, structured run
  queries, paraphrased and cross-lingual counts, and alias clusters. It has no non-lexical hops, no planted
  connections, no setting-style stale traps and no look-alikes: its documents are written by the author model, and
  rebuilding them costs model calls.
- **Systems do not yet export alias lines.** Entity resolution reads an exported entity's title and its alias lines.
  A system that exports neither gets low recall on renames. That is the measurement working, not a scoring bug, but
  check knode's export (`src/eval/systems/knode.ts`) before reading the numbers.
- **Nothing is run against a model.** No pack is rebuilt on disk, and the phase 4 answers are not rescored. Without
  rescoring, `eval report` on that run already shows the new MDE, per-type, cost-per-correct and paired-per-pack
  tables. `confident_wrong` and `stale_answer` need a rescore (§8).

## 8. Rescoring an existing run

`eval score` scores only answers it has not scored before. Rescore a copy that keeps the retrieval and generation
scores, which `eval score` does not recompute. The copied judge cache answers every grade item it has seen. List
items matched by the judge are re-asked, and that costs model calls.

```bash
R=~/knode-eval/runs/corpus-2026-11/run-1x-ranking; N=$R-rescored; cp -R "$R" "$N" && jq -c 'select(.suite == "generation" or (.metric | test("^(recall@|all@|mrr@|ndcg@)")))' "$R/scores.jsonl" > "$N/scores.jsonl" && knode-os eval score "$N" && knode-os eval report "$N"
```
