# 19 — Mind maps: pictures of trees read as outlines, drawn as maps, joined to the graph

> Status: **implemented** (2026‑10‑30). Canonical form `type: MindMap` (src/mindmap/outline.ts), image
> converter version 2 (mind maps come back as outlines), reviewed transcripts `<original>.md`, branch-path
> chunks, extractor `tier0.mindmap` (src/mindmap/graph.ts), web/mindmap.js + web/mindmap.css.

## 0. What was there

A mind map is a tree of short labels: a root (华为, 字节产业链, 情绪) and branches that group and qualify what hangs
under them. People who follow A-share themes keep their knowledge this way — an industry chain with the listed
companies in each segment, a trader's framework with its phases and rules — and share it as pictures.

Before this, a picture of one went through the image converter like any picture. The vision model was told to
"transcribe and describe": it returned a nested list, a paragraph, a table or a mix, whichever it chose. The
Markdown was chunked by size, so a piece could hold `- 永贵电器（液冷充电枪）` without saying that it sits under
华为 › 华为智驾 › 液冷超充; tier‑0 linked at most 64 names a document; the tree itself — which company is in
which segment of which chain — reached the graph only if tier‑1 happened to say so. A misreading could not be
corrected: the derived Markdown is read-only, and the original's bytes are what a re-upload replaces.

