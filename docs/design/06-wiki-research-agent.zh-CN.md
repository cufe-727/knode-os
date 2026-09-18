# 06 — Wiki 研究 Agent 与图谱增强：本体 / 实体消歧 / 时效 / 推荐 / lint

> 状态：**已实现**（2026‑09‑15）。本文是 [01 — 文档处理](01-doc-processing-graph-wiki.md) 与
> [05 — Agent Context Database](05-agent-context-db.zh-CN.md) 之上的第三层：
> 图谱怎么变得"像人整理过"，以及 wiki 怎么由外部 coding‑agent CLI 越写越准。
> 英文版：[06-wiki-research-agent.md](06-wiki-research-agent.md)。

## 0. 目标与决策

上传的文档经 Tier‑1 抽取后已有 entities / relations / claims，但：实体只按 `slugify(name)` 分配 id、没有消歧；
关系词表硬编码、未知谓词静默降级为 `related_to`、边没有世界时间；claims 只有 `startDate/endDate`，
没有文档参考日期与事件时间；wiki 页只是物化视图（存根、来源摘要、社区页），没有"深度研究"的产物。

四个已确认的决策：

| 决策 | 结论 |
| --- | --- |
| D1 执行方式 | knode‑os 内置 runner：`serve` 内的持久化任务队列拉起配置好的 agent —— 无头的 claude / codex / cursor CLI，或者跑在 OpenAI 兼容连接上的**内置 agent**（`serve` 进程内的 LangChain `deepagents` 循环），供没装任何 CLI 的机器使用；同时提供"导出任务包 → 手动跑 → reclaim"的模式。`research.agent` 必须显式指定，不再回退到默认 LLM 提供方（2026‑09‑18 改） |
| D1a agent 怎么接 knode | **MCP 为主，由 `serve` 以 Streamable HTTP 提供**（`POST /mcp`）；`raw/docs`、`wiki`、`.sidecar` 只读挂给 agent；**所有写入只经 `knode_write`**。不采用"agent 调 knode‑os CLI"（每次重开库、非结构化输出、shell 权限面） |
| D2 页面地位 | agent 写的 wiki 页是 **Source**：frontmatter `actor: agent/<cli>`（内置 agent 为 `agent/deep-agents`）→ quarantined；`aliases / relations / claims` 进图，与 trusted 冲突自动开 dispute；人工 promote 后升 trusted |
| D3 实体消歧 | 写入时**确定性**解析（NFKC / 全半角 / 公司后缀归一 + name/alias 精确键匹配）；模糊候选交给夜间审计 → `merge` 建议 → 人工确认 → 可撤销链接 |
| D4 关系本体 | 可配置本体（`playbooks/ontology/*.yaml`）+ 内置 `core` / `organization` 两个包 |

为什么 MCP 走 HTTP 而不是再起一个 stdio 进程：默认索引后端 PGlite 是单进程嵌入库，`knode-os mcp` 会与正在运行的
`serve` 抢同一个工作区；三种 CLI 都支持 Streamable HTTP；只有 MCP 能给 agent `as_of/valid_at`、workset 钉时间、
`knode_resolve/feedback` 学习闭环和 trust/ACL。

## 1. 总体数据流

```
raw/docs ──sync──▶ Tier0(frontmatter entities/relations/claims → 概念/wikilink) ──▶ ScopeWriter ──▶ evidence ──fold──▶ entities(name_key, canonical_id) / relations(valid_from/to) / claims(event_at, observed_at, superseded_by)
                    └─ Tier1 LLM（本体驱动 prompt + 已知实体注入 + 文档日期）──────────┘
wiki/<type>/<slug>.md ◀── research runner ◀── research_jobs ◀── 推荐（suggestions kind=wiki）/ `research ask` / 手动
   │ actor: agent/<cli>, relations:, claims:, sources:, research:
   └──sync──▶ Source(quarantined) ──▶ disputes ──▶ promote（UI / knode_trust）
serve: /api/* + /mcp（Streamable HTTP，按工作区路由，bearer token）◀── claude -p / codex exec / cursor-agent -p（隔离 run workspace，只读 add-dir）
夜间 Tier2：社区页 + claim 审计（supersession）+ 重复实体审计 + 推荐刷新 + wiki lint
```

