# 07 — 知识库初始化与对话入口：overview + AGENTS.md 指南 / chat / 研究 agent 改进

> 状态：**已实现**（2026‑09‑18）。本文接在 [06 — Wiki 研究 Agent](06-wiki-research-agent.zh-CN.md) 之后：
> 研究 runner 已经能写单页，本篇让它先把**整个知识库**读一遍并写出给后来 agent 的说明书，
> 再给人一个自然语言入口。英文版：[07-init-and-chat.md](07-init-and-chat.md)。

## 0. 目标与决策

一个新建（或刚导入一批文档）的工作区，对 agent 来说是黑箱：`wiki/overview.md` 还是 `initDataDir` 写下的模板、
`purpose.md` / `schema.md` 是占位符，agent 只能从零检索。人也一样：只有搜索框和"发起研究任务"，
没有一个地方能问"这个库里到底有什么"，也没有地方把口头知识交给它。

三个已确认的决策：

| 决策 | 结论 |
| --- | --- |
| D1 单次初始化的产出 | 一次运行只写两份：`wiki/overview.md`（总览/枢纽页）与数据目录根的 `AGENTS.md`（`CLAUDE.md` 为同内容副本）；规划阶段选出的主题页作为**普通研究任务自动入队**（默认最多 6 个），逐个走既有校验流程 |
| D2 对话里"教"的知识 | 先隔离：agent 写 `raw/docs/notes/<日期>-<slug>.md`（`actor: agent/<cli>`），立即 `knode_sync` 可查，但是 quarantined，与可信事实冲突时开 dispute；聊天界面提供一键"采纳（promote）" |
| D3 会话续接 | **不用 CLI 的 resume**：`syncTraces` 会把 `~/.claude/projects` 下所有 `.jsonl` 镜像进 `raw/traces/`，持久化的聊天会话会被当成 trace 收进知识库。每轮都是新进程 + 历史回放（`--no-session-persistence`） |

指南放数据目录根，而不是 `wiki/` 里：根文件不会被 `enumerateDeclared` 收成 source（它只额外收 `purpose.md` / `schema.md`）、
不被 watcher 监视、不进 OKF 校验；同时 `cd` 进数据目录直接开 Claude Code 就会自动读到 `CLAUDE.md`——这正是
codebase `/init` 的类比。`knode_write` 为此增加了根文件白名单 `AGENTS.md` / `CLAUDE.md`（`src/fs/files.ts`），
`knode_forget` 与 `/api/forget` 则拒绝它们（不是 source）。

## 1. 初始化（研究 kind = `init`）

复用 `research_jobs` 队列、service 循环、profile、取消与重试，只是多了前置步骤与第二个产出文件。

```
POST /api/research/init ─▶ research_jobs(kind=init) ─kick─▶ service 认领
 runResearchJob
   ├─ prepareInit（src/research/init.ts）                    payload.steps 逐步落库，UI 可见
   │    sync → drainTier1（可配置、有时间上限）→ ensureEntityStubs / HotTopics / SourcesIndex
   │    → surveyKnowledgeBase（空库直接失败："先添加文档"）
   ├─ prepareRunWorkspace：brief = 「知识库概况」+ 上一版指南全文 + 两个输出契约
   ├─ team 流水线，提示来自模板声明的 phases（init-plan / init-research / init-synthesize）
   │    plan → {sections, topics}；research 按"领域"并行；synthesize 写 overview 与 AGENTS.md
   │    review/revise 同时看两份文件
   ├─ validateResearchPage(overview) + validateCompanions(AGENTS.md)
   └─ finalizeInit：sync only overview → 搬运「## 人工备注」→ 盖戳 → 复制 CLAUDE.md → 入队 topics
```

**模板级 phase 提示。** `ResearchTemplate` 新增两个键：`companions`（第二个输出文件及其必需章节）与
`phases`（这个 kind 用哪几份提示，相对 `playbooks/research/`）。提示优先级：模板 `phases[phase]` > 角色自己的
`prompt` > `phases/<phase>.md` > 内置常量（`rolePromptText(dataDir, role, override)`）。这样 init 不必新建 profile，
任何 profile 的角色跑 init 任务时都会拿到 init 的提示。

**为什么总览的章节叫「资料概况」而不是「资料来源」**：`outlineFrom` 会把标题含 `来源|sources|证据表|evidence`
的章节判为主笔自填、不派研究员（`src/research/pipeline.ts`），叫"资料来源"就没人去调查了。

