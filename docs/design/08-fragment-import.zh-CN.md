# 08 — 碎片化知识的导入规范：消息流 → 知识单元 → 文档

> **Record status (2026-11-17): Proposal — never accepted as written.** This is a decision record, not the description of the system. What the code does now is in [ARCHITECTURE.md](../ARCHITECTURE.md) §5.1, §10. K1 (frequency stoplist) is built under `playbooks/concepts/`; K2 is half built (no doc-date range filter on search); K3 is not built. D8 is reversed by design 26 (feeds). Still useful: the frontmatter key ownership table and the `event_at` / `observed_at` rule.

> 状态：**提案，待确认**（2026‑09‑29）。本文回答一个具体问题：飞书群、微博/星球中转、微信群转播这类
> "一段话就是一条观点"的碎片化内容，应该用什么载体、带哪些元数据、按什么单位进 knode-os。
> 结论建立在对 finance 工作区现状的体检（§1）和对开源方案的调研（§7）之上。英文版待决策确认后补。

## 0. 决策清单

| # | 决策 | 建议 | 备选 |
| --- | --- | --- | --- |
| D1 | 载体 | **JSONL 做真源，Markdown 做派生的入库形式**；JSON 单文件不用 | 只用 Markdown（丢失可重建性）；只用 JSONL（knode-os 会当纯文本切） |
| D2 | 入库单位 | 三层：碎片（一条消息）→ **知识单元**（帖子 / 会话窗口 / 截图摘要）→ **文档 = 一个频道一天**，上限 12k 字符 | 一月一文件（现状，tier1 只看到 3.7%）；一条消息一文件（文档数爆炸，chunk 无上下文） |
| D3 | 文档路径 | `raw/docs/finance/<platform>/<target>/<YYYY>/<MM>/<YYYY-MM-DD>[.pN].md` | 按群平铺；按月目录不分日 |
| D4 | frontmatter | OKF 兼容 + knode-os 键：`type` `title` **`date`** `generated` `sources` `tags`，生产者扩展 `platform` `channel` `origin` `window` `items` `span`，可选 `entities` / `claims` | 只写 OKF 最小集（丢掉时间轴与观点层） |
| D5 | 时间 | 每条碎片两枚时间戳：`event_at`（原发时间）与 `observed_at`（中转/抓取时间），带时区；文档 `date` 取 `event_at` 的日期 | 只记抓取时间（现状：`generated.at` 会劫持 doc_date） |
| D6 | 正文规范 | 每个单元一个 `##`，标题自带时间+说话人+主题；正文每行自描述；模板词用 ASCII 标签；单元下一行"语境句"（contextual retrieval） | 现状：中文模板行每帖重复，污染 tier0 概念 |
| D7 | 抽取分工 | **观点/事实抽取放生产端**，写进 frontmatter `claims`（无条数上限、不占 tier1 的 LLM 调用、可重跑）；tier1 只做按天小文档的兜底 | 全靠 tier1（每文档 ≤10 条 claim，且只看前 12k 字符） |
| D8 | 职责边界 | 生产端（rookie-trade crawler 加 `feishu` 平台）负责拉取/去重/分类/切窗/OCR/渲染；knode-os 只做通用改进（§6），不加聊天专用解析器 | 在 knode-os 里加 IM 解析（把平台细节带进内核） |

## 1. 为什么不能照搬"一月一个 markdown"

finance 工作区现有 `raw/docs/shujiu/2025-01.md … 2026-09.md`（21 个月，每个 316–723 KB、240–390 帖），是
rookie-trade `crawler/archive-markdown.mjs` 从 ndjson 渲染的，结构其实不差（每帖一个 `##` + 元数据引用块）。
问题出在入库单位与 knode-os 的机制不匹配：

