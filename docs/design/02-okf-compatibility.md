# Google Open Knowledge Format（OKF）v0.1 兼容设计

> 调研基线：2026-07-18。实现目标版本：OKF `0.1`（Draft）。

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

## 2. v0.1 数据模型

### 2.1 Concept 文档

```markdown
---
type: API Endpoint
title: Create order
description: Creates a completed customer order.
resource: https://api.example.com/openapi#create-order
tags: [orders, write-api]
timestamp: 2026-07-18T10:00:00Z
producer_extension: preserved
---

# Examples

See the [Order model](/models/order.md).

# Citations

[1] [OpenAPI source](https://api.example.com/openapi)
```

规范只强制 `type` 是非空字符串。推荐字段依优先级为 `title`、
`description`、`resource`、`tags`、`timestamp`。生产者可以增加任意字段；
消费者 round-trip 时应保留不认识的字段，不能因为未知 `type` 或扩展字段拒绝文档。

正文没有强制章节。`# Schema`、`# Examples`、`# Citations` 是有约定语义的
推荐标题。结构化标题、列表、表格和代码块通常比连续散文更利于人和 agent 检索。

### 2.2 Reserved 文件

- `index.md`：可出现在任意目录，用分组标题和链接列表做渐进式披露。通常无
  frontmatter；只有 bundle 根 `index.md` 可以用 frontmatter 声明
  `okf_version: "0.1"`。
- `log.md`：可出现在任意目录，按 `## YYYY-MM-DD` 分组、日期倒序记录更新；
  `**Update**`、`**Creation**` 等首词只是约定，不是固定枚举。

这两个文件不是 Concept，不能当作普通概念文档使用。

### 2.3 链接、图与引用

OKF 支持两类内部链接：以 `/` 开头的 bundle-root-relative 链接，以及相对当前
文件的普通相对链接。前者在同一子目录内移动文件时更稳定，是规范推荐形式。

链接只声明“存在从 A 到 B 的关系”，边的业务类型由周围文字表达，不另设关系
schema。因此通用消费者通常把它建模成无类型有向边。断链是允许的：它可能只是
尚未补齐的知识，消费者必须 best-effort 继续工作。

外部材料支持正文主张时，应在底部 `# Citations` 中编号列出。引用可以指向外部
URL、bundle 内路径，或者把外部材料镜像为 `references/` 下的一等 Concept。

### 2.4 合规与版本

OKF v0.1 的硬性合规条件只有三条：

1. 所有非 reserved `.md` 文件都有可解析的 YAML frontmatter；
2. 每个 frontmatter 都有非空 `type`；
3. 存在的 `index.md`、`log.md` 符合各自结构。

缺少可选字段、未知类型、未知扩展字段、断链、缺少 `index.md` 都不能让消费者
拒绝 bundle。版本采用 `<major>.<minor>`：minor 保持向后兼容，major 才允许
破坏性变化；不理解声明版本的消费者仍应尝试 best-effort 读取。

## 3. knode-os 的映射

```text
外部 OKF bundle
      │  okf import（先校验，Markdown 字节不改写）
      ▼
raw/docs/okf/<bundle>/          L0 原件
      │  cook
      ▼
cooked/docs/okf/<bundle>/       L1 检索输入 + sidecar
      │  ingest
      ├── chunks / embeddings / FTS
      └── Concept 节点 + links_to 有向边

wiki/                            knode-os 原生 OKF v0.1 bundle
      └── okf export → 可移植目录
```

实现选择如下：

| OKF 能力 | knode-os 支持 |
| --- | --- |
| 原生生产 | `init`、wiki generator、dream、tier-2 页面均产生合规 Concept；根索引声明 `0.1` |
| 校验 | CLI、REST、MCP 共用同一校验器；错误与 soft warning 分开 |
| 宽容消费 | 未知类型/字段被保留；断链、未知版本只警告；`--allow-invalid` 可显式 best-effort 导入 |
| 导入 | 保持目录、Markdown 字节和非隐藏附件，复制到 `raw/docs/okf/<name>`；隐藏 provenance 文件不进入摄入，并初始化为 Obsidian Vault |
| 导出 | 先校验 `wiki/`，合规后复制 Markdown 与附件并初始化为 Obsidian Vault；不会悄悄导出坏 bundle |
| 旧库迁移 | 补根版本、补 Concept `type`、移除子索引 frontmatter、转换旧日志；异常 YAML 留给人工处理 |
| 图谱 | 标准 Markdown 内链解析成 `links_to`；bundle 绝对链接按各自 bundle 根解析 |
| knode 扩展 | 继续支持 `[[wikilink]]`、`aliases`、`generated`、`heat` 等；它们不影响 OKF 合规 |

## 4. 使用方式

```bash
# 新数据目录的 wiki/ 已经原生合规
knode-os init --data ~/knode-data
knode-os okf validate --data ~/knode-data

# 老数据目录先预览、再迁移
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
  `exportOkfBundle` 从包入口导出。

## 5. 兼容边界与建议

- OKF v0.1 仍是 Draft。当前实现对未知版本只警告，后续应跟踪 major/minor 变化并
  增加按版本路由，不能假定 Google 的参考 agent 就是规范本身。
- OKF 不定义固定类型体系。knode-os 保留生产者的 `type`，图查询中未知类型作为
  普通概念使用，不做中心注册表。
- OKF 不定义 typed edge。knode-os 使用 `links_to` 作为最保守的投影；需要
  `depends_on`、`part_of` 等精确关系时，仍由现有 tier-1 抽取或正文语义提供。
- `[[wikilink]]` 是 knode-os/Obsidian 风格扩展，不是 OKF 跨工具契约。面向外部交换
  的关键关系应优先写普通 Markdown 链接；两者可以并存。
- OKF v0.1 没有专门建模附件。为保持 Obsidian 链接可用，knode-os 会携带全部
  非隐藏附件，但排除源 `.obsidian`、`.git` 和 workspace/plugin 状态，并在目标端
  生成新的安全 Vault 配置；外部稳定资产仍建议通过 `resource` 或 citations 引用。
- OKF 是交换层而不是检索层。大规模 bundle 仍需 knode-os 的分块、索引、热度和
  graph/RAG 机制；采用 OKF 不等于可以移除这些层。

## 6. 一手资料

- [Google Cloud 发布说明：Introducing the Open Knowledge Format](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing)
- [OKF v0.1 官方规范](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
- [GoogleCloudPlatform/knowledge-catalog 的 OKF README 与参考实现](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
- [OKF Apache License 2.0](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/LICENSE.md)
