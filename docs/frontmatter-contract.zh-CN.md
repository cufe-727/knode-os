# 上传文档的 frontmatter 契约

摄入一份 Markdown 时，knode-os 读两件事：**文件落在哪**，以及 **frontmatter 里有哪些键**。
好消息是第二件事有兜底——索引时会替你补最低限度的合规字段；坏消息是第一件事没有兜底，
落点选错了，补出来的字段也只是躺在那里。

## 1. 索引时自动补什么

索引时，[src/okf/normalize.ts](../src/okf/normalize.ts) 会在内存里给每份 Markdown 补上
OKF 要求的字段：文本源不落盘副本，只有 PDF/图片的转换结果带着这些字段写进
`.sidecar/<key>/content.md`。**你什么都不用做**，上传就有：

| 情况 | 动作 |
| --- | --- |
| 没有 `type` | 补 `type: "Document"` —— OKF 唯一的硬性要求 |
| 没有 `title` | 补 `title`，取自 frontmatter → 首个 H1 → 文件名 |
| 有 `generator` + `generated_at` | 翻译成标准的 `generated: { by, at }`，**原键保留** |
| 是 knode-os 转换出来的（PDF / 图片） | 写 `generated: { by: "knode-os/<model>", at }` |
| 已经有 `type` | 一个字节都不动 |

三条边界：

- **只加不改。** 已有的键不会被重写、重排或删除，生产者自己的字段原样 round-trip。
- **不编造溯源。** 没人声明过作者的文档就不写 `generated`——翻译私有拼写可以，凭空署名不行。
- **不碰 reserved 文件和非 Markdown。** `index.md` / `log.md` 按规范不能带 frontmatter；
  往 `.csv` / `.txt` 里塞 YAML 头会直接破坏内容。

`raw/` 仍然按字节保存原件；补齐的字段只存在于 knode-os 索引的视图里，磁盘上唯一带着
它们的文件是 PDF/图片转换出的 `content.md`——那本来就是 knode-os 写的。

幂等性是设计约束：文本源的归一化不带任何时间（否则 `touch` 一下就会换哈希、触发重新索引）；
转换产物的 `generated.at` 取 raw 文件的 mtime 而不是 `now`，重复 prepare 同样的字节产出完全相同。

## 2. 路径仍然决定语义层级

自动补 `type` 不等于 `type` 会生效。"文档自身成为图谱里的一个实体"只发生在 **bundle 内的
页面**上，判定在 [`bundleContext()`](../src/graph/wire.ts) 里，只认两种前缀：

```
wiki/<...>
raw/docs/okf/<bundle>/<...>
```

| 落点 | 怎么进去 | `type` `aliases` bundle 内链 | `title` | `entities` `relations` `claims` | `trust` `actor` `acl` |
| --- | --- | :-: | :-: | :-: | :-: |
| `raw/docs/<任意目录>/` | 拖拽上传、`POST /api/upload` | ✗ | ✓ | ✓ | ✓ |
| `raw/docs/okf/<bundle>/` | `knode-os okf import` | ✓ | ✓ | ✓¹ | ✓ |
| `wiki/` | 原生页、`knode_write` | ✓ | ✓ | ✓¹ | ✓ |

¹ bundle 页的缺省主语是页面自身实体：`claims` 不写 `subject`、`relations` 不写 `source` 时，
都落到这一页的实体上。`wiki/` 里写了 `selfEntity: false` 的页面没有自身实体，这三个键都会被忽略。

同一份 frontmatter（`type` + `title` + `aliases`）过 `planWireFromMarkdown` 的实测：

```
raw/docs/shujiu/2025-05.md                       bundle=null       self=null
raw/docs/okf/zsxq/15281584515252/2025-05.md      bundle=okf/zsxq   self=Archive / <title> / aliases=[…]
wiki/entities/x.md                               bundle=wiki       self=Archive / <title> / aliases=[…]
```

所以自动补字段买到的是：文档成为**合法的 OKF 概念**——可校验、可导出、外部工具能读懂，
`isGeneratedConcept()` / `readGeneratedAt()` 能认出它的出处。买不到的是图谱身份：想要
`type` 变成实体类型、`[[wikilink]]` 解析成 `links_to` 边，仍然得走 `okf import`。

## 3. 键清单

### OKF 交换层（外部工具也认）

| 键 | 地位 | 说明 |
| --- | --- | --- |
| `type` | **唯一强制** | 缺了索引时会补 `Document`；自己写更准确 |
| `title` | 推荐 | 缺了索引时会补 |
| `description` / `resource` | 推荐 | 没有兜底，要就自己写 |
| `tags` | 推荐 | 必须是 YAML list（摄入侧暂不消费，只做校验） |
| `generated: { by, at }` | 可选 | `by` 是 actor：`<producer>/<version>`、`human:<id>`、`process:<id>` |
| `sources` | 可选 | 材料出处，每条至少 `{ id, resource, title }` |
| `verified` / `status` / `stale_after` | 可选 | 信任分档与生命周期 |

