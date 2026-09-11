# 05 — Agent Context Database：面向 agent 的知识库重设计

> 状态：Phase 1–6 **全部已实现**——血缘账本、Temporal Resolver、Capability Graph、Context Compiler、学习闭环（ranker / recipe 蒸馏 / pack 评测）、以及负知识、工作集、信任层级、ACL 继承、变更订阅。英文版见 [05-agent-context-db.md](05-agent-context-db.md)。

## 0. 一句话

**对 agent 看起来是一个数据库，物理上允许数据保留在不同系统；每一个派生字节都有血缘和逆操作；核心操作是 `resolve` 而不是 `search`。**

knode-os 原本是"markdown 为真、PGlite 为可丢弃索引"的本地知识库。这次重设计把它改造成 *Agent Context Database*（ACD）：一个逻辑数据库，覆盖文档、图片、agent trace、memory、skill、离线数仓与在线 MySQL 等多模态、多物理存储；对 agent 提供文件系统、RAG、图检索和 LLM wiki 四种查询面；每条知识带世界时间与系统时间；并逐步把"给一个 query，把相关数据与知识准备好、告诉 agent 还能补查什么"变成可配置、可学习的 Context Compiler。

## 1. 动机：五个需求

| # | 需求 | 本设计的回答 | 阶段 |
|---|---|---|---|
| ① | 时空可组合：删除一个文档/数据，它之前产生的影响都能移除 | Effect Ledger：每个源是一个 scope，每个派生写入要么是按 scope 关闭的 evidence，要么是带逆操作的 effect；`dispose` 逆序回滚，`sync` 做声明态/运行态对账 | Phase 1 ✅ |
| ② | 一个逻辑库，多模态、多物理存储 | 本地只保存目录 + 稳定且昂贵的派生物；易变数据联邦查询；连接器是 Cordis 风格插件（注册 = apply 一个 scope）；Capability Graph 把「能问什么、怎么问、贵不贵、多新」统一成一张表 | Phase 1–3 ✅ |
| ③ | agent 友好的查询：FS、RAG、图、LLM wiki、时间有效性 | 四种查询面共用一个目录；wiki 页面是图上的物化视图；三条时间轴（`as_of` 系统时间 / `valid_at`·`valid_range` 世界时间 / `freshness` 实时读上限）由 Temporal Resolver 显式分开并贯穿检索；`kinds`/`sources` 限定哪些源可以作答 | Phase 1–2 ✅ |
| ④ | 尽量减少 agent 探索，可配置可学习 | Context Compiler：intent spec（可配置）+ receipts/feedback（可学习）→ ContextPack v2 + 一个在 agent 侧执行的 workflow 式 Plan；ranker 用 Thompson 采样在利用与探索之间取舍 | Phase 4–5 ✅ |
| ⑤ | 其它 agent 用不好数据库的场景 | 预算与裁剪、回执、负知识、快照/工作集、信任层级、ACL 继承、变更订阅 | Phase 6 ✅ |

## 2. 理论依据

- **DeepSeek《A Programming Paradigm for Spatiotemporal Composability》（arXiv 2608.25512，Cordis）**：时间可组合 = 每个 effect 携带一个逆操作，运行时持有 dispose stack，卸载组件时按注册逆序回滚；空间可组合 = 组件通过 `inject` 声明 coeffect（依赖的服务），依赖出现/消失时依赖方被反应式激活/停用；config reconciliation = 声明态 vs 运行态做 diff，只装卸变化的组件。本设计把这三条一一映射到知识库（§4）。
- **DeepSeek Harness PTC（Programmatic Tool Calling）**：模型针对一份由工具定义生成的 typed SDK 写程序，中间数据留在执行环境，只有精选结果回到模型。本设计中 Plan 可以渲染成这种 TypeScript 程序（§8）。
- **Karpathy LLM wiki**：raw 不可变、wiki 由 LLM 全权维护、schema 共同演化，ingest/query/lint 三操作；但它没有回答"删源之后 wiki 怎么办"。本设计的回答是：wiki 页面是声明了输入的物化视图（§5）。
- **Argus（arXiv 2605.16217）**：把研究看成"证据装配"，用 evidence graph 判断还缺哪些证据块——这是 ContextPack 里 `unknowns` / `available_next_queries` 的来源（§8）。

## 3. 总体架构与原则

```
Agent (Claude / Codex / DeepSeek Harness / 自研)
        │  MCP · CLI · HTTP · 虚拟文件系统 · 只读 SQL(catalog)
        ▼
┌──────────────────── Context Compiler (Phase 4) ──────────┐
│ resolve(query, actor, as_of, valid_at, budget)            │
│   intent 识别 → 实体落地 → 证据槽规划 → 本地可填的直接填     │
│   → 剩余槽位编译成 Plan(workflow 程序, agent 执行)           │
│   → ContextPack + receipt                                 │
├───────────── Temporal Resolver ── Policy / ACL ───────────┤
│ valid_time ⟂ tx_time ⟂ freshness                          │
├─────────────────── Effect Ledger (Phase 1 ✅) ────────────┤
│ scopes · effects(+inverse) · evidence · deps · pages       │
│ apply / dispose / fold / propagate / sync / purge / rebuild│
├────────── Knowledge (materialized) ────── Capability Graph ┤
│ chunks · entities · claims · pages · memories · episodes   │ datasets(✅) · capabilities · locators
└───────────────────────────────────────────────────────────┘
   ▲ files = 人类真相                    ▲ ledger/events.jsonl = 机器真相
   raw/ cooked/ wiki/ packs/                .knode/db = 可重建投影
   ▲ 物理存储：MySQL · TimescaleDB · parquet/DuckDB（✅）· S3 · HTTP API · Prometheus（Phase 3）
```

设计原则：

1. **一个逻辑库，多个物理库。** 放置策略是 capability 级配置：`materialize | federate | cache(ttl)`。
2. **每个派生字节都有血缘和逆操作。** 没有 `(scope, effect, inverse)` 的写入不允许存在。
3. **依赖显式声明，解析反应式。** 派生物声明 `deps(required|optional)`；输入消失 → required 缺失则归档，optional 变化则重算。
4. **默认双时态。** `valid_from/valid_to`（世界时间）+ `tx_from/tx_to`（系统时间）。删除 = 关闭 `tx_to`（tombstone），`purge` 才物理清除。
5. **核心操作是 `resolve` 不是 `search`。**
6. **文件仍是人类真相；ledger 是机器真相；DB 是两者的可重建投影。当前态 = 物化聚合列，历史态 = evidence。**

## 4. Effect Ledger（Phase 1，已实现）

### 4.1 Cordis → 数据库的映射