## 1. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 One form: an outline with `type: MindMap` | A mind map is Markdown whose frontmatter says `type: MindMap`: the root is its H1, every other node a `- ` bullet two spaces under its parent, labels verbatim (numbering and parenthetical notes included, bold kept as `**…**`). Headings below the H1 are nodes too, so markmap and XMind exports read the same | It is the form tools already exchange (markmap, Logseq, Workflowy/幕布 and XMind exports), it reads in Obsidian and the Mac app with no renderer, it chunks and searches as text, and every producer — a vision model, a person, an agent, a future `.xmind` converter — can write it |
| D2 Read line by line, not as CommonMark | `parseMindMap` takes each item as one node and keeps its text: `- 1. 市场整体情绪极弱` is a label that starts with "1.", not a nested ordered list. A label's trailing parenthetical is its **note** (`钢研高纳（高温合金平台类企业）` → name 钢研高纳, note 高温合金平台类企业; an unclosed one runs to the end), leading numbering is not part of its **name**. The writer escapes what CommonMark would otherwise read (`1\.`, `\#`, `\*`) | Numbered steps and notes are how these maps are written; a Markdown parser would renumber the steps and nest them. The name is what an entity is called; the note is what the map says about it |
| D3 The image converter asks for the outline | The vision prompt gains one branch: a picture of a mind map, tree diagram, org chart or outline comes back as a marked outline (`<!-- knode:mindmap -->`, `# root`, nested bullets), which the converter validates (`parseMindMap` must find a tree) and rewrites in the canonical form with `type: MindMap`, `conversion: image-mindmap`. A mark over something that is no tree is dropped with a warning and the text kept. The image converter is **version 2**: its cache key changes, so images converted before are converted again | One call, as before; other pictures are described as before. Re-converting is what the cache key is for — the output for a mind map changed — and costs one call per picture (none in the workspaces on this machine on 2026‑10‑30) |
| D4 A reviewed transcript sits beside its original | A text file named after the converted Markdown — `华为产业链.webp.md` beside `华为产业链.webp`, `report.pdf.md` beside `report.pdf` — is the original's **transcript**: while it exists, prepare reads it instead of converting (cache key `transcript|<sha>`), and it is not a document of its own. Its frontmatter is kept as written; `source`, `source_type`, `conversion: transcript`, `conversion_model` (from `transcribed_by`, the key research captures use for the same thing) and `transcript` are added. A change to it re-prepares the original; deleting it hands the original back to the converter | Vision models misread dense pictures; the fix is an edit, made where every other edit is made: in a file, which the watcher, the ledger and Obsidian already see. The document keeps its key (the picture), so citations and links to it hold. Nothing is written over the original, and no model is asked to redo what a person corrected |
| D5 Chunks follow branches | A mind map is cut along its tree: each piece starts with the path to it (`华为 › 华为智驾 › 液冷超充`) and holds whole sibling branches, packed up to `ingest.chunkSize` characters; a branch larger than that is cut the same way one level down. Labels go in as plain text | A piece read alone — in a search hit, a context pack, a tier-1 segment's grounding — says where it sits. Whole branches keep a company with its notes and its children |
| D6 Tier‑0 joins named nodes, and only those | A node **counts** when its name is the **name** of a typed entity the graph already knows — exact spelling, not an alias, not a stop-listed word, not a person, event, dataset, indicator or "other", not an organization of two characters — or an entity the document declares in `entities:`. `subject:` names what the root stands for (`华为产业链`, typed `theme` when the ontology has it); on a wiki page, the page's own entity does. Branch labels nobody names (上游, 特征, 整车) and notes (20cm, 实锤独供) stay text | Branch labels mean something only under their parent: "上游" in one chain is not "上游" in another, and minting them as entities would make hubs of words. Aliases are where extraction's merges collect, right and wrong: in finance on 2026‑10‑30, 创业板 and 20cm were aliases of A股, CPU / GPU / HBM of 芯片, 混沌期 of a blogger 混沌20000, 中国船舶 of 中船特气 — a node read through them would hang on the wrong entity. Two-character names are where companies and everyday words meet (海洋 and 稀土 were organizations there). A reviewed transcript declares what the graph knows by another spelling or not at all |
| D7 An edge to the nearest named ancestor, typed by the two types | Between a counted node and the nearest counted node above it the map states one edge (`edgeFor`): a company under a sector or theme `belongs_to_sector`; a company under a product, technology or commodity `produces` it; a product under a company is produced by it; parts under parts `part_of`; anything else — two companies, a person — `related_to`. Two groupings (neither a company) are joined only when the upper one is the subject, and a company under a segment also `belongs_to_sector` the subject. Predicates the workspace's ontology lacks fall back to `part_of` / `related_to`. The description is the path from the root (`华为 › 华为智驾 › 液冷超充 › 永贵电器（液冷充电枪）`) | The tree says "listed under", which is only as precise as the two ends' types allow: 赛力斯 under 华为 may be a partner, a supplier or a customer, and saying `related_to` with the path is honest where `supplies_to` would be a guess. 整车 under 华为智驾 is true inside this map and false of the auto sector, so it is not said; 赛力斯 being in the 华为 chain is what the map is for, so it is said even when a segment sits between them. Typed edges come from tier‑1, which reads the path-carrying chunks |
| D8 Linked like a link, declared like a declaration | Known entities are written by id with the fallback type at half weight (as `tier0.link`), so the map never out-votes the type tier‑1 gives them; `related_to` edges weigh half. Evidence carries extractor `tier0.mindmap`, which counts as the author naming the entity (`DECLARING_EXTRACTORS`): the file view marks every named node, sectors and themes included | A map is a person's statement about where things belong — worth showing on the entity panel, not worth retyping an entity |
| D9 Drawn as HTML, not SVG | The file view (and the embed reader) draws a `type: MindMap` page as its tree: nested lists laid out by flexbox, bracket lines in CSS, the root on the left like the source pictures. Branches fold (the button shows how many nodes are behind it), the map fits the pane, the same list reads as an indented outline, and — for a map read off a picture or a transcript beside one — the picture opens under the map | Labels size and wrap themselves with nothing measured in script; the browser's find reaches them; the page policy (no inline style, script or handler) is kept; and the file view's entity marking turns node names into entity links exactly as it does in prose, which is the link from the map to the graph |

## 2. The form

```markdown
---
type: MindMap
title: 华为产业链
subject: { name: 华为产业链, type: theme }      # optional: what the root stands for
entities:                                        # optional: types for names the graph may not know yet
  - { name: 高新发展, type: organization, aliases: [高兴发展] }
linkNodes: declared                              # optional: only declared names count (a map of jargon)
transcribed_by: "human:ning"                     # optional, a transcript's author
---
# 华为

- 华为智驾
  - 整车
    - **赛力斯（核心）**
      - 问界
  - 液冷超充
    - 永贵电器（液冷充电枪）
- 华为算力
  - 散热
    - 液冷管路
      - 川环科技
        - 实锤独供
```