**`selfEntity: false`。** wiki bundle 里每个非保留页默认会生成一个"页面自身实体"（`planWireFromMarkdown`）。
总览页讲的是整个库，不是一个实体，所以骨架里写 `selfEntity: false`，`classify`（`src/ingest/apply.ts`）尊重它——
否则图里会多出一个叫"知识库总览"的实体。

**人工备注。** 指南的最后一节 `## 人工备注` 归人所有：运行前把现有指南备份到 `.runs/<id>/existing-AGENTS.md`，
校验通过后由 runner 把上一版这一节的正文原样搬进新指南（`carryOverHumanNotes`），agent 只需保留标题。
第一行的 `<!-- knode-init: {"job","at","agent"} -->` 是盖章，`knode_survey` 读回它显示"谁在什么时候生成的"。

**种子模板不算人写的。** `humanParagraphsOf` 会保护现有页面里 ≥40 字的段落；`initDataDir` 写的
`wiki/overview.md` 正文恰好够长，所以 `isSeedTemplate`（`src/fs/datadir.ts`）判断文件是否仍等于模板，是则不保护。

**失败回滚。** 校验不过时：页面移到 `.runs/<id>/rejected.md`、指南移到 `rejected-AGENTS.md`，两者都从备份恢复，
任务退回重试一次（`MAX_ATTEMPTS = 2`）。

## 2. 指南送到 agent 面前的三条通道

1. **运行工作区**：研究与聊天会话的 `CLAUDE.md` / `AGENTS.md` = 协议 + 模板 + `# 知识库自述`（指南、purpose、schema）。
2. **MCP `instructions`**：`src/mcp/instructions.ts` 把三行固定前言 + 指南（截断 6 000 字符）作为 server instructions
   返回给任何连上来的 agent（stdio 与 HTTP 两个入口都传），按文件 mtime 缓存——HTTP 端点每个请求新建 server。
3. **`knode_read "AGENTS.md"`**：研究协议第 0 步写明"不熟悉这个库就先读指南、再 `knode_survey`"。

## 3. `knode_survey` / `GET /api/survey`

`src/research/survey.ts`，确定性、无 LLM、约十条查询：文档按目录与日期范围、实体按类型与提及排名、
关系谓词（含 `unknownPredicates`）、claims 按状态与事件范围、wiki 页（生成 / 人写 / 研究）、本体包、
外部数据源、抽取积压与预算、指南与总览的状态、`purpose.md` / `schema.md` 是否仍是模板。
`renderSurvey` 把它渲染成 brief 里的 `## 知识库概况`，UI 的初始化卡片直接用数字部分。

## 4. 对话入口（`src/chat/`）

| 表 | 说明 |
| --- | --- |
| `chat_conversations` | id / title / agent / model / status(`idle`\|`running`) / created_by / payload |
| `chat_messages` | conversation_id + seq 唯一；role、content、events(jsonb)、payload(jsonb，v10)、turns、cost_usd、error |

一轮 = 一次 agent 会话（无头 CLI，或 `serve` 进程内的内置 agent），cwd 是 `.runs/chat/<会话 id>/`（每轮重写 schema 文件，协议与指南的改动立刻生效）。
提示由 `playbooks/chat/turn.md` 渲染：最近 `chat.historyTurns` 条历史（助手消息各截 2 000 字符、总量 40 000 字符封顶）、
本轮消息、写入约定。回复落库时 `events` 来自 transcript 里解析出的工具调用（`parseActivity`：claude / cursor 的
stream-json `tool_use` + `tool_result`；codex 没有事件流则为空），外加回复里 `<!-- knode:wrote <路径> -->` 标记的文件。

- **状态**：路由 202 立刻返回，客户端每 1.5 s 拉 `GET …/status`（运行中解析当前 transcript，给出实时工具活动）。
- **取消**：`killAgentsFor('chat:<id>')`，该轮助手消息记 `error: cancelled`，会话回到 idle。
- **教学**：协议要求先复述确认，再 `knode_write` 笔记 + `knode_sync only:[路径]`，并告诉用户它是 quarantined。
- **联网**：`chatWebAllowed` 只在 `review.external` 允许的范围内收紧或放开，从不越过主开关。

### 4.1 与 Ask 合并（2026‑09‑19）

原来 Ask（`POST /api/ask`，一次检索 + 一次 LLM 调用、无状态）与 Chat 是两个一级入口，但对人来说是同一个意图的
两种成本档。现在界面上只剩一个 **Ask**，模式开关在输入框旁：