| Cordis | ACD 实现 |
|---|---|
| component | **Source**：一个文件（cooked 文档、skill、人工 wiki 页、purpose/schema）、一个 datasource 配置、一次 dream。一次 apply = `scopes` 一行；tier-1 抽取、生成页上的人工散文（`wiki-human`）、每张数据表（`dataset`）是子 scope |
| `ctx.effect(() => inverse)` | 图证据（entity/relation/claim）、mention、chunk/embedding 的逆是**隐式**的（按 `scope_id` 关闭或删除）；文件写入、托管区块、队列、建议、依赖、页面行、dataset 行等**显式** effect 记在 `effects(scope_id, seq, kind, target, inverse)` |
| dispose stack | `disposeScope`：子 scope 先，再关闭 evidence、删 mention、删投影，然后 `effects` 按 `seq DESC` 执行逆操作 |
| `inject`（coeffect） | `deps(artifact ← input, required)`；input 只能是 `entity / relation / claim / document / dataset / trace / set`，**page 永远不能依赖 page** |
| 反应式激活/停用 | `foldTouched` 重算被触及行的聚合 → `fold_sha` 变化或 tombstone → `propagate`：required 输入消失 → page 归档；否则标 dirty；依赖它的 suggestion → `stale` |
| config reconciliation / HMR | `sync`：声明态（raw/ 文件树 + datasource 配置）vs 运行态（活跃根 scope）diff，只 apply/dispose 差量 |
| 幂等 | 同 `(kind, key, sha)` 的 apply 在开事务前返回 `unchanged`：零写入、零 ledger 行 |

### 4.2 Schema（migration v2）

```
scopes    (id, kind, key, sha, parent_id, status: applying|active|disposed, actor, applied_at, disposed_at, meta)
          UNIQUE (kind, key) WHERE status <> 'disposed'
effects   (seq, scope_id, kind, target, inverse JSONB, reverted_at)
evidence  (id, kind: entity|relation|claim, target_id, scope_id, segment_id, weight, extractor, attrs, tx_from, tx_to)
deps      (artifact_kind: page|suggestion, artifact_id, input_kind, input_id, required, input_sha)
pages     (path, kind, scope_id, generator, inputs_sha, file_sha, regions, status: active|dirty|archived, dirty_reason, tx_from, tx_to)
entities  + tx_from, tx_to, evidence_count, fold_sha
relations + tx_from, tx_to, evidence_count, fold_sha           （document_id 停写）
claims    + valid_from, valid_to, tx_from, tx_to, evidence_count, fold_sha, primary_scope_id
entity_mentions  PK 改为 (entity_id, chunk_id, scope_id)
datasets  + scope_id, tx_from, tx_to ；documents + scope_id, kind: source|view，status 新增 disposed
```

迁移由 `src/store/migrations.ts` 按版本在各自事务中执行；旧库（无 `schema_version` 但有 `documents` 表）视为 v1。v2 会**重建图层**（旧行没有 per-source evidence 且权重已膨胀），保留 chunks/embeddings（chunk id 由内容派生，可直接复用），tier-1 结果从 sidecar 免费重放。

### 4.3 evidence 与 fold：共享行 + per-source 贡献

旧版的硬伤是 `relations.id = sha(source|type|target)`、`claims.id = sha(subject|statement)` 与文档无关，但行只属于"先写者"，`weight = weight + δ` 每次重 ingest 都膨胀，删文档时按 `document_id` 删又会误删别的文档仍在断言的边。

新模型：实体/关系/断言仍是**内容寻址的共享行**，但每个 source 对它的支持是一条 `evidence`；可见列由 `src/lineage/fold.ts` 在 apply/dispose 的同一事务内**只对被触及的 id** 从活跃 evidence 重算，规则与顺序无关（重建可复现）：

- entity：`name` = 最高权重 evidence 的名字（并列取最早、再字典序）；`type` 按固定优先级；`description` 最长；`aliases` 大小写不敏感并集；`mention_count = COUNT(DISTINCT chunk_id)`。
- relation：`weight = SUM(evidence.weight)`（wire 0.3 / concepts 0.1 / tier1 0.2 各自一行，重 ingest 不累加）。
- claim：任一 disputed → disputed，否则任一 fact → fact，否则 suspected；`valid_from = MIN`；`valid_to` 任一为空则为空（"未注明结束的再次断言 = 仍在断言"），否则 MAX；`primary_scope_id` = 最早的活跃来源。
- 活跃 evidence 归零，或端点实体 / 主体实体已 tombstone → 行 tombstone（`tx_to`）；重新获得 evidence → 重开（`tx_from` 更新，完整历史在 evidence）。

为什么不用视图或增量计数器：全表 `GROUP BY evidence` 会让每个热查询（`graphSignal`、SAG 排序、`matchEntities`）变慢，PGlite 单线程无并行；增量计数器要求所有写者纪律一致，而 touched-id 重算按构造精确且自愈（`sync --verify` 做全量重算并报告漂移）。

### 4.4 视图不是来源：关闭三条"复活"路径

旧版有三条路径让已删除来源的实体复活：`wiki/entities/*.md` stub 被当作 concept 节点重新 ingest；`wiki/index.md` 的 hot-topics 区块带 `[[实体]]`；`wiki/sources/*.md` 摘要带 `[[链接]]`。新的分类（`src/ingest/apply.ts`）：

- **Sources**：`cooked/docs/**`、`raw/skills/**`、`purpose.md`/`schema.md`、`wiki/**` 中既非保留页也非视图的人工页（含 self-entity，与今天一致）、datasource 配置。
- **Views**（有活跃 `pages` 行或 `generated: true` 的 wiki 文件）：只做 chunk/embedding 供检索，**不产生实体证据**；仅当托管区块外有非标题正文时，才作为 `extractor: human` 的证据来源（人在 stub 上写了散文 = 人在断言这个实体），并以 `wiki-human` 子 scope 记录。
- **Reserved**：`index.md`（任何层级）只进检索不接图；`wiki/log.md`、`wiki/.archive/**`、`attachments/**`、`*.knode.json`、`ledger/**`、`raw/traces/**` 永远不是来源。`ledger/events.jsonl` 取代 `log.md` 作为机器日志，`appendLog` 仍是人类可读的 OKF 日志。

### 4.5 apply / dispose / sync / purge / rebuild

**`applyScope(store, {kind, key}, sha, opts, body)`**（`src/lineage/scope.ts`）：① 同 sha 的活跃 scope → `unchanged`，不开事务；② sha 不同 → 先 `dispose(old, 'replaced')`（文档 scope 保留 chunks/embeddings 供新 apply 复用）；③ 一个事务：插 scope → `ledger_seq++` → `body(writer)` → `foldTouched` → `propagate` → scope `active`；④ COMMIT 后执行排队的文件操作（幂等）；⑤ 追加 ledger 行。**body 内禁止 await 网络/LLM/embedding**——一切先算好再传入，PGlite 的互斥锁只保持很短。