| 机制 | 代码 | 对月文件的后果（实测） |
| --- | --- | --- |
| tier1 每文档一次 LLM 调用，只送前 12,000 字符，上限 15 实体 / 20 关系 / 10 claim | `src/constants.ts:10`，`src/graph/llm-extract.ts` | 每个月**恰好** 15 实体 / 10 claim，全部来自当月头两天的帖子；21 个月 ≈ 6000 帖只得到 210 条 claim（覆盖率 < 1%） |
| 文档日期：frontmatter `date/published/as_of…` → `generated.at` → 路径 | `src/ingest/docdate.ts` | 21 个文档 `doc_date` 全空（入库早于该逻辑）；再 sync 会被 `generated.at`（渲染时间 2026‑09‑15）劫持，比路径里的 `2026-08` 优先。210 条 claim 的 `event_at`/`observed_at` 全为 NULL，时间轴、相对日期折算全部失效 |
| tier0 概念：CJK 取 2–4 字子串、出现 ≥4 次即算，每文档 8 个 | `src/graph/concepts.ts:68` | 排名靠前的"实体"是 公司 84、时间 84、预期 52、类型 40、作者 24、原帖 16——来自每帖重复的模板行「类型: talk · 作者: 舒九 · 时间: …」「原帖:」；4 个概念聚类页里 2 个围绕它们生成 |
| 切块：递归切分 1200 字符 / 重叠 150，短段贪心合并，chunk 元数据只有 `{path,title}`，frontmatter 不进 chunk | `src/ingest/chunker.ts`，`src/lineage/writer.ts:372` | 一个 chunk 横跨 1–3 帖；单独看一个 chunk 不知道是谁、什么时候说的 |
| 检索没有按文档日期的过滤；`as_of` 是系统时间；MCP `knode_search` 不返回 `docDate` | `src/search/search.ts:84-96`，`src/mcp/tools.ts:82-89` | 时间切片只能靠 `sources` 路径前缀 |

7 月的评测（[docs/eval/2026-07-finance-kb.md](../eval/2026-07-finance-kb.md)）已经给出方向：≤9000 字符分卷时 hybrid doc R@10 0.64，
但碎片化的评论楼层（雪球 0.52、淘股吧 0.33）是短板，建议"按语义单元而非按大小分卷"。飞书群比雪球评论更碎：

| 群 | 内容形态 | 量级（近 50 条推算） | 中位长度 |
| --- | --- | --- | --- |
| 源深路炒家 | 微信群 "V+" 逐句转播，多人对话 | ~100 条/天 | 14 字 |
| 混沌 | 微博 混沌20000 卡片中转 | ~19 条/天 | 166 字 |
| 投星 | 投星资产【付费微博】 | ~17 条/天 | 41 字 |
| 索策略 | 卖方研报/策略转载 | ~8 条/天 | 58 字 |
| 1024 | "2030" 星球推送，单帖可达 9k 字 | ~7 条/天 | 56 字 |
| 唐史主任 | 唐史主任司马迁【免费/付费微博】 | ~3 条/天 | 260 字 |
| 浮光 | 【群主】截图，几乎全是图片 | ~2 条/天 | — |

它们都是**中转站**：真正的作者在微博/微信/星球，飞书只是投递渠道。这决定了 D5（两枚时间戳）和 D8（当作 crawler 的一个平台）。

## 2. 三层模型：碎片、知识单元、文档

```
碎片 fragment      一条消息 / 一条评论 / 一张卡片 / 一张截图        → JSONL 一行，永不单独入库
知识单元 unit       能独立被理解和引用的最小单位（帖子+评论 / 会话窗口 / 当日截图摘要）→ markdown 里一个 ## 段
文档 document       一个频道一天的所有单元，≤12k 字符，超出按单元边界分卷  → 一个 .md，一次 tier1
```

单元的切法按内容形态定，不用一条规则：

| 形态 | 单元 | 规则 |
| --- | --- | --- |
| 帖子流（唐史主任、混沌、投星、索策略、1024） | `post`：一条帖子 + 它的评论/回复 | 一条消息即一帖；回复（飞书 `thread_id` / 引用）挂到主帖下，同 Onyx 的 "thread = document" |
| 对话流（源深路炒家） | `window`：同一群内连续的若干轮 | 相邻消息间隔 ≤ 30 分钟归同一窗口；窗口 ≥ 40 轮或 ≥ 3000 字符时在最近的间隔切开；单轮不成单元 |
| 截图流（浮光） | `digest`：一天的截图 OCR + 描述 | 每图一行 OCR/描述；没有 OCR 的截图不入库 |
| 卡片（interactive） | 并入所在形态 | 卡片文本 + 原链接（微博 id）作为正文 |