时间戳一律用带显式 UTC 偏移的 ISO 8601（`2026-09-13T04:05:24Z`）。纯日期 `2026-09-13`
在每个时区指向不同瞬间，规范要求消费者忽略它。

### knode-os 扩展（OKF 不认，但摄入会读）

| 键 | 在哪生效 | 作用 |
| --- | --- | --- |
| `entities` / `claims` | `raw/docs/**` 与 bundle 页 | tier-0 声明式抽取——不配 LLM 也能建图，是这批键里最值钱的。claims 可带 `eventDate`（事件时间）与 `startDate/endDate`（有效期），日期支持 `2026Q2`、`2026年上半年`、`去年`（按文档日期折算）等写法；bundle 页里 `subject` 缺省为页面自身实体 |
| `relations` | `raw/docs/**` 与 bundle 页 | 类型化关系：列表 `- { source?, target, type, from?, to? }` 或映射 `supplies_to: ["[[特斯拉]]"]`；谓词按 `playbooks/ontology/*.yaml` 归一（同义词、反向拼写自动翻转、未知降级为 `related_to` 并计数）；bundle 页缺省 source 为页面自身实体 |
| `date` / `published` / `as_of` | 全部 | 文档参考日期（`documents.doc_date`）；缺省从路径里的日期推断，永不用 mtime |
| `sameAs`（entities 内） | 全部 | 声明该实体与已知实体相同，写入时直接落到规范实体 |
| `actor: agent/<cli>` + `research: {…}` | `wiki/**` | 研究 agent 写的页面：显式 `actor` 使其成为 **Source**（即使带 `generated`），以 quarantined 入库；`research` 记录 job / 模版 / 时间，runner 会盖章 |
| `sameAs` / `notSameAs` | `wiki/reviews/**`（verify 任务） | 核实页的身份结论：`sameAs` 里的已知实体变成待审的 `merge` 建议，`notSameAs` 记为已拒绝的合并对，夜间审计不再提出 |
| `selfEntity: false` | bundle 页 | 这一页讲的不是某个实体（总览 / 枢纽页），不要为它生成"页面自身实体" |
| `trust` / `actor` | 全部 | 信任分档 |
| `acl` | 全部 | 访问控制 |
| `aliases` | 仅 bundle 内 | 实体别名 |
| `[[wikilink]]` | 仅 bundle 内解析成 `links_to` | 其余位置退化为 `mentions` |

## 4. 值得自己写的最小模板

自动补的是兜底，不是最优解——`type: "Document"` 对所有文档一视同仁，`sources` 和
`description` 更是无从推断。生产端能写就写：

```yaml
---
type: "Archive"
title: "zsxq · 唯有业绩永恒 · 2025-05"
generated: { by: "my-exporter/1.0", at: "2026-09-13T04:05:24Z" }
sources:
  - id: "origin"
    resource: "crawler/archive/zsxq/15281584515252/2025-05.ndjson"
    title: "原始 envelope"
tags:
  - "platform/zsxq"
---
```

生产者自有的任意字段都可以留着——规范明确要求消费者保留不认识的字段，不能因此拒绝文档。

## 5. 一个坑

**`INDEX.md` 不是 `index.md`。** OKF 的 reserved 文件名是小写；大写的 `INDEX.md` 会被当成
普通 Concept，必须带 `type`（索引时会替它补）。反过来，真用了小写 `index.md`，则只有 bundle
根那一个可以带 frontmatter（用来声明 `okf_version`），子目录的 `index.md` 带 frontmatter 是
error——归一化会跳过这两个文件名，不会好心办坏事。

## 6. 自检

```bash
knode-os okf validate --as-indexed <data>/raw/docs/<子树>   # 验证 knode-os 实际索引的视图（自动补字段之后）
knode-os okf validate <目录>                                  # 验证磁盘上的原样字节
```

`errors=0` 就可以 `okf import`。`broken_link`、`version_undeclared` 这类 warning 不拦截导入，
附件没跟着走时出现一堆 `broken_link` 是正常的。

机器接口同源：`GET /api/okf/validate?path=…&asIndexed=1`、MCP `knode_okf_validate({ path, as_indexed })`。

## 7. 归一化规则变了怎么办

每份文档的 `meta.json` 记录了索引时用的归一化版本（`normalizer`）。规则一变，把
[src/okf/normalize.ts](../src/okf/normalize.ts) 里的 `NORMALIZER_VERSION` 加一，下一次
`knode-os ingest` 会重新 prepare 所有文本源；PDF/图片只对已有的 `content.md` 重新归一化，
不会重新转换。代价比想象中小：

- **embedding 不花钱**——分块切的是 `parsed.body`，frontmatter 被剥离，chunk 内容不变，
  `chunkIdFor()` 算出同样的 id，全部命中已有向量。
- **tier-1 抽取会失效**——它按索引文本的 contentSha 门控，sha 变了缓存就作废，
  下次 `knode-os extract` 会重跑这些文档的 LLM 抽取。`--no-llm` 只是不立刻排队。

## 参考

- [OKF v0.2 兼容设计](design/02-okf-compatibility.md) —— 规范本身与 knode-os 的映射
