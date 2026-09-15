# Google Open Knowledge Format（OKF）v0.2 兼容设计

> 调研基线：2026-09-11。实现目标版本：OKF `0.2`。
> 上一版本基线 2026-07-18 对齐的是 v0.1，本文记录升级后的实现。

## 1. OKF 是什么

Google Cloud Data Cloud 团队在 2026 年 6 月发布 Open Knowledge Format，
把已经广泛出现的“LLM wiki”模式收敛成一个供应商中立的交换规范。它不是
知识库服务、向量库、RAG 框架、模型或运行时，而是一个很薄的文件格式：

- 一个 **Knowledge Bundle** 就是一个可独立分发的目录；
- 每个普通 Markdown 文件表示一个 **Concept**；
- YAML frontmatter 放可查询的结构化元数据，正文放自由 Markdown；
- 文件路径去掉 `.md` 后就是 **Concept ID**；
- 普通 Markdown 链接把目录树补成有向知识图；
- bundle 可放进 Git、压缩包、对象存储或更大仓库的子目录。

这个边界很重要：OKF 解决“知识如何可移植地表示”，knode-os 继续负责摄入、
分块、embedding、检索、图谱计算、LLM 提炼和 MCP 服务。OKF 与 MCP 也是互补
关系：前者是静态知识交换格式，后者可作为发现和读取这些知识的运行时协议。

**规范已经独立建仓**。2026-08-11 起，SPEC、参考实现和样例 bundle 的权威位置
是 `GoogleCloudPlatform/open-knowledge-format`；原先的
`knowledge-catalog/okf/` 目录已被上游标记为冻结快照，不应再作为对齐依据。

## 2. v0.2 数据模型

v0.1 只回答“这是什么”。v0.2 把“它从哪来、该信多少、还新鲜吗、算得对吗”
也放进 frontmatter，且全部可选：缺失即退化成一个合法的 v0.1 概念。

### 2.1 Concept 文档

```markdown
---
type: API Endpoint
title: Create order
description: Creates a completed customer order.
resource: https://api.example.com/openapi#create-order
tags: [orders, write-api]
sources:
  - id: openapi
    resource: https://api.example.com/openapi
    title: OpenAPI source
    last_modified: 2026-08-30T00:00:00Z
generated: { by: reference_agent/gemini-2.5-pro, at: 2026-08-31T22:53:05Z }
verified: { by: human:ahormati, at: 2026-09-01T09:00:00Z }
status: stable
stale_after: 2026-12-01T00:00:00Z
producer_extension: preserved
---

# Examples

See the [Order model](/models/order.md).
```

规范仍然只强制 `type` 是非空字符串。推荐字段依优先级为 `title`、
`description`、`resource`、`tags`。生产者可以增加任意字段；消费者 round-trip
时应保留不认识的字段，不能因为未知 `type` 或扩展字段拒绝文档。

正文没有强制章节。`# Schema`、`# Examples`、`# Computation` 是有约定语义的
推荐标题。v0.1 的 `# Citations` 正文列表已被 frontmatter `sources` 取代。

### 2.2 溯源、信任与生命周期（§5）

| 字段 | 语义 |
| --- | --- |
| `sources` | 概念派生自哪些材料，每条可带 `author`、`usage_count`、`last_modified` 等可信度信号；`usage_window` 是它的兄弟字段 |
| `generated: { by, at }` | 当前内容**由谁产生**、何时产生。`by` 必填 |
| `verified: [{ by, at }]` | 谁**确认过**内容与来源一致。单条可省略列表短横线，消费者必须按单元素列表处理 |
| `status` | `draft` / `stable` / `deprecated`，缺省为 `stable` |
| `stale_after` | 绝对时刻；`now >= stale_after` 即过期。用绝对时刻而不是相对 TTL，判断才是一次纯比较 |

`generated` 与 `verified` 刻意分开：写的人不必是确认的人。消费者据此推导
三档信任（§5.3）：无 `verified` 为 unverified；只有非 `human:` 确认者为
machine-confirmed；有 `human:<id>` 为 human-reviewed。

**Actor 约定（§7）**：`<producer>/<version>`（工具与 agent）、`human:<id>`、
`process:<id>`。信任分档就靠 `human:` 前缀，人工内容必须用它。

**时间戳（§5 前言，2026-08-21 收紧）**：每个时间戳值都是带显式 UTC 偏移的
ISO 8601 datetime，例如 `2026-06-30T14:00:00Z`。纯日期是不合规的——
`2026-12-31` 在每个时区指向不同瞬间，同一个 bundle 会在一地过期、在另一地
新鲜。§9 的日志日期标题不受此限，它分组而不是字段值。

### 2.3 Attested Computation（§10）

新概念类型 `Attested Computation`：把一个指标/口径的**计算本身**变成一等
概念，用 `runtime`、`parameters`、`computation`、`executor`、`attester`
描述，正文用约定标题 `# Computation`。运行时协议（receipt / verdict 线格式、
attester ABI、沙箱、缓存）明确留给后续版本。

knode-os 当前不生产这类概念，也不执行它们；导入时按普通概念保留全部字段。