按**天**成文档的理由：tier1 一次能看完一整天；`date` 与路径都能给出日期；昨天的文件不再变化（sha 不变即跳过重索引），
只有今天的文件在追加；Slack 官方导出也是"每频道每天一个 JSON"。源深路炒家一天约 100 轮 ≈ 6–10 KB，仍在 12k 内；
超出时按窗口边界分成 `.p2.md`。

## 3. JSONL 真源（fragment 记录）

沿用 rookie-trade `crawler/archive/<platform>/<target_id>/YYYY-MM.ndjson` 的 envelope，`schema_version` 升到 2，
新增 `record_type: turn|card|media` 与 `relay`/时间字段。飞书是新平台 `feishu`，`target_id` = `oc_xxx`。

```jsonc
{
  "schema_version": 2,
  "record_type": "post",                 // post | comment | turn | card | media | system
  "platform": "feishu",
  "target": { "id": "oc_5c14…", "name": "混沌", "kind": "group" },
  "month": "2026-09",
  "post_id": "om_…",                     // 稳定 id = 飞书 message_id；评论/回复各自一行，用 reply_to 指回
  "sort_key": 1790000000000,             // epoch ms，= event_at；没有原发时间时退回 observed_at
  "post": {
    "id": "om_…", "msg_type": "post",     // post | text | interactive | image | file
    "author": { "id": "weibo:混沌20000", "name": "混沌20000", "role": "origin" },   // origin | member | owner | relay
    "relay":  { "bot": "自定义机器人", "platform": "weibo", "origin_id": "5348792061920444",
                "origin_url": "https://weibo.com/…", "visibility": "free" },       // free | paid
    "event_at": "2026-09-29T20:21:00+08:00",      // 原发时间：来自正文首行「2026-09-30 10:46:51」或卡片
    "observed_at": "2026-09-29T20:21:31+08:00",   // 飞书投递时间（lark-cli create_time 换算成 +08:00）
    "text": "…", "text_markdown": "…",
    "reply_to": null, "thread_id": null, "quote": null,
    "images": [ { "key": "img_v3_…", "local": "imgs/<sha1>.jpg", "ocr_text": "…", "image_description_zh": "…" } ],
    "files": [], "links": [ "https://…" ],
    "reactions": { "THUMBSUP": 3 },
    "investment_relevant": true, "investment_reviewed_at": "…", "investment_relevance_note": "…",
    "dedupe_key": "sha1(relay.origin_id ?? normalize(text))",
    "duplicate_of": null                  // 跨渠道重复（如飞书唐史主任 vs 微博爬虫）指向保留的那条
  },
  "comments": [], "comment_count": 0,
  "post_markdown": "…"                     // 渲染好的单元正文（见 §5），入库文件由它拼接
}
```

约定：

- **一行一碎片，按 `post_id` 幂等 upsert**，月文件整体重渲染（沿用 `lib/month-merger.mjs` 的 touch(month) 语义）；不手改。
- 时间戳一律 ISO 8601 带显式偏移（OKF 的要求；纯日期在不同时区指向不同瞬间）。
- `event_at` 与 `observed_at` 分开，直接对应 knode-os claim 的 `event_at` / `observed_at`；Zep/Graphiti 也把
  `reference_time` 定义为"事件发生的时间，不是入库时间"。
- 图片先落盘再 OCR/描述（沿用 `analyze-images.mjs` 的 sidecar `imgs/<local>.analysis.json`），没有描述的图只保留占位。
- `investment_relevant` 对帖子流按帖判，对对话流按**窗口**判（单轮无法判断）。

为什么不是 JSON 单文件：不可追加、不可行级 diff、一条变动整文件重写；为什么不只用 JSONL：knode-os 会把 `.jsonl`
当纯文本按 `\n\n`/`\n` 切，frontmatter 契约、wiki、agent 的 `knode_read` 都以 markdown 为准。

## 4. 文档 frontmatter

