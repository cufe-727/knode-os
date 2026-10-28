# 16 — Time in the knowledge base: entries, mention timelines, measures and market data

> Status: **proposed** (2026‑10‑27). Builds on [05](05-agent-context-db.md) §7.1 (`as_of`, `valid_at`, `freshness`)
> and [13](13-client-contract.md) §4–§5 (`known_at`, the entry index, the `rt-market` datasource). Schema v17 here is
> the version 13 planned for `available_at`, and carries those columns. Figures are read-only aggregates of the
> finance workspace and of rookie-trade's `data/market`, taken on 2026‑10‑27 (knode-os at d73bb38, schema v16).

## 0. The questions, and where things stand

1. Prices, valuations and financial reports are time-sensitive. How should the knowledge base hold them?
2. Which reads answer these questions: when was an entity mentioned; how often in a period; what relationships two
   entities had in a period; what comments or opinions about X appeared in the past day; how X has changed recently?
3. Should the prices and financial metrics rookie-trade queries come into the knowledge base, and through what
   pipeline?

### 0.1 What the base has

| Piece | State |
| --- | --- |
| Time axes | `as_of` (system time; graph rows refold from evidence), `valid_at` / `valid_range` (world time on claims and relations), `freshness` (live reads): [05](05-agent-context-db.md) §7.1. `known_at` (availability) is proposed in [13](13-client-contract.md) §4 and not built. |
| Documents | `doc_date` from frontmatter `date` or a date in the path (`src/ingest/docdate.ts`): a calendar day stored as 00:00 UTC (`src/store/dates.ts`). 28,500 of 28,570 documents have one. |
| Chunks | No time. At most 1,200 characters with 150 of overlap; 340,194 of them, each merging consecutive entries; `metadata` is `{path, title}`. |
| Mentions | `entity_mentions` (entity, chunk, scope, document): 3,063,049 rows, no time of their own. A linked or mined entity gets at most 4 chunks per document (`src/graph/concepts.ts:742`); a tier-1 entity at most 8, or 4 per extraction segment (`src/graph/llm-extract.ts:257`, `:322`). |
| Claims | 641,461 live (merge representatives). `observed_at` is the document's date (`llm-extract.ts:366`); 48% have `event_at` and 17% a validity window. `kind` is fact / opinion / prediction / rumor, `type` one of 17 since 2026‑10‑23. No value, metric or unit: a number exists only inside `statement`. |
| Relations | 178,098 live; 12% have a validity window. |
| Reads by time | `knode_claims` filters `event_range` and orders by `timeline`. Subscriptions return what the base *recorded* since a system time ([05](05-agent-context-db.md) §9.5). Nothing counts or lists mentions by time, and nothing filters by when something was said. |

### 0.2 Findings

1. **The finest time the base knows is a file's first day.** rookie-trade exports one file per source per day or ISO
   week. 7,758 of the 22,563 exported files are weekly, so every chunk, claim and mention from them is dated that
   week's Monday, and a comment rendered under its post takes the post's file date. Yet the files carry each entry's
   minute: 1,377,373 anchors (`<a id="e-7244ec10"></a>`), each followed by a heading such as `## 10-26 18:04 · 舒九`
   for a post, `### 10-22 16:25 · …` for a comment and `#### …` for a reply, in Shanghai time without a zone.
2. **Mentions are a sample.** The caps keep `entity_mentions` small enough for SAG and co-occurrence, and make it
   useless for counting. An entity named in 60 of the 470 messages of one Feishu day file (`顶级资讯/2026-10-20.md`)
   gets at most 4 rows from linking plus 4 per tier-1 segment; one named once in a short weekly file gets a row as
   well. Counting rows by date measures file layout and extraction, not attention.
3. **"Undated" reads as "always".** `valid_at` matches a claim with an open window (`validAt`, `src/store/temporal.ts`),
   and 84% of claims have none: 89% of opinions (99,805 of 112,498) and 63% of predictions. Asking what holds today
   returns a 2016 「估值偏高」 next to last week's.
4. **Numbers live in sentences, and the base already copies the market badly.** 409,434 claims (64%) contain digits;
   45,690 are `price_move` and 4,684 `valuation`. For 宁德时代 on 2026‑10‑26 the base holds a 09:41 price of 229.78,
   an intraday 238.21, a close of 238 and 「总市值约1.10万亿元，市盈率15.27倍」, all as facts. rookie-trade has that day
   exactly (previous close 237.6; open 234.95, low 229.6, high 241.6, close 238.0): the three prices agree with it and
   so does the market value, but `daily_basic.pe_ttm` was 12.56; the 15.27 is a PE on some basis the text does not
   name. Supersession compares claim types (`src/wiki/refine.ts:159`) and `valuation` covers PE, market value and
   target prices alike, so "PE fell from 18 to 15" cannot be represented.
5. **Type filters miss most claims.** 361,142 live claims (56%) still carry free-text types from before the closed list
   (市场表现 8,585, 股价表现 4,114, 市场判断 4,065, 盈利预测 3,791 …; 57,131 distinct), because the fold copies
   `attrs.type` without mapping it (`src/store/temporal.ts:237`).
6. **The corpus is uneven in time and in source.** 15,197 of the 28,570 documents are from 2026. Feishu holds
   1,177,105 of the 1,377,373 entries (85%), mostly news feeds; 知识星球 116,805; 雪球 50,210. A raw count over time
   measures what was linked when, and how chatty the feeds were.
7. **Calendar days are UTC.** `2026-10-19` is stored as 08:00 in Shanghai, where every heading and trading day is.

### 0.3 rookie-trade's side