## 2. 本体与类型化 / 带时效的关系（`src/graph/ontology.ts`）

- 本体包 `playbooks/ontology/<pack>.yaml`，按 `graph.ontologyPacks`（默认 `["core","organization"]`）顺序合并；
  `initDataDir` 播种内置包，之后不覆盖用户编辑。关系类型字段：`id / inverse / symmetric / hierarchical / temporal /
  domain / range / synonyms / inverseSynonyms / description / system`。
- `normalizePredicate()`：同义词 → 规范 id；反向拼写（`parent_of`、`母公司`、`buys_from`）→ 规范 id 并**翻转方向**；
  对称谓词端点按 id 排序只存一行；未知谓词 → `related_to`，原拼写记入 evidence attrs `raw_type`，
  `knode_graph_insights.unknownPredicates` 统计——提示扩本体。系统谓词（`mentions / links_to / co_occurs / …`）永远合法、不进 prompt。
- Tier‑1 prompt 由本体生成（谓词 + 一句定义 + 反向拼写 + domain→range 提示），relation 输出增加 `validFrom/validTo`。
- `relations.valid_from / valid_to`（迁移 v7）：写入 evidence attrs，fold 规则与 claims 相同（MIN 起点；任一支持者开放则开放，否则 MAX 终点）；
  `knode_graph_search` 的 `valid_at / valid_range` 现在同时过滤边；边返回 `validFrom/validTo`。
- frontmatter `relations:` 两种写法（列表 `{source?, target, type, from?, to?}`；gbrain 式映射 `supplies_to: ["[[特斯拉]]"]`），
  `raw/docs` 与 bundle 页（`wiki/**`）都解析；bundle 页的默认 source 是页面自身实体。
- 已知取舍：`relationId = sha(source|type|target)`，同一条边在不同文档的不同时段会 fold 成并集窗口——分期事实用 claim 表达。

## 3. 实体消歧（`src/graph/normalize.ts` / `resolve.ts` / `merge.ts` / `dedupe.ts`）

- `nameKey()`：NFKC → 小写 → 去包裹符 → 只留字母数字得 `key`；再剥公司后缀（股份有限公司 / Inc. / Co., Ltd. …）得 `bare`。
  fold 为每个实体维护 `entities.name_key` 与 `entity_alias_keys`（name + aliases 的 key / bare），合并进来的成员实体的键也并入幸存者。
- 写入时（`ScopeWriter.entity()`）：显式 `sameAs` → 同 slug 的已有行（跟随 `canonical_id`）→ 任一键命中且类型兼容
  （相同，或任一为 `concept/other`）→ 否则新 slug。命中时该拼写记为别名，evidence attrs 记 `resolved_from`。
  同一 scope body 内还有本地键索引（fold 只在提交后发布键），且 frontmatter 声明先于概念挖掘应用。
- 抽取时实体链接：Tier‑1 prompt 注入文中出现的已知实体（名称 / 类型 / 别名，热度前 30），LLM 可用 `sameAs` 指回规范名。
- 合并：`entity_links` + `entities.canonical_id`，由 `merge` scope 的显式效果写入（inverse `entity_link.remove`），
  `applyMerge / unmergeEntity` 记 ledger feedback（`entity.merge / entity.unmerge`），`rebuild` 按顺序重放。
  读路径（graph search、claims、context pack、vfs、实体页）统一重定向到幸存者；被合并实体的存根页变成重定向页。
- 夜间审计（Tier‑2）：同 bare 键 / 共享别名键 / 短名是长名前缀（同类型）/ embedding 相似（真实 embedder 时，按 fold_sha 缓存于 `entity_embeddings`）
  → `suggestions` kind `merge`（依赖两个实体，任一 tombstone 即 stale；拒绝过的对不再提出）。接受 → `applyMerge`。
- 接口：`knode-os entities merge|unmerge|merges|dedupe|resolve`，`POST /api/entities/merge|unmerge|dedupe`，`GET /api/entities/merges`。

## 4. claims 的时间（`src/store/dates.ts` / `src/ingest/docdate.ts`）