```yaml
---
type: "ChatArchive"                    # OKF 唯一强制键；帖子流沿用 "Archive"，对话流用 "ChatArchive"
title: "混沌 · 2026-09-29 · feishu"    # 频道 + 日期 + 平台，全库唯一（source-summary 页按标题去重）
date: "2026-09-29"                     # knode-os doc_date，必填；不要指望 generated.at 或路径
platform: "feishu"
channel: { id: "oc_5c14…", name: "混沌", kind: "group" }
origin:  { platform: "weibo", account: "混沌20000", relay: "自定义机器人" }   # 中转来源；多来源写列表
window:  { unit: "post" }              # 对话流: { unit: "window", gap_minutes: 30, max_turns: 40 }
items: 19                              # 碎片数
units: 19                              # 单元数
span: [ "2026-09-29T08:12:00+08:00", "2026-09-29T20:21:00+08:00" ]
timezone: "Asia/Shanghai"
generated: { by: "rookie-trade/feishu-archive@0.1", at: "2026-09-30T02:00:00+08:00" }
sources:
  - { id: "ndjson", resource: "crawler/archive/feishu/oc_5c14…/2026-09.ndjson", title: "envelope" }
tags: [ "platform/feishu", "channel/混沌", "origin/weibo/混沌20000" ]
entities:                              # 可选：说话人与别名，一次声明，正文只用规范名
  - { name: "混沌20000", type: "person", aliases: [ "混沌" ] }
claims:                                # 可选：生产端抽取的观点/事实，无条数上限
  - { subject: "万科", type: "opinion", status: "suspected", eventDate: "2026-09-29",
      statement: "混沌20000 认为地产政策是重大利好，万科昨日由跌停爬起涨停" }
  - { subject: "股票ETF", type: "flow", status: "fact", eventDate: "2026-09-29",
      statement: "连续三天股票 ETF 净流入 5.44 亿、247.71 亿、43.98 亿元，合计 297.13 亿元" }
---
```

键的归属（对照 [frontmatter-contract](../frontmatter-contract.zh-CN.md)）：

| 键 | 谁读 | 说明 |
| --- | --- | --- |
| `type` `title` `generated` `sources` `tags` | OKF 校验；`title`/`generated` 也被 knode-os 读 | 保持 OKF v0.2 合法，外部工具能读 |
| `date` | knode-os → `documents.doc_date` → claim 的 `observed_at`、相对日期折算 | **必填**。`month:`、`first_post_at` 都不是它认的键 |
| `entities` `relations` `claims` | knode-os tier0 声明式抽取（`src/graph/frontmatter.ts`） | 不走 LLM、无上限；`claims.eventDate` 进 `event_at`，`startDate/endDate` 进有效期 |
| `trust` `actor` `acl` | knode-os 信任/权限 | 中转内容默认 trusted；若由 agent 生成的摘要页则写 `actor` |
| `platform` `channel` `origin` `window` `items` `units` `span` `timezone` | 生产者扩展，knode-os 原样保留 | 给人和 agent 看；`knode_survey` 以后可以按它们统计 |

## 5. 正文规范

目标：**每个 chunk 单独拿出来也知道是谁、何时、在哪、说了什么**（chunk 不带 frontmatter，1200 字符会跨单元合并）。

```markdown
# 混沌 · 2026-09-29 · feishu

> 由 crawler/archive/feishu/oc_5c14…/2026-09.ndjson 渲染，19 条 / 19 单元，重新生成会覆盖。

## 20:21 · 混沌20000 · 韩国股市高开回落
_混沌20000 在微博（飞书「混沌」群中转）评论 9 月 29 日的盘面情绪。_
> id: om_… · origin: weibo/5348792061920444 · 👍 12 · 💬 3

韩国股市高开回落，影响我们情绪，又有点祖训的样子。但都最后一天了，抛压应该不大。

## 19:41 · 混沌20000 · 地产重大利好，万科涨停
…
> img: imgs/3f9a….jpg
> ocr: 万科A 000002 … 涨停 …
> desc: 手机截图，同花顺个股页面，万科A 涨停封板。
```

对话流：

