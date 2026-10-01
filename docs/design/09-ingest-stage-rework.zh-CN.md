# 09 — 处理流程重排：抽取后即消歧、摘要前移、页面交给研究

> 状态：**已实现**（2026‑09‑30）。本文改的是 [06 — Wiki 研究 Agent](06-wiki-research-agent.zh-CN.md) 里的两件事——
> 模糊消歧的时机（06 · D3）和夜间 Tier‑2 写概念页——以及 Settings 里「预处理」（Ingest，原 Pipeline）页的阶段划分。
> 英文版：[09-ingest-stage-rework.md](09-ingest-stage-rework.md)。

## 0. 背景与决策

处理流程原来有五个阶段：转换、索引、抽取、综合、摘要。前三个按文档跑；后两个里混着三类性质不同的工作：

- **跨文档的页面写作**：综合每晚给热点实体簇写 `wiki/concepts/<名字>-cluster.md`——一次调用、约 350 字、
  只看 15 个实体和 5 段 300 字的摘录、不带来源引用；
- **单文档的摘要**：`wiki/sources/<名字>.md`，只在有人跑 `wiki generate` 时、给最近更新的 20 篇非冷门文档写，App 里没有入口；
- **判断**：knode_ask、Dream、重复实体复核、冲突断言复核。

由此带来四个问题：

1. 模糊消歧要等到夜里 03:10。入库后的一整天里，检索的图谱路、knode_ask 带出的断言、热点簇计算用的都是没合并的实体。
2. 概念页两套并存：综合写的 `-cluster.md`，和推荐系统为同一个簇建议的研究页 `wiki/concepts/<名字>.md`——路径不同，
   前者挡不住后者，同一个簇最后会有两页。
3. 摘要页覆盖不全；而它其实是研究 agent 和 knode_ask 的**输入**，却排在流程最后。
4. 一条 `summaryLlm` 路由同时服务"每篇一次、量大"的摘要、"有人在等"的 knode_ask 和"要判断力"的复核，选哪个模型都顾此失彼。

五个已确认的决策（2026‑09‑30）：

| 决策 | 结论 |
| --- | --- |
| D1 消歧前移 | 模糊候选的审计与 LLM 复核从夜间挪到**每轮抽取之后**，只看这一轮写到的实体（增量）；夜间保留一次全量审计兜底。写入时解析仍然只做确定性匹配（06 · D3 的理由不变）——前移的是**可撤销的合并**，不是写入时的匹配 |
| D2 摘要前移 | 每篇 `raw/docs` 文档都有摘要页，在**同一个后台轮次**里紧跟抽取生成，按内容哈希缓存；不再区分冷热 |
| D3 页面交给研究 | 综合阶段不再写页：热点簇只生成 `concept` 研究建议（开了 `research.auto` 就自动排队），已有的 `-cluster.md` 归档。实体页保留零模型存根，值得写的由研究升级成正式页 |
| D4 路由拆分 | 删除 `extraction.conceptLlm`；`summaryLlm` 只管文档摘要；新增 `extraction.judgeLlm`（判断）接管 `ctx.llm`：knode_ask、Dream、重复实体复核、断言复核。旧配置的 `judgeLlm` 取自原来的 `summaryLlm`，这些任务仍跑在原处 |
| D5 复核模式进界面 | `review.llmJudge`（off / suggest / auto）与 `review.claims`（off / suggest）放进「判断」阶段的表单，`PUT /api/config` 接收；默认仍是 `suggest`，也就是合并要人确认 |

## 1. 调整后的流程

```
文件进来 ─sync─▶ ① 转换（视觉）─▶ ② 索引（向量化）─▶ tier‑0 图谱 ─▶ 进抽取队列

后台文档轮次 runDocumentPass（serve 每 extraction.intervalMinutes 分钟一轮；`knode-os extract`；初始化的补抽）
   ③ 抽取：按优先级取 batchSize 篇，concurrency 路并行 ─▶ 记下本轮写到的实体
      └▶ 增量消歧：只拿这些实体找候选 ─▶ 「判断」模型复核 ─▶ merge 建议 / auto 时直接合并（可撤销）
   ④ 摘要：本轮抽取的文档优先，其次是缺摘要或摘要过期的文档，最多 batchSize 篇
   └▶ 零模型视图对账

研究（按推荐挑少数对象，06 §5）：实体页、概念页、比较、时间线……
夜间（dream.schedule，默认 03:00 跑 Dream、03:10 跑 Tier‑2）：
   claim 审计 → 全量消歧兜底 → 断言复核 → 归档旧簇页 → 热点 → 刷新推荐 → 视图对账 → lint
随时：knode_ask（判断路由）
```