- 文档参考日期 `documents.doc_date`：frontmatter `date / published / as_of / generated.at …` → 路径中的日期（`2026-05-10`、`2026-05`、`2026年3月`、`2026Q2`）→ 无（**不用 mtime**，保证幂等）。写进 sidecar `meta.docDate`，搜索结果带 `docDate`。
- `normalizeDateExpr()`：`2026-08 / 2026Q2 / 2026年第二季度 / 2026年上半年 / FY2025 / 去年 / 上季度 / 去年同期 / 2024年以来 / 截至 2026-06-30`
  → 精度感知的 `[from, to]`；相对形式按文档日期折算，缺参考日期返回 null。`valid_range` 查询短语复用同一语法。
- claims 新列 `event_at`（事件时间，最高权重支持者）、`observed_at`（最早来源日期）、`superseded_by`（系统维护）。
  prompt 与 frontmatter 都区分 `eventDate` 与 `startDate/endDate`。
- supersession：同主体同类型、均为 fact、较旧者窗口在较新者开始前结束（或未闭合）→ `superseded_by = 新者`；
  `knode_claims` 默认隐藏（`include_superseded=true` 可见），`order=timeline` 按事件时间排序，`event_range` 过滤。
- 实体存根页拆成 `## Facts (current)`（未替代、未过期）与 `## Timeline`（按事件时间升序，被替代的标注）。

## 5. 研究 runner（`src/research/`）

- **模版即技能**：`playbooks/research/AGENTS.md`（共用协议）+ `entity / concept / comparison / timeline / question / refresh.md`
  （frontmatter：`kind / output / maxTurns / requires.frontmatter / requires.sections`；正文是 agent 读的指令）。用户可改。
- **任务**：`research_jobs` 表（`queued → running → validating → done|failed|cancelled`），同 kind+target 去重；serve 崩溃后遗留的 running 重新排队。
- **运行目录** `<data>/.runs/<jobId>/`：`CLAUDE.md`=`AGENTS.md`（协议 + 模版 + purpose/schema）、`brief.md`（目标、输出契约、可用谓词、
  已有页面全文与必须保留的人写段落、`knode_resolve` 预整理、上次退回原因）、`.mcp.json` / `.cursor/mcp.json`、`transcript.jsonl`、
  `result.json`、`validation.json`、被退回的 `rejected.md`、被覆盖前的 `existing.md`。
- **启动配方**（`launch.ts`）：claude `-p --output-format stream-json --max-turns N --mcp-config .mcp.json --strict-mcp-config
  --allowedTools mcp__knode-os__* Read Grep Glob --disallowedTools Write Edit … Bash WebFetch WebSearch --permission-mode dontAsk --add-dir …`；
  codex `exec - --sandbox read-only --cd <ws> -c mcp_servers.knode-os.url=… -c mcp_servers.knode-os.bearer_token_env_var=KNODE_MCP_TOKEN`
  （工作区参数走 URL query）；cursor `-p --output-format stream-json --trust --approve-mcps --workspace <ws> --add-dir …`。
- **校验**（`validate.ts`）：页面存在 → YAML 可解析 → 盖章 `actor` / `research`（不信任 agent 记得写）→ 必需键、`title/type`、
  必需章节、至少一条可核查的 `sources`、`relations` 谓词在本体内（否则告警）、日期可解析、wikilink 有页（否则告警）、
  **人写段落必须原样保留**（错误）、OKF 校验。失败：草稿移到 `rejected.md`、恢复原页面、带原因重排一次（第二次失败即 failed）。
- **成功**：只 `sync` 这一路径（落为 quarantined Source，`detectDisputes` 自动开 dispute）→ 关闭 workset → `wiki/index.md#recent-research` 区块 → `wiki/log.md`。
- **来源 / 视图判定修正**：`isGeneratedConcept` 对任何 `generated.by` 返回 true，会把研究页当视图；现在显式 `actor` 的页是 Source；
  wiki Source 页的图布线只用 managed region 之外的正文。输出路径上已有的生成存根先归档（`wiki/.archive/`）。
- 接口：CLI `knode-os research queue|ask|run|list|show|cancel|retry|recommend|templates|export|reclaim`；
  HTTP `/api/research/jobs[…]`、`/api/research/ask`、`/api/research/pages`、`/api/research/recommendations`、`/api/research/templates`；
  MCP `knode_research`；Web `Wiki` 标签页（排队 / 任务与日志 / 研究页 promote·demote·refresh / 推荐）。
  `research run` 与 `--now` 在 CLI 进程内临时起一个只服务本上下文的 `/mcp`，不依赖 serve。