- **Market data** (Tushare, `data/market`, 1.4 GB of Parquet). Per trade date: `daily`, `daily_basic` (pe_ttm, pb,
  ps_ttm, total_mv, circ_mv, turnover), `adj_factor`, `moneyflow`, `stk_limit` and the limit lists — 680 trading days,
  2024‑01‑02 → 2026‑10‑27, about 5,400 rows a day (3.68 M rows of `daily`). Per report period: `income`,
  `balancesheet`, `cashflow`, `fina_indicator`, `forecast` and `express`, 2022‑12‑31 → 2026‑06‑30. Per code: 7 indices,
  243 full histories and minute bars for 302 stocks (31.6 M rows). Snapshots overwritten in place: `stock_basic`
  (5,919 codes), `namechange` (13,922 rows), `ths_index`, `trade_cal`. US, HK and options data come from EODHD, Theta
  Data and Cboe, outside the manifest.
- **Fundamentals keep their point-in-time fields** (`ann_date`, `f_ann_date`, `end_date`, `update_flag`) **but cannot
  be trusted yet.** They were last fetched on 2026‑08‑09, so 2026Q2 holds the first ~280 filers and 2026Q3, being
  reported this month, is absent. Each period is one call without paging: `cashflow` has exactly 6,400 rows in each of
  14 periods and `balancesheet` exactly 7,000 in 6. A period whose file exists is never fetched again
  (`backend/src/rookie_trade/data/fundamental_sync.py:71`), so late filings and restatements are lost. There is no earnings calendar, dividend table,
  analyst consensus or index/concept membership history.
- **Updates**: an in-app scheduler after the close (15:45–22:30 Shanghai, since 2026‑10‑27). FastAPI on 12300 serves
  prices and valuations with a `DataStamp`. There is no agent-facing tool and no knode-os client.
- **Entries**: `content_v3.entry` has `posted_at`, `posted_at_kind` (`captured` when the platform gave no time),
  `captured_at` and `edited`. The export rewrites today's files through the day (22:30 on 2026‑10‑27) but carries only
  the heading's minute. The review returns relevance and image descriptions, not instruments, stance or claims.

## 1. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 Time belongs to entries | An entry is one thing said at one moment by one author: a post, comment, reply, chat message, report, filing or dated section. Every document has entries, if only one; files and chunks take their times from them | A file is a period and a chunk a retrieval unit; neither was said at a time. The minute is already in the files (finding 1) |
| D2 Five axes, each with one owner | posted (entry), available (entry: 13's `known_at`), world (claim, relation, measure), system (evidence), freshness (live read) | The questions above are mostly posted-time questions. "How has X changed" needs world, posted and system time at once, and must say which is which |
| D3 Every time has a grain | A time is an interval at the precision it was given. Filters overlap by default and can demand precision | A weekly file's undated text stays a week long instead of becoming Monday 00:00 |
| D4 One workspace zone | Zone-less times, calendar shorthand and buckets use `time.zone` (finance: `Asia/Shanghai`); instants stay UTC | Headings, trading days and "today" are Shanghai's (finding 7) |
| D5 Mentions get a census | `entity_occurrences`: one row per entity per entry, for every entry, with the entry's time. `entity_mentions` stays the capped retrieval sample | Counting needs every entry (finding 2); SAG and co-occurrence need the sample small |
| D6 Numbers become measures | A claim that states one number about its subject carries `metric`, `value`, `unit` and a basis, at the claim's own time. Supersession, change and checks work per metric | "PE 18 → 15" and "the stated close agrees with the market" need the number as a number (finding 4) |
| D7 Undated claims age | Each claim type has a shelf life; a world-time read treats a claim without a window as holding from when it was said for that long | Finding 3 |
| D8 Market data is connected, not copied | Series stay in rookie-trade and are read in place, point in time. The base materializes instrument identity, the trading calendar and a small stream of derived market events, and joins them with what was said at read time | §7.1 |
| D9 Four reads | `timeline`, `feed`, `between`, `changes`; `search`, `sag`, `claims` and `graph` gain the same `posted` filter; one envelope for all | Each question in §0 becomes one call (§6.7) |
| D10 No model call and no re-embedding for time | Entries, chunk times, occurrences and evidence times are derived from the files and the existing chunks | The backfill must be affordable: this workspace's embedding quotas run out daily |

## 2. Time axes

| Axis | Read parameter | Owner | Stored as | Answers |
| --- | --- | --- | --- | --- |
| posted | `posted` (range) | entry | `entries.posted_at`, `posted_to`, `posted_grain` | when was it said |
| available | `known_at` (instant) | entry | `entries.available_at` | what could a reader have seen by then (13 §4) |
| world | `valid_at` / `valid_range`, `event_range` | claim, relation, measure | `valid_from` / `valid_to`, `event_at` | when does it hold, when did it happen |
| system | `as_of` | evidence, scope | `tx_from` / `tx_to` | what had the base recorded |
| freshness | `freshness` | live read | probe cache | how old may a live read be |

### 2.1 Time-sensitive data, by kind

A number has two times, when it holds and when it became known, and a read that ignores the second reads the future.
2026Q3 net profit holds for July–September and exists from its announcement in late October; a restated 2025 figure
exists from its `f_ann_date`; a forward-adjusted 2024 price includes dividends paid in 2026.

| Data | World time | Posted / known | Lives in |
| --- | --- | --- | --- |
| daily price; PE, PB, market value | `trade_date`, at the close | the close, plus rookie-trade's sync lag | rookie-trade, read in place (§7) |
| financial statement line | the period (`end_date`, cumulative to date) | `f_ann_date` of each version | rookie-trade, every version kept (§7.4 stage 0) |
| results, forecast or express announced | `event_at` = the announcement; window = the period | the announcement date | base: a market event with measures (§7.4 stage 3) |
| an author's number: target price, PE on 2027 earnings, position size | the period or horizon it names | the entry's time | base: claim with a measure, kind opinion or prediction |
| an author's view: 估值偏高, 看好 | from when it was said, for the type's shelf life | the entry's time | base: claim |
| a dated event: 除息, 回购公告 | `event_at` | the entry's time | base: claim, kind fact |
| a relation: `holds_position_in`, a supply contract | its window, else unknown | each assertion's entry time | base: relation; its evidence carries posted times |
| a mention | — | the entry's time | base: occurrence |

### 2.2 Grains and the zone

- A time with a zone is an instant; one without is read in `time.zone`. A date is that day in `time.zone`:
  `posted: 2026-10-27` is [2026‑10‑27 00:00+08, 2026‑10‑28 00:00+08).
- `posted` takes ranges (`2026-10-01..2026-10-27`, `2026-10-01..`), calendar shorthand (`2026-10`, `2026-W43`) and
  relative forms (`24h`, `7d`, `today`, `yesterday`, `this-week`), resolved against now, or against `as_of` /
  `known_at` when a read pins one. The resolver's `notes` echo the instants and the zone it used.
- Entries store `posted_at` (start), `posted_to` (exclusive end) and `posted_grain` (`minute`, `day`, `week`, `month`,
  `quarter`, `year`, `unknown`). `precision: overlap`, the default, matches an entry whose interval meets the window;
  `precision: within` only one inside it, so a week-grain entry is never "in the past day".
- Buckets (`hour`, `day`, `week`, `month`, and `trading_day` from `trade_cal`) are cut in the zone. An entry coarser
  than its bucket is counted in the bucket's `coarse` column, neither spread over the bucket nor dropped.
- World-time dates stay floating calendar dates stored at 00:00 UTC, as now; turning an instant into a world date uses
  the zone (a post at 07:30 Shanghai on the 27th is about the 27th). Rewriting them would refold 2.3 M evidence rows
  for nothing.

## 3. Entries

### 3.1 Where they come from

Readers run at apply, and the first that matches wins. They are plugins ([11](11-plugins-and-udfs.md)), so another
producer can add its own.

1. **The producer's index**: frontmatter `anchors:` as 13 §4.2 and §6.2 specify (entry id, `posted_at` with its zone,
   `posted_at_kind`, `captured_at`, `reply_to`, `available_at`). The only source of exact availability.