| | 快速（quick） | Agent |
| --- | --- | --- |
| 怎么答 | `ask()`（`src/search/ask.ts`）一次检索 + 一次 LLM 调用 | 一次 agent CLI 会话，走 MCP |
| 路由返回 | **200**，回复已写库，无需轮询 | 202 + 轮询 `…/status` |
| 前置条件 | 无 —— **不需要 MCP 端点，也不需要装 agent CLI** | 两者都要，否则 503 |
| 回复怎么自述 | `payload`：citations / gaps / facts | `events`：工具调用芯片 |
| 能否写入 | 否 | 能（隔离笔记，可采纳） |

- **模式落在哪**：会话级在 `chat_conversations.payload.mode`（该列本来就有）；回复级在新增的
  `chat_messages.payload`（**migration v10**）。`contexts` 故意不存——整块 chunk 太大且可重算。
- **路由**：`POST …/messages` 增加可选 `mode`（缺省 `agent`，老客户端行为不变）。quick 分支在两处 503 检查
  **之前**返回，这是「没装 Claude Code 也能用 Ask」的关键。实现在 `src/chat/quick.ts`。
- **一问一会话**：每次快速提问新建一条会话，列表读起来就是一部提问史；快速回答下方的「交给 agent 深入」
  会用同一个问题另开一条 agent 会话。模式从不改写已有会话的含义。
- **`POST /api/ask` 原样保留**：MCP 的 `knode_ask` 与 CLI 都依赖它，`quick.ts` 也是调它。
- **配置键不动**：`knode.config.json` 里仍是 `chat.*`（改键等于动用户的配置文件），只有 UI 文案改成
  「Ask · Agent 模式」。`chat.keep` 默认从 50 提到 200 —— 一问一会话把 50 条大约一天就填满了。

## 5. 研究 agent 的改进

1. **按任务取消**：`launch.ts` 的子进程注册表从 `Set` 改成 `Map<jobId, Set<ChildProcess>>`，新增
   `killAgentsFor(jobId)` / `clearCancelled(jobId)` 与 `JobCancelledError`。被杀的子进程会像正常退出一样
   resolve（`runProcess` 在 `close` 上 resolve），所以 `launchSession` 在返回后再查一次取消标记并抛出，
   否则 team 流水线会带着错误继续跑下一阶段。流水线每个阶段之间还查一次数据库行，覆盖跨进程取消。
   runner 捕获后置 `cancelled`，不重试、不标 failed。
2. **tier‑1 串行**：`runTier1Pass` 按 dataDir 排队（与 `sync` 同样的 promise 链），初始化排空队列时不会与
   serve 的定时器抢同一批文档。
3. **任务进度**：`GET /api/research/jobs/:id` 现在同时返回 `steps`、`phases`（运行中直接读 `.runs/<id>/phases.json`）、
   `plan` 与可用的 transcript 标签；`?log=<label>` 可看某个阶段的 transcript。
4. **立即认领**：`startResearchLoop` 返回 `kick()`，`serve` 把它连同该工作区的 MCP 端点登记到 `createApp` 的
   `services`，入队后立刻开跑，不等 30 s 定时器。聊天路由也从这里取 MCP 端点。

## 6. 配置与迁移

```jsonc
"research": {
  "init": { "followUps": 6, "extraction": "drain", "extractionMaxMs": 900000 }
},
"chat": {
  "agent": "", "model": "", "effort": "default", "maxTurns": 30, "timeoutMs": 600000,
  "web": "inherit", "historyTurns": 12, "keep": 50
}
```

迁移 **v9**：`chat_conversations` / `chat_messages` 两张表。种子文件新增 `playbooks/research/init.md`、
`playbooks/research/phases/init-*.md`、`playbooks/chat/AGENTS.md`、`playbooks/chat/turn.md`（都不覆盖已有文件）。

## 7. 未决 / 已知限制

1. codex 的会话事件流没有在本次实现里解析，聊天界面对 codex 只显示"正在回答"，没有工具活动芯片。
2. 不用 CLI resume 是为了避开 trace 同步（见 D3）；代价是长对话每轮重放历史、输入 token 随轮数增长。
   若以后把 `raw/traces` 的采集范围收窄到项目目录，可以再考虑 `--resume`。
3. init 的产物质量完全取决于所配 CLI；本仓库的测试用假 agent 覆盖流程（步骤、两份文件的校验、回滚、
   人工备注搬运、后续任务入队），没有覆盖"写得好不好"。
4. `knode_survey` 每次实时算（约十条查询）；超大库上初始化卡片的刷新可以考虑缓存。
5. 聊天与研究共用 `research.readDirs` 与 `review.external`；还没有单独的聊天只读目录设置。
