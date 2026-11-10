# Feeds: following sources that keep producing

A **feed** follows something that keeps producing items — a Feishu group, a mailbox, X accounts, an arXiv search,
GitHub repositories, an RSS feed, web pages, or a program of yours — and writes what is worth keeping into the
workspace as Markdown documents, which knode-os then indexes like anything else. Each feed has a **filter** layer
(is this item worth keeping?) and a **transform** layer (what should it look like?), and both can be rules, your
own functions or programs, models, or agents. Design and rationale: [docs/design/25](design/25-feeds.md).

## Quick start

```bash
knode-os feeds connectors                      # what can be followed, with parameters
knode-os feeds add papers --connector arxiv \
  -p 'categories=["cs.CL","cs.IR"]' -p 'query=abs:"retrieval augmented"' --at 08:30
knode-os feeds check papers                    # can it reach arXiv?
knode-os feeds preview papers                  # what a run would write — nothing is kept
knode-os feeds run papers                      # now; `serve` also runs it daily at 08:30
knode-os feeds items papers --status drop      # what the filter dropped, and why
```

A feed is a YAML file, `playbooks/feeds/<id>.yaml` in the workspace. `knode-os feeds add <id> --file feed.yaml`
writes one (checked first), or edit the file directly; secrets may be written as `env:VAR`. Under `serve`, feeds
run on their schedules and show under **Tasks → Feeds** with **Run now**.

```yaml
title: 混沌                       # shown in Tasks and in document titles
connector: feishu-chat
params: { chatId: oc_5c14…, relayTimestamps: true }
schedule: { every: 30m }          # or { at: ["06:00", "18:00"] }, or manual
backfillDays: 3                   # how far back the first run goes
units: { by: window, gapMinutes: 30 }      # item | thread | window
filter: []                        # stages, below
filterDefault: keep               # what no stage decided on becomes
transform: []
render:
  period: day                     # item | day | week | month — what one document holds
  dest: finance/feishu/hundun     # under raw/docs; default raw/docs/feeds/<id>
  by: null                        # author | channel: a folder level each
  timezone: Asia/Shanghai
  maxChars: 12000                 # longer continues in <name>.p2.md
attachments: { download: true }   # pictures and PDFs saved for the vision model / converters
maxModelCalls: 200                # per run
trust: trusted                    # or quarantine
```

## Connectors

| id | Follows | Key params |
| --- | --- | --- |
| `feishu-chat` | Feishu group chats, as the signed-in Feishu user (lark-cli) | `chatId` / `chatIds`, `lookbackDays`, `relayTimestamps` |
| `email` | IMAP mailboxes, read-only | `host`, `user`, `password` (`env:…`), `mailboxes`, `tls` |
| `x` | X accounts through the paid API v2 | `usernames`, `token` (default `env:X_BEARER_TOKEN`) |
| `opencli` | ~170 sites through your logged-in Chrome (X lists, Weibo, Zhihu, 雪球, Bilibili…) — read commands only | `site`, `command`, `args` |
| `arxiv` | New papers for categories / a query | `categories`, `query` |
| `github` | Releases, commits, issues, pull requests | `repo` / `repos`, `events`, `token` |
| `rss` | RSS / Atom / JSON Feed — and every RSSHub route | `url` / `urls` |
| `web` | Pages, rewritten when their main text changes | `url` / `urls` |
| `push` | Nothing — items are pushed in | `platform` |
| `command` | A program of yours speaking knode-feed/1 | `command`, `args`, `env` |

Feishu group chats need the Feishu sign-in of design 21 with the message-reading scope; `knode-os feeds check <id>`
says what is missing. X without the API: an `opencli` feed (`site: twitter, command: list-tweets, args: { listId: … }`)
or an `rss` feed on a local RSSHub (`http://127.0.0.1:<port>/twitter/user/<name>`).

## Filter stages

The first stage that says keep or drop decides; put cheap ones first.

```yaml
filter:
  - kind: rules
    rules:
      - drop: { fields: { meta.automated: [true] } }        # mailing lists, no-reply senders
      - drop: { shorterThan: 8, note: chit-chat }
      - drop: { authors: [机器人], none: [研报] }
      - keep: { any: [业绩预告, 回购, 增持], note: corporate actions }
      - keep: { regex: ['\b[036]\d{5}\.(SH|SZ)\b'] }
  - kind: dedupe                    # already held by another feed (same post relayed twice)
  - kind: llm                       # a model connection by id
    use: connection-3
    prompt: |
      Keep views on A-share sectors or companies that give a reason, a number or a source.
      Drop greetings, emoji reactions, ads, and repeats of what the knowledge base already says.
    context: { purpose: true, similar: 3 }   # purpose.md, and the 3 nearest indexed passages
    threshold: 0.6                  # keep when score ≥ 0.6
    batch: 8
  # or an agent from playbooks/agents (its own loop and tools, read-only):
  # - kind: agent
  #   use: codex
  #   promptFile: prompts/judge.md  # under playbooks/feeds/
```