2. **`rookie-trade-export@1`**: frontmatter `platform` and `period`, and anchor + heading pairs in the body. The
   heading's level gives the kind (`##` post or message, `###` comment, `####` reply) and the parent (the nearest
   shallower heading above); its text gives the minute and the author. The year is the one that puts the date nearest
   the file's period: a 2026‑W01 file holds 12‑29, and the section at a file's end holds older posts that got a comment
   in the period. `available_at` is `posted_to` plus the platform's polling interval (900 s; 3,600 s for WeChat), the
   rule 13 §6.2 gives backfills.
3. **Dated headings**: hand-written timelines and notes whose headings begin with a date (`## 2026-10-27`,
   `### 2026-10-27 09:45`), at that precision.
4. **The document**: one entry over the whole text at `doc_date` and its grain, or `unknown` without one.

Generated wiki pages get no entries: views are not sources ([05](05-agent-context-db.md) §4.4). Pages people or agents
write get entries like any document, but discourse reads default to `kinds: doc` (§6.1): a synthesis page written
today is not today's talk about everything it covers.

### 3.2 Schema v17

```sql
CREATE TABLE entries (
  id            TEXT PRIMARY KEY,        -- sha(document_id | anchor), or the ordinal without an anchor
  document_id   TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  anchor        TEXT,                    -- e-7244ec10
  ext_id        TEXT,                    -- the producer's id, when its index gives one
  parent_id     TEXT,                    -- a comment's post
  kind          TEXT NOT NULL,           -- post | comment | reply | message | report | section | document
  author        TEXT,                    -- as written
  author_id     TEXT,                    -- the person or organization entity, when resolved
  platform      TEXT,
  source        TEXT,
  char_start    INTEGER NOT NULL,        -- offsets in the indexed text
  char_end      INTEGER NOT NULL,
  text_sha      TEXT NOT NULL,           -- of the normalized entry text: a repost has the same
  posted_at     TIMESTAMPTZ,
  posted_to     TIMESTAMPTZ,
  posted_grain  TEXT NOT NULL,
  available_at  TIMESTAMPTZ
);
CREATE INDEX entries_doc_idx    ON entries (document_id, ordinal);
CREATE INDEX entries_posted_idx ON entries (posted_at);
CREATE INDEX entries_author_idx ON entries (author_id, posted_at) WHERE author_id IS NOT NULL;

CREATE TABLE chunk_entries (chunk_id TEXT NOT NULL, entry_id TEXT NOT NULL, PRIMARY KEY (chunk_id, entry_id));
CREATE INDEX chunk_entries_entry_idx ON chunk_entries (entry_id);
ALTER TABLE chunks ADD COLUMN time_lo TIMESTAMPTZ, ADD COLUMN time_hi TIMESTAMPTZ, ADD COLUMN available_at TIMESTAMPTZ;
CREATE INDEX chunks_time_idx ON chunks (time_lo, time_hi);

CREATE TABLE entity_occurrences (
  entity_id     TEXT NOT NULL,
  entry_id      TEXT NOT NULL,
  scope_id      TEXT NOT NULL,           -- the document's scope, or its tier-1 child
  document_id   TEXT NOT NULL,
  posted_at     TIMESTAMPTZ,             -- the entry's, copied for range scans
  posted_grain  TEXT NOT NULL,
  hits          SMALLINT NOT NULL,       -- surface matches inside the entry
  via           TEXT NOT NULL,           -- link | tier1 | producer | relink
  PRIMARY KEY (entity_id, entry_id, scope_id)
);
CREATE INDEX occurrences_entity_time_idx ON entity_occurrences (entity_id, posted_at);
CREATE INDEX occurrences_entry_idx ON entity_occurrences (entry_id);
CREATE INDEX occurrences_scope_idx ON entity_occurrences (scope_id);

ALTER TABLE evidence ADD COLUMN entry_id TEXT, ADD COLUMN posted_at TIMESTAMPTZ, ADD COLUMN available_at TIMESTAMPTZ;
CREATE INDEX evidence_posted_idx ON evidence (kind, posted_at) WHERE tx_to IS NULL;
CREATE INDEX evidence_entry_idx  ON evidence (entry_id) WHERE entry_id IS NOT NULL;

ALTER TABLE claims ADD COLUMN last_observed_at TIMESTAMPTZ,
  ADD COLUMN metric TEXT, ADD COLUMN value NUMERIC, ADD COLUMN unit TEXT, ADD COLUMN measure JSONB,
  ADD COLUMN checked JSONB;              -- system-maintained, like superseded_by (§5.3)
CREATE INDEX claims_metric_idx ON claims (subject_id, metric, COALESCE(event_at, valid_from))
  WHERE tx_to IS NULL AND metric IS NOT NULL;
```