```markdown
## 10:30–10:47 · V+ · TRS 杠杆与海外恐慌（17 轮）
_微信群「V+」9 月 30 日上午关于 TRS、海外杠杆和恐慌情绪的讨论，经飞书「源深路炒家」中转。_
> id: om_a…–om_q… · relevant: true

- 10:46:35 V+：trs主要是海外
- 10:46:40 V+：都是中国人
- 10:46:44 V+：这个恐慌情绪就蔓延了
- 10:46:51 V+：我知道的好几个都是4倍杠杆
```

规则：

1. 单元标题 `## <时间> · <说话人> · <主题>`：帖子流主题取首句（≤30 字），对话流由分类步骤给出话题标签。
2. 标题下一行斜体**语境句**（50–100 token）：谁、在哪个渠道、就什么发言。这是 Anthropic contextual retrieval 的做法
   （chunk 前置语境后 top‑20 召回失败率 −35%，加 BM25 −49%）；生产端一天一次 LLM 批量生成，可以关掉。
3. 元数据引用行只用 ASCII 标签（`id:` `origin:` `img:` `ocr:` `desc:` `relevant:`），**不再重复中文模板词**
   （现状的「类型/作者/时间/原帖/图片描述」每帖重复，正是 tier0 的噪音来源）。
4. 说话人用 frontmatter `entities` 里的规范名，正文不用「【群主】」「V+:」这类原始前缀（可保留在 JSONL）。
5. 对话流每轮一行 `- HH:MM:SS 说话人：内容`，不空行；帖子正文保留原换行。
6. 图片：`> img:` 行 + `> ocr:` + `> desc:`；没有 OCR/描述的图只留 `> img:`。
7. 单元之间不用 `---`；`## ` 已经是切分器的第一优先分隔符。
8. 渲染必须确定性：输入不变输出字节相同，knode-os 按 sha 跳过；今天的文件允许被重写。
9. 单文件 ≤ 12,000 字符（tier1 截断上限）；超出在单元边界分卷 `YYYY-MM-DD.p2.md`，`date` 相同、`title` 加 `· p2`。

路径：`raw/docs/finance/<platform>/<target_slug>/<YYYY>/<MM>/<YYYY-MM-DD>[.pN].md`。目录分到月是为了
`sources=raw/docs/finance/feishu/hundun/2026/09` 这样的前缀过滤（它只做目录级匹配）；文件名保留完整日期是给人看和路径回退。
渲染只有一个入口：rookie-trade 的 `crawler/archive-markdown.mjs`（knode-os 侧的 `import archive` 已决定移除，不再保留第二个渲染器）。
它此前输出的 `YYYY-MM.md` 月文件（finance 工作区里 shujiu 的 21 个月）和 `~/knode-finance` 里旧的 `YYYY-MM-pNN.md` 分卷，
都从 ndjson 按这个布局重新渲染，整个 finance 工作区一套规范。

## 6. 流水线与分工

```
lark-cli im +chat-messages-list --page-all --download-resources      拉取（按上次 sort_key 增量）
   → normalize   剥首行时间戳→event_at；解析说话人前缀→author/visibility；卡片→文本+origin；图片落盘
   → dedupe      按 relay.origin_id / 文本 hash 跨渠道去重（飞书唐史主任 vs 微博爬虫）
   → classify    investment_relevant（帖子按帖，对话按窗口）；可选：话题标签、涉及标的
   → segment     帖子 = 单元；对话按 30 分钟间隔切窗口；截图按天聚合
   → enrich      可选，一天一批 LLM：语境句、窗口主题、frontmatter claims/entities
   → render      按频道按天渲染 markdown（§4 §5），确定性输出
   → knode-os    watcher 触发 sync；tier1 只处理当天小文档；claims 直接来自 frontmatter
```

生产端落在 rookie-trade crawler，因为拉取/去重/OCR/分类的基础设施都在那边，`content_persons` 还能把飞书里的唐史主任和
微博的唐史主任并成一个人。生产端两处改动：

| # | 改动 | 为什么 |
| --- | --- | --- |
| R1 | `archive-markdown.mjs` 改按频道按天分卷、写 `date:`、目录到月（§5 路径） | 现在的月文件既超过 12k 又不写 `date`；`knode-os import archive` 已移除，这里是唯一的渲染器 |
| R2 | 新增 `feishu` 平台：lark-cli 拉取 → 裸记录 → month-merger envelope → 切窗/语境句/claims（§3 §5） | 复用去重、`investment_relevant`、图片 OCR/描述、按人归并 |