- A chain of single nodes (`A —— B —— C` in the picture) nests: B under A, C under B.
- A label is copied as drawn, typos included; a reviewer maps a misspelt company to the real one with `entities:`
  and the misspelling as an alias, so the picture and its outline still match.
- Colour carries nothing a label does not already say (`20（创）` is drawn orange, `20（科）` green); it is not kept.

## 3. The flow

```
picture.webp ──prepare──► transcript beside it? ──yes──► its text (no model)
                                │ no                         │
                                ▼                            ▼
                    vision model (image v2) ──► outline? ──► content.md  type: MindMap
                                                 │ no            │
                                                 ▼               ▼
                                          description      apply: branch-path chunks → embeddings
                                                           tier‑0: links, mined terms, declared facts,
                                                                   mind map plan (named nodes → edges)
                                                           tier‑1: queued; reads the outline with its paths
```

Everything after prepare treats a Markdown source with `type: MindMap` the same way, whether it came from a
picture, a transcript, a `raw/docs/…/x.md` a person wrote, or a wiki page (whose own entity is its subject).

## 4. Reading

- **Web file view.** The metadata panel, then the map: `Mind map · N nodes · D levels`, *fit*, *unfold all*,
  *outline*, and *picture* when there is one. Names the graph knows are entity links in their type's colour,
  first mention each; a click opens the entity panel, whose relations list the map's edges with their paths.
- **Embed reader** (`/embed/v1`). The same map, read-only.
- **Mac app, Obsidian.** The outline as a nested list.
- **Search and context packs.** Chunks with their paths: a hit on 永贵电器 shows `华为 › 华为智驾 › 液冷超充`.

## 5. Known limits

- Dense pictures are read at the converter's `maxImageDimension` (2048 px); a 621 × 2000 map with 7 px text is at the
  edge of what a vision model reads reliably. Transcribe those (D4); a future converter could read such a picture in
  overlapping tiles and merge the outlines.
- A transcript is kept when its picture changes: it is a person's text, and only a person knows whether it still
  matches. Delete it to have the new picture converted.
- Names only: 瑞捷网络 does not find 锐捷网络, and 浪潮信息 does not find an entity named 浪潮 whose alias it is. A
  transcript declares them (`{ name: 锐捷网络, type: organization, aliases: [瑞捷网络] }`); a picture converted with
  no transcript leaves them to tier‑1.
- `edgeFor` knows the core and finance types. A workspace with its own ontology gets `part_of` / `related_to`
  where it has no rule; rules in the ontology pack would be the next step.
- No native mind-map files yet. `.xmind` (a zip with `content.json`), `.opml`, `.mm` and `.km` hold the tree
  exactly and need no model: a converter plugin (docs/design/11) that writes D1's outline is all they need.
- The Mac app shows the outline, not the map.

## 6. Where the changes go

| Piece | File |
| --- | --- |
| Outline: read, write, labels, chunks | `src/mindmap/outline.ts` |
| Graph: resolve nodes, type edges, write them | `src/mindmap/graph.ts` |
| Vision prompt branch, outline check, converter v2 | `src/ingest/converters/shared.ts`, `src/ingest/converters/image.ts` |
| Transcripts: names, cache key, provenance | `src/ingest/convert.ts`, `src/ingest/prepare.ts`, `src/ingest/sync.ts` |
| Chunks and tier‑0 for `type: MindMap` | `src/ingest/apply.ts` |
| Extractor family `mindmap`; node names count as declared | `src/store/entities.ts`, `src/graph/mentions.ts` |
| The map in the page | `web/mindmap.js`, `web/mindmap.css`, `web/markdown.js`, `web/app.js`, `web/index.html`, `web/embed/` |
| Tests | `tests/mindmap.test.ts`, `tests/web-mindmap.test.ts` |