Entries, `chunk_entries` and occurrences belong to a document's projection, like its chunks: written when the document
is applied, deleted when it is disposed, rebuilt by `rebuild`. An entry's text is never copied; reads slice the
document's indexed text by offset, as `knode_read` reads it. The catalog gains `v_entries`, `v_occurrences` and
`v_entity_activity`; `v_claims` and `v_evidence` gain the new columns at their ends.

### 3.3 What takes its time from entries

- **A chunk**: `time_lo` / `time_hi` are the earliest `posted_at` and the latest `posted_to` of the entries it
  overlaps, and `available_at` the latest of theirs (13 §4.2's rule). Chunk text and ids do not change, so nothing is
  re-embedded.
- **Evidence**: the entry it is grounded in. A claim's is the entry inside its chunk that overlaps the statement best
  (the scoring of `bestChunkFor`, `src/graph/llm-extract.ts:379`, one level down); an entity's or a relation's is the
  first entry in its chunk that names it. The extraction input already contains the anchors, so new tier-1 calls
  return each claim's anchor; grounding by overlap stays for replays and the backfill.
- **The author**: a claim from a group file is attributed to the member whose entry it came from, not to the group's
  owner. 知识星球 files mix the owner's posts with members' (表舅's 2026‑W43 file has 农村债狗, 刘琼 and others).
- **The claim fold**: `observed_at` becomes the earliest posted time of its live evidence (an entry's minute instead of
  a file's Monday), and `last_observed_at` the latest. Each repetition stays an evidence row, so who said it, when
  and how often is a read over evidence.
- **Relations**: windows fold as now; their evidence's posted times answer "asserted when".

### 3.4 Backfill

`knode-os time backfill` derives entries, chunk links and times, occurrences and evidence times for every live
document, one document per transaction, resumable. It takes the shape of `knode-os entities relink` (`relinkTier0`,
`src/graph/concepts.ts:863`): planned outside the transaction, written under the document's live scope after the ledger
lock, touched claims folded at the end in batches. It reads files and existing chunks only: no model call, no
re-chunking, no embedding. Run it on a copy of the workspace first to measure its time and the number of occurrences,
and outside the nightly tier-2 pass. New documents get all of it when they are applied.

## 4. Occurrences: counting mentions

### 4.1 Writing them

- At apply, occurrences are found with the linker's surface rules (`weakLinkKey`, the frequent-term and alias stop
  lists: never a short number, a two-letter spelling or a generic alias), over **every** typed entity rather than the
  10,000 hottest the link index holds (`LINK_CANDIDATE_LIMIT`, `src/graph/concepts.ts:425`). A count must not depend on
  whether an entity was hot the day a document was applied. Mined concepts are not counted: they are corpus
  statistics, not names.
- Tier 1 adds the entities it extracts, matched in entries by name and alias as `applyExtraction` matches chunks.
- A producer's per-entry instruments (13 §6.3, once the review returns them) add exact rows, including names that
  appear only in an image.
- A listed company whose name is also an ordinary phrase (金融街, 智慧农业, 人民网) counts only next to its code or a
  security word; the instruments document marks such names (§7.4 stage 2).

### 4.2 Entities that arrive later

An entity created, or an alias added, after a document was applied has no occurrences in it. A relink step after each
extraction pass, beside the duplicate audit, takes the entities and aliases added since its cursor, finds candidate
chunks through the keyword index (`tsv`, and the CJK `ILIKE` fallback the graph route uses), confirms the surface
inside each entry, and writes rows `via: relink` under the document's scope. A merge needs no rewrite: reads resolve an
entity to its group, as `knode_claims` does (`entityRefSql`, `src/store/claims.ts`).

### 4.3 What a count means

- Units: `entries` (the default: posts, comments and messages that name it), `unique` (distinct `text_sha`: a news
  item reposted to five Feishu chats counts once), `authors`, `documents`, `hits`.
- Every bucket returns its denominator, all entries in the bucket under the same filters, and `share`. A source linked
  in October then shows up in the denominator instead of as a surge.
- `by: platform | source | author | kind` splits buckets. Feeds and people are counted apart: export v2 marks each
  source `feed`, `person` or `group` beside `kb_export` (13 §6.2); until then `platform: feishu` stands in for feeds.
- A trend compares a window with a baseline on `share`: the ratio (lift) and a z-score over the baseline's buckets.

## 5. Claims in time

### 5.1 Shelf life

`CLAIM_TYPES` (`src/graph/store.ts:106`) gains `shelfLife`, which an ontology pack can override:

| Types | Shelf life | Why |
| --- | --- | --- |
| `price_move` | 1 trading day | about one session |
| `technical`, `fund_flow` | 7 days | a reading of the current chart or flows |
| `valuation`, `recommendation`, `macro` | 30 days | a judgement at a price or a print |
| `outlook`, `holding`, `risk` | 90 days | a stance until restated |
| `earnings`, `guidance` | the period they name, else 1 year | |
| `fundamentals` | 1 year | |
| `management`, `policy`, `event`, `method`, `other` | none | a point, a rule, or until replaced |

- It applies when a read asks a world-time question (`valid_at`, `valid_range`) of a claim without a window: the claim
  holds from `observed_at` for its shelf life. A claim with a window keeps its window.
- `undated: shelf | open | exclude` overrides it; `open` is today's behaviour.
- The claim audit's "expired facts" uses the same horizon. The values are a starting point; measure how long views are
  restated before a later one contradicts them, and tune per pack.

### 5.2 Measures

- The ontology pack gains `metrics:` beside `entityTypes` and `relationTypes`: id, label, unit, kind (`price`, `ratio`,
  `level`, `flow`, `count`), timing (`instant` or `period`) and synonyms. The finance pack (`src/graph/ontology.ts`)
  starts with what rookie-trade can check and what authors state: `close`, `pct_change`, `market_cap`, `pe_ttm`,
  `pe_static`, `pe_forward`, `pb`, `ps_ttm`, `dividend_yield`, `turnover_rate`, `revenue`, `net_profit`,
  `net_profit_yoy`, `revenue_yoy`, `gross_margin`, `roe`, `eps`, `target_price`, `position_pct`, `net_inflow`, and
  macro prints (`cpi_yoy`, `pmi`, `lpr_1y`).
- A claim gets `metric`, `value`, `unit` and `measure {basis, currency, scale}` when its statement states one number
  about its subject. `basis` says what the number is of: ttm, static, FY2027 forecast, year on year, single quarter,
  cumulative. Its time is the claim's: `event_at` for an instant (a close), the window for a period (2026Q3 net profit,
  PE on 2027 earnings).
- New extractions return `measure` with each claim. Existing claims get a statement-only pass after a deterministic
  parser has taken the common forms (市盈率15.27倍, 收盘价238元, 净利润同比-8%): the remaining statements with digits,
  out of 409,434, about 50 per call through the lease protocol ([12](12-remote-processing.md)), so the remote worker
  does it. No document is read again.
- Supersession also keys on `(subject, metric, basis, object)`, and on `event_at` when there is no window, so a newer
  PE supersedes the older one; claims without a metric keep today's rule. A forecast still never supersedes a result.

### 5.3 Checking stated numbers

A nightly step after the claim audit takes facts whose metric rookie-trade has, on a subject with a locator, and reads
the source's value for that trading day or period, point in time (§7.3). It records `checked {source, value, at,
verdict}` on the claim, system-maintained like `superseded_by`, not evidence:

- `agrees`: the stated close, change or market value matches, or an intraday price falls inside the day's range. The
  three 宁德时代 prices of 2026‑10‑26 agree, and so does its market value. Agreeing facts drop out of entity pages and
  packs by default, since the source says them better.
- `differs`: 「市盈率15.27倍」 against `pe_ttm` 12.56. Usually a misread screenshot or an unstated basis; the claim goes to
  the suggestions queue with both numbers.
- `no_data`: no locator, a holiday, or a period not yet fetched.

Predictions with a metric and a horizon (a target price within six months, FY2027 net profit) are scored when the
horizon closes: the measured half of 13 §7.2's track records.

### 5.4 Free-text types

The fold maps `attrs.type` through `normalizeClaimType`, and one `sync --verify` refolds the claims whose type is off
the list. This is independent of everything else here and comes first, since every type filter in §6 depends on it.

## 6. Reads

### 6.1 The envelope

The resolver (`src/store/resolver.ts`) gains `posted`, `precision`, `grain` and 13's `known_at`, and resolves relative
forms against now or the pinned time. The four new reads default to `kinds: doc` (what was said, not what the base
wrote about it), current belief, `trust: any` and every source. They are MCP tools, `/api` routes and CLI commands, and
become contract operations (beta tier) once 13's contract exists.

### 6.2 `timeline`: when, and how often

```
knode_timeline { entity | entities[], posted: "90d", grain: "day", unit: "entries", by?, kinds?, sources?, authors? }
→ { zone, grain, buckets: [{ start, count, total, share, coarse, by? }],
    first_seen, last_seen, totals: { entries, unique, authors, documents }, top_authors, applied }
