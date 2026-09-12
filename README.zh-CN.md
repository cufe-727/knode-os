# knode-os

> 面向 coding agent 的本地优先知识操作系统 —— 在你的文档、agent 执行 trace 和用过的 skills 之上,自动构建 **wiki** + **知识图谱** + **向量召回**。一个进程、一个文件夹、内嵌 Postgres。

[English](./README.md) · [设计文档](./docs/design/00-overview.md) · [Agent Context Database（v2 重设计）](./docs/design/05-agent-context-db.zh-CN.md) · [OKF 兼容设计](./docs/design/02-okf-compatibility.md) · [Obsidian 兼容设计](./docs/design/03-obsidian-vault.md)

knode-os 结合了两个项目的核心思想:[llm_wiki](https://github.com/nashsu/llm_wiki) 的"让 LLM 维护一个持久、互链的 wiki,而不是每次从零做 RAG",以及 [gbrain](https://github.com/garrytan/gbrain) 的"Markdown 是事实源,Postgres 只是可随时重建的派生索引"——并把它们对准 coding agent 留下的资产:文档、会话 trace、skills。

## 特性

- **一条命令**:`knode-os serve` 同时启动 Web 页面、REST API、文件监听、trace 定时同步和夜间 dream。
- **文件系统即数据库。** 数据目录(`raw/` + `wiki/`)就是普通的 markdown 文件,可以直接读、改、grep、`git init`。`.knode/` 下的 [PGlite](https://pglite.dev)(WASM 版 Postgres + pgvector)索引随时可删,`knode-os ingest` 即可重建。
- **自动收集 agent trace。** Claude Code(`~/.claude/projects`)与 Codex CLI(`~/.codex/sessions`)的会话记录自动镜像到 `raw/traces/`,用过的 skills 进 `raw/skills/`。trace 供夜间 dream 分析使用(不进入搜索索引);skills 可被检索。
- **混合检索**:pgvector 余弦召回 + Postgres 全文检索 + 图谱信号,RRF 融合,并叠加温和的使用热度加权。开箱即用、完全离线(内置哈希 embedder);配置任意 OpenAI 兼容的 embedding 接口可获得生产级效果。
- **分层知识图谱**:tier 0 在每次摄入时做确定性布线(`[[wikilink]]` + NLP 概念共现,不需要 LLM);变更文档进入 tier-1 队列,由 `serve` 后台(或 `knode-os extract`)在每日 token 预算内按热度优先做 LLM 实体/关系/断言抽取。抽取结果持久化到文档 sidecar,重建索引不会重复付费。支持多跳图搜索与图谱洞察(枢纽节点、孤立节点)。
- **`/dream`**:每晚(或手动)分析近期 agent 会话——问了什么、哪些工具失败、什么在重复——产出对 **skills**、**memory**、**知识库** 的改进建议,在页面上一键接受/拒绝。
- **实时数据源 —— 一个逻辑数据库。** 注册 MySQL、TimescaleDB、parquet/CSV 目录(DuckDB,模拟 HDFS)、JSON HTTP 端点、Prometheus 指标和对象目录:knode-os 把它们内省成知识图谱里的 capability(`datasource`/`dataset` 实体,按实体列采样生成 `appears_in` 边与 locator;端点和指标的绑定由已知的表和别名推导),并生成 `wiki/datasets/` 页面——行数据留在原系统、查询时实时获取。提到一个公司,图谱同时知道*哪些文档提到它*、*哪些表包含它*、*哪个 API 端点能查它*。
- **Context Pack。** `knode-os pack "<语句>"`(或 MCP 工具 `knode_context_pack`)自动匹配语句中的实体,沿图谱展开(文档 chunk、带 `STALE`/`CONFLICT` 标记的时效断言、关联的实时表),按 playbook 执行实时探针查询(带 asOf 时间戳、短 TTL 缓存、绝不落库),并输出缺口分析和可直接执行的后续 SQL。
- **会学习的 playbook。** Context pack 由 agent 可编辑的 `packs/*.md` 工作流驱动;每次构建记录到 `pack_events`,`knode-os pack-optimize`(也随夜间 dream 运行)把失败/缺口模式转化为完整的 playbook 修订建议——接受后直接写回 `packs/`,下一次查询就跑在更好的脚本上。
- **MCP 服务**:Claude Code / Codex(命令行或 App)可直接搜索、提问、读写、grep、对实时数据源执行原生 SQL、构建 context pack。
- **Google OKF v0.2 原生兼容**:`wiki/` 本身就是一个可移植的 Open Knowledge Format bundle；支持规范校验、版本路由、旧库迁移、外部 bundle 无损导入/导出，OKF 普通 Markdown 链接会进入知识图谱。v0.2 的溯源/信任/生命周期字段(`generated`、`verified`、`status`、`stale_after`)会被识别,v0.1 bundle 仍按规范给出的回退路径读取。未知类型、扩展 frontmatter 和断链按规范宽容处理。
- **原生 Obsidian Vault**:`wiki/` 可直接在 Obsidian 中作为 Vault 打开，内置 Vault 配置与附件目录；支持 Properties、别名、标签、`[[Wikilink]]`、路径链接、标题/块引用和 `![[嵌入]]`。OKF 导入和导出的每个知识 bundle 也自动是独立 Vault。
- **`ask`**:基于知识库的带引用问答,并显式列出"知识库还缺什么"。

## 快速开始

```bash
pnpm install && pnpm build

# 初始化数据目录(默认 ~/.knode-os,可用 --data <path> 或 $KNODE_OS_DATA)
node dist/cli.js init --data ~/knode-data

# 往 <data>/raw/docs 放一些 markdown/文本,然后
node dist/cli.js ingest --data ~/knode-data
node dist/cli.js search "向量召回" --data ~/knode-data

# 启动全部服务(Web 页面 http://127.0.0.1:9100)
node dist/cli.js serve --data ~/knode-data
```

全局安装(`npm link` 或 `pnpm add -g .`)后可直接使用 `knode-os` 命令。

### 数据目录

```
<data>/
├── knode.config.json   # embedding / llm / server / dream 配置
├── purpose.md          # 这个知识库是干什么的
├── schema.md           # wiki 结构规则
├── raw/                # 原始输入,永不改写
│   ├── docs/           # 用户上传的文档
│   ├── traces/         # claude/ + codex/ 会话记录(自动同步)
│   └── skills/         # agent 用过的 skills 与 prompts(自动同步)
├── cooked/
│   └── docs/           # 文本、PDF、图片统一转换出的 Markdown(实际索引层),以及
│                       # <name>.knode.json sidecar(元数据、LLM 抽取结果、
│                       # 使用热度),重建数据库也不会丢失
├── wiki/                 # 原生 OKF v0.2 bundle + Obsidian Vault
│   ├── .obsidian/        # Vault 配置(已有设置绝不覆盖)
│   ├── attachments/      # Obsidian 附件
│   ├── index.md  overview.md  log.md
│   ├── entities/  concepts/  sources/  dreams/
└── .knode/             # 派生的 PGlite 索引 —— 可随时删除重建
```

搜索结果里的引用路径是 `cooked/docs/...`,即你放进 `raw/docs/` 文件的归一化副本。

通过 Web UI 使用 `serve` 时，`--data` 是所有 Workspace 的根目录。一个用户可以拥有多个 Workspace；每个 Workspace 都有一套完整、独立的上述目录结构：

```
<data>/
├── users/<username>/workspaces/<workspace-id>/  # 私有文件、配置、Wiki 和 PGlite 索引
└── teams/<team-name>/                         # 选择同名 Team 的用户共享
```

可在 Workspace 菜单中创建和切换空间。使用 **设置 → 清空 Workspace** 时，服务会先关闭该空间的后台任务，再永久删除整个目录（文件、数据库、图谱、trace 和配置），最后在原名称下重建一棵干净的空目录树。新建或刚清空的空间会暂停历史 trace 自动同步；在 **Traces → sync now** 主动同步一次后，才会导入历史并恢复定时同步。

原来直接位于 `<data>/raw`、`<data>/wiki`、`<data>/.knode` 的数据会原样保留，不会自动迁移。CLI 命令可以直接指定某个隔离目录，例如 `--data ~/.knode-os/users/admin/workspaces/default`。

### 配置模型

每个 Web 工作空间都有独立的模型配置。切换到目标个人或 Team 工作空间后，可在 **Settings** 中配置，也可以直接编辑对应文件：

- 用户 Workspace：`<data>/users/<username>/workspaces/<workspace-id>/knode.config.json`
- Team 空间：`<data>/teams/<team-name>/knode.config.json`

只通过 CLI 使用的独立数据目录仍然读取 `<data>/knode.config.json`：

```jsonc
{
  "embedding": {
    "provider": "openai",            // 默认为 "local":离线哈希 embedder,384 维
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "env:OPENAI_API_KEY",  // 或直接填 key
    "model": "text-embedding-3-small",
    "dimensions": 1536
  },
  "llm": {
    "provider": "openai",            // 也可用 "codex-cli" / "claude-cli" / "cursor-cli"
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "env:OPENAI_API_KEY",
    "model": "gpt-4.1-mini"          // 留空 = 关闭 LLM 功能,走启发式
  },
  "extraction": {
    "entityLlm": { "provider": "codex-cli", "model": "" },
    "conceptLlm": { "provider": "cursor-cli", "model": "" },
    "documentLlm": { "provider": "codex-cli", "model": "" } // 视觉模型/API/Codex/Claude Code
  },
  "dream": { "schedule": "03:00", "lookbackDays": 7 }
}
```

任何 OpenAI 兼容端点都可以(Ollama、vLLM、硅基流动等)。实体提取、Concept 综合和文档视觉转换都可以独立路由。文本型 PDF 在本地提取；图片和扫描型 PDF 可使用支持视觉的 OpenAI 兼容模型、Codex CLI 或 Claude Code CLI 转成 Markdown。修改 `dimensions` 会在下次启动时重建 embedding 表。也可以在 Web 页面的 **Settings** 标签里编辑并测试各条模型路由。

其他配置块(用 `knode-os config` 查看完整默认值):`ingest`(分块大小/重叠、文件监听)、`extraction`(每日 token 预算、批大小、间隔、tier-1/2 模型、是否抽取断言)、`heat`(热度半衰期、搜索加权、冷判定阈值)、`trace`(Claude/Codex trace 目录、skill 目录、同步间隔)、`server`(host/port)。

配置 LLM 后解锁:tier-1 实体/关系/断言抽取、`ask` 问答、`wiki generate` 文档摘要、tier-2 社区页、LLM 级 dream 分析。不配置时所有功能仍以确定性/启发式路径运行。

## CLI

```
knode-os init                 创建数据目录与数据库
knode-os serve [-p port]      Web 页面 + API + 文件监听 + trace 同步 + tier-1 抽取循环
                              + 热度回写 + 夜间 dream 与 tier-2 精炼
knode-os sync [--only p..] [--verify] [--no-llm] [--no-datasources]
                              把声明态(raw/docs、wiki、skills、数据源配置)与索引对账:变更文件作为
                              scope 应用,被删除的源 dispose(它产生的所有效果全部撤销),依赖它们的
                              wiki 视图再生或归档。`ingest` 是别名。
knode-os lineage show <entity|relation|claim|page|document> <id>
                              某条图数据背后的证据(来源 scope、抽取器、系统时间窗口)
knode-os history <path>       一个源的 apply / dispose / purge 历史
knode-os forget <path>        删除源、dispose 并清除其历史(不可逆)
knode-os purge [--before iso] [--archived]  物理清除已 dispose 的历史 / 归档页面
knode-os rebuild [--history]  删除 .knode/db 并从文件 + ledger 重建
knode-os extract [--batch n]  在每日预算内消费 tier-1 LLM 抽取队列
knode-os datasource list|sync             查看已注册实时表 / 重新内省 schema 进图谱
knode-os datasource query <id> <sql>      对数据源执行只读原生 SQL
knode-os pack <语句> [--json] [--as-of iso] [--valid-at iso]
                                          构建 context pack(实体+证据+实时探针+缺口建议)
knode-os pack-optimize [--apply]          从 pack_events 学习 → playbook 修订建议
knode-os demo seed-stock                  股票分析 demo 数据(见 demo/stock/README.md)
knode-os search <q> [-m hybrid|vector|keyword|sag] [-k n] [--as-of iso] [--json]
knode-os ask <问题>           带引用的问答 + 知识缺口(需配置 llm.model)
knode-os graph [q] [--depth n] [--as-of iso] [--valid-at iso] [--insights] [--json]
                              (无查询时输出高频实体概览;--as-of 从 evidence 现算当时的图)
knode-os obsidian init [dir]           初始化/修复 Obsidian Vault(默认 <data>/wiki)
knode-os obsidian status [dir]         检查 Vault 是否可直接打开
knode-os okf validate [bundle] [--json]  校验 OKF v0.2(默认校验 <data>/wiki)
knode-os okf migrate [--dry-run]         将旧版 wiki 结构迁移到 OKF v0.2
knode-os okf import <bundle> [--name n]  无损导入到 raw/docs/okf/<name>
knode-os okf export <dir>                校验并导出原生 wiki bundle
knode-os wiki generate        生成文档摘要页与实体页
knode-os wiki refine          tier-2:热点社区概念页 + 断言审计 + 热门话题块
knode-os trace sync           拉取新的 Claude Code / Codex trace 与 skills
knode-os dream [--lookback d] 先同步 trace,再分析 → skills/memory/知识库建议
knode-os mcp                  在 stdio 上运行 MCP 服务
knode-os connect claude|codex 把 MCP 服务注册到 agent CLI
knode-os config               查看当前配置(密钥已脱敏)
```

所有命令都支持 `--data <path>`(或设置 `KNODE_OS_DATA`)。

## 在 Claude Code / Codex 中使用

```bash
knode-os connect claude   # 执行 claude mcp add --scope user knode-os -- node <cli> mcp --data <dir>
knode-os connect codex    # 在 ~/.codex/config.toml 追加 [mcp_servers.knode-os]
```

暴露的 MCP 工具:`knode_resolve`(优先调这个,见下)、`knode_plan`、`knode_feedback`、`knode_capabilities`、`knode_checkout` / `knode_commit` / `knode_worksets`(为长任务锚定一致视图,结束时把结论写回为 Source)、`knode_absences`(查过但没找到的东西)、`knode_disputes` / `knode_trust`(矛盾,以及提升被隔离的写入)、`knode_subscribe`(订阅实体/源/意图的变化)、`knode_learning`(planner 学到了什么)、`knode_search`、`knode_graph_search`、`knode_claims`、`knode_ask`、`knode_ls`、`knode_read`(路径以 `/` 开头则读虚拟文件系统)、`knode_write`(仅限 wiki/、raw/docs 与 packs/)、`knode_grep`、`knode_ingest` / `knode_sync`、`knode_lineage`、`knode_history`、`knode_forget`、`knode_okf_validate`、`knode_graph_insights`、`knode_suggestions`、`knode_context_pack`、`knode_datasources`、`knode_query`(只读原生 SQL,`source="catalog"` 可查知识库自身的 `v_*` 视图)。三条时间轴互相独立:`as_of`(系统时间:当时相信什么)、`valid_at` / `valid_range`(世界时间:断言何时成立)、`freshness`(实时读最多可以多旧);`kinds` / `sources` 限定哪些源可以作答。

**用 `knode_resolve` 取代 search。** search 返回的是「文本长得像」的东西;resolve 会先算出这**类**问题的答案需要哪些槽位(`intents/*.yaml` 里声明),把本地索引能答的部分直接答掉,剩下的编译成一份 plan 交给 agent 执行。填不上的必需槽位会出现在 `unknowns` 里,而不是用几篇看起来相关的文档糊过去。执行完用 `knode_feedback` 带上 receipt id 回报,下一次同类问题就会更准。

**闭环是真的闭上了。** feedback 喂给一个 ranker,它学习「哪个能力真正回答了哪个槽位」——评分依据是调用方**留下了什么**,而不是有没有返回行——并用 Thompson 采样做探索,让第一次抛硬币输了的源仍有机会被再试。反复奏效的 plan 形状会被蒸馏成 recipe 提案:先拿它派生自的 receipt 离线重放,再做只读安全检查,最后等人接受——**任何东西都不会自动发布**。`knode-os learning` 打印全部结果,`wiki/learning/` 让这些数字可复核。

**agent 的写入默认被隔离(quarantined)。** 它可检索、可引用、可归因,但不能悄悄变成知识库的立场:与 trusted claim 冲突时会开一条 dispute,而不是覆盖它。人复核后用 `knode_trust` 提升。空查询会被记成带过期窗口的负知识,于是同一条无果查询不会每个 session 重跑一遍——窗口一过又会重新尝试。

典型闭环:agent 在重新推导项目知识前先搜索;把新结论通过 `knode_write` 写进 `wiki/concepts/…`;下一个会话直接搜到。

## Web 页面

`knode-os serve` → http://127.0.0.1:9100

- **Files** —— 浏览目录树、Markdown 编辑与预览，上传文本/PDF/图片到 raw/docs(自动转换和摄入)
- **Search** —— hybrid/vector/keyword 检索,展示分数构成
- **Ask** —— 带引用的问答与缺口分析
- **Graph** —— 力导向图谱浏览 + 洞察(枢纽/孤立节点/类型分布)
- **Traces** —— 已收集的 agent 会话
- **Dream** —— 手动触发 dream,审阅并接受/拒绝建议
- **Settings** —— embedding 与独立的 Entity / Concept / 文档视觉模型路由；保存后按需重建 embedding 或刷新转换

## REST API(仅 localhost)

`GET /api/health · /api/config · /api/stats · /api/tree · /api/file · /api/search · /api/graph · /api/graph/insights · /api/entities · /api/documents · /api/okf/validate · /api/traces · /api/suggestions`
`PUT /api/config` · `PUT /api/file` · `DELETE /api/file` · `POST /api/config/test | /api/upload | /api/ingest | /api/ask | /api/mv | /api/mkdir | /api/traces/sync | /api/dream | /api/wiki/generate | /api/suggestions/:id/status`

Workspace 范围内的数据 API 需要请求头：`X-Knode-User`、`X-Knode-Workspace-Kind`（`personal` 或 `team`）、`X-Knode-Workspace-ID` 和 `X-Knode-Workspace-Name`。`GET/POST /api/workspaces` 只需要 `X-Knode-User`；`DELETE /api/workspace` 会彻底清空所选 Workspace。

## 开发

```bash
pnpm dev -- serve --data ./.dev-data   # tsx 直跑,无需构建
pnpm typecheck && pnpm test            # tsc + vitest
```

## 安全说明

服务只绑定 `127.0.0.1`，目前仍是浏览器 Mock 登录；Workspace 请求头只负责存储路由，不是真实的权限认证，请勿对外暴露。API key 支持 `env:VAR` 引用，配置文件可不落盘密钥。文件 API 被限制在当前 Workspace 目录内（防路径穿越）；写入、移动和删除操作（HTTP 与 MCP 一致）仅限 `wiki/` 与 `raw/docs/`。

## License

MIT