## 5b. 团队式流水线（`src/research/pipeline.ts`，`pipeline = "team"`，默认）

单会话模式（`single`）让一个 agent 从头做到尾；团队模式把它拆成多次 CLI 会话，**每个阶段由 profile（见 5d）里的一个或多个角色承担**，状态以文件在运行目录间传递：

| 阶段 | 默认角色 | 会话 | 工具范围 | 产物 |
| --- | --- | --- | --- | --- |
| plan | planner | 1 | 只读 | `plan.json`：3–6 个章节子任务（问题、检索词、实体） |
| research | researcher | 每章节 1 个，`parallel`（缺省 `research.researchers`）并行；多个 research 角色轮流领章节 | 只读（claude 通过 `--allowedTools` 白名单强制，其余靠提示） | `findings/<n>-<章节>.md`：发现、候选 claims/relations、缺口 |
| synthesize | synthesizer | 1 | 可写（`knode_write` / `knode_commit`） | 页面本身 |
| review | critic（可多个，全部运行、意见合并） | 每轮每角色 1 个 | 只读 | JSON 判定 `{pass, issues, summary}`；与确定性校验并行 |
| revise | reviser | 最多 `rounds`（缺省 `research.reviewRounds`）轮 | 可写 | 修订后的页面 |

关掉一个角色就跳过它的阶段：没有 planner → 提纲 = 模版必需章节；没有 researcher → 主笔自己取证；没有 critic → 只跑确定性校验；没有 reviser → 不修订。每个角色可以指定自己的 CLI（连接 id 或 provider 名）、模型、推理强度、工具范围（写页 / 读文件 / 联网）与提示词文件；提示词缺省是 `playbooks/research/phases/<阶段>.md`，在 Settings 里改过的角色提示词写到 `playbooks/research/roles/<id>.md`，harness 会补上首行 `<!-- knode-phase: … -->` 标记。`phases.json` 记录每个会话的角色、CLI、轮数、成本与错误，写进任务 payload。

第三种模式 `native`：一个「主管」会话负责写页，profile 里标了 `native` 的角色注册为 CLI 自己的子代理——claude 用 `--agents <json>`（description / prompt / tools / model，并放开 `Agent` 工具），codex 用 `agents.enabled=true` 加每个角色一个 `agents.<id>.config_file` TOML 层（`model` / `model_reasoning_effort` / `web_search` / `developer_instructions`，运行目录 `agents/<id>.toml`）；cursor-agent 没有子代理定义，退回单会话。主管提示词是 `playbooks/research/phases/orchestrate.md`，子代理没有 `knode_write`。

## 5c. 三层 review（`review` 配置块）

| 层 | 配置 | 行为 |
| --- | --- | --- |
| 写入时解析 | `review.resolution: exact`（默认）/ `suffix` | `exact` 只在拼写与已知名称或别名一致时自动合并；`suffix` 额外允许"只差公司后缀"的名称。`entity_alias_keys.kind` 区分 exact / bare 键（迁移 v8） |
| LLM 复核 | `review.llmJudge: off / suggest（默认）/ auto`，`llmMinConfidence`、`autoMergeMinConfidence`、`maxJudgedPerRun` | 夜间审计把候选对连同描述与原文片段交给 LLM 判"是否同一实体"；`suggest` 把判定写进建议；判"不同"且置信 ≥ 阈值的对记为 rejected（actor `llm-judge`，不再提出）；`auto` 在置信 ≥ `autoMergeMinConfidence` 时直接 `applyMerge`（可撤销） |
| 断言复核 | `review.claims: off / suggest（默认）` | 对开放 dispute 与 `suspected` 断言，LLM 读两条断言及其原文片段给出 verdict（a / b / both / neither / unclear）与建议动作（提升来源、降级、保留争议、需外部核实），写成 `knowledge` 建议 |
| 外部核实 | `review.external: off / verify（默认）/ research` | 联网的总开关：`off` 永远不联网；`verify` 只让 `verify` 任务（模版 `verify.md`，输出 `wiki/reviews/`）联网，但 profile 或角色写 `web: on` 可把联网放宽到所有任务；`research` 全开，profile / 角色仍可关。claude 放开 WebSearch/WebFetch，codex 设 `web_search = live | cached`（新鲜度来自 profile），cursor 只能靠提示；页面 frontmatter 的 `sameAs` 变成待审 merge 建议，`notSameAs` 记为已拒绝 |