Any stage can carry `when:` (the same conditions as a rule) to run only on matching units, and `onError: hold | keep
| drop` (default hold: the unit waits for the next run).

## Transform stages

Every transform runs on every kept unit; later ones see and override earlier ones.

```yaml
transform:
  - kind: fetch                     # a link with a short summary gets the page's text
    minChars: 400
  - kind: llm
    use: connection-3
    prompt: |
      Write the item as a research note: a one-line takeaway in bold, then the argument as bullets,
      then any numbers as a small table. Keep tickers and figures exactly.
    # answers {title, markdown, context, summary, tags, entities} — or output: markdown for the body alone
  - kind: template
    template: |
      **{{title}}** — {{author.name}}, {{date}}

      {{text}}
      {{#tags}}#{{.}} {{/tags}}
  - kind: redact                    # keys and tokens out of what is written
```

A template sees the unit: `id`, `kind`, `title`, `text`, `url`, `author`, `authors`, `channel`, `date`, `time`,
`tags`, `meta`, `origin`, `attachments`, `items` (each with `time`, `author`, `text`) and `output` (what earlier
transforms set).

## Your own stages

**In-process (a plugin, docs/plugins.md):**

```js
// <data>/plugins/finance-feeds.mjs, listed under "plugins" in knode.config.json
export default {
  name: 'finance-feeds',
  feedStages: [
    {
      id: 'tickers-only',
      kind: 'filter',
      run: (units) => units.map((u) => (/\b[036]\d{5}\b/.test(u.items.map((i) => i.text).join(' ')) ? { keep: true } : null)),
    },
    {
      id: 'tag-tickers',
      kind: 'transform',
      version: 2,                   // bump to re-decide what it decided before
      run: (units) => units.map((u) => ({ tags: [...new Set(u.items.flatMap((i) => (i.text ?? '').match(/\b[036]\d{5}\b/g) ?? []))] })),
    },
  ],
};
```

```yaml
filter:    [{ kind: udf, name: tickers-only }]
transform: [{ kind: udf, name: tag-tickers, options: { … } }]
```

**Any language (`knode-feed-stage/1`):** the program reads one JSON object on stdin and writes one on stdout.

```python
#!/usr/bin/env python3
import json, sys
req = json.load(sys.stdin)            # {"protocol":"knode-feed-stage/1","stage":"filter","units":[…],"options":{…}}
out = [{"id": u["id"], "keep": "研报" in u["text"], "reason": "mentions a report"} for u in req["units"]]
json.dump({"results": out}, sys.stdout)
```

```yaml
filter: [{ kind: command, command: ./scripts/judge.py, timeoutMs: 60000 }]
```

## Your own connectors

**A program (`connector: command`, `knode-feed/1`):** read one JSON object on stdin, write JSON Lines.

```js
#!/usr/bin/env node
let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', async () => {
  const { params, state } = JSON.parse(s);
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const since = state?.since ?? null;
  for (const post of await fetchPosts(params.account, since)) {
    out({ type: 'item', item: { id: post.id, url: post.url, author: { name: post.author }, publishedAt: post.time, text: post.text } });
  }
  out({ type: 'state', state: { since: new Date().toISOString() } });   // a checkpoint
});
```

**A plugin** registers a `FeedConnector` (`feedConnectors: [...]` or `api.registerFeedConnector`) with `id`,
`label`, `params` and `pull(ctx)` returning `{ items, state, more }` — see src/ingest/feeds/connectors/rss.ts.

## Pushing items in

```bash
knode-os feeds add inbox --connector push --manual
curl -X POST https://knode.example/api/feeds/inbox/items \
  -H "authorization: Bearer $KNODE_TOKEN" -H 'x-knode-workspace-kind: personal' -H 'x-knode-workspace-id: default' \
  -H 'content-type: application/json' \
  -d '{"items":[{"id":"https://ex.com/a","url":"https://ex.com/a","title":"Worth keeping","text":"…"}]}'
knode-os feeds push inbox items.ndjson
```

`id` is required (a URL works); `publishedAt` defaults to when it arrives. Items go through the feed's filters and
transforms. Agents can push through the MCP tool `knode_feed_push` (only into `push` feeds; an agent only into one
with `trust: quarantine`).

## Looking after a feed

- `knode-os feeds items <id> --status drop` — what was dropped, by which stage, why. `--status pending` — what waits
  (an error, or the quota floor).
- `knode-os feeds rerender <id>` — write its documents again from the ledger (after changing a template or `render`);
  `--redecide` also asks the stages again (costs model calls).
- `knode-os feeds remove <id> [--remove-files] [--forget]` — keep or remove its documents and ledger.
- Changing a feed's connector or params starts its cursor over from `backfillDays`; items already kept are not
  written twice.