### 2.4 Reserved 文件

- `index.md`：可出现在任意目录，用分组标题和链接列表做渐进式披露。通常无
  frontmatter；只有 bundle 根 `index.md` 可以用 frontmatter 声明
  `okf_version: "0.2"`。
- `log.md`：可出现在任意目录，按 `## YYYY-MM-DD` 分组、日期倒序记录更新。

这两个文件不是 Concept，不能当作普通概念文档使用。

### 2.5 链接、图与引用

OKF 支持两类内部链接：以 `/` 开头的 bundle-root-relative 链接，以及相对当前
文件的普通相对链接。前者在同一子目录内移动文件时更稳定，是规范推荐形式。

链接只声明“存在从 A 到 B 的关系”，边的业务类型由周围文字表达，不另设关系
schema。因此通用消费者通常把它建模成无类型有向边。断链是允许的：它可能只是
尚未补齐的知识，消费者必须 best-effort 继续工作。

外部材料支持正文主张时，应写进 frontmatter 的 `sources`，或者把外部材料镜像
为 `references/` 下的一等 Concept。

### 2.6 合规与版本

v0.2 的硬性合规条件与 v0.1 完全相同，仍然只有三条：

1. 所有非 reserved `.md` 文件都有可解析的 YAML frontmatter；
2. 每个 frontmatter 都有非空 `type`；
3. 存在的 `index.md`、`log.md` 符合各自结构。

新增的溯源/信任/计算族**都不能让 bundle 不合规**：缺失可选字段、未知类型、
未知扩展字段、断链、缺少 `index.md` 都不是拒绝的理由。版本采用
`<major>.<minor>`：minor 保持向后兼容，major 才允许破坏性变化；不理解声明
版本的消费者仍应尝试 best-effort 读取。

## 3. 从 v0.1 升级：两处破坏性变更

v0.2 整体是 minor 升级，但有两处按 §13.1 明确列出的字段级破坏性变更：

| v0.1 | v0.2 | knode-os 的处理 |
| --- | --- | --- |
| frontmatter `timestamp` | `generated: { by, at }` | 生成页改写 `generated`；读取时 `generated.at` 优先，回退 legacy `timestamp` |
| 正文 `# Citations` 列表 | frontmatter `sources` | 导入的 v0.1 bundle 保留原正文；原生页暂不生产 `sources` |

knode-os 还有一处自身的冲突需要处理：它一直用布尔 `generated: true` 标记
“这页是机器生成的视图”，而 v0.2 把 `generated` 收编为 `{ by, at }` 映射。
现在原生页写映射形式，`by` 是真实的 actor（LLM 页用模型标签，模板页用生成器
名），`at` 取内容实际产生的时刻——命中缓存时用缓存记录的时刻，而不是本次
重新渲染的时刻，这正是 §5.2 说的“最后一次实质变化”。读取侧统一走
`isGeneratedConcept()`，布尔形式作为历史数据继续被识别。

## 4. knode-os 的映射

```text
外部 OKF bundle
      │  okf import（先校验，Markdown 字节不改写）
      ▼
raw/docs/okf/<bundle>/          L0 原件 = 文档键
      │  prepare / apply（索引时在内存中补齐 OKF frontmatter；派生状态落 .sidecar/raw/docs/okf/<bundle>/…）
      ▼
索引视图                         okf validate --as-indexed 校验的就是它
      │  ingest
      ├── chunks / embeddings / FTS
      └── Concept 节点 + links_to 有向边

wiki/                            knode-os 原生 OKF v0.2 bundle
      └── okf export → 可移植目录
```

实现选择如下：

| OKF 能力 | knode-os 支持 |
| --- | --- |
| 原生生产 | `init`、wiki generator、dream、tier-2 页面均产生合规 Concept，带 `generated: { by, at }`；根索引声明 `0.2` |
| 索引视图归一化 | 每份 Markdown 在索引时于内存中补齐 `type` 与 `title`，并把 `generator` + `generated_at` 这类私有拼写翻译成 `generated: { by, at }`。只加不改、不编造溯源、跳过 reserved 与非 Markdown；文本源不传 mtime（否则 `touch` 就会改哈希），PDF/图片的转换结果落盘时才以 raw 的 mtime 记 `generated.at` 以保证幂等 |
| 校验 | CLI、REST、MCP 共用同一校验器；错误与 soft warning 分开，信任族问题一律是 warning |
| 版本路由 | 按 `<major>.<minor>` 分流：`legacy-minor` 走 v0.1 回退，`newer-minor` 保留并忽略未知字段，`unknown-major` 仅告警后 best-effort |
| 宽容消费 | 未知类型/字段被保留；断链、未知版本只警告；`--allow-invalid` 可显式 best-effort 导入 |
| 导入 | 保持目录、Markdown 字节和非隐藏附件，复制到 `raw/docs/okf/<name>`；隐藏 provenance 文件不进入摄入，并初始化为 Obsidian Vault |
| 导出 | 先校验 `wiki/`，合规后复制 Markdown 与附件并初始化为 Obsidian Vault；不会悄悄导出坏 bundle |
| 旧库迁移 | 补根版本并升到 `0.2`、补 Concept `type`、把 `generated: true` + `timestamp` 折叠成 `generated: { by, at }`、移除子索引 frontmatter、转换旧日志；异常 YAML 留给人工处理 |
| 图谱 | 标准 Markdown 内链解析成 `links_to`；bundle 绝对链接按各自 bundle 根解析 |
| knode 扩展 | 继续支持 `[[wikilink]]`、`aliases`、`heat` 等；它们不影响 OKF 合规 |