`knode-os review entities|claims`、`POST /api/review/claims`、`POST /api/entities/dedupe` 可手动触发；夜间 Tier‑2 依次跑 claim 审计、重复实体审计（含 LLM 复核）、断言复核、推荐刷新、lint。

## 5d. 研究 profile（`src/research/profile.ts`，`playbooks/research/profiles/<name>.yaml`，`research.profile`）

profile 把「怎么研究」从 harness 里抽出来：一份 YAML 同时回答推理多深、能不能联网、事实要多硬、什么时候停、页面长什么样，以及有哪些子代理。由 `research.profile` 选中，缺失时退回内置 `default`。

| 块 | 键 | 作用 |
| --- | --- | --- |
| `reasoning` | `effort: default / low / medium / high / xhigh / max` | 每个会话的推理强度；角色可覆盖（`default` = 跟 CLI 自己的设置） |
| `search` | `web: inherit / on / off`；`freshness: live / cached`；`maxRounds` | 联网开关（只在 `review.external` 允许的范围内放宽或收窄，见 5c）、codex 检索新鲜度、每章节检索轮数（写进简报） |
| `verification` | `minSourcesPerClaim`；`preferPrimarySources`；`resolveConflicts: flag / prefer_primary / prefer_recent` | 写进简报；`minSourcesPerClaim ≥ 2` 时校验器要求每条 `fact` 自带 `sources: [...]`（`suspected` 只告警） |
| `stop` | `maxSections`；`marginalGain` | 提纲章节上限（代码强制）；「新一轮检索不再带来新事实就停」（写进简报） |
| `output` | `citations`；`uncertainty`；`evidenceTable` | 写进简报；`evidenceTable` 让 `## 证据表` 成为必需章节（校验 + 提纲都认） |
| `pipeline` | `'' / single / team / native` | 空 = 跟 `research.pipeline` |
| `roles[]` | `id, title, phase, enabled, agent, model, effort, tools{write, files, web}, parallel, rounds, maxTurns, prompt, native, description` | 子代理定义（见 5b）；`agent` 为空 = `research.agent`，`prompt` 为空 = `phases/<phase>.md` |

内置四个（删除即重置为内置内容）：`default`（团队；强度与联网跟随 CLI 与 review 的默认值）、`quick`（单会话、medium、cached、最多 4 章节）、`thorough`（max、5 个并行研究员、2 轮评审、每条 fact 至少 2 个来源、证据表）、`native`（原生子代理、high）。简报里多出一段「研究规范（profile: …）」，把上面这些写成 agent 能读的规则。

每个 CLI 的适配集中在 `src/research/launch.ts` 的 `sessionArgs`（`research export` 打印的命令行同样带上）：

| | claude | codex | cursor-agent |
| --- | --- | --- | --- |
| 推理强度 | `--effort <level>` | `-c model_reasoning_effort="…"`（`max` → `xhigh`） | 模型名括号 `model[effort=high]`（`xhigh`/`max` → `high`；没填模型就设不了） |
| 联网 | `WebSearch` / `WebFetch` 进 `--allowedTools` 或 `--disallowedTools` | `-c web_search="live" | "cached" | "disabled"`（不再用 `tools.web_search`） | 只能靠提示 |
| 读文件 | `Read` / `Grep` / `Glob` 进白名单或黑名单 | 沙箱只读，总是可读 | `--add-dir`，总是可读 |
| 原生子代理 | `--agents <json>`，并放开 `Agent` / `Task` | `agents.enabled`、`agents.max_concurrent_threads_per_session`、`agents.default_subagent_reasoning_effort`、`agents.<id>.description`、`agents.<id>.config_file` | 不支持（退回单会话） |

入口：Settings 页「03 · Deep research」——选运行任务的 CLI、并发与超时、profile，编辑 profile 的强度 / 联网 / 核实 / 停止 / 输出，以及每个角色的 CLI、模型、强度、工具与提示词（另存为新 profile、重置内置）；`GET /api/research/profiles`、`GET/PUT/DELETE /api/research/profiles/:name`（PUT 带 `prompts: {roleId: text}` 会把改动的提示词写成文件，`activate: true` 顺带切换）；`PUT /api/config` 的 `research` 块（agent / model / profile / pipeline / 并发 / 轮数 / 超时 / auto）；`knode-os research profiles`、`knode-os research profile <name> [--use]`。