## 2. 五个阶段与路由

| # | 阶段 | 配置键 | 对模型的要求 | 什么时候跑 |
| --- | --- | --- | --- | --- |
| 1 | 转换 Convert | `extraction.documentLlm` | 视觉 | sync 时 |
| 2 | 索引 Index | `embeddingUse` | 向量化 | sync 时 |
| 3 | 抽取 Extract | `extraction.entityLlm` | 量大：快、便宜、JSON 稳 | 后台文档轮次 |
| 4 | 摘要 Summarize | `extraction.summaryLlm` | 文笔：每篇一次，写给人读 | 后台文档轮次，紧跟抽取 |
| 5 | 判断 Judge | `extraction.judgeLlm` | 质量：调用少，判断要准；knode_ask 有人在等 | 每轮抽取后的消歧复核、夜间、随问随答 |

- `ctx.llm` 是判断路由的客户端（`judgeLlmClient`，`src/context.ts`）。摘要页的生成器自己解析 `summaryLlm`
  （`summaryLlmClient`）。`regeneratePage` 按**生成器自己用的客户端**判断"模型可用吗"，不再一律看 `ctx.llm`——
  以前一张概念页要同时配好综合和摘要两个阶段才写得出来，就是因为这里只看 `ctx.llm`。
- `ROUTE_KEYS` = `entityLlm` / `documentLlm` / `summaryLlm` / `judgeLlm`。`pinRoutes`、`renameRetiredAgents`、
  删 agent 后的回落都按这个列表走，新路由自动覆盖。

## 3. 抽取后即消歧

`runDocumentPass`（`src/ingest/background.ts`）是后台文档轮次的唯一入口：

1. `runTier1Pass` 返回本轮写到的实体 id（`touched`）：每篇文档 `applyExtraction` 写下的实体，包括关系端点临时建的
   `concept` 实体，以及 sidecar 重放的结果。
2. `auditDuplicateEntities(ctx, { focus: touched })`。四种信号不变——去公司后缀后同名 0.98、共享别名 0.95 / 0.9、
   短名是长名前缀 0.85、向量相似度 ≥ 0.92——但只保留**至少一端在 focus 里**的候选对。向量信号只给 focus 实体补算
   embedding（按 `fold_sha` 缓存在 `entity_embeddings`），近邻在已有缓存里找。
3. 复核用 `ctx.llm`（判断路由），模式取 `review.llmJudge`：`suggest` 写进 merge 建议；判"不同"且置信度
   ≥ `llmMinConfidence` 的对记为 rejected、不再提出；`auto` 在"相同"且置信度 ≥ `autoMergeMinConfidence`（0.95）时
   直接 `applyMerge`。每轮最多复核 `review.maxJudgedPerRun` 对。
4. 夜间的全量审计照旧（不带 focus），兜底增量看不到的情况：两端都是老实体、别名积累之后才撞上的对、换过向量模型。

**为什么仍然可撤销。** 写入时解析只做确定性匹配，因为写入时把提及挂错实体是撤不回来的（06 · D3）。本节产出的是
`merge` scope 上的 `entity_link`，`knode-os entities unmerge <id>` 随时可以拆开，所以提前做不改变风险性质。

**串行。** `runDocumentPass` 按数据目录串行（`runTier1Pass` 自己另有一条链），serve 的定时器、`knode-os extract`
和初始化的补抽不会同时审计、同时写摘要。

## 4. 文档摘要并入后台轮次

`ensureSourceSummaries(ctx, { limit, prefer, concurrency })`（`src/wiki/pages.ts`）：

- **候选**：`raw/docs` 下已索引的 source 文档，满足其一：还没有摘要页；摘要页是 dirty（文档改过）。
- **顺序**：本轮刚抽取的文档（`prefer`）在前，其余按 `updated_at` 倒序。每轮最多 `extraction.batchSize` 篇、
  `extraction.concurrency` 路并行——和抽取共用「每轮文档数 / 并行调用」两个设置。
- **页面路径**：文档已有摘要页（经 deps 找回）就沿用；否则用 `wiki/sources/<标题 slug>.md`，该路径已被别的文档
  占用时加路径哈希后缀 `-<6 位>`。以前同名文档的第二篇永远没有摘要页。
- **失败**：同一内容连续失败 3 次后跳过，直到文档内容变化；失败记录在文档 sidecar 的
  `views/source-summary.failed.json`。