迁移的取舍：只有本来就写了 `generated: true` 的页才会被折叠成
`generated` 映射，actor 记为 `knode-os/migrated`（原始生产者已不可恢复）。
只有 `timestamp` 而没有生成标记的人写页保持原样——我们不替人编造溯源。
无法解析的 `timestamp` 同样原样保留，不会被悄悄丢弃。

## 5. 使用方式

```bash
# 新数据目录的 wiki/ 已经原生合规
knode-os init --data ~/knode-data
knode-os okf validate --data ~/knode-data

# 老数据目录先预览、再迁移（v0.1 → v0.2 也走这里）
knode-os okf migrate --dry-run --data ~/knode-data
knode-os okf migrate --data ~/knode-data

# 导入外部 bundle，随后进入现有 cook/ingest 管线
knode-os okf import ./team-knowledge --name team --data ~/knode-data
knode-os ingest --data ~/knode-data

# 导出原生 wiki；目标目录必须尚不存在，避免覆盖
knode-os okf export ./knode-okf-export --data ~/knode-data
```

机器接口：

- REST：`GET /api/okf/validate?path=wiki`
- MCP：`knode_okf_validate({ path: "wiki" })`
- TypeScript：`validateOkfBundle`、`migrateWikiToOkf`、`importOkfBundle`、
  `exportOkfBundle`、`classifyOkfVersion`、`okfGenerated`、
  `isGeneratedConcept`、`readGeneratedAt` 从包入口导出。

## 6. 兼容边界与待办

- OKF 仍在快速演进。当前实现按 minor/major 分流并对未知版本告警后
  best-effort，不能假定 Google 的参考 agent 就是规范本身。
- **时间戳严格性尚未完全落地**：校验器要求 `generated.at`、`verified[].at`、
  `stale_after` 是 ISO 8601 datetime，但还没有强制“必须带显式偏移”这一条
  （§11 要求消费者忽略纯日期值）。原生产出走 `toISOString()`，天然带 `Z`。
- **`sources` 尚未原生生产**。knode-os 的溯源目前在 lineage/scope 体系里，
  还没有投影成 OKF frontmatter；这是把内部血缘对外交换的下一步。索引视图归一化同样
  不生产它——`sources` 无法从一份没有声明的文档里推断出来，编造出处比缺字段更糟。
- **归一化只存在于索引视图**。`raw/` 保持上传时的字节，文本源连副本都不落盘，所以一份
  外部文档的 `type` 只存在于 knode-os 索引的内容里（`okf validate --as-indexed` 校验的
  就是这个视图）；PDF/图片的转换结果带着补齐的字段落在 `.sidecar/` 的 `content.md`。
  合规性因此是摄入的产物，不是上传的前提；想让原件本身也合规，仍然要在生产端写对。
- Attested Computation 只做保留式消费，不执行、不生产。
- OKF 不定义固定类型体系。knode-os 保留生产者的 `type`，图查询中未知类型作为
  普通概念使用，不做中心注册表。
- OKF 不定义 typed edge。knode-os 使用 `links_to` 作为最保守的投影；需要
  `depends_on`、`part_of` 等精确关系时，仍由现有 tier-1 抽取或正文语义提供。
  上游 issue #16 正在讨论把 typed、带信任的 `relationships` 写进规范。
- `[[wikilink]]` 是 knode-os/Obsidian 风格扩展，不是 OKF 跨工具契约。面向外部交换
  的关键关系应优先写普通 Markdown 链接；两者可以并存。上游 issue #9 正在讨论
  把这种语法纳入规范。
- OKF v0.2 仍没有专门建模附件。为保持 Obsidian 链接可用，knode-os 会携带全部
  非隐藏附件，但排除源 `.obsidian`、`.git` 和 workspace/plugin 状态，并在目标端
  生成新的安全 Vault 配置；外部稳定资产仍建议通过 `resource` 或 `sources` 引用。
- OKF 是交换层而不是检索层。大规模 bundle 仍需 knode-os 的分块、索引、热度和
  graph/RAG 机制；采用 OKF 不等于可以移除这些层。

## 7. 一手资料

- [OKF 规范仓库（权威位置）](https://github.com/GoogleCloudPlatform/open-knowledge-format)
- [OKF v0.2 官方规范 SPEC.md](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md)
- [OKF Apache License 2.0](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/LICENSE.md)
- [Google Cloud 发布说明：Introducing the Open Knowledge Format](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing)
- [已冻结的旧位置 knowledge-catalog/okf](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)（仅作历史参考）