## 6. 推荐与问答归档（`src/research/recommend.ts`）

信号（各自在候选集内归一化）：提及 + 检索热度、近 30 天 `receipts.entities` 的需求、图度数、未解决 dispute、过期 / 被替代事实；
页面状态：无页 +0.25、仅存根 +0.15、研究页写于最新证据之前 → **refresh** 候选；热点簇无综述页 → concept；
`receipts.query` 归一聚类重复 ≥2 或本地回答有缺口 → question。结果写成 `suggestions` kind `wiki`（payload 即任务），
接受 → `queueJob`；`research.auto.enabled` 时每天自动接受前 `dailyJobs` 条。人写的页面不推荐刷新。

## 7. wiki lint（`src/wiki/lint.ts`）

零 LLM：孤儿页、坏 wikilink、研究页早于最新证据（→ refresh 建议）、隔离超期未审、`stale_after` 过期、正文仍含被替代的事实、
有 open dispute 的页。报告写成视图页 `wiki/lint/<date>.md`（`lint` scope），夜间 Tier‑2 之后运行；`knode-os wiki lint`、`POST /api/wiki/lint`。

## 8. 配置与迁移

- `database.kind` 出厂默认改为 `postgres`（共用库 `knode`、按工作区分 schema）；`pglite` 保留为显式可选，测试套件通过 `KNODE_DATABASE_KIND=pglite` 使用它；连不上 Postgres 时报清晰错误而不是静默回退。
- `server.mcp { enabled, path }`；`knode-os connect <client>` 默认注册 HTTP 端点（`--stdio` 才是独立进程）。
- `research { agent, model, profile, pipeline: single | team | native, maxTurns, timeoutMs, concurrency, runsDir, keepRuns, readDirs, researchers, reviewRounds, auto { enabled, dailyJobs } }`（profile 文件在 `playbooks/research/profiles/`，内置 default / quick / thorough / native）；
  `graph { ontologyPacks }`；`review { resolution, llmJudge, llmMinConfidence, autoMergeMinConfidence, maxJudgedPerRun, claims, external }`。
- 迁移 `V8_REVIEW`：`entity_alias_keys.kind`（exact / bare）。
- 迁移 `V7_WIKI_RESEARCH`：`relations.valid_from/valid_to`、`claims.event_at/observed_at/superseded_by`、`documents.doc_date`、
  `entities.canonical_id/name_key`、`entity_alias_keys`、`entity_links`、`research_jobs`、视图补列 + `v_entity_links` / `v_research_jobs`；
  `entity_embeddings` 随 embedding 维度在开库时建。
- token：`<data>/.knode/mcp-token`（0600），`knode-os connect <claude|codex|cursor> --http` 注册 HTTP 端点。

## 9. 未决 / 已知限制

1. codex 对 HTTP MCP 的鉴权用 `bearer_token_env_var`（已按其 CLI 帮助实现），工作区字段走 query；未实测 codex 会否忽略 `-c` 里的 `mcp_servers.*`。
2. cursor‑agent 的 `--add-dir` 是否只读、`--mode ask` 是否阻断 MCP 写工具未实测；默认不用 `--mode`。
3. Postgres 后端下多进程并发 apply 可能产生短暂重复实体（PGlite 串行化事务不会）；夜间审计会提出合并。
4. 服务端改动需 `macos/scripts/package-app.sh` 重新打包 macOS App。初始化（kind = `init`）、对话入口与研究 agent 的后续改进见 [07 — 初始化与对话](07-init-and-chat.zh-CN.md)。
5. 原生子代理模式按官方配置参考实现（claude `--agents` 的 description / prompt / tools / model；codex `agents.*` 与子代理层里的 `developer_instructions`），尚未用真 CLI 跑过；cursor-agent 的 `effort` 只见过 `high` 的示例，`xhigh` / `max` 都映射成 `high`。
6. `claude --effort` 需要较新的 CLI（老版本会因未知参数退出），所以内置 `default` profile 的强度是 `default`（不传参数）；要用 `max` 请选 `thorough` 或自建 profile。