```

- `first_seen` and `last_seen` answer "when was it mentioned". `v_entity_activity` (entity, `first_seen`, `last_seen`,
  `entries_1d` / `_7d` / `_30d`, `authors_30d`) answers it for every entity in one SQL read.
- `top` mode, `knode_timeline { top: 20, posted: "today", baseline: "30d" }`, lists the entities with the largest lift:
  what is being talked about today.
- The web UI's entity panel shows the 90-day timeline as a sparkline beside the last week's `feed`.

### 6.3 `feed`: what was said

```
knode_feed { entity, posted: "24h", claim_kinds?: [opinion, prediction, rumor], q?, authors?, kinds?, sources?,
             with_market?, limit, cursor }
→ { items: [{ entry: { id, posted_at, grain, author, platform, source, kind, parent, path, anchor },
              text,                  // the entry, cut around the mention
              also_in: [sources],    // the same text reposted elsewhere
              claims: [{ statement, type, kind, status, metric?, value? }],
              market?: { close_then, pe_ttm_then, return_since } }],
    counts: { entries, unique, authors, extracted }, next_cursor, applied }
```

- Newest first. With `q`, items are ranked by hybrid search over the chunks whose time meets the window, reported as
  their entries.
- "What opinions about 宁德时代 appeared in the past day" is `knode_feed { entity: 宁德时代, posted: 24h, claim_kinds:
  [opinion, prediction] }`: every entry of the window that names it, each with the views extracted from it. Without
  `claim_kinds` it is the whole discussion, entries tier 1 has not reached included; `counts.extracted` says how many
  it has. Entries are in the base minutes after rookie-trade exports them; claims follow the extraction queue, which
  re-extracts only a growing file's last segment ([10](10-long-docs-and-claim-merge.md)).
- `with_market` adds the instrument's close and PE when the entry was posted and its return since, read from
  `rt-market` (§7.4 stage 4).

### 6.4 `between`: two entities in a period

```
knode_between { a, b, posted?: range, valid?: range, grain? }
→ { relations: [{ type, direction, valid_from, valid_to, asserted: { first, last, count } }],
    claims: [{ subject, object, statement, kind, observed_at, event_at, valid_from, valid_to }],
    co_mentions: { total, buckets, entries },
    applied }