**`disposeScope(store, id, {reason})`**：子 scope 先；事务内关闭 evidence（RETURNING → touched）→ 删 mention → 若拥有文档投影则删 chunks、`documents.status = disposed` → `effects` 逆序执行逆操作 → fold → propagate → scope `disposed`；COMMIT 后执行文件逆操作（`reason = archived` 时 `file.delete` 变成移入 `wiki/.archive/`）；`removed` 的 cooked 文档额外删除 cooked 文件并把 sidecar 移入 `ledger/attic/`。`replaced` 时 propagate 只标 dirty 不归档、也不执行文件逆操作：替换的 apply 通常会立刻恢复同样的证据，真正消失的输入由 `reconcileViews` 重新 plan 时归档。

**`sync(ctx, {only?, verify?})`**（`src/ingest/sync.ts`）取代旧的三处孤儿扫尾：cook（只建/更新）→ `enumerateDeclared`（cooked 文件只算 raw 原件仍存在的；`raw/docs/x` 前缀映射到 cooked 孪生路径；`datasources` 伪前缀）→ 运行态 = 活跃根 scope → diff → removed 先 dispose，added/replaced 按 `ingest.concurrency` 并发准备、事务串行 apply → datasource scopes → `reconcileViews`（归档 / 再生 / 漂移修复）→ `--verify` 时 `recountAll` + ledger 补行。watcher、trace 定时器、HTTP/MCP 都调 `sync`，增量路径（`only`）与全量路径**同样会 dispose 被删除的源**。

**`purge`**：只对已 dispose 的 scope 物理删除 evidence/effects/mentions/attic sidecar/旧文件版本，并 GC 没有任何 evidence 引用的实体/边/断言；`purge --before <ts>` 压缩历史；`purge --archived` 清 `wiki/.archive/`。活跃源不能 purge。**`forget <path>`** = 删文件 + `sync` + purge。

**`rebuild [--history]`**：删 `.knode/db` → 重开（跑迁移）→ 从 ledger 重播种 `ledger_seq` → `sync`，未变源沿用 ledger 里的原始 apply 时间（`tx_from` 忠实）→ 回放 feedback 事件（建议状态）；`--history` 额外对已被删除但 attic 里有 sidecar 的源，按原时间只做图层 apply 再按原时间 dispose，使图层的 `as_of` 在重建前后一致（stock demo 端到端验证：删研报前 3 条断言、删后 2 条、`rebuild --history` 后 `--as-of` 仍是 3 条）。

### 4.6 双时态与删除语义

- 查询默认 `tx_to IS NULL`；`as_of = T`：`tx_from <= T AND (tx_to IS NULL OR tx_to > T)`；`valid_at = T`：`(valid_from IS NULL OR valid_from <= T) AND (valid_to IS NULL OR valid_to >= T)`。统一在 `src/store/temporal.ts`；`as_of` 的图读取不看聚合列，而是从 evidence 现算（`entitiesAsOf / relationsAsOf / claimsAsOf`）。
- Phase 1 的 `as_of` 覆盖图层（实体、关系、断言、页面、datasets、文档作为 scope）。chunks/embeddings/mentions 在 dispose 时硬删——pgvector 没有索引，tombstone 会拖慢每次向量检索；`as_of` 检索返回"当时活跃文档"的当前 chunk。
- 普通删除 = dispose（历史可回看）；`forget` / `purge` 才彻底消失。

### 4.7 机器真相：`ledger/events.jsonl` + `ledger/attic/`

事件 `apply | dispose | purge | feedback | migrate | rebuild`，含 `seq, ts, actor, scope{id, kind, key, sha, parent}`，**不含正文**；`seq` 取自 `meta.ledger_seq` 并在 scope 事务内递增，DB 行与 ledger 行一致。`ledger/attic/` 保存被删源的 sidecar（付费抽取，含 tier-0.5 声明的 entities/claims）与被覆盖的人工文件旧内容（`blobs/<sha>`）。

### 4.8 幂等与崩溃安全