- **缓存**：正文仍按文档内容哈希缓存在 sidecar 的 `views/source-summary.md`；换摘要模型不会重写已有摘要。
- `wiki generate` 与 `POST /api/wiki/generate` 仍可手动补齐（同一个函数，默认一次 20 篇）。
- `wiki/sources/index.md` 的来源索引照旧标热度，只是不再说"冷文档没有摘要页"。

## 5. 综合阶段退役

- 删除 `concept_cluster` 生成器。`refineWiki` 不再写 `-cluster.md`，并把仍在用的这类页面归档到
  `wiki/.archive/concepts/`（`retireConceptClusterPages` → `archivePage`；托管区之外人写的段落随文件一起留在归档里）。
- 热点簇只在 `refreshRecommendations` 里发现：≥ 4 个实体的社区、没有 `wiki/concepts/<锚点>.md` → `concept` 建议。
  接受建议，或开了 `research.auto.enabled`，它就进研究队列，按 profile 写成带来源、过校验与评审的概念页（06 §5）。
- 实体页：零模型存根（事实、时间线）不变；推荐对"没有页面 / 只有存根"的热门实体加分，研究写正式页时先把存根归档
  （06 §5 已有的行为）。

## 6. 夜间任务

`refineWiki` 现在做：claim 审计（零模型）→ 全量消歧兜底（判断路由）→ 断言复核（判断路由）→ 归档旧簇页 →
热点 → 刷新推荐。之后 serve 照旧 `reconcileViews(llm: true)` 与 lint。Dream 不变，跑在判断路由上。

## 7. 配置、接口与迁移

```jsonc
"extraction": {
  "entityLlm":   { "use": "…" },  // ③ 抽取
  "documentLlm": { "use": "…" },  // ① 转换
  "summaryLlm":  { "use": "…" },  // ④ 摘要：每篇文档一页
  "judgeLlm":    { "use": "…" },  // ⑤ 判断：knode_ask、Dream、消歧复核、断言复核
  "batchSize": 8, "concurrency": 1, "intervalMinutes": 5   // 抽取与摘要共用
},
"review": { "llmJudge": "suggest", "claims": "suggest" /* 其余键不变 */ }
```

- **迁移**（`loadConfig`，都会触发一次回写）：`migrateJudgeRoute`——文件里没有 `extraction.judgeLlm` 时，复制当时的
  `summaryLlm`（use、model、effort、speed 一并带上）；`dropConceptRoute`——删掉 `extraction.conceptLlm` 与
  `extraction.tier2Model`。
- **`PUT /api/config`**：接收 `extraction.judgeLlm`；`review.llmJudge` ∈ off / suggest / auto，`review.claims` ∈ off / suggest；
  其余 `review` 键仍只能改配置文件。
- **`POST /api/config/test`、`POST /api/config/models`**：路由集合换成 entityLlm / documentLlm / summaryLlm / judgeLlm。
- **`GET /api/stats`**：`llmModel` 报的是判断路由（`ctx.llm`）。
- **CLI**：`knode-os extract` 跑一整轮（抽取 → 增量消歧 → 摘要）；`knode-os ask` 跑在判断路由上。

## 8. 界面

macOS 与 Web 的「预处理」页，左侧五个阶段：转换 · 视觉、索引 · 向量化、抽取 · 量大、摘要 · 文笔、判断 · 质量。

- **摘要**：运行于 / 模型 / 强度，附注"和抽取同一轮跑，用抽取的每轮文档数与并行调用"。
- **判断**：运行于 / 模型 / 强度，加两项：重复实体复核（关 / 只建议 / 高置信自动合并）、断言复核（关 / 只建议）。
- **测试各阶段**的结果五行：1 转换、2 索引、3 抽取、4 摘要、5 判断。

## 9. 已知限制

1. 增量消歧只在已有的 embedding 缓存里找向量近邻：从没进过任何一轮 focus、也不在夜间前 600 名里的实体找不到。夜间全量兜底覆盖。
2. 摘要与抽取共用每轮文档数：积压大时两者一起变慢；要更快就调大「并行调用」或「每轮文档数」。
3. `suggest` 模式下合并仍要人确认，前移只是让建议更早出现；`auto` 才会自动合并。
4. 研究写概念页成本高（多轮 agent 会话），`research.auto.enabled` 默认关，热点簇默认只出建议。
5. 增量复核会重新判断"仍待确认、但这一轮又被写到"的实体对（和夜间审计对待处理建议的方式一样），每对一次调用。
