# 15 — Research studies: from a topic to a set of wiki pages, with the sources kept

> Status: **implemented** (2026‑10‑27). Kinds `study` / `section` on `research_jobs` (no migration: two new statuses,
> `draft` and `waiting`), `src/research/{study,refine,capture,fetch,web,sources,chart,deep-research,read}.ts`, the HTML
> converter (`src/ingest/converters/html.ts`), the web UI's **Research** section, `knode-os research study …`.

## 0. What was missing

The research runner of [06](06-wiki-research-agent.md) writes **one page about one subject** (an entity, a concept,
a question …) from what the knowledge base already holds, and may verify against the web. A request like

> Starting with Anthropic's latest prospectus, I want to understand its revenue and cost structure, the companies
> upstream and downstream in its value chain, how it compares with competitors, what others think of it, its future
> prospects, and anything else you think is important.

is none of those. It is a *study*: the question has to be sharpened first (which prospectus? which competitors?), the
material mostly is not in the base yet and has to be found and **kept** — a page that cites a URL cites something the
validator cannot check and the reader may never see again — and the answer is several pages that belong together,
with numbers that read better as charts.

## 1. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 A study is a job | One `research_jobs` row (kind `study`) carries the topic, the brief, the runner and the sources in its payload; each planned page is a `section` job pointing back at it (`payload.study`) | The queue, cancellation, retries, run workspaces, pipelines, validation, quarantine and the Jobs list already exist for jobs. A page of a study is an ordinary page job with a payload-driven outline, so everything 06 built applies to it unchanged. No migration: `status` and `kind` are text |
| D2 Draft → refine → start | A study begins as a `draft`. Refinement is one model call with no tools: the topic, what the base already holds about it (a `resolve` without a receipt), the selected sources, and on later rounds the previous brief, the person's feedback and their answers to the brief's clarifying questions. The answer is normalized (`normalizeBrief`): ids, unique slugs, `## ` headings with no sources section, every question on a page, limits | The person sees and edits the plan before any agent spends quota. Normalizing in code means a sloppy model answer still yields a brief the runner can rely on. The refiner is `research.study.refiner`, else the default LLM when it is a model, else the study's own agent one-shot — so a machine with only Codex refines on Codex |
| D3 The runner is the study's | `payload.runner` = `{ mode: agent \| deep-research, agent, model, profile, deepResearch }`; the page jobs copy it. Without `research.agent` the loop still claims a job that names its own agent | "Let the user choose Codex, Claude, another CLI or a deep-research mode" is a per-study choice, not a workspace setting |
| D4 Collect, then write | Stage `collect`: the brief's seed URLs and the selected sites' URLs are captured; then one **collector** session per planned page (read-only tools + `knode_capture`, the web per the study) gathers material and writes notes — or, in deep-research mode, one call to a deep-research model collects and every URL it cites is captured. The material is indexed; then the page jobs are queued and the study `waits` | Pages written from captured, indexed material cite `raw/docs/…` paths the validator verifies, and every later agent finds the same sources through search |
| D5 Captures are originals | `knode_capture` makes knode fetch the URL itself and keep the bytes under `raw/docs/research/<study>/` (HTML with one provenance comment prepended, PDFs, CSV/JSON, images). The ordinary pipeline converts (the new HTML converter, the PDF converter read to 1,000 pages there) and indexes it. An agent's own text is accepted only as a labelled **excerpt** when knode cannot fetch the page | raw/ holds originals and the sidecar the derived Markdown (as for every PDF); an agent's paraphrase never poses as the page. The same URL — or the same bytes — is kept once per workspace and listed in every study's register that used it |
| D6 The fetch guard | Agent-chosen URLs: http(s) only, no credentials in the URL, never a private / loopback / link-local / reserved address (checked on every address a name resolves to, on every redirect, and again inside the socket's lookup), capped size and time. Proxies as curl reads them (HTTPS_PROXY / NO_PROXY); HTTPS through CONNECT | An agent reads pages anyone wrote; a URL it picks must not reach this machine's services. A machine behind a proxy (this Mac mini's 127.0.0.1:7897) must still reach the web — Node's own fetch ignores proxies |
| D6a Fake-IP DNS | A proxy in fake-IP mode (Clash, mihomo, Surge, sing-box) answers every name with a reserved address (198.18.0.0/15, fdfe:dcba:9876::/64, fc00::/18) and resolves the real one itself. A name that resolves only into those ranges is checked again against public resolvers (1.1.1.1, 8.8.8.8, 223.5.5.5): a real private answer is refused; a name they cannot reach either is let through, the proxy resolving it. An IP literal in those ranges is always refused | On the Mac mini every public site resolves to 198.18.x.x; without this the guard refused the web outright. What is left is the case nothing local can check: a proxy that owns all DNS resolving a public name to a private address |
| D6b The printed filing | The HTML converter strips EDGAR's SGML wrapper (`<DOCUMENT><TYPE>…<TEXT>`), joins a page printed to HTML line by line (each line an absolutely positioned `<div>` at a `top:` offset) back into paragraphs by the vertical gap, reads CSS bold and italic, and — when a page has no `<h1>`–`<h6>` of its own — makes a fully bold one-line paragraph a heading. Financial tables fold the cells a figure is split into (`$` · `1,234` · `)`) and drop spacer columns | Anthropic's S-1 (14 MB, 2026‑10‑26) is such a page: without this it converted to 15,000 one-line paragraphs and no outline; with it, 1.6 MB of Markdown in 0.3 s, 120 statement tables and an outline (Prospectus Summary, Risk Factors, How We Generate Revenue …) that `knode_read section` can use |
| D7 Trust follows the asker | A capture is on record (`recordOrigin`) as whoever asked: an agent's lands quarantined, like the rest of its work; a person's capture from the UI or CLI is trusted. The study view promotes a study's pages or its sources in one click | Third-party web content chosen by an agent should not silently become the base's position |
| D8 Sources are files | Research sources live in `playbooks/research/sources/<id>.yaml`: `mcp` (an MCP server attached to every session of a study that selects it — HTTP or a local command), `api` (declared JSON endpoints, called through `knode_api`, an allowlist), `site` (domains that steer search, seed URLs captured first), `datasource` (a `datasources[]` id for `knode_query`). Editing them is the `settings` API group | Users configure "their own data sources, APIs and integrations" the way agents and profiles are configured. A stdio MCP source runs a command on the server, which is an administrator's call |
| D9 Web search for everyone | `research.web.search` names a search API (SearXNG, Brave, Tavily, Serper) behind `knode_web_search`; with none configured the tool does not exist. Claude Code and Codex keep their own search | The built-in agent has no web tool and Cursor's cannot be switched per session; neither should be stuck, and knode never calls a vendor nobody named |
| D10 Charts are data | A page carries charts as fenced ```` ```chart ```` blocks holding a small JSON spec (`type`, `title`, `x`, `series`, `unit`, `source`, `note`). The validator rejects a block it cannot read (the reviser fixes it); `knode_chart` checks one before it is written; the web viewer draws it (web/chart.js); Obsidian shows the JSON | The numbers stay readable, diffable and citable in the page itself; a picture an agent rendered would be none of those, and would need image serving the workspace-scoped API does not do |
| D11 Long documents in parts | `knode_read` takes `section` (a heading), `offset` / `limit` (lines) and `outline` | A converted S-1 is tens of thousands of lines; an agent must be able to read its MD&A without pulling the whole filing into context |

## 2. The flow

```
topic ──refine (one call, no tools)──▶ brief (draft) ──edit / refine again──▶ start
                                                                              │
 collect ◀────────────────────────────────────────────────────────────────────┘
   seed URLs + site URLs ──knode capture──▶ raw/docs/research/<study>/{web,files}/…   (manifest .captures.json, register sources.md)
   collectors, one per page, in parallel (research.study.collectors)
     knode_resolve / knode_search / web search / sources ──knode_capture──▶ raw/docs/research/<study>/…
     findings ──harness──▶ raw/docs/research/<study>/notes/<n>-<page>.md
   | or deep-research mode: one Responses-API call (background, polled) ──▶ reports/<date>-<model>.md + its citations captured
   wait for the capture syncs; sync the study folder (convert, chunk, embed; extraction is queued as for any document)
 pages: one `section` job per page ──ordinary runner (profile pipeline)──▶ wiki/research/<study>/<page>.md
   brief = the study document (objective, scope, every page and its questions, what was collected, the sources) + the page's outline
   validation: planned sections + the sources heading in the output language, charts, `study:` stamped, sources verified
 report: when every page is done or failed (continueStudies, every loop tick) ──single session──▶ wiki/research/<study>.md
```

Statuses: `draft` → `queued` → `running` (collect) → `waiting` (pages) → `queued` → `running` (report) → `done`.
`continueStudies` runs on every tick of the research loop and when any job ends, so a study never waits on a page
that is gone; a cancelled study cancels its unfinished pages. Retry puts a failed study back at the stage it failed
in, with its failed pages.

## 3. Layout

```
raw/docs/research/
├── .captures.json                       url → file for every capture (dotfile: never indexed)
├── web/                                 captures that belong to no study
└── <study>/
    ├── sources.md                       the register: title, site, published, type, file, URL, why
    ├── web/<published>-<site>-<slug>.html
    ├── files/<published>-<site>-<slug>.pdf | .csv | .json | .png
    ├── notes/<n>-<page>.md              collector findings (type: research-notes; quarantined)
    └── reports/<date>-<model>.md        a deep-research model's report
wiki/research/
├── <study>.md                           the report (type: research-report)
└── <study>/<page>.md                    the pages (type: research-page)
playbooks/research/
├── study.md  section.md                 the templates of the two kinds
├── phases/refine.md  phases/collect.md  the refiner's and the collectors' prompts
└── sources/<id>.yaml                    research sources
```

A file name carries the document's own date (its `published` meta, a PDF's creation date), never the fetch date: a
date in the path dates the document in the index. Pages link each other with vault-root paths
(`[[research/<study>/<page>|Title]]`), which Obsidian and knode resolve the same way wherever the link sits.

## 4. Config

```jsonc
"research": {
  "study": { "collectors": 3, "maxPages": 6, "maxCaptures": 60, "refiner": "" },
  "web": {
    "search": { "provider": "", "baseUrl": "", "apiKey": "", "maxResults": 8 },  // searxng | brave | tavily | serper
    "maxBytes": 26214400, "timeoutMs": 30000,
    "allowPrivateHosts": false,
    "proxy": "",            // '' = HTTPS_PROXY / HTTP_PROXY from the environment, 'none', or http://host:port
    "userAgent": "knode-os/0.1 (local research assistant)"   // SEC EDGAR wants "Name email@domain"
  }
}
```

The workspace's web switch is still `review.external`: `off` turns the web off for studies too; under `verify` (the
default) a study's own web choice widens it for that study, as a profile's `search.web: on` does.

## 5. Surfaces

- Mac app: **Research → Studies** (the same loop without per-page editing); chart blocks render natively.
- Web UI: **Research → Studies** (compose, refine with answers and edits, start, watch the stages, open the report
  and pages, promote pages or sources, session logs) and **Research → Sources** (web settings, research sources).
- HTTP: `GET/POST /api/research/studies`, `GET/PUT/DELETE /api/research/studies/:id`,
  `POST /api/research/studies/:id/{refine,start,cancel,retry,promote}`, `GET /api/research/studies/:id/log?label=`,
  `POST /api/research/capture`, `GET /api/research/captures`, `GET /api/research/sources`, `PUT/DELETE /api/research/sources/:id`.
- MCP: `knode_capture`, `knode_web_fetch`, `knode_web_search` (configured only), `knode_api`, `knode_chart`, `knode_study`
  (list / show for every caller; create / refine / start from this machine's own clients only), `knode_read` with
  `section` / `offset` / `limit` / `outline`.
- CLI: `knode-os research study new "<topic>" [--agent codex-cli] [--no-web] [--sources a,b] [--deep-research conn:model] [--start | --now]`,
  `research study refine <id> [feedback] [--answer "q=a"]`, `research study start|run|show|list|cancel`,
  `research capture <url> [--study id]`, `research sources`.

## 6. Open items

1. Deep-research mode follows OpenAI's documented Responses API (`background: true`, `web_search_preview`,
   `url_citation` annotations) and Perplexity's `citations` / `search_results`; it has been run against stand-ins only.
2. Codex's per-server keys for a source's MCP server (`env_http_headers`, `env_vars`, `enabled_tools`) follow its
   config reference; a stdio source on cursor-agent is untested.
3. The Mac app has a Research → Studies screen (compose, answer the brief's questions, refine, start, follow the
   stages, open pages, sources and the report, promote) and draws chart blocks with Swift Charts; editing a brief page
   by page, and the Sources settings, are the web UI's.
4. Captured sources are quarantined like any agent write; a study's "promote sources" is the one-click review. A
   per-site trust list (always trust sec.gov) is not built.
5. SEC EDGAR asks automated clients for a contact in the User-Agent (`research.web.userAgent`, "Name email@domain").
   From the Mac mini, through its proxy, EDGAR answered knode's default User-Agent (2026‑10‑27); from elsewhere it may
   answer 403, and the capture error says what to set.
6. Converted originals now carry their capture's writer: apply reads the origin record of a PDF or HTML original
   too (`originOf`), so a page an agent had knode capture lands quarantined like its other work. A converted file
   with no record — an upload, a linked folder — is unaffected.