同 `(kind, key, sha)` 三次 apply 零写入；内容变化 = dispose(t) + apply(t' > t) 两个事务，fold 只看活跃 evidence，权重不可能膨胀；DB 事务是原子单位，文件操作 COMMIT 后幂等执行；commit 与 ledger 追加之间崩溃由 `sync --verify` 补行；apply 中途崩溃则旧 scope 已 dispose、新 scope 不存在，下次 sync 因声明≠运行自动重试；内容派生 id + 顺序无关 fold ⇒ 两次 sync 得到相同行集。

## 5. wiki 页面即视图（Phase 1，已实现）

`src/wiki/pages.ts` 的 `PageGenerator {kind, version, llm, mode, plan(), render()}`：`plan` 从当前图状态声明 deps 并算 `inputsSha`；`render` 产出 frontmatter 与托管区块；`regeneratePage` 在 `page` scope 里写 `pages` 行 + deps + 文件，再为文件建立检索投影。

| kind | 路径 | deps（粗体 required） | LLM | 缓存 |
|---|---|---|---|---|
| `entity_stub` | `wiki/entities/<id>.md` | **entity**, claims | 否 | — |
| `source_summary` | `wiki/sources/<slug>.md` | **document**(sha) | 是 | doc sidecar `views.sourceSummary` |
| `dataset` | `wiki/datasets/<id>.md` | **dataset**(schema sha), 关联实体 | 否 | — |
| `sources_index` | `wiki/sources/index.md#sources` 区块 | `set:docs`, documents | 否 | — |
| `hot_topics` | `wiki/index.md#hot-topics` 区块 | `set:hot-entities`, entities | 否 | — |
| `concept_cluster` | `wiki/concepts/<slug>-cluster.md` | **anchor entity**, members | 是 | `cooked/wiki/…knode.json` |
| `dream` | `wiki/dreams/<date>.md` | traces | 是 | 一次性 scope |

- 托管区块 `<!-- knode:begin <id> --> … <!-- knode:end <id> -->`；区块外的人工散文在每次再生中保留，并且是知识来源。旧的 `generated: true` 无标记页视为整体托管；旧 `<!-- hot-topics:start -->` 首次再生时改写。
- frontmatter 增加 `knode: { view, inputs: {entities, claims, documents…} }`——用 id 取代复制原文。
- 目标路径上已有人工文件（无 `pages` 行、无 `generated: true`）→ `blocked`，永不触碰。
- 归档：required 输入 tombstone → `pages.status = archived` → `reconcileViews` dispose 该 page scope（文件移入 `wiki/.archive/`、`wiki_path` 复原）并 dispose 其检索投影；来源回来后 `generateWiki` 从归档副本恢复再生成（人工部分不丢）。
- **不会循环**：视图不产生 evidence，重生成改不了任何 fold；dirty 只由 `fold_sha`/文档 sha 的**变化**触发；`deps.input_kind` 不含 page；index 类页依赖每轮只算一次的 `set:*` sha；`reconcileViews` 每轮最多三趟。

## 6. 逻辑多模态数据库（Phase 1 部分 + Phase 3）

已实现：datasource 配置是一个 `datasource` scope（sha = 配置 + introspect 出的 schema 列表），每张表是 `dataset` 子 scope（sha = schema + 采样到的实体值），dataset 实体、`stored_in` / `appears_in` 边、`datasets` 行、dataset wiki 页都是它的 effect；从配置中删掉一个源 → `sync` dispose → 行 tombstone、边关闭、页面归档，而文档仍在断言的实体不受影响（测试：`tombstones datasets, links and pages when a source leaves the config`）。

**端点与指标的绑定是派生的。** 表可以枚举自己的列值，HTTP 端点和 Prometheus 指标不能——不调用就没有值可采样。所以 `sync` 先处理能采样的源（表、对象目录），再为端点/指标推导 locator：凡是某实体已经在别的 capability 上以同名参数绑定（parquet 表里 `symbol = 300750`），端点声明了 `entityParams: [{ column: symbol }]` 就得到同一条绑定；对 `symbol / code / ticker` 形态的参数，还会用实体的 ticker 形态别名（研报 frontmatter 里的 `aliases: ["300750"]`）直接生成绑定，因此 API 是唯一实时源时也能绑上。派生绑定同样产生 `appears_in` 边（描述为 `bound by param quote.symbol`，证据权重 0.25）和 locator，planner 于是给出 `quote?symbol=300750` 而不是一个无参调用；绑定与配置顺序无关。

**CSV 与 parquet 同级。** `duckdb` 源把目录里的 `.csv / .tsv`（含 `.gz`）也注册成视图（`read_csv_auto`），同名 stem 时 parquet 优先。

**探针按方言渲染。** playbook 里的 `{symbol}` 落到 SQL 时是字符串字面量，落到 HTTP 端点时是 URL 组件，落到 PromQL 时是带引号的标签值；pack 为未探测的端点给出的"下一步查询"也用该源自己的写法（`quote?symbol=300750`），不再一律生成 SQL。端到端测试：`tests/quote-api.test.ts`（本地 mock 行情 API + CSV 日线 + 研报，`resolve` 规划并执行两条绑定好的调用，删掉 API 配置后能力、locator 与 plan 节点一并退役）。

### 6.1 Capability Graph（Phase 3，已实现）

三张表，schema v4，全部由**写入它们的 scope 拥有**，dispose 时按 scope id 关闭——和 evidence 同一套契约，因此不需要逆操作，也不可能比声明它们的源活得更久：

| 表 | 内容 | 谁写 |
|---|---|---|
| `capabilities` | `id / kind(table·endpoint·metric·tool) / source_id / name / dialect / schema / semantics / sample_queries / freshness_seconds / cost / acl / placement` | dataset scope（机器发现的一半） |
| `capability_notes` | `semantics / sample_queries / pitfalls / joins / cost / freshness` | `capabilities/*.md` 的 doc scope（人写的一半） |
| `locators` | `entity_id → (capability_id, param, value)` | dataset scope 的采样 |

- **两半分开存**是刻意的：撤掉 datasource 不该删掉别人写的口径文档，反之亦然。读时在 `src/capability/store.ts` 合并，notes 在 cost/freshness 上覆盖机器默认值（写下「这个视图延迟 15 分钟」的人比 introspect 知道得多），散文则追加而非替换。
- **locator 是「宁德时代」变成「market-mysql.daily_quotes 上 symbol='300750'」的那一步**，也是 planner 判断一次调用是「有据可依」还是「碰运气」的依据。别名会一并写入，所以研报里的 `aliases: ["300750"]` 直接把实体接到了 parquet 表上。
- `knode_capabilities` / `GET /api/capabilities` / `knode-os capabilities` 返回目录；`format=dts` / `--dts` 生成 TypeScript 声明（列名类型进注释、pitfalls 与 sample query 进 doc comment），供 `ts-program` 形态的 plan 直接写程序。
- 内置工具（`knode.search` / `knode.claims` / `knode.graph` / `knode.catalog`）在**读时合成**而不是落表——它们是代码不是数据，没有可拥有它们的 scope；但 planner 必须能在同一个目录里比较「查本地索引」和「查 MySQL」，否则前者永远上不了台面。

### 6.2 连接器（Phase 3，已实现）

保留 mysql/timescale/duckdb，新增：

- **`http-json`**：声明式端点。`endpoints[]` 是**白名单而不是模板**——请求一个没声明的端点、或传一个端点没声明的参数，直接拒绝。这是防止「配了一个 HTTP 源」变成「给了 agent 一个开放代理」的关键。
- **`prometheus`**：语句就是 PromQL，走 `/api/v1/query`（本身不可写）；`expr @ <时间>` 后缀把 plan 的 `as_of` 送到指标源。结果按 series 拍平成 labels + value + timestamp，让指标读起来和表一样。
- **`object`**：一个目录上的对象存储，`list / stat / head` 三个动词，只读打开、每个 key 过 `safePath`，`..` 出不去根目录。元数据进目录，字节留在原地。

`DataSourceConnector` 新增 `dialect: sql | http | promql | object`，所有调用收口到 `src/datasource/execute.ts`：**只有 sql 方言过 SQL 守卫**，其余三种由构造保证只读。收口在一处，是为了新连接器不可能悄悄绕过守卫，也不会把 SQL 关键字规则套到一条合法包含它的 PromQL 上。

### 6.3 多模态 cook（Phase 3，部分实现）

- 图片 → caption/OCR 已由 Phase 1 的 `convert.ts`（vision 路由）覆盖。
- **trace → episode**：`raw/traces/**.jsonl` cook 成 `cooked/traces/**.md`，按 turn 分段（用户请求、tool call、observation），于是一份没法检索的会话记录变成了普通 source——分块、嵌入、连图、可回滚。**默认关闭**（`trace.episodes: true` 开启）：一台存了几个月 agent 历史的机器，否则一次 sync 就是几千次 embedding 调用。
- 音视频 transcript **未实现**：需要引入 ASR 依赖，与其塞一个假的占位实现，不如留出接口等真正接入时再做。

### 6.4 放置策略

materialize（文档与解析文本、媒体元数据/描述/embedding、trace、memory、skill、schema 与语义、实体关系、长期事实、来源/权限、历史 plan）；federate（利用率、需求状态、库存、实时订单、负责人、监控指标、高频 MySQL 行、数仓明细）；cache(ttl)（查询结果、时点快照、高成本计算、当前任务工作集；沿用 pack 的进程内 TTL cache，永不持久化）。`capabilities.placement` 记录每个能力的归属。

## 7. agent 友好的查询面

已实现：

- `knode_search / knode_graph_search / knode_context_pack` 支持 `as_of`（系统时间）、`valid_at` / `valid_range`（世界时间，断言）、`kinds` / `sources`（源范围），`knode_context_pack` 另有 `freshness`；HTTP `?as_of= / ?valid_at= / ?valid_range= / ?kinds= / ?sources=`；CLI `--as-of / --valid-at / --valid-range / --freshness / --kinds / --sources`。
- `knode_lineage {kind, id}`：一个实体/关系/断言背后所有活跃与历史 evidence（来源 scope、extractor、权重、系统时间窗口）、一个页面的输入、一个文档的 scope 历史。
- `knode_history {path}`、`knode_sync {only?, verify?}`、`knode_forget {path}`；HTTP `/api/lineage`、`/api/history`、`/api/sync`、`/api/forget`、`/api/purge`、`/api/rebuild`；`DELETE /api/file` 现在是 dispose 语义（删文件 + 定向 sync）。
- CLI：`sync`（`ingest` 为别名）、`lineage show`、`history`、`forget`、`purge`、`rebuild`。

### 7.1 Temporal Resolver（Phase 2，已实现）

`src/store/resolver.ts` 是把松散的 agent 入参变成一个显式查询信封的唯一入口。三条时间轴被刻意分开——把它们混为一谈，正是 agent 读到一个过期数字还当成当前值的经典原因：

| 轴 | 参数 | 含义 | 作用范围 |
|---|---|---|---|
| 系统时间 tx | `as_of` | 知识库**当时相信**什么 | 收缩历史；图层从 evidence 现算 |
| 世界时间 valid | `valid_at`（时点）/ `valid_range`（区间） | 断言**在世界上何时成立** | 只作用于 claims 的有效期窗口 |
| 新鲜度 freshness | `freshness` | 实时/联邦读**最多可以多旧** | 约束未来：缓存超过该时长的 probe 会重跑 |

一条断言可以今天被相信（tx）、描述的是上季度（valid）、而背后的实时表是五分钟前读的（freshness）——三者互不替代。

- `valid_at` 与 `valid_range` 互斥；区间语义是**窗口重叠**（开口端为 ±∞），时点退化成"窗口包含该时刻"。
- 日历简写会自动展宽：`2026` → 全年，`2026-08` → 全月，`2026-08-10` → 全天；区间写法 `2026-01-01..2026-06-30`、`2026-03-01..`（开口）、`{from, to}` 对象、`[from, to]` 元组。
- `freshness` 接受秒数或 `30s / 15m / 2h / 7d / 1w`。
- 非法输入抛 `TemporalError`，HTTP 侧映射为 400 而不是 500——这是调用方能修的错误。
- `resolved.notes` 把实际生效的约束回显给 agent（ContextPack 的 `applied` 字段、CLI 的 `applied:` 行）。

### 7.2 `kinds` / `sources` 过滤（Phase 2，已实现）

- `kinds`：`doc`（raw/docs）、`wiki`（人写的 wiki 散文）、`view`（生成的 wiki 页）、`skill`（raw/skills）。`wiki` 与 `view` 同处一个目录，但只有前者是知识来源。
- `sources`：路径前缀，复用 `normalizePrefixes`，所以 `raw/docs/reports` 会自动映射到 cooked 孪生路径。
- 对 chunk 检索，过滤走 `documents` 谓词（`docLiveAt` 统一收口，任何一条召回路径都不可能漏掉它）；对图行（实体/关系/断言），过滤的含义是"**有一条通过过滤的 scope 提供的 evidence**"——这才是血缘上正确的语义，并且与 `as_of` 组合时只看当时活跃的 evidence。
- SAG 的二部图扩展同样带上这两个谓词：一次带 `as_of` 的游走不能穿过当时还不存在的实体，一次带 `sources` 的游走也不能借共享实体逃出范围。

### 7.3 结构化 `knode_claims` 与 catalog（Phase 2，已实现）

- `knode_claims {subject?, object?, types?, statuses?, text?, as_of?, valid_at?, valid_range?, kinds?, sources?, limit?}`：返回断言本身而不是需要 agent 自己读、自己信的散文。每行带有效期窗口、`status`（fact/suspected/disputed）、`stale`（窗口已关闭）、支撑它的 scope 路径与 evidence 条数。CLI `knode-os claims [subject]`、HTTP `GET /api/claims`。
- `knode_query(source='catalog')`：对 PGlite 的只读视图 `v_documents / v_entities / v_relations / v_claims / v_scopes / v_evidence / v_pages / v_datasets / v_mentions` 跑 SQL。视图隐去 fold 记账列（`fold_sha`、`dirty_reason`）并默认只暴露当前相信的行，因此一条普通 SELECT 不可能把 tombstone 当成现状读出去；历史仍可经 `v_evidence` 查到。守卫 = `assertReadOnlySql` + 只允许 SELECT/WITH + 关系白名单（含 CTE 名）+ 外层强制 `LIMIT`。`knode_datasources` 与 `datasource list` 会一并列出这些视图。

### 7.4 虚拟文件系统（Phase 4，已实现）

`src/compiler/vfs.ts`。agent 擅长读文件，所以再开一个文件形态的面：

```
/                                    根目录说明
/entities/<id>.md                    一个实体：类型、别名、断言、邻居、可经哪些 capability 触达
/claims/<subject>.md                 该主语的断言与有效期窗口
/capabilities/<source>/<name>.md     schema、语义、坑、示例查询
/live/<capability>?<param>=<value>   执行该 capability 并渲染结果
```

全部**读时渲染**：没有要同步的目录、没有要再生的页面，而且每条路径都支持 `?as_of=`——因为渲染本身就是一次查询。`/live/` 是唯一会伸到进程外的路径，因此和其它实时读走同一个 executor（方言路由、守卫、行数上限）。

入口：`knode_read`（路径以 `/` 开头即走虚拟 FS）、`GET /api/vfs?path=`、`knode-os vfs <path>`。

## 8. Context Compiler（Phase 4，已实现；plan 在 agent 侧执行）

### 8.1 `resolve` 流程

```
resolve({query, actor, as_of?, valid_at?, budget:{max_tool_calls, max_latency_ms, max_tokens}})
 1. intent 识别   intents/*.yaml 匹配器(regex/关键词/实体类型) + 意图样例向量相似度 + 可选 LLM 分类；fallback default
 2. 落地         实体/参数（复用 matchEntities，改走 locators 与别名索引）
 3. 规划         对 intent 每个 evidence 槽枚举候选：本地(claims/pages/chunks) vs 活能力(capability 模板)
                Utility = 预期成功增益 − token − 延迟 − 数据成本 − 权限风险 − 噪声概率（统计来自 receipts）
 4. 本地填充     能从物化层直接填的槽在 DB 内完成（便宜、ACL 过滤、带 provenance）
 5. 编译 Plan    剩余槽位（live/昂贵/外部工具）编译成 Plan 交给 agent
 6. 组装         ContextPack v2（今天字段的严格超集）+ receipt_id
```

### 8.2 ContextPack v2

```json
{ "intent": {"type","entities","time_range"},
  "facts": [{claim, valid_time, tx_time, status, confidence, evidence:[{scope_key, segment_id, extractor}]}],
  "documents": [{path, chunk_id, score, why}], "graph_context": [...],
  "live_results": [],                       // agent 执行 plan 后经 feedback 回填
  "skills": [{recipe, success_rate, applicable}], "memories": [...],
  "unknowns": [{question, default_assumption, risk}],
  "plan": {...},
  "available_next_queries": [{node_id, capability, args, est_cost, est_latency, expected_gain}],
  "provenance": [...], "permissions": [...], "budget_report": {used, cut:[...]}, "receipt_id": "..." }
```

### 8.3 Plan DSL：一份 plan，两种渲染

```yaml
plan_id: r_01J...            # = receipt id
intent: stock_analysis
budget: { max_tool_calls: 8, max_latency_ms: 5000, max_tokens: 12000 }
slots: { required: [canonical_identity, latest_quote, recent_filings], optional: [peer_baseline, recent_news] }
nodes:
  - id: quote
    fills: latest_quote
    tool: { kind: mcp, server: knode-os, name: knode_query }   # kind: mcp(任意 server) | cli | http
    args: { source: market-mysql, sql: "SELECT ... WHERE symbol = '300750' ORDER BY trade_date DESC LIMIT 5" }
    freshness: 30s
    on_error: { fallback: hist_bars }
  - id: hist_bars
    fills: latest_quote
    tool: { kind: mcp, server: knode-os, name: knode_query }
    args: { source: hist-parquet, sql: "..." }
  - id: news
    fills: recent_news
    tool: { kind: mcp, server: knode-os, name: knode_search }
    args: { query: "宁德时代 最新", valid_range: ["2026-08-01", null], k: 6 }
  - id: peers
    fills: peer_baseline
    tool: { kind: mcp, server: knode-os, name: knode_resolve }  # 子 resolve
    args: { query: "同行业公司近期估值", as_of: "$as_of" }
    after: [quote]
render: json-graph | ts-program
```

- `json-graph`：Claude / 自研 agent 按节点调 MCP/CLI，`after` 决定并行/串行，等价于 Claude Workflow 的 phase/parallel/pipeline；`ts-program`：对生成的 SDK `tools.knode_query(...)` 写成程序，交给 DeepSeek Harness 的 `run_code`。渲染在 DB 侧，执行在 agent 侧——DB 不内置沙箱，但对自己工具的每次调用仍做只读 SQL、maxRows、token 估算与 ACL 检查：预算在 DB 工具上硬约束，在 plan 上是注解。
- `knode_capabilities` 返回工具目录与 d.ts（每个 datasource 表 → `live.<ds>.<table>.query(template, params)`，列名/类型进注释）。
- 回传：`knode_feedback(receipt_id, executed:[{node_id, ok, elapsed_ms, rows|tokens}], used_ids[], ignored_ids[], outcome, revised_plan?)`；`revised_plan` 进入 recipe 蒸馏队列。
- **Recipe**（可配置）= 带槽位的 plan 模板，`packs/*.md` 里 `type: recipe`（`playbook` 自动升级：`retrieval` → `kb.search` 节点，`probes[]` → `live.<source>.sql` 节点），选择顺序 `entity:<id> > intent+entity type > intent > default`。
- **Receipts**（schema v5）：`receipts(id, kind, query, actor, recipe_path, recipe_sha, program_sha, entities, calls[], budget, summary, as_of, valid_at)`；`pack_events` 迁移后变成 `receipts` 上的兼容视图（历史行一并搬过去），既有学习闭环的查询一字不改；同时追加 `ledger/receipts.jsonl`。
- **可学习**（Phase 5，已实现）：见 §8.5。

### 8.4 实现要点（Phase 4）

- **intent 匹配可解释**：关键词 / 正则 / 实体类型各自贡献可见分数（`src/compiler/intents.ts`）。设计里允许的 LLM 分类器是后续优化——它让 spec 更好写，不会让匹配更正确，而一个说不出「你为什么给我这些槽位」的 planner 是没法调试的。无 spec 时退回内置 `default` intent，所以 `resolve` 在没人写过配置时也能用。
- **utility 是一个小而可读的公式**，不是模型：`expectedGain(成功率 × 命中度 × 必需性) − 成本 − 延迟 − 无 locator 惩罚 − 过期惩罚`。选择理由逐条写进 `node.why.reason`。
- **recipe 优先于 planner**：有人写过就按写的来，没人写过才自己规划。已被本地物化层填上的槽位，recipe 节点会被丢弃——那次调用的结果就在同一个 pack 里，重跑纯属浪费。
- **老 playbook 自动升级**：`retrieval` → `kb.search` 节点，`probes[]` → `live.<source>` 节点（`src/compiler/recipes.ts`），旧知识库不用改一个字就获得 plan。
- **`unknowns` 是 resolve 相对 search 的分界线**：填不上的必需槽位被显式报出来（含 `default_assumption` 与 `risk`），而不是回六篇看起来相关的文档让 agent 自己发现窟窿。
- **预算是两件事**：对 knode 自己的工具是硬约束（只读 SQL、maxRows、行数上限），对 plan 是注解；被预算砍掉的槽位进 `budget_report.cut` 而不是静默消失——「因预算放弃」和「没有任何能力能填」是两回事。

### 8.5 学习闭环（Phase 5，已实现）

**ranker（`src/compiler/ranker.ts`）** —— 两件事必须同时成立：要**利用**（连续答对九次的源应该继续被调用），也要**探索**（第一次抛硬币输了的能力，否则永远不会被再试一次，planner 会心满意足地收敛到一个平庸的源）。Thompson 采样一次抽样同时给出两者：按每个候选的 Beta 后验抽一个数来排序。证据充分的 90% 能力几乎总能压过只失败过一次的；但后者后验很宽，因此偶尔会被抽中——而这正是它证明自己或被彻底淘汰所需要的证据。

三条关键设计：

- **成功信号是 `used` 而不是 `ok`**。返回了行但没人采用的源，是在回答错误的问题；把它记成成功，正是 planner 学会「自信地无用」的方式。
- **后验负责「值不值得调用」，抽样只负责「调用哪一个」**。一个必需槽位若只有一个候选，不该因为一次低抽样而被丢掉——Thompson 采样决定拉哪个臂，不决定要不要拉。
- **调用方明确要求的 freshness 是约束不是偏好**。超出上限的源排在所有合规候选之后，探索只在组内发生：为了「学习」去查一个过期源，是在回答另一个问题。

计数写进 `wiki/learning/capability-ranking.md`，是普通 wiki 页——**驱动 planner 的数字必须是人能复核、能纠正的**。`rng` 可注入，因为无法复现的探索策略也无法调试。

**recipe 蒸馏（`src/compiler/distill.ts`）** —— 同一形状的 plan 反复成功，这个形状本身就是知识；让它留在隐式状态，意味着每次都要重新推导、重新支付探索成本。候选必须连过三关才**被提出**（而不是被发布）：

1. **重放**：拿它派生自的 receipt 离线回放（不接触任何源），问的不是「能不能跑」而是「这个形状以前跑出来的东西有没有被采用」；
2. **安全**：每一条语句都必须只读——recipe 是发布出去的配置，一旦接受就会无人值守地运行，「以前 agent 只发过 SELECT」不构成理由；
3. **审批**：走既有 suggestions 流，人接受了才写进 `packs/`。

顺序很重要。自动发布意味着某个走运 plan 里的一个错误会悄悄变成这类问题的默认答案，而本该揭示它的 receipt 此刻正在度量这个错误。agent 通过 `revised_plan` 送回的改写 plan 自成一个形状——那是最有价值的信号，因为有人不得不修好我们的 plan 才拿到答案。

**pack 评测（`src/compiler/evaluate.ts`）** —— 检索基准问「对的文档有没有回来」，这对 context pack 是错的问题：它该由 agent**留下了什么**来评判。返回二十篇文档才拿到有用的两篇，等于把十八篇文档份额的上下文烧在了无用信息上，而任何 recall 指标都不会告诉你。所以头号指标是 **precision = used / returned**，从 receipt 而非固定测试集算出——上下文有没有用，唯一诚实的裁判是拿着它的调用方。没有回报的 resolve 单独计数而不假定成功：agent 从不回报是**度量缺口**，不是满分。报告写进 `wiki/learning/pack-evaluation.md`，并点名「被调用多次、从未被采用」的能力。

三者都挂在夜间 dream 里，也可以随时 `knode-os learning [--distill]` / `knode_learning`。

## 9. 其它 agent-DB 特性（Phase 6，已实现）

schema v6。这些是「数据库对 agent 而言通常做错的地方」，各自独立。

### 9.1 负知识（`src/compiler/absence.ts`）

没有它，agent 每个 session 都会重跑同一条空查询，每次都付钱，却从不积累这次失败教给它的唯一一件事。一次空结果记成 `status: absent` 的普通 claim——有主语、有陈述、**有有效期窗口**。窗口是关键：「这家公司没有申报文件」是某一刻为真，不是永远为真；不带过期地记下来，等于把一次空结果变成永久盲区。

- scope kind `absence`，key 是那条恰好返回空的绑定（`<capability>:<param>=<value>`），所以再次观测是**替换**而不是堆积，撤掉 datasource 会带走它产生的全部 absence——关于一个已不存在的源的「我查过、没有」不是知识，是垃圾。
- 只有「成功且返回 0 行」才算：**报错不算**。源挂了不能说明数据不存在，把它记成 absence 会压制那次本可找到数据的重试。
- fold 里 `absent` 不是弱化的 `fact`：只有当全部 evidence 都说 absent 时才成立，一旦有源正面断言，absence 就不再成立。（这个 fold 分支是被测试逼出来的——早先版本把 absent 折叠成了 `suspected`，等于悄悄抹掉每一条负知识。）
- planner 读它来跳过近期已空的调用，窗口一过自动恢复；被压制的调用出现在 `budget_report.cut` 里，说明原因。

### 9.2 快照 / 工作集（`src/compiler/workset.ts`）

一个 plan 要跑几分钟，一次调研要跑几小时。没有锚点，每一步读到的知识库都略有不同，agent 最后报出的「矛盾」可能只是两次读取分别落在了一次 sync 的两侧。`checkout` 冻结系统时间一次，之后带 `workset` 的每次读取都在那一刻作答。显式 `as_of` 仍然优先——workset 是 session 的默认值，不是笼子。

`commit` 是另一半：把结论**作为普通 Source 写回**（`raw/docs/notes/<id>.md`），下次 sync 当作文档索引，有自己的 scope，可归因、可回滚。agent 的结论不享有进入图谱的捷径：如果它错了，删掉文件必须像撤掉任何一个坏源一样把它撤干净。

### 9.3 信任层级与 dispute（`src/lineage/trust.ts`）

agent 的写入落在 **quarantined**：可检索、可引用、可归因，但不能悄悄变成知识库的立场。当它与一条 trusted claim 冲突时，fold **记录一条 dispute 而不是覆盖**。这就是「持续积累知识的系统」与「积累最后一个 agent 恰好相信什么的系统」的区别。

- **信任跟着文件的来源走，不跟着谁运行了 sync**。文档 frontmatter 的 `actor`（或显式 `trust`）决定层级；sync 是机械对账，不是作者。（这条也是被端到端验证逼出来的：早先版本让 agent 写的笔记因为别人跑了一次 sync 就变成了 trusted。）
- 「冲突」的定义刻意收窄：同主语、同类型、陈述不同、有效期窗口有重叠。谈论不同季度的两条断言并不矛盾，宽定义只会把真正的分歧埋进没人读的噪声里。
- `knode_trust` 提升一个源时，会**顺带解决它开出的 dispute**——隔离等的就是这次复核。
- 读取侧：`trust: 'trusted'` 排除未复核的 agent 写入，默认 `any`（可见、标注，但不能压过 trusted）。

### 9.4 ACL 继承

ACL 挂在 scope 上，向下走时**取交集**：一个由公开文档和受限文档共同派生出的页面是受限的——取并集、或取第一个输入的列表，正是派生物泄露的方式。空 ACL = 不受限，所以它是交集运算的单位元；而受限 scope 在**不知道谁在问**时必须拒绝——「不知道 actor」和「谁都能读」不是一回事。

### 9.5 变更订阅（`src/compiler/subscribe.ts`）

轮询而非推送，游标是**系统时间**而不是队列位置。于是离线一周的订阅者仍能看到全部变化，两个订阅者读同一目标也不会互相消费掉对方的事件——队列要小心处理的事，双时态存储白送。`peek` 不推进游标：处理到一半崩溃的订阅者应该再看到同样的事件。

支持 `entity`（evidence + claim）、`source`（scope apply/dispose）、`intent`（receipt）三种目标。

### 9.6 已在前序阶段落地的

预算与裁剪报告（Phase 4 的 `budget_report.cut`）、回执与 feedback（Phase 4 receipts + Phase 5 precision）、capability 的 cost/freshness 标签（Phase 3）、plan 可解释（Phase 4 的 `node.why`）。

## 10. 数据目录（Phase 1 之后）

```
<data>/
├── raw/            原件（L0）；cooked/  归一化 + sidecar（L1，sidecar 现含 views 缓存与 tier-0.5 声明）
│                   cooked/traces/  turn 分段的 episode（需 trace.episodes: true）
├── wiki/           视图 + 人工页（L3）；wiki/.archive/  被归档的生成页
│                   wiki/learning/  ranker 排名与 pack 评测（可复核的学习产物）
├── packs/          playbook / recipe（怎么取）
├── capabilities/   实时源的语义层：指标口径、join 路径、坑（本身就是 Source）
├── intents/        intent spec：一个答案需要哪些槽位（怎么算答完了）
├── ledger/         events.jsonl（机器真相）；receipts.jsonl（每次 resolve）；attic/（被删源的 sidecar、旧文件版本）
└── .knode/db       PGlite 投影（可 `rebuild`）
```

## 11. 路线图与决策记录

| Phase | 内容 | 状态 |
|---|---|---|
| 1 | migrations · lineage 运行时 · evidence/fold · sync 对账 · 页面视图 · as_of/valid_at · lineage/history/forget/purge/rebuild · 测试 | ✅ |
| 2 | Temporal：Resolver 分离三条时间轴，`valid_range/kinds/sources` 进 search/sag/graph/pack，`knode_claims`，`knode_query(source='catalog')` 与 `v_*` 视图，清理旧 TEXT 日期列（schema v3） | ✅ |
| 3 | 逻辑目录与多模态：capabilities/locators/notes（schema v4）、trace→episode、http-json/prometheus/object 连接器、图片 caption 派生 | ✅（音视频 transcript 待 ASR 依赖） |
| 4 | Context Compiler：intents、planner、Plan DSL 两种渲染、`knode_resolve/plan/feedback/capabilities`、recipes、receipts（schema v5）、虚拟 FS | ✅ |
| 5 | 学习闭环：ranker（Thompson 采样）、recipe 蒸馏与离线重放、pack 评测 | ✅ |
| 6 | 负知识、checkout/commit、信任层级与 dispute、ACL 继承、订阅（schema v6） | ✅ |

决策（Phase 5–6）：ranker 用 `used` 而非 `ok` 作为成功信号；后验决定「值不值得调用」、抽样只决定「调用哪一个」；`used_ids: []` 读作「什么都没采用」而不是「全采用了」；调用方要求的 freshness 是硬约束，探索只在合规组内发生；蒸馏出的 recipe 一律走人工审批，永不自动发布；absence 只由「成功且 0 行」产生，且必须带过期窗口；`absent` 在 fold 里只在全部 evidence 都是 absent 时成立；信任层级跟着文档来源走而不是跟着 sync 的执行者；ACL 沿派生链取交集，空 ACL 是单位元，未知 actor 读不到受限内容；订阅游标是系统时间，`peek` 不推进。

决策（Phase 3–4）：capability 的机器发现半边与人写半边分表存放，读时合并——撤源不该删掉别人写的口径；capability/locator/note 由写入它们的 scope 拥有并按 scope id 关闭，复用 evidence 契约而不新增逆操作；内置工具读时合成不落表；`http-json` 的端点是白名单而非模板；方言路由收口在 `execute.ts`，只有 sql 过 SQL 守卫；trace episode 默认关闭；intent 匹配保持可解释（LLM 分类器留作后续）；recipe 优先于 planner，但已被本地填上的槽位丢弃其节点；plan 渲染在 DB 侧、执行在 agent 侧，预算对 knode 工具是硬约束、对 plan 是注解。

决策（Phase 1–2）：迁移编号按 schema 版本连续递推，Phase 2 落在 **v3**（本文早前草稿写作 "migration 4"）；`claims.start_date/end_date` 这对 TEXT 投影列被删除——同一个事实由 `valid_from/valid_to` 两列表达就够了，两份会漂移，日期投影改在读路径上算（`toDateString`）；catalog 只开视图不开基表，agent SQL 因此不受基表 schema 变动影响；聚合列用 touched-id 重算；实体 id 在 Phase 1 保留 `slugify(name)`（evidence.attrs 保留各源原名，日后可拆分不丢血缘）；chunk 在 dispose 时硬删、`as_of` 只保证图层、chunk 历史靠 `rebuild --history`；机器真相是小事件日志 + attic，effects 明细留在 DB 可重建；Context Compiler 不内置沙箱，plan 在 agent 侧执行；旧库升级重建图层、保留 chunks/embeddings。

## 12. 与旧版的行为差异

- `ingest` 是 `sync` 的别名；`--only` 与 watcher 的增量路径现在同样会 dispose 被删除的源。
- `wiki/sources/index.md` 不再被整文件覆盖，而是维护一个 `sources` 托管区块；`wiki/index.md` 的热点区块改用 `knode:begin hot-topics` 标记。
- `generateWiki` 对已有页面不再"存在即跳过"，而是按 deps 再生；人工内容放在标记外即可保留。
- `documents.status` 新增 `disposed`；`suggestions.status` 新增 `stale`；`entities/relations/claims` 带 `tx_from/tx_to`，读路径默认只看活跃行。
- 删除文件后，`.knode/db` 里保留 tombstone 与 evidence 历史；要彻底抹掉请用 `forget` 或 `purge`。
- （Phase 2）`claims.start_date` / `end_date` 已删除；读路径返回的 `startDate` / `endDate` 由 `valid_from` / `valid_to` 投影而来，语义不变。
- （Phase 2）`knode_datasources` 与 `GET /api/datasources` 的 `sources` 数组新增一个 `catalog` 条目，并附带 `catalog` 视图清单。
- （Phase 3）`DataSourceConnector` 新增 `dialect`；所有源查询改走 `runSourceQuery`，SQL 守卫只作用于 sql 方言。`datasources[].tables[].description` 之外，http-json 用 `endpoints[]`、prometheus 用 `metrics[]` 声明各自的单元。
- （Phase 3）`initDataDir` 新建 `capabilities/` 与 `intents/`，并首次写入 `packs/default.md` 与 `intents/entity-overview.yaml`（此前 `ensureDefaultPlaybooks` 从未被调用）。
- （Phase 4）`pack_events` 从表变成视图；写入路径改为 `receipts`。读它的代码不受影响。
- （Phase 4）`knode_read` 遇到以 `/` 开头的路径改读虚拟 FS。
- （Phase 5）`node.why` 增加 `posterior` 与 `exploring`；`expectedGain` 现在是 Thompson 抽样值，因此不是确定值——需要可复现时传 `rng`。断言应落在 `posterior` 上。
- （Phase 5）新增 suggestion kind `recipe`，`applySuggestion` 接受它并写入 `packs/`；新增 CLI `suggestions list/accept/reject`（此前只有 HTTP 有接受入口）。
- （Phase 6）`scopes` 增加 `trust` / `acl`，`evidence` 增加 `trust`；`v_scopes` 视图追加这两列。`search` / `graph` / `claims` / `resolve` 增加 `--trust` 与 `--actor`。
- （Phase 6）`CLAIM_STATUS` 增加 `absent`；`ScopeKind` 增加 `absence`。