```

- `relations`: the typed edges between them. `valid` keeps those whose window meets the period (the 88% without a
  window are listed as `window: unknown`, not dropped); `posted` keeps those asserted in it.
- `claims`: one of them as subject and the other as object, filtered on the same two axes.
- `co_mentions`: entries that name both, from occurrences. This is finer than today's derived `co_occurs`, which pairs
  entities per document (`src/graph/cooccur.ts`).

### 6.5 `changes`: how an entity changed

```
knode_changes { entity, window: "7d", baseline: "prev" | "30d", as_of? }
→ { discourse: { entries, authors, share, lift, z, by_kind, new_associations: [{ entity, lift }], notable },
    events:    [kind-fact claims with event_at in the window, market events included],
    measures:  [{ metric, basis, from: { value, at }, to: { value, at }, change, source: "kb" | "rt-market" }],
    knowledge: { new_claims, superseded: [{ old, new }], disputes_opened, disputes_resolved, merges },
    unknowns, plan }
```

- Three kinds of change, each labelled: the world's (events and measures, by world time), the discussion's (by posted
  time) and the base's own (by system time: what it learned this week may be about 2019).
- `measures` come from claims with metrics and, when `rt-market` is connected, from the source over the window.
- `new_associations` are entities co-mentioned more in the window than in the baseline. `notable` lists opinions and
  predictions from the window, ranked by author track record once those exist (13 §7.2), else by how many authors
  share them.
- It is also an intent, `entity-recent-change`, so `knode_resolve` plans the live market slots, and a virtual path,
  `/changes/<entity>?window=7d`, rendered on read like `/entities/` ([05](05-agent-context-db.md) §7.4).

### 6.6 The reads that exist

- `search`, `sag`: `posted` keeps chunks whose `time_lo` / `time_hi` meet the window and reports the entries inside
  it. A SAG walk under `posted` bridges only through entities with occurrences in the window.
- `claims`: `posted` (evidence posted in the window) and `metric`; rows add `observed_at`, `last_observed_at` and how
  often the window repeated them.
- `graph`: `posted` keeps edges asserted in the window and derives co-occurrence from the window's occurrences.
- Subscriptions stay on system time. "New opinions on X since I last looked" is a subscription on X read through `feed`.

### 6.7 The questions, answered

| Question | Read |
| --- | --- |
| When was X mentioned? | `timeline { entity: X }`: `first_seen`, `last_seen`, the series |
| When was each entity mentioned? | `v_entity_activity` in the catalog; `timeline { entities: [...] }` side by side |
| How many times was X mentioned between A and B? | `timeline { entity: X, posted: "A..B", grain: week }`: entries, unique, authors, share |
| What relationship did X and Y have in P? | `between { a: X, b: Y, valid: P }` (held) or `{ posted: P }` (said) |
| What opinions about X appeared in the past day? | `feed { entity: X, posted: 24h, claim_kinds: [opinion, prediction] }` |
| How has X changed recently? | `changes { entity: X, window: 7d }` |
| What is being talked about today? | `timeline { top: 20, posted: today, baseline: 30d }` |
| What did we know about X the evening before its results? | any read with `known_at` (13 §4) |

## 7. Market data from rookie-trade

### 7.1 Should it come in?

Into the base's identity, timeline and reads: yes. Into its documents, chunks, embeddings and claims: no.

- **What the base adds is the join**: who said what about an instrument, when, and what the market did around it. That
  needs the instrument as one entity with its codes, the market's events on the same timeline as the discussion, and
  prices read at the time of each statement. Today the join is done by hand.
- **The series are tables, not text.** 3.68 M daily bars, 3.7 M adjustment factors, 31.6 M minute bars and about
  420 K statement rows would be millions of chunks to embed and extract with nothing to understand, and every
  correction upstream would have to be replayed downstream. SQL over the Parquet answers "PE on 2026‑10‑26" exactly;
  retrieval answers it approximately.
- **Point in time belongs to the source**: `f_ann_date` versions, adjustment factors, the trading calendar. A copy has
  to re-implement them; a read in place inherits them, given a capability note that says how (§7.3).
- **The base already pays for a worse copy** (finding 4). Once connected, those claims become checkable (§5.3), and
  questions about prices go to the source.

### 7.2 Placement

| What | Where | How |
| --- | --- | --- |
| daily bars, `daily_basic`, `adj_factor`, `stk_limit`, `moneyflow`, limit lists, indices | rookie-trade | the `rt-market` DuckDB source with glob tables (13 §5.1), read point in time |
| `income` … `fina_indicator`, `forecast`, `express` | rookie-trade | the same source, one table per dataset over its period files, read by `f_ann_date` |
| minute bars; US, HK and options | rookie-trade | later, as their own tables or sources; no read above needs them |
| instruments: names, codes, listing and delisting, former names | base | one producer document per market (stage 2) |
| trading calendar | base, cached from `trade_cal` | `trading_day` buckets, `price_move`'s shelf life |
| market events | base | producer documents per trading day, tier 0 only (stage 3) |
| track records, forward returns | base | producer documents (13 §7.2) |
| live quotes | rookie-trade's API | seconds-fresh prices are a trading concern, not knowledge |

### 7.3 Point in time, per table

`playbooks/capabilities/rt-market.md`, written and versioned in rookie-trade (13 §5.1), says for each table which
column is world time and which is availability; the planner fills `{known_at}` and `{posted}` templates from it.

| Table | World time | Known from | A read at t |
| --- | --- | --- | --- |
| `daily`, `daily_basic`, `stk_limit`, `moneyflow` | `trade_date` | that day's close plus the sync lag (from 15:45) | `trade_date` before t's day, or on it once t is past the sync |
| `adj_factor` | `trade_date` | the same | compare a stated price with the unadjusted close; compute returns with the factors; never show a forward-adjusted level as what someone saw |
| `income`, `balancesheet`, `cashflow`, `fina_indicator` | `end_date`, cumulative to date | `f_ann_date` of each version | per `(ts_code, end_date)`, the latest version with `f_ann_date` ≤ t |
| `forecast`, `express` | `end_date` | `ann_date` (`first_ann_date`) | `ann_date` ≤ t |
| `stock_basic`, `namechange` | listing; `start_date` / `end_date` | snapshots, overwritten | names by date; the industry is today's only |

### 7.4 The pipeline

```
rookie-trade                                                     knode-os · finance
────────────                                                     ──────────────────
Tushare ─▶ market_schedule (15:45–22:30) ─▶ data/market/** ────▶ rt-market: DuckDB, glob tables, read only
             fundamentals: paged, refetched while open               capability note (§7.3) · locators: codes ↔ entity
stock_basic, namechange ─▶ rt kb instruments ─────────────────▶ raw/docs/rookie-trade/instruments/a-share.md
data/market/** ─▶ rt kb events (after each day's sync) ──────▶ raw/docs/rookie-trade/market-events/<YYYY>/<date>.md
entries + prices ─▶ rt kb track-records (weekly) ────────────▶ raw/docs/rookie-trade/track-records/<author>.md
                                                                   │ tier 0 only: entries, occurrences, claims + measures
                                                                   ▼
                                  timeline · feed · between · changes · claims ◀── reads of rt-market at read time
                                  nightly: check stated numbers (§5.3), score predictions
```

**Stage 0: fix the source (rookie-trade).** Page the fundamentals calls and check each period's count against
`stock_basic`; re-fetch a period until its disclosure deadline plus a margin has passed, keeping every version with its
`f_ann_date`; add `disclosure_date` (the earnings calendar) and `dividend`; run fundamentals from the scheduler daily
in reporting seasons; write the manifest after every step, with column schemas, providers and date ranges. Without
this, the Q3 results announced this month cannot become events, and a check would compare against a truncated table.

**Stage 1: read in place.** `rt-market` as 13 §5.1 specifies (`files` globs, `sample: all` on `stock_basic`), plus a
table per fundamentals dataset and `trade_cal`; `freshness: 1d`; the capability note of §7.3. Nothing is copied.

**Stage 2: instruments.** `rt kb instruments` writes one producer document per market listing every instrument: name,
`ts_code`, `symbol`, exchange, listing and delisting dates, former names. It creates or finds each entity with all its
spellings before any post is linked, so 「300750」, 「300750.SZ」 and a former name land on the same entity as
「宁德时代」 (13 §5.2). Former names are aliases, since identity is timeless (13 §4.5), and each change is an event with
its date, so timelines show it. Names that are also ordinary phrases are marked to link only next to a code or a
security word (§4.1). Overviews skip entities whose only evidence is this list.

**Stage 3: market events.** `rt kb events` runs after each day's sync and writes one producer document per trading
day, rewritten when that day's data changes (a late fetch), which the base then replaces. Each event is an entry
(anchor; `posted_at` when it became public, `available_at` when rookie-trade had it) with a frontmatter claim carrying
its measures:

- **results**: forecast, express and report announcements, with net profit, revenue and growth against the forecast
  range or the previous period; one per company per filing, about 25–30 K a year;
- **moves**: limit up or down, a return beyond 3σ of the stock's own 60-day returns, 52-week highs and lows, streaks;
  for instruments with occurrences in the last 90 days, the indices and a watchlist, capped per day;
- **identity**: listings, delistings, name and ST changes (`namechange.change_reason`);
- **dividends and splits**, once fetched;
- optionally **valuation regimes**: PE or PB crossing its own 3-year 10th or 90th percentile.

The method is versioned in `generated.by` (`rookie-trade/events@1`), and the files are written with the producer
token, so they land trusted. The base indexes them with tier 0 only, without a model call. An event is then
searchable, counted, listed by `feed` and `changes`, and disposed by deleting its file.

**Stage 4: join at read time.** `changes` and `between` read measures over their windows from `rt-market`; `feed` with
`with_market` adds the close and PE when an entry was posted and the return since. All of it goes through the
datasource, point in time, cached for the source's freshness.

**Stage 5: close the loop.** The nightly checks (§5.3) and the track records (13 §7.2) check stated numbers, score
predictions and measure authors against what followed.

`rt kb events` runs at the end of rookie-trade's daily schedule, after fundamentals; the linked folder's watcher picks
the file up within seconds. Nothing runs during knode-os's nightly tier-2 pass. When rookie-trade is down, market
slots come back `no_data` with a note and every read falls back to what the base holds.

### 7.5 What stays out

Intraday quotes, order books and minute bars; per-post trading signals (13 decision 5); US, HK and options data until a
read needs them, which would then follow the same pattern with their own capability notes.

## 8. Phases

| Phase | Content | Done when |
| --- | --- | --- |
| A | Claim types mapped in the fold (§5.4) | no live claim has a type off the list after one `sync --verify` |
| B | Schema v17, `time.zone`, the four entry readers; apply writes entries, chunk times and evidence times; `time backfill` | the 22,563 exported files have one entry per anchor (1,377,373); a comment in a weekly file carries its own minute; a claim from a Wednesday post has that Wednesday as `observed_at`; no chunk or embedding was rewritten |
| C | Occurrences at apply and relink; `timeline`, `feed`, `between`; `posted` on search, SAG, claims and graph; the catalog views; CLI, MCP and the entity panel | a synthetic day file of 470 messages, 60 of them naming X, counts 60; an alias added later counts its past entries; `feed` over 24 h returns exactly the window's entries, with their claims |
| D | Shelf life; the metrics vocabulary; measures from tier 1 and the statement pass; supersession per metric; `changes` from the base | `valid_at: today` leaves out a 2016 opinion; "PE 18 → 15" comes back as a measure change; a forecast supersedes no result |
| E | rookie-trade's stage 0; `rt-market` with globs and the capability note; the instruments document | `knode_query rt-market` returns 宁德时代's 2026Q3 net profit as known on a given day; 300750, 300750.SZ and 宁德时代 resolve to one entity |
| F | `rt kb events`; the nightly checks; market measures in `changes`; `with_market` | a day's events file indexes without a model call, appears in `changes`, and takes its claims with it when deleted; 宁德时代's 2026‑10‑26 claims check as three prices and the market value agreeing, the PE differing |

A and B–C answer questions 1 and 2 with no change to rookie-trade and no model call. E can run beside B–D. B is also
13's phase 4 groundwork: its `known_at` reads become filters on the columns B adds, and 13's export v2 sharpens them
(exact availability, `posted_at_kind`, source classes) rather than enabling them.

## 9. Sizes and costs

| Item | Size |
| --- | --- |
| `entries` | about 1.38 M rows, one per anchor, plus one per other document |
| `chunk_entries` | about one row per entry, plus the overlaps |
| `entity_occurrences` | measured in phase B; at two linked names per entry, about 3 M rows, the size of `entity_mentions` today |
| model calls | none for A–C; D's statement pass, at most about 8 K batched calls on the remote worker, fewer after the parser |
| embeddings | none |
| market events | about 25–30 K result events a year, plus capped moves |

## 10. Behaviour changes, limits and open questions

Behaviour changes:

- `valid_at` and `valid_range` stop matching an undated claim after its shelf life; `undated: open` restores the old
  answer.
- `observed_at` moves from a file's first day to the entry's minute, so claim lists sorted by date reorder within weeks.
- Claims with a metric supersede per metric.

Limits:

- An entry's time is the one rookie-trade rendered: a `captured` entry, whose platform gave no time, shows its capture
  minute until export v2 says so.
- Edits: a file shows the current text, and `captured_at` resets on an edit. What a reader saw at t lives only in
  rookie-trade's raw archive (13 §4.5).
- Recall: occurrences count names the base knows. A nickname counts once it is an alias (宁王 for 宁德时代); pronouns and
  「该股」 do not; producer instruments would cover images.
- Feeds and people are told apart by platform until export v2 marks sources.
- Gaps upstream: without consensus estimates there is no "surprise against consensus", and without membership history
  "which concepts was X in during 2025" cannot be answered (`kpl_cons` holds exactly 3,000 rows on 357 of 493 days).

Open questions:

- Is an author's own activity a mention? Proposed: no; activity is `entries.author_id`, counted apart.
- Do Feishu feeds belong in discourse counts by default? Proposed: yes, always split by source class.
- Events for all ~5,500 instruments, or only those the base discusses? Proposed: results for all, moves for the
  discussed.
- Calendar or trading days for the baselines of `changes`? Proposed: trading days when the entity is an instrument.

## 11. Where the changes go

| Area | Files |
| --- | --- |
| Schema | `src/store/migrations.ts` (v17) |
| Time envelope | `src/store/resolver.ts` (`posted`, `precision`, `grain`, `known_at`, relative forms); `src/store/dates.ts` (zone-aware parsing); `src/config.ts` (`time.zone`) |
| Entries | `src/time/entries.ts` (new: the readers); `src/plugins/builtin.ts` (registers them); `src/ingest/apply.ts` (entries, chunk times); `src/lineage/writer.ts` (evidence times); `src/graph/llm-extract.ts` (anchor and measure per claim, grounding to entries) |
| Occurrences | `src/time/occurrences.ts` (new: census and relink); `src/graph/concepts.ts` (surface rules shared); `src/lineage/scope.ts` (dispose deletes them) |
| Claims | `src/store/temporal.ts` (type mapping, shelf life); `src/graph/store.ts` (`shelfLife`); `src/graph/ontology.ts` (`metrics`); `src/lineage/fold.ts` (`last_observed_at`, measures); `src/wiki/refine.ts` (supersession per metric, checks); `src/store/claims.ts` (`posted`, `metric`) |
| Reads | `src/time/reads.ts` (new: timeline, feed, between, changes); `src/search/search.ts`, `src/search/sag.ts`, `src/graph/query.ts`, `src/graph/cooccur.ts`; `src/mcp/tools.ts`, `src/server/app.ts`, `src/compiler/vfs.ts`; `src/cli.ts` (`timeline`, `feed`, `between`, `changes`, `time backfill`); the web UI's entity panel |
| Datasource | `src/datasource/duckdb.ts` (globs, 13 §5.1); `src/datasource/sync.ts` (`sample: all`) |
| rookie-trade (under `backend/src/rookie_trade/`) | `data/fundamental_sync.py` (paging, refetching, versions); new `disclosure_date` and `dividend` datasets; `data/market_schedule.py` (fundamentals and `rt kb` steps); `data/market_manifest.py`; `rt kb instruments / events / track-records` (new); `content_v3/export.py` (v2, 13 §6) |
| finance workspace | `knode.config.json` (`time.zone`, `rt-market`); `playbooks/capabilities/rt-market.md`; the finance pack's metrics; `playbooks/intents/entity-recent-change.yaml` |
| Tests | new `tests/entries.test.ts` and `tests/timeline.test.ts`; `tests/temporal-claims.test.ts` (shelf life, measures); a DuckDB glob test |
