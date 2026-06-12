# knode-os

> 面向 coding agent 的本地优先知识操作系统 —— 在你的文档、agent 执行 trace 和用过的 skills 之上,自动构建 **wiki** + **知识图谱** + **向量召回**。一个进程、一个文件夹、内嵌 Postgres。

[English](./README.md) · [设计文档](./docs/design/00-overview.md)

knode-os 结合了两个项目的核心思想:[llm_wiki](https://github.com/nashsu/llm_wiki) 的"让 LLM 维护一个持久、互链的 wiki,而不是每次从零做 RAG",以及 [gbrain](https://github.com/garrytan/gbrain) 的"Markdown 是事实源,Postgres 只是可随时重建的派生索引"——并把它们对准 coding agent 留下的资产:文档、会话 trace、skills。

## 特性

- **一条命令**:`knode-os serve` 同时启动 Web 页面、REST API、文件监听、trace 定时同步和夜间 dream。
- **文件系统即数据库。** 数据目录(`raw/` + `wiki/`)就是普通的 markdown 文件,可以直接读、改、grep、`git init`。`.knode/` 下的 [PGlite](https://pglite.dev)(WASM 版 Postgres + pgvector)索引随时可删,`knode-os ingest` 即可重建。
- **自动收集 agent trace。** Claude Code(`~/.claude/projects`)与 Codex CLI(`~/.codex/sessions`)的会话记录自动镜像到 `raw/traces/`,用过的 skills 进 `raw/skills/`。
- **混合检索**:pgvector 余弦召回 + Postgres 全文检索 + 图谱信号,RRF 融合。开箱即用、完全离线(内置哈希 embedder);配置任意 OpenAI 兼容的 embedding 接口可获得生产级效果。
- **知识图谱**:每次摄入都做确定性的 `[[wikilink]]` 布线(不需要 LLM),配置 LLM 后追加实体/关系抽取。支持多跳图搜索与图谱洞察(枢纽节点、孤立节点)。
- **`/dream`**:每晚(或手动)分析近期 agent 会话——问了什么、哪些工具失败、什么在重复——产出对 **skills**、**memory**、**知识库** 的改进建议,在页面上一键接受/拒绝。
- **MCP 服务**:Claude Code / Codex(命令行或 App)可直接搜索、提问、读写知识库。
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
├── raw/
│   ├── docs/           # 用户上传的文档
│   ├── traces/         # claude/ + codex/ 会话记录(自动同步)
│   └── skills/         # agent 用过的 skills 与 prompts(自动同步)
├── wiki/
│   ├── index.md  overview.md  log.md
│   ├── entities/  concepts/  sources/  dreams/
└── .knode/             # 派生的 PGlite 索引 —— 可随时删除重建
```

### 配置模型

编辑 `<data>/knode.config.json`:

```jsonc
{
  "embedding": {
    "provider": "openai",            // "local" = 离线哈希 embedder(默认)
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "env:OPENAI_API_KEY",  // 或直接填 key
    "model": "text-embedding-3-small",
    "dimensions": 1536
  },
  "llm": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "env:OPENAI_API_KEY",
    "model": "gpt-4.1-mini"          // 留空 = 关闭 LLM 功能,走启发式
  },
  "dream": { "schedule": "03:00", "lookbackDays": 7 }
}
```

任何 OpenAI 兼容端点都可以(Ollama、vLLM、硅基流动等)。修改 `dimensions` 会在下次启动时重建 embedding 表。

配置 LLM 后解锁:图谱实体/关系抽取、`ask` 问答、`wiki generate` 文档摘要、LLM 级 dream 分析。不配置时所有功能仍以确定性/启发式路径运行。

## CLI

```
knode-os init                 创建数据目录与数据库
knode-os serve [-p port]      Web 页面 + API + 文件监听 + trace 同步 + 夜间 dream
knode-os ingest [--no-llm]    增量摄入:分块 → embedding → 图谱(按 sha256 去重)
knode-os search <q> [-m hybrid|vector|keyword] [-k n] [--json]
knode-os ask <问题>           带引用的问答 + 知识缺口(需配置 llm.model)
knode-os graph [q] [--depth n] [--insights] [--json]
knode-os wiki generate        生成文档摘要页与实体页
knode-os trace sync           拉取新的 Claude Code / Codex trace 与 skills
knode-os dream [--lookback d] 分析 trace → skills/memory/知识库建议
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

暴露的 MCP 工具:`knode_search`、`knode_graph_search`、`knode_ask`、`knode_ls`、`knode_read`、`knode_write`(仅限 wiki/ 与 raw/docs)、`knode_ingest`、`knode_graph_insights`、`knode_suggestions`。

典型闭环:agent 在重新推导项目知识前先搜索;把新结论通过 `knode_write` 写进 `wiki/concepts/…`;下一个会话直接搜到。

## Web 页面

`knode-os serve` → http://127.0.0.1:9100

- **Files** —— 浏览目录树、markdown 编辑与预览、上传到 raw/docs(自动摄入)
- **Search** —— hybrid/vector/keyword 检索,展示分数构成
- **Ask** —— 带引用的问答与缺口分析
- **Graph** —— 力导向图谱浏览 + 洞察(枢纽/孤立节点/类型分布)
- **Traces** —— 已收集的 agent 会话
- **Dream** —— 手动触发 dream,审阅并接受/拒绝建议

## 开发

```bash
pnpm dev -- serve --data ./.dev-data   # tsx 直跑,无需构建
pnpm typecheck && pnpm test            # tsc + vitest
```

## 安全说明

服务只绑定 `127.0.0.1` 且无鉴权,请勿对外暴露。API key 支持 `env:VAR` 引用,配置文件可不落盘密钥。文件 API 被限制在数据目录内(防路径穿越);MCP 写操作仅限 `wiki/` 与 `raw/docs/`。

## License

MIT
