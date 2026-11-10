# 26 — Feeds: connectors, filter and transform layers, and a protocol to push and pull

> Status: **phase 1 implemented** (2026‑11‑09). Source: src/ingest/feeds/ — types.ts (items, units, stages,
> connectors), definitions.ts (playbooks/feeds/<id>.yaml), ledger.ts (ledger/feeds/<id>/), units.ts (windows,
> threads, periods), stages.ts (the filter and transform layers), render.ts (Markdown documents), run.ts (one run),
> runner.ts (the scheduler under `serve`), command.ts (programs speaking the protocols), manage.ts, cli.ts,
> connectors/. Server: `/api/feeds*` in src/server/app.ts, the runner in src/server/serve.ts, the Feeds rows in
> Tasks. CLI: `knode-os feeds list|connectors|add|check|preview|run|push|items|rerender|remove|show`. MCP:
> `knode_feeds`, `knode_feed_push`. How-to with examples: [docs/feeds.md](../feeds.md).

## 0. What was there

A workspace got content four ways: files dropped in or uploaded, a linked folder (src/ingest/folders.ts), a
Feishu document or wiki mirrored and polled daily (design 21), and Claude Code / Codex conversations followed
(design 24). Each of the last three is its own little system: its own config list, scheduler class, routes,
Tasks row and CLI group.

Everything that *streams* — group chats, social accounts, mail, papers, repository activity — came from outside.
The finance workspace's 259 person folders (`raw/docs/content-markdown/<作者>__<hash>/<platform>/…/<YYYY-Www>.md`)
are a linked mirror of rookie-trade's exporter: its crawlers (`twitter-scrape.mjs`, `weibo-scrape.mjs`,
`xueqiu-scrape.mjs`, `zsxq-scrape.mjs`, `wechat-scrape.mjs`, …) fetch, an LLM marks posts
`investment_relevant`, pictures are described, and `content_v3/export.py` renders weekly files. Design 08 D8
put it there on purpose: the crawler project already had the fetching, dedupe and OCR.

That works for one workspace with a sibling project behind it. A new workspace — a research reading list, a
team's Feishu groups, a mailbox — would need its own external pipeline. This design moves the *producer* side
into knode-os as one module, keeping design 08's document conventions (fragment → unit → dated document,
`event_at` vs `observed_at`, contextual lines, stable rendering), and turns "where data comes from" into
configuration plus an extension point.

## 1. What comparable projects do

Researched 2026‑11‑09 from source (shallow clones in `tmp/research/`, not committed) and current docs.