knode-os 不加任何 IM 专用解析，只做三处通用改进：

| # | 改动 | 为什么 |
| --- | --- | --- |
| K1 | tier0 概念加语料频率过滤 + 工作区停用词（`playbooks/ontology/*.yaml` 里可声明） | 出现在多数文档里的词不是概念；「公司/时间/预期」这类金融通用词靠停用词 |
| K2 | `knode_search` 返回 `docDate`；`search()` 增加 `doc_date` 区间过滤 | 这类语料本质是时间序列，"9 月混沌怎么看地产"要能按日期切 |
| K3 | chunk 元数据记最近的 `##` 标题与其时间；检索命中时可回整段 | LlamaIndex "small‑to‑big"：小块召回、整段返回；也给 claim grounding 提供锚点 |

R1、K1、K2 各半天量级；K3 稍大，可后置。

## 7. 开源方案怎么做的，我们借什么

| 方案 | 怎么处理碎片 | 借鉴到本规范 |
| --- | --- | --- |
| [Zep / Graphiti](https://arxiv.org/html/2501.13956v1)（[docs](https://help.getzep.com/graphiti/core-concepts/adding-episodes)） | 入库单位是 episode：message 类型写成 `{speaker}: {text}` 多轮；`reference_time` = 事件时间；抽实体时带前 4 条消息做语境；实体去重 = 向量 + BM25 + LLM；边有 `t_valid/t_invalid`（事件轴）+ `t_created/t_expired`（事务轴）；社区用标签传播 + map‑reduce 摘要；检索 cosine+BM25+BFS，RRF/MMR/节点距离重排；云端单 episode 限 10k 字符 | D2 的会话窗口 = episode；D5 两枚时间戳；单元要小（≤ 一屏）才抽得准 |
| [Mem0](https://docs.mem0.ai/core-concepts/memory-operations) | 从消息对抽"事实"，带会话摘要 + 最近 m 条做语境；对每条候选检索 top‑s 相似记忆，LLM 决定 ADD/UPDATE/DELETE/NOOP；`infer=False` 存原文 | 事实层与原文层分开——本规范里 JSONL 是原文层，frontmatter `claims` 是事实层，合并/取代交给 knode-os 的 fold 与 supersession |
| [Microsoft GraphRAG](https://www.mintlify.com/microsoft/graphrag/concepts/overview) | text unit 默认 1200 token；600 token 的块抽出的实体数是 2400 token 的 2 倍；社区摘要回答全局问题 | 抽取单元宁小勿大；按月/按频道的 digest 页（knode-os 的 hot_topics / concept_cluster）回答"这个月大家在聊什么" |
| [LightRAG](https://github.com/HKUDS/LightRAG) | 逐 chunk 抽实体关系，图做并集、描述合并摘要；边上记 source id，删文档可重建 | 与 knode-os scope/evidence 同构，不需要改 |
| [RAPTOR](https://iclr.cc/virtual/2024/poster/19034) | ~100 token 小块 → 聚类 → 递归摘要成树，检索时各层都能命中 | 碎片的"父节点"就是窗口/天/月三级摘要；日文件的语境句和月 digest 页承担这一层 |
| [A‑MEM](https://proceedings.neurips.cc/paper_files/paper/2025/hash/19909c36f51abc4856b4560aff3d36d6-Abstract-Conference.html) | 每条记忆是 Zettelkasten 卡片：内容、时间、关键词、标签、语境描述、链接；新卡片触发邻居更新 | 单元 = 卡片：标题 + 语境句 + tags；"演化"由 fold 完成 |
| [Anthropic Contextual Retrieval](https://anthropic.com/news/contextual-retrieval) | 每个 chunk 前置 50–100 token 由 LLM 写的语境，再做 embedding 与 BM25；失败率 −35% / −49% | §5 规则 2 的语境句，是对碎片最便宜也最有效的一招 |
| [LlamaIndex sentence‑window / auto‑merging](https://developers.llamaindex.ai/python/examples/retrievers/auto_merging_retriever/) | 小单位做 embedding，命中后返回父节点整段 | K3 |
| [Onyx (Danswer) Slack connector](https://github.com/onyx-dot-app/onyx/blob/main/backend/onyx/connectors/slack/connector.py) | document = 一个 thread（根帖 + 回复），无 thread 的消息单独成文；id = `channel__thread_ts`；标题 = "发送者 in #频道: 摘要"；时间放元数据不进正文；bot 消息默认过滤 | D2 的 post 单元；标题格式。区别：中转群里 bot 就是内容，不能过滤 |
| Slack / Telegram 导出格式（[Slack](https://slack.com/help/articles/220556107)、[Telegram](https://core.telegram.org/import-export)） | Slack：每频道每天一个 JSON；Telegram：单个 `result.json`，`messages[]{id,type,date,from,text,reply_to_message_id,photo}` | D2 按天成文有官方先例；JSONL 字段命名对齐 Telegram 的 `reply_to`/`from` |
| [Karpathy LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)（2026‑04）与 [v2](https://gist.github.com/rohitg00/2067ab416f7bbe447c1977edaaa681e2) | raw 不可变 / wiki 由 LLM 维护 / schema 文件定规矩；ingest 一次触及 10–15 页；lint 查矛盾、过期、孤页；评论区的实践是先用 Telegram bot 把消息分类进表，再由 wiki 维护者合成；v2 加置信度、取代链、类型化关系、"工作记忆→情景→语义"分层 | knode-os 本身就是这个模式；要补的是 **capture 层**（本规范的 JSONL + 渲染）与 wiki 合成分离 |
| [chatlog‑ai](https://github.com/nsdmgt/chatlog-ai)、[WechatRagAgent](https://github.com/WechatRagAgent/agent) | 微信记录 `时间 发送者: 内容`；按时间间隔切"话题窗口"而非定长，准确率 71% → 86%；另一家按 50 条一批 + bge reranker | D2 对话流按间隔切窗口 |
| 对话主题分割研究（[CobSeg 2026](https://arxiv.org/pdf/2605.30668) 等） | 学习式的话题边界预测，不调 LLM | 30 分钟间隔是 v1；窗口质量不够时升级到主题分割 |
| [OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md) | 只强制 `type`；`sources` / `generated` / `verified` / `status` / `stale_after` 表达出处与可信度；`index.md` / `log.md` 保留 | §4 的 frontmatter 保持合法 |
| [schema.org SocialMediaPosting](https://schema.org/SocialMediaPosting) / ActivityStreams `Note` | `sharedContent`（转发的原内容）、`datePublished`、`author`、`about` / `mentions`、`isPartOf`、`inReplyTo`、`attachment` | 只借词汇：`relay` ≈ `sharedContent`，`reply_to` ≈ `inReplyTo` |

共识很清楚：**原文层与知识层分开；抽取单元要小并自带时间与说话人；事实带事件时间与有效期；碎片靠语境句和上层摘要
才检索得到；群聊按话题/时间间隔切窗口，不按定长。** 没有一家把"一个月的消息拼成一个文档"当入库单位。

## 8. 待确认

1. 工作区：进 finance（与 shujiu 同库，跨源实体能并）还是另开一个？建议同库。
2. 源深路炒家（微信群逐句转播，中位 14 字）值不值得进：建议先只进 `relevant: true` 的窗口，观察一个月。
3. 生产端 LLM 步骤（语境句、窗口主题、frontmatter claims）用哪个连接、是否默认开启：建议开，成本约每群每天 1–2 次调用。
4. 图片：全部 OCR + 描述（浮光、投星、索策略截图多），还是只 OCR？建议沿用 `analyze-images.mjs` 两者都做。
5. 历史回填范围：各群从建群（2026‑06 起）全量，还是只回填最近 N 月？
6. 存量 shujiu：按 R1 用 `archive-markdown.mjs` 从 ndjson 重渲染成按天布局并删除旧月文件（会触发 21 → ~600 个文档的重索引与 tier1）。

确认后：先做 R1 与 K1–K2，再写 `feishu` 平台适配（R2），用混沌、唐史主任两个群跑通，再上其余。