| Project | How data gets in | What we take |
| --- | --- | --- |
| [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) | Files only: manual import, a watched `raw/sources/` with a persisted change queue and periodic reconcile, one scheduled folder, URL batch import, a Chrome clipper posting to a local server, MCP. **No Feishu, mail, chat or social connector in code** — Feishu appears only as a comment about an external export skill | Persisted queues, never in-memory pending lists |
| "llm wiki v2" | No project matching "imports Feishu group chats and email" exists. rohitg00's LLM Wiki v2 gist is a design note (event hooks, secret stripping on ingest). [crow-hq/llm-wiki-v2](https://github.com/crow-hq/llm-wiki-v2) has the cleanest pull contract: `changes(cursor) → {changes, cursor, more}` + `fetch(change)`, cursor saved per page, a `max_cost` per sync — but only a local-folder source | The contract shape (§3), a cost cap per run |
| [garrytan/gbrain](https://github.com/garrytan/gbrain) | Scheduled "source kinds": Slack (one page per channel per day, re-reads `lookbackDays` before its committed boundary to catch edits and late replies, deterministic renderer), Gmail (one page per thread, rule-based noise senders before any LLM, history-id cursor), GitHub (delta + nightly reconcile + HMAC webhook), meetings; a push daemon (`IngestionSource.emit`, `untrusted_payload`); X only as a recipe an agent writes for itself | Day pages with a lookback, thread pages for mail, noise rules first, hold failing items, a config change resets the cursor |
| [Tencent/WeKnora](https://github.com/Tencent/WeKnora) | `Connector{Validate, ListResources, FetchAll, FetchIncremental(cursor)}` + streaming `Emit`/`Checkpoint`; Feishu Drive/Wiki (app identity, blocks → Markdown), Notion, Yuque, Confluence, RSS…; cron per source. Its Feishu IM code is a Q&A bot, not history | Checkpointed streaming, deletion only after a complete listing |
| [Onyx](https://github.com/onyx-dot-app/onyx), RAGFlow, Dify, FastGPT, MaxKB, AnythingLLM, Khoj, Supermemory, Cognee | Many SaaS connectors (Slack 1 doc/thread, Gmail/IMAP/Outlook, GitHub PRs/issues, Confluence, Drive…). **None archives Feishu group-chat history** (Dify has a message *trigger*, WeKnora a bot); none ingests GitHub releases; X only through paid third parties | Onyx's webhook inbox (verify first, then a drain), push APIs that upsert by your own id |
| [RSSHub](https://docs.rsshub.app) | Not a KB: ~1000 routes turning sites into feeds — X (with an auth cookie), Weibo, Zhihu, Bilibili, 财联社, 华尔街见闻, 金十, 雪球, Telegram channels, 小宇宙, GitHub, arXiv | One generic `rss` connector covers all of it when a local RSSHub runs |
| [OpenCLI](https://github.com/jackwener/opencli) (on this Mac) | ~170 site adapters over the person's logged-in Chrome, JSON out, each command declares `access: read/write` | One `opencli` connector instead of a scraper per site |
| Airbyte, Singer, Meltano | `spec / check / discover / read(state)`; `RECORD` / `STATE` / `LOG` / `TRACE` messages; **state is a checkpoint: committed only after the records before it** | The external protocol (§6) |

Two things nobody surveyed does, and knode-os can: keep every item with what each stage decided about it, so a
filter can be audited and re-run over history without fetching again (only Airbyte's raw tables come close), and
let an *agent* be a filter or a transform with the same contract as a regex.

## 2. Connectors — what ships and how each source is reached

### 2.1 The six asked for

| Source | Connector | How it is reached | Cursor / identity | Document |
| --- | --- | --- | --- | --- |
| Feishu group chats | `feishu-chat` | lark-cli `im +chat-messages-list --as user` (thread replies expanded inline), the same sign-in as Feishu documents (design 21 D1). Scopes `im:message:readonly`, `im:message.group_msg:get_as_user`, `im:message.p2p_msg:get_as_user`, `im:message.reactions:read` (+ `im:chat:read` for the chat's name) — **not** in design 21's login, so a one-time `lark-cli auth login --scope …`; `feeds check` names what is missing. Pictures through `im +messages-resources-download` into `assets/` for the vision model | newest `create_time` per chat; each pull re-reads `lookbackDays` (2) before it, so edits, recalls and late thread replies land; `message_id` | one per chat per day, **conversation windows** cut at 30‑minute gaps (design 08 §2); relay groups can take the original post time from the message's first line (`relayTimestamps`) |
| Feishu documents | (design 21) | lark-cli mirror + daily metas poll — already a follower; stays as it is | docx token + `latest_modify_time` | the document's own folder |
| Twitter / X | `x`, or `opencli`, or `rss` | **Official API v2**, pay-per-use (≈ $0.005 per post read today; 40 accounts × 8 posts/day ≈ $48/month), bearer token. **Free alternatives**: OpenCLI `twitter tweets` / `list-tweets` on the logged-in browser (low rate, the account's own risk), or a local RSSHub `/twitter/user/<name>` with its auth cookie. Nitter is gone | `since_id` per account | per author per ISO week (as rookie-trade's export), self-threads joined |
| Email | `email` | IMAP (Node built-ins only): Gmail app password or XOAUTH2, QQ/163 授权码 (with the `ID` command 163 requires), iCloud app password, Outlook through DavMail locally. EXAMINE and `BODY.PEEK`, never marks read; credentials only over TLS (implicit, or STARTTLS whenever offered) except to a loopback bridge | `(UIDVALIDITY, last UID)` per mailbox; Message-ID | **one per thread** (gbrain); `meta.automated` flags List-Id / bulk / no-reply mail for a rule to drop before any model |
| New arXiv papers | `arxiv` | the query API (`export.arxiv.org/api/query`), categories and/or `abs:`/`ti:`/`au:` query, one request per 3 s as arXiv asks; PDF optional through `attachments.download` | newest submission date, one day of overlap; arXiv id without version (v2 replaces v1) | one per paper |
| GitHub project updates | `github` | REST: releases, commits (`since`), issues and PRs (`since`, sorted by update); `GITHUB_TOKEN` or `gh auth token`, anonymous works for a few repos' releases | per repo: commits/issues `since`; releases re-listed and deduplicated by the ledger | per repo per day; an issue is one item whose revisions follow it |

Also shipped: `rss` (RSS 2.0 / RDF / Atom / JSON Feed, conditional GET), `web` (watch pages for changes),
`opencli`, `push` (items only arrive by push), `command` (any program speaking knode-feed/1, §6).

### 2.2 Recommended next, by value for effort

1. **A local RSSHub** beside knode-os (Docker `diygod/rsshub`, `ACCESS_KEY` set, a port from the 120xx block) —
   no code: the `rss` connector then reaches 财联社, 华尔街见闻, 金十, 财新, 雪球, 36kr, 少数派, Substack, Telegram
   channels, 小宇宙 podcasts, Bilibili and X.
2. **Zotero** (local API on Zotero 7, `since=<library version>`) — pairs with arXiv.
3. **Podcasts and video transcripts** — RSS enclosures + a local Whisper; yt-dlp subtitles for YouTube/Bilibili.
4. **WeChat official accounts** — as RSS from a self-hosted `we-mp-rss`; too fragile for a native connector.
5. **Hacker News / Reddit** — RSS (hnrss, `.rss`); **Readwise Reader** (`updatedAfter`) if used.
6. **Notion / Google Drive / Feishu Drive folders** — mirror-type, like design 21; worth it only when used.
7. **Calendars** — ICS polling. **Slack / Discord** — low for this user (Slack's 2025 rate cut for non-Marketplace apps).
8. **Weibo, Zhihu, 雪球, 小红书** — through `opencli` (one connector, read-only commands) rather than per-site code;
   not MediaCrawler (non-commercial licence, Playwright).

## 3. The pipeline

```
 connector.pull(cursor)          POST /api/feeds/<id>/items · knode-os feeds push · knode_feed_push
        │ items + new cursor                    │ items
        └───────────────┬───────────────────────┘
                        ▼
   normalize (HTML → Markdown, dates, ids) → ledger: keep new items and new revisions only
                        │ (cursor committed after the items are kept: a crash re-pulls, never loses)
                        ▼
   periods those items fall in (+ units still pending, + a period an item moved out of)
                        ▼
   units: item | thread | window ──► filter layer ──► transform layer      (cached per unit hash + pipeline key)
                        ▼
   render each period's documents (stable bytes) → write the changed ones under raw/docs → one scoped sync
                        ▼
   the ordinary pipeline: chunks, vectors, tier-0, extraction, summaries, wiki
```

| Concept | What it is |
| --- | --- |
| **Item** | One message, post, mail, paper, release (`FeedItem`): stable `id`, `publishedAt` (origin time) and `observedAt` (first seen), author, channel, Markdown text, attachments, `threadId`/`replyTo`, `origin` for relayed content, `dedupeKey`, `meta`. The same id with other content is a **revision** |
| **Unit** | What the layers decide on: an item, a thread, or a **window** of conversation (consecutive messages with no 30‑min gap, ≤ 40 messages / 3000 chars). A window that grows keeps its id and gets a new hash |
| **Document** | One per unit (`period: item`) or per day / ISO week / month, optionally one folder per author or channel; longer than 12 000 characters continues in `.p2.md` |
| **Ledger** | `ledger/feeds/<id>/`: `items/<YYYY-MM>.jsonl` (every revision), `index.json`, `decisions.jsonl` (per unit: keep/drop/pending, by which stage, why, the transform's output), `state.json` (cursor, failures), `docs.json`. Machine truth, beside events.jsonl; not indexed, not in the tree |

## 4. The filter and transform layers

Both layers are ordered lists of **stages**. Every kind of stage has the same contract — a batch of units in,
one answer per unit out — so a regex, a JavaScript function, a Python script, a model and an agent are
interchangeable and can be mixed.

| Kind | Filter | Transform | Notes |
| --- | --- | --- | --- |
| `rules` | ✓ | | Declarative: `keep:`/`drop:` with `any`, `all`, `none`, `regex`, `authors`, `channels`, `tags`, `shorterThan`, `longerThan`, `hasMedia`, `language`, `fields` (`meta.msgType: [system]`). First matching rule decides |
| `dedupe` | ✓ | | Drops a unit whose `dedupeKey` / canonical URL another feed (or this one) already holds — a Weibo post relayed into two groups, an arXiv paper from RSS and the API |
| `udf` | ✓ | ✓ | A function a plugin registered (`feedStages`, `registerFeedStage`), in-process |
| `command` | ✓ | ✓ | A program speaking `knode-feed-stage/1` (§6): any language |
| `llm` | ✓ | ✓ | A model connection by id, a prompt (inline or `promptFile`), batched; sees `purpose.md` and, with `context.similar: k`, the k most similar passages already indexed (novelty) |
| `agent` | ✓ | ✓ | The same with an agent from playbooks/agents (Codex, Claude Code, a deepagents loop): its own loop and tools, one-shot, read-only sandbox |
| `template` | | ✓ | Markdown with `{{field}}`, `{{#list}}…{{/list}}`, `{{^x}}…{{/x}}` over the unit's view |
| `fetch` | | ✓ | A unit with a link and little text gets the page's main text (RSS summaries, HN links) |
| `redact` | | ✓ | API keys, tokens and passwords out of what is written |

**Filter semantics.** A stage answers keep, drop, or nothing; the first that answers decides, the later ones are not
asked. Cheap first, expensive last:

```yaml
filter:
  - kind: rules                     # free
    rules:
      - drop: { fields: { meta.msgType: [system] } }
      - drop: { shorterThan: 6 }
      - keep: { any: [业绩预告, 回购, 减持] }      # certain enough: skip the model
  - kind: dedupe
  - kind: llm                       # only what is left
    use: connection-3
    prompt: Keep views on A-share sectors and companies that give a reason or a number.
    context: { similar: 3 }
    threshold: 0.6
filterDefault: keep
```

**Transform semantics.** Every stage runs on every kept unit (or the ones its `when` matches), its fields merged over
the earlier ones': `title`, `markdown` (the section body), `context` (a contextual-retrieval line under the
heading, design 08 §5 rule 2), `summary`, `tags`, `entities` and `claims` (into frontmatter, read by tier‑0
without a model call, design 08 D7).

**Errors and money.** A failing stage leaves its units **pending** (asked again next run) unless `onError: keep|drop`.
A model stage under the quota floor (`processing.minQuotaPercent`) or with processing stopped always leaves them
pending; model calls go through the machine's call cap (`processing.maxLocalCalls`) like every background stage;
`maxModelCalls` (200) caps one run. Decisions are cached by unit hash and a **pipeline key** (a hash of the stages,
their prompt/template files and UDF versions): changing a prompt does not silently re-decide history — `knode-os
feeds rerender --redecide` does, by request.

**Untrusted content.** Items are other people's text. Model stages wrap each unit in `<item>` and say it is data, not
instructions; CLI agents run one-shot in a read-only sandbox (src/llm/cli.ts); the renderer escapes lines that would
start a heading or a fence inside a section; the `opencli` connector runs only commands OpenCLI declares
`access: read`.

## 5. Documents

```markdown
---
type: ChatArchive                 # per connector; render.type overrides
title: 混沌 · 2026-11-09
date: '2026-11-09'                # documents.doc_date — never generated.at (design 08 §1)
platform: feishu
feed: hundun
channel: { id: oc_…, name: 混沌, kind: group }
items: 23
units: 6
span: ['2026-11-09T08:12:00+08:00', '2026-11-09T20:21:00+08:00']
timezone: Asia/Shanghai
tags: [feed/hundun, platform/feishu]
entities: [...]                   # from transforms, when they extract
generated: { by: knode-os/feeds/feishu-chat }
---
# 混沌 · 2026-11-09

## 10:30–10:47 · V+, 张三 · TRS 杠杆与海外恐慌
_V+ 在「源深路炒家」讨论海外 TRS 杠杆引发的恐慌情绪。_
> id: om_a… · tags: 杠杆, 港股

- 10:30:00 V+：trs主要是海外
- 10:46:51 张三：我知道的好几个都是4倍杠杆
```

Rendering is stable: a section's bytes depend on its unit alone, nothing records when it was rendered, so a day
that gains messages keeps its earlier sections byte-identical and their chunks, vectors and extraction are reused
(as design 24 D7). Frontmatter changes, chunks don't. An item that moved period (an edited date) leaves its old
document too; a recalled message is dropped on the next render of its day.

## 6. Protocols and triggers

**Triggers.** The scheduler under `serve` (per feed `schedule.every` / `schedule.at`, catching up a missed time at
startup, sooner while a connector says `more`, 5 min → 6 h backoff after failures, never closer than the
connector's `minIntervalMinutes`); **Run now** (Tasks, `POST /api/feeds/<id>/run`, `knode-os feeds run`); pushes;
`rerender`. Runs of one feed are queued, never concurrent.

**knode-feed/1 — a program as a connector** (`connector: command`), Airbyte's checkpoint rule in JSON Lines:

```
stdin   {"protocol":"knode-feed/1","command":"read","feed":{"id","title"},"params":{…},"state":<cursor|null>,"since":"<ISO>|null"}
stdout  {"type":"item","item":{…FeedItem…}}
        {"type":"state","state":<cursor>,"more":false}     checkpoint: everything before it is kept
        {"type":"tombstone","id":"…"}                      deleted at the source
        {"type":"log","message":"…"}   {"type":"error","message":"…"}
```

A program that fails after a checkpoint keeps what came before it and moves the cursor there. `"command":"check"`
answers one `{"ok":…, "message":…}`. rookie-trade's crawlers can become feeds by printing these lines.

**knode-feed-stage/1 — a program as a stage**: stdin `{"protocol":"knode-feed-stage/1","stage":"filter"|"transform",
"feed":{…},"options":{…},"units":[{id, kind, title, text, url, author, channel, date, time, tags, meta, items:[…],
output}]}`, stdout `{"results":[{"id", "keep", "score", "reason", "tags"} | {"id", "title", "markdown", "context",
"tags", "entities", "claims"}]}`.

**Push API**: `POST /api/feeds/<id>/items` with `{"items":[…]}` or NDJSON, ≤ 5000 per request, a bearer token of an
account allowed `ingest` (`knode-os user token`). Items go through the same layers; the answer says what was kept.
The same from `knode-os feeds push <id> file.ndjson` and the MCP tool `knode_feed_push` (only into `push` feeds; an
agent only into a feed with `trust: quarantine`).

**Permissions.** Defining, previewing and checking a feed are `settings` (an administrator's: a feed can make the
server run a program or a model); running, pushing and re-rendering are `ingest`; reading feeds and their decisions
is `files`. Feed files live in playbooks/, which no file API or MCP tool writes.

## 7. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 One module for every streaming source, connectors as plugins | `FeedConnector` is registered through the plugin API (design 11) — the built-ins too — and `FeedStagePlugin` adds named UDFs. A feed is a YAML file naming a connector, its params, its stages and its rendering | Three bespoke followers already showed the shape; a fourth, fifth and sixth would each repeat it. New sources become configuration or a plugin, not a branch in the server |
| D2 Definitions in playbooks/feeds/<id>.yaml | Like research sources and agents: edited in a file or through the API, diffable, secrets as `env:VAR`, written 0600 | People write pipelines with prompts in them; YAML holds that better than knode.config.json, and playbooks/ is outside every writable root |
| D3 Keep everything, decide per unit, cache decisions | The ledger keeps every revision and every decision with who made it and why; documents are rendered from it | Filters are tuned by looking at what they dropped (`feeds items --status drop`); a better prompt can be run over history (`rerender --redecide`) without fetching anything — no surveyed system does this |
| D4 Units, not messages | Chats are judged and rendered as windows; mail as threads; posts as items | A one-line chat message cannot be judged alone (design 08 §2); a thread is how mail is read (gbrain, Onyx) |
| D5 Stable, dated documents in raw/docs | Day / week / month / item documents with `date:`, sections whose bytes depend only on their unit | The rest of knode-os — doc_date, temporal resolver, path-prefix scoping, chunk reuse — already works on them; the finance workspace's weekly files already look like this |
| D6 Same contract for every stage kind | Batch of units → one answer per unit, whether rules, JS, a program, a model or an agent | The person picks the cheapest thing that works per step and mixes them; an agent is "just" a stage |
| D7 Cursor after the items, checkpoints from programs | The cursor moves only once the items it covers are in the ledger; programs checkpoint with `state` lines | Airbyte's rule: a crash re-pulls, never loses |
| D8 Background work rules apply | Model stages share the machine's call cap and rest under the quota floor; pending units wait for the next run; a per-run cap | Feeds must not eat the Codex window finance's processing lives on |
| D9 Ask before money and accounts | X API is opt-in with its own token; `opencli` read commands only; IMAP EXAMINE; no webhook endpoint yet | Following someone must never post, like, mark read or delete |
| D10 Feishu documents and conversations stay where they are | Their followers keep working; a later step can present them in the Feeds list as mirror-type sources | Moving them changes nothing for the user and risks two working systems |

## 8. Moving finance off rookie-trade (when wanted)

Not done automatically — the finance workspace's 259 linked person folders keep working. A path, one source at a
time: (1) Feishu groups → `feishu-chat` feeds with `relayTimestamps`, the `investment_relevant` judgement as an
`llm` filter over windows, design 08's layout as `render.dest: finance/feishu/<group>`; (2) X accounts → `opencli`
(`twitter list-tweets` over one list) or `x`; (3) Weibo / 雪球 / 知识星球 → keep rookie-trade's scrapers but run them
as `command` feeds (print knode-feed/1 lines) or have them push (`POST /api/feeds/<id>/items`), so its exporter
and the linked mirror can be retired; (4) unlink the content-markdown mirror once the feeds cover it.

## 9. Not done

- **Webhooks for push-capable sources** (GitHub, Feishu events, changedetection.io): an unauthenticated
  `/hooks/feeds/<workspace>/<id>` verifying Standard Webhooks signatures (`webhook-id`, `webhook-timestamp`,
  `webhook-signature: v1,<HMAC-SHA256>`, per-feed `whsec_` secret, 5‑minute replay window), deliveries stored in the
  ledger and drained by the next run (Onyx's inbox). Polling covers every source until then.
- **A Feeds screen** in the web UI and the Mac app to create feeds from the connector catalog with a live
  preview; today Tasks lists feeds with Run now, and feeds are written as YAML or with the CLI.
- **Connector `control` messages** to persist rotated credentials (Airbyte's `CONNECTOR_CONFIG`).
- **arXiv listings** (`rss.arxiv.org/atom/<cats>` with `announce_type`) as the cheaper daily path; HTML full text before PDF.
- **Cost estimates** for a feed's model stages (`knode-os estimate`), and a per-day model budget across feeds.
- **Retention**: compacting old ledger months; documents are kept like any source.
- **Feishu message seconds**: lark-cli's shortcut prints `create_time` to the minute, so messages within a minute
  keep their listed order but show `:00`; the raw `im/v1/messages` API (whose shape the parser already reads) has
  milliseconds. Late thread replies are seen while the thread's root is inside `lookbackDays`.
- **Mail**: attachments are listed, not downloaded; OAuth access tokens are not refreshed (the `env:` value must
  be kept current); CONDSTORE (changed flags) and IDLE (push) are not used — a 15‑minute poll.
