# 13 — 客户端契约：其他项目如何使用 knode-os，从 rookie-trade 开始

> 状态：**提案**（2026‑10‑21）。English version: [13-client-contract.md](13-client-contract.md)。
> 建立在 [05](05-agent-context-db.zh-CN.md)（时间轴、工作集、信任层级）、[08](08-fragment-import.zh-CN.md)
> （rookie-trade 的导出）和 [12](12-remote-processing.md)（`/remote/v1` 及其 token）之上。契约的目录结构照搬
> AgentMux 的 `contract/`。

## 0. 现状

rookie-trade 是第一个要从自己的代码和 agent 里使用 knode-os 的项目，而不是由人手工把内容喂进来。设想的闭环是：
rookie-trade 抓取帖子和行情；knode-os 把文本变成知识；rookie-trade 依据这些知识开发并测试策略；结果和反馈再写回
知识库。Mac mini 上的其他项目（AgentMux、GoalLoop、homebook）也会使用同一套接口。

两者今天如何相连（knode-os 为 f9e084a，rookie-trade 为其 2026‑10‑20 的最新提交；finance 的数字来自 2026‑10‑21 的
只读聚合查询）：

| 连接 | 现状 |
| --- | --- |
| 文本 | finance 的 `ingest.linkedFolders` 里有 32 项，2026‑10‑17 手工建立。每一项是 rookie-trade `data/exports/content-markdown/` 下的一个作者目录，其中两项只含某位作者的一个平台。已索引 13,607 个文件，其中 3,818 个是周文件，来自 163 个作者目录中的 32 个。没有一个是飞书群，而 163 个目录里有 121 个是飞书，飞书约占 rookie-trade 200 万条内容中的 169 万条。 |
| 行情数据 | 没有接入；finance 没有任何 datasource。rookie-trade 以 Parquet 保存：`data/market/<dataset>/<year>/<YYYYMMDD>.parquet`（Tushare，2024‑01 → 2026‑10），另有美股、ETF 和期权数据。 |
| 代码 | 两个仓库互不调用。rookie-trade 没有 knode-os 客户端，knode-os 也没有在任何 Claude Code 配置里注册为 MCP server。 |
| 结果 | 没有结果库。Strategy Lab 按需计算报告并缓存在进程内；研究脚本把 JSON、CSV 和 Markdown 留在 `data/research/` 与 `docs/research/<strategy>/outputs/` 下。 |
| 知识 → 策略 | 靠人：规则从帖子里提炼到 `docs/sentiment-cycle/`、`docs/zeiwang-selection-rules.md` 和舒九的 wiki 页面。没有任何代码读取内容或知识库来产生信号。 |

knode-os 能给其他程序用的接口：

| 接口 | 面向 | 凭证 | 覆盖 |
| --- | --- | --- | --- |
| `/mcp`（仅限本机） | 编程 agent | 数据根目录的 `.knode/mcp-token`，或 `serve` 为它启动的 agent 在内存里签发的 `kmw_` token | 33 个工具：检索、claims、resolve / plan / feedback、工作集、订阅、catalog 与实时 SQL、写入（quarantined） |
| `/api` | Web UI 与 App | 会话 cookie，或 `knu_` 用户 token | 几乎所有功能；没有版本，按 UI 的需要设计 |
| `/remote/v1` | 远程 worker 与脚本 | `knr_` token：哈希存储、有 scope（`label`、`read`、`write`、`sql`）、绑定工作区、有审计和限流 | 租约任务；文档与 sync；检索（`q`、`mode`、`k`、`as_of`）；图；claims（`subject`、`object`、`text`、`limit` ≤ 500）；实体；catalog SQL（≤ 1,000 行） |
| CLI | 管理员 | 无：它自己打开数据目录 | 一切；`--data` 写错会打开一个全新的 schema |

五个发现决定了这份设计。

1. **无法按过去某一时刻读取。** finance 的 206,852 条现存 claim 在 2026‑10‑17 到 2026‑10‑21 之间进入索引，描述的
   却是 2010–2026 年。`as_of` 是系统时间，所以 `as_of=2025-06-30` 什么也返回不了：它能固定一个视图，却回答不了
   「当时能知道什么」。其他时间参数也补不上：
   - `search()` 只接受 `as_of`、kinds 和路径前缀，与发布时间无关（`src/search/search.ts:203`）。
   - tier-1 claim 的 `observed_at` 是所在文档的日期，精度到天（`src/graph/llm-extract.ts:267`、`:330`）。周文件的
     日期是那周的周一，而 rookie-trade 会把一条帖子后来收到的评论渲染进帖子自己的周期文件，所以一个文件里有比它
     的日期晚几天甚至几周写下的文字。
   - claim 的状态、取代关系、dispute 和实体合并都由全部来源 fold 而成，包括更晚的来源。生成页面（摘要、概念页和
     研究页）则是用它们运行时已索引的一切写成的。
2. **远程写入是 trusted。** `PUT …/document` 以 actor `remote:<token>` 执行 sync，且不记录写入者
   （`src/remote/api.ts:325`）。隔离规则只匹配以 `agent`、`mcp` 或 `api` 开头的 actor（`src/lineage/trust.ts:27`），
   所以除非文档自己的 frontmatter 把它降级，它就是 trusted。同样的文字经 `knode_write` 写入则会被隔离。
3. **agent 拿到的是 owner token。** `knode-os connect claude` 用数据根目录的 token 把 knode-os 注册到 Claude Code
   的用户级配置（`src/cli.ts:1293`）。这个 token 能打开请求所指定的任何工作区（只要账户存在），并以
   `caller: 'owner'` 运行（`src/server/mcp-http.ts:173`）。owner 可以提升来源、裁决 dispute，而这正是 agent 自己的
   写入在等待的人工复核。没有一种持久 token 只以 agent 身份打开一个工作区。
4. **同一个内核上有三套各自手写的适配层。** `src/mcp/tools.ts`、`src/remote/api.ts` 和 `src/server/app.ts` 各自
   解析参数。`/remote/v1` 已经落后于 MCP：它的 claims 不接受任何时间或信任过滤，也没有 resolve、工作集和订阅。
5. **DuckDB 数据源只看一个平铺目录。** 它为 `path` 下直接存在的每个 `.parquet`、`.csv` 或 `.tsv` 文件建一个视图
   （`src/datasource/duckdb.ts:90`）。rookie-trade 的行情数据按年分子目录（仅 `daily/` 的 2025 年就有 243 个文件），
   所以只有顶层的三个文件（`stock_basic`、`trade_cal`、`ths_index`）会出现。

## 1. 决策

1. **一份契约，每类调用方一个适配层。** knode-os 增加一个和 AgentMux 一样的 `contract/` 目录：由操作定义生成的
   OpenAPI 3.1 文档和 JSON Schema、一个发现漂移就失败的 golden 测试，以及写明 `contract_version`、稳定性分级和
   变更流程的 `CONTRACT.md`。每个操作只定义一次（zod 输入与输出、一个 scope、一个 handler），同时挂成
   `/remote/v1` 路由和 MCP 工具。
2. **`/remote/v1` 就是对外的 HTTP API。** 它已经具备程序需要的鉴权模型，并在路径里写明工作区。`/api` 仍归 UI
   自己用，不进入契约。不再增加第三套 HTTP API。
3. **一个程序就是一个带角色和信任层级的 token。** 层级说明这个 token 写入的是证据（爬虫的导出：trusted）还是
   观点（agent 或策略的结论：quarantined）。远程写入像 MCP 写入一样记录写入者。任何程序 token 都不能提升来源或
   裁决 dispute。
4. **`known_at` 是第四条时间轴。** 它把一次读取限制在某一时刻之前已可获得的内容上，并重算由此 fold 出的一切。
   可获得性属于条目（一条帖子、一条评论、一条消息），不属于文件，由生产端声明。
5. **knode-os 是慢层。** 价格和逐帖信号留在 rookie-trade 的存储里。knode-os 提供身份、题材、规则、历史战绩以及
   它们背后的理由。它永远不在下单路径上。
6. **写回的是实验，不是事实。** 策略结果以 quarantined 的 `type: Experiment` 来源进入 knode-os，并链接到它所
   检验的对象。背后的数字留在 rookie-trade，作为 datasource 读取。
7. **SDK 要薄，并与契约放在一起。** `sdk/python`（包名 `knode-sdk`，导入名 `knode_sdk`）用 httpx 和类型化模型
   封装 `/remote/v1`，对照 golden schema 校验，并由 rookie-trade 通过 uv 的 path source 安装，和现在的
   `agentmux-sdk` 一样。
8. **CLI 仍是管理员的工具。** 项目调用契约，不去运行 `knode-os`。

## 2. 闭环

```
 rookie-trade                                                       knode-os · finance
 ────────────                                                       ──────────────────
 crawlers ─▶ content_v3.entry ─▶ review (LLM) ─▶ rt export, kb target ── linked folder ──▶ raw/docs/content-markdown/…
             posted_at,           relevant, instruments,   entry index                      │ tier 0: producer claims
             captured_at          stance, claims           in frontmatter                   │ tier 1: extraction (fallback)
                                                                                            ▼
 data/market/**.parquet ◀──────── duckdb datasource rt-market (read-only, glob tables) ──── graph · claims · locators
                                                                                            │
 Strategy Lab, research ◀── knode_sdk: evidence, mentions, claims (known_at, as_of) ────────┤
 agents in the repo     ◀── MCP: resolve, search, read (agent token) ───────────────────────┘
   │
   ▼
 run registry ─▶ record_experiment ── /remote/v1, agent token ────▶ raw/docs/rookie-trade/experiments/…   (quarantined)
   └─▶ track records per author ───── /remote/v1, producer token ─▶ raw/docs/rookie-trade/track-records/…
```

- **文本以文件形式进入。** 链接目录仍是批量通道。文件就是记录，每个效果都有血缘和逆操作，删掉文件就带走它产生
  的知识。导出升级到第 2 版（§6）。
- **数字留在原处。** 行情数据和运行登记表通过 datasource 就地读取（§5）。
- **策略经 SDK 读取，agent 经 MCP 读取。** 两者到达的是同一组操作（§3、§8）。
- **结果以来源的形式回来**，各自带着信任层级（§7）。

## 3. 契约

### 3.1 目录结构

```
contract/
  CONTRACT.md          contract_version、稳定性分级、鉴权与角色、四条时间轴、变更流程
  openapi.yaml         生成（OpenAPI 3.1）
  schemas/*.json       每种线上类型一个 golden JSON Schema，生成
src/contract/
  op.ts                defineOp()：id、method、path、scope、tier、输入/输出（zod）、MCP 名称与说明、handler
  ops/*.ts             documents、knowledge、evidence、worksets、subscriptions、sql、live、work
  remote.ts            把每个操作挂到 /remote/v1
  mcp.ts               注册每个有 MCP 名称的操作
  emit.ts              写出 openapi.yaml 和 schemas/（pnpm contract:emit）
tests/contract.test.ts 在内存里重新生成两者，与 contract/ 比对
sdk/python/            knode-sdk（§8.1）
```

### 3.2 每个操作只定义一次

```ts
export const listClaims = defineOp({
  id: 'claims.list',
  method: 'GET',
  path: '/w/:owner/:workspace/claims',
  scope: 'read',
  tier: 'stable',
  input: ClaimsQuery,   // subject, object, types, statuses, text, valid_at | valid_range, event_range,
                        // as_of, known_at, kinds, sources, trust, cursor, limit
  output: ClaimsPage,   // claims[], next_cursor, applied[]
  mcp: { name: 'knode_claims', description: '…' },
  handler: (ctx, input, caller) => queryClaims(ctx.store, claimQueryFrom(input, caller)),
});
```

- handler 拿到工作区的 `AppContext`、解析后的输入和一个 `Caller`（`{ via: 'token' | 'mcp', name, scopes, tier, agent }`）。
  适配层从 `knr_` token、数据根目录的 token 或签发的工作区 token 构造 caller，handler 看不到传输层。
- zod 4 的 `z.toJSONSchema` 生成 schema，MCP 注册取输入对象的 shape。路由适配层用同一个 schema 解析 query
  string 和请求体，所以两边返回的 400 说的是同一句话。
- 迁移靠搬代码而不是重写。先搬两边都已有的操作（search、graph、claims、entities、documents、sync、catalog SQL），
  再在 MCP 独有的操作获得路由时逐个搬过来。`/api` 保留自己的 handler，以后可以调用同一批操作。租约路由
  （`work/*`、`labeling/*`）最后搬，并保持线上格式不变：它属于 worker，由 `work/config` 定版本。

### 3.3 版本与稳定性

- `contract_version` 从 `1.0` 开始，由 `GET /remote/v1/health` 和 `/whoami` 返回。minor 版本只增不改。破坏性
  变更升 major 版本，并使用新前缀 `/remote/v2`，与 v1 并行提供一个版本周期。
- **stable**：health、whoami、documents、sync、search、graph、entities、claims、catalog SQL。
- **beta**（minor 版本内可以调整，记在 `CONTRACT.md` 里）：`known_at`、evidence、mentions、
  resolve / plan / feedback、工作集、订阅、实时 datasource 查询。
- **worker**：`work/*` 和 `labeling/*`，照旧由 `work/config.version` 定版本（[12](12-remote-processing.md) §4.1）。
- SDK 在第一次使用时读取 `contract_version`，遇到更新的 major 版本就拒绝工作。

### 3.4 `/remote/v1` 增加什么

| 操作 | 路由 | scope | 现状 |
| --- | --- | --- | --- |
| health、whoami | `GET /health`、`GET /whoami` | — / 任意 | 已有；增加 `contract_version` 以及 token 的角色和层级 |
| documents | `GET documents`、`GET` / `PUT` / `DELETE document` | read / write | 已有；`PUT` 记录写入者（§3.5） |
| 批量写入 | `POST documents/batch` `{ documents: [{ path, content, if_sha? }] }` | write | 新增：多篇文档、一次 sync、乐观并发的 `if_sha` |
| search | `GET search` | read | 增加 `kinds`、`sources`、`known_at` |
| claims | `GET claims` | read | 增加 `knode_claims` 的全部过滤条件、`known_at` 和 keyset 分页（`cursor`，`limit` ≤ 1,000） |
| evidence | `GET evidence` | read | 新增，beta：claims、mentions 或 relations 背后的每条证据一行，带 `available_at`（§4.4） |
| mentions | `GET mentions?entity=` | read | 新增，beta：哪些条目所在的 chunk 提到了某个实体，带时间和来源 |
| entities、graph | `GET entities`、`GET graph` | read | 增加 `as_of` 和 `known_at` |
| catalog SQL | `GET sql/views`、`POST sql` | sql | 已有；增加视图 `v_entries`（生产端的条目索引） |
| resolve、plan、feedback | `POST resolve`、`POST plan`、`POST feedback` | read | 来自 MCP |
| 工作集 | `POST worksets`、`GET worksets`、`POST worksets/:id/commit` | read / write | 来自 MCP |
| 订阅 | `POST subscriptions`、`GET subscriptions/:id/changes`、`DELETE subscriptions/:id` | read | 来自 MCP 和 `/api` |
| 实时数据源 | `GET datasources`、`POST datasources/:id/query` | `live`（新增） | 来自 MCP；由各数据源自己的守卫保证只读 |

`live` 单独成为一个 scope，与 `sql` 分开，因为它会触达其他系统。catalog 视图属于知识库本身；datasource 查询
触达的是 MySQL、Parquet 文件或某个 HTTP API。

### 3.5 Token：角色与信任层级

`RemoteTokenRecord`（`src/remote/tokens.ts`）增加 `role` 和 `tier`。角色是一组预设的 scope 加一个默认层级，两者
仍可显式设置。

| 角色 | scope | 写入落为 | `/mcp` |
| --- | --- | --- | --- |
| `producer` | read、write | trusted：证据，比如爬虫的导出 | 否 |
| `consumer` | read、sql、live | — | 否 |
| `agent` | read、write、sql、live、mcp | quarantined | 是，以 `caller: 'agent'` 运行 |
| `worker` | label | — | 否 |

```bash
knode-os remote token create --name rookie-trade-kb    --role producer --workspace admin/finance
knode-os remote token create --name rookie-trade-agent --role agent    --workspace admin/finance
```

- **远程写入记录写入者。** `PUT document`、`documents/batch` 和 `worksets/:id/commit` 在 sync 之前调用
  `recordOrigin`：trusted token 记为 `remote:<name>`，quarantined token 记为 `agent:remote/<name>`。剩下的交给
  `tierForActor` 和 `applyDocScope` 里的写入者上限（`src/ingest/apply.ts:213`）：frontmatter 可以把 producer 的
  文档降级，却不能把 agent 的文档升级。
- **`/mcp` 接受带 `mcp` scope 的 `knr_` token。** 工作区由 token 决定：它唯一的工作区，或请求指定的、属于它的
  某个工作区。这样的会话永远以 `caller: 'agent'` 运行。数据根目录的 token 留给本机的交互式客户端。
- **血缘记下 token。** 每次写入产生的来源 scope 都带着写入者，就像远程审计日志现在做的那样。
- `knode-os connect claude --project <dir> --token-env KNODE_AGENT_TOKEN` 写出项目级 `.mcp.json`，取代带着根
  token 的用户级注册（§8.2）。

### 3.6 留在契约之外的

- **`/api`。** 它服务于 UI，随 UI 变化。
- **推送。** 订阅仍是轮询，游标是系统时间（[05](05-agent-context-db.zh-CN.md) §9.5）：离线一周的消费者依然能看到
  这期间的一切。像 AgentMux 事件订阅那样的签名 webhook 以后再说。
- **以库的方式嵌入。** 在另一个进程里 import `knode-os` 会在 `serve` 之外再打开一次工作区的索引。PGlite 是
  单进程的；在 Postgres 上它则会绕过 `serve` 的 watcher、锁和登录。

## 4. 按决策时刻读取：`known_at`

### 4.1 四条时间轴

| 轴 | 参数 | 回答的问题 |
| --- | --- | --- |
| 系统时间 | `as_of` | knode-os 当时记录了什么 |
| 世界时间 | `valid_at` / `valid_range` | 这条 claim 在现实中何时成立 |
| 新鲜度 | `freshness` | 实时读取最多可以多旧 |
| 可获得性 | `known_at` | 读者当时能看到什么 |

`known_at = t` 只保留 `available_at ≤ t` 的证据，并重算由它 fold 出的内容。它可以和其他轴组合。回测把 `as_of`
固定在一个工作集上，让同样的读取以后返回同样的行，再让 `known_at` 随测试推进。resolver（`src/store/resolver.ts`）
在 `txTime` 旁增加 `knownAt`，`applied` 像回显其他轴一样回显它。

### 4.2 可获得性属于条目

文件是错误的单位：周文件跨七天，帖子的文件里还有后来写的评论。生产端用导出器已经写出的锚点作键，声明一份
条目索引：

```yaml
anchors:
  e-3f9a12bc: { id: "post/5348792061920444", posted_at: "2026-09-29T20:21:00+08:00", captured_at: "2026-09-29T20:36:02+08:00" }
  e-77c0d1e4: { id: "comment/998877", posted_at: "2026-10-02T09:13:00+08:00", captured_at: "2026-10-02T09:40:11+08:00", reply_to: "e-3f9a12bc" }
```

条目的 `available_at` 取以下第一个可用的值：

1. 生产端给出的该条目自己的 `available_at`；
2. `captured_at`，前提是该条目在 `posted_at` 之后一天内被抓到：那是实时抓取，生产端当时就有了它；
3. 否则取 `posted_at`：这是补抓，没人知道当时会在何时看到它。

对补抓的条目，rookie-trade 把 `available_at` 写成 `posted_at` 加上该平台的基础轮询间隔（§6.2），这样回测就不会
假设自己在 14:30 就看到了一条 14:30 的帖子。

没有索引的文本（其他生产端、手写文档）取保守的默认值：frontmatter 的 `available_at`，否则取 `date_end` 的结束
时刻，再否则取文档日期的结束时刻。它永远不早于这个文件可能描述的最后时刻。

派生出的一切都从它的落点继承可获得性：

- **chunk** 取它覆盖的锚点中最晚的 `available_at`。chunker 仍会合并短条目（检索需要这样），并把锚点及其偏移记在
  `chunks.metadata` 里。第一个锚点之前的文字取文档的默认值。
- **证据**（落到某个 chunk 上的 tier-1 实体、关系或 claim，以及 mention）取其 chunk 的可获得性。生产端的 claim 用
  frontmatter `claims` 里的 `anchor:` 指明自己的条目，取该条目的值。
- `chunks` 和 `evidence` 增加带索引的 `available_at` 列（schema v16）。文档 apply 时填写；已经索引的文档用
  `sync --reapply` 补上。

### 4.3 `known_at` 读取会重算什么

| 读取 | 在 `known_at = t` 下 |
| --- | --- |
| search、SAG | `available_at ≤ t` 的 chunk；SAG 遍历不会经过到 `t` 时还没有任何证据的实体 |
| claims | 用 `available_at ≤ t` 的证据重新 fold，走 `foldAsOf` 为 `as_of` 已经走的路径（`src/store/claims.ts:203`），在 tx 窗口旁加一个可获得性条件。状态、证据数和 dispute 都是 `t` 时刻应有的样子 |
| 取代关系 | 只有当后继 claim 自己在 `t` 之前已可获得时，才算被取代 |
| 实体、关系、图 | 到 `t` 时已有证据的那些；度数和权重按这些证据计算 |
| 生成页面（`view`）、agent 写的 wiki 页面 | 默认排除；显式要求时在 `applied` 里加一条警告，因为它们是在知道之后索引的一切的情况下写成的 |
| 负知识 | 排除：它记录的是 knode-os 何时查过，而不是世界何时知道 |
| 实时数据源 | 不过滤；playbook 和 plan 拿到 `{known_at}` 作为模板参数（`WHERE trade_date <= {known_at}`） |
| 实体合并 | 保留：身份被视为与时间无关（§4.5） |

### 4.4 回测读证据，而不是 fold 结果

一次 fold 回答一个时刻，而回测要走过成百上千个时刻。所以回测一次性读取事件流，在自己这边 fold：

- `GET evidence` 分页返回证据行：每行支持的 claim、mention 或 relation；主体和客体；来源的断言（陈述、状态）；
  来源路径、锚点和条目 id；`posted_at` 与 `available_at`；抽取器和信任层级。可以按实体、类型、来源和
  `available_at` 区间过滤。
- 每一步只使用 `available_at ≤ t` 的行。前视偏差从结构上被排除，不需要每一步都查询一次。
- SDK 的 `snapshot()` 把这些页写成 Parquet 并附上清单：`contract_version`、工作区、工作集的 `as_of`、过滤条件、
  行数以及每个文件的 SHA-256。运行登记表保存这份清单。
- 结果引用的是快照文件。`as_of` 能让 claim 和证据的读取可重复，但 chunk 文本永远是当前版本，所以事后重新查询
  不能代替快照。

`known_at` 的单点读取仍留给人和 agent 查看某一个时刻：「宁德时代发财报的前一晚，我们知道些什么？」

### 4.5 `known_at` 解决不了的

- **模型自身的知识。** 2026 年的模型读 2024 年的帖子时知道 2025 年发生了什么，这会影响它给出的 claim、类型和
  状态。把抽取模型训练截止日期之前的时段算作样本内，并优先使用生产端抽取（§6.3，其提示词禁止使用外部知识），
  而不是 tier 1。
- **全语料统计。** tier-0 概念和 `playbooks/concepts/frequent.yaml` 是在整个语料上学出来的。
- **身份。** 实体合并无论何时决定都会生效：2025 年改名的公司在 2024 年也以新名字出现。
- **处理延迟。** 回测假设条目一可获得，knode-os 就已经处理完它。实际运行时 tier-1 抽取可能滞后几个小时；生产端
  claim 随导出一起到达。
- **编辑。** 导出文件显示的是条目的当前文本。读者在 `t` 时刻看到的原文只保存在 rookie-trade 不可变的原始归档里。

## 5. 留在 rookie-trade 的数据

### 5.1 行情数据作为 datasource

`DataSourceTableConfig` 增加 `files`：相对于数据源 `path` 的一个 glob。带 `files` 的表是一个视图，覆盖 glob
匹配到的所有文件。不带它的表保持现在每个文件一个视图的行为。

```jsonc
{
  "id": "rt-market",
  "kind": "duckdb",
  "description": "rookie-trade market data (Tushare A-shares, daily)",
  "path": "/Users/ning/Projects/rookie-trade/data/market",
  "freshness": "1d",
  "tables": [
    { "name": "stock_basic", "entityColumns": [{ "column": "name", "entityType": "organization", "aliasColumns": ["ts_code", "symbol"], "sample": "all" }] },
    { "name": "daily",       "files": "daily/*/*.parquet", "entityColumns": [{ "column": "ts_code", "entityType": "organization", "sample": "all" }] },
    { "name": "daily_basic", "files": "daily_basic/*/*.parquet" },
    { "name": "adj_factor",  "files": "adj_factor/*/*.parquet" },
    { "name": "stk_limit",   "files": "stk_limit/*/*.parquet" },
    { "name": "trade_cal" }
  ]
}
```

- glob 在 DuckDB 实例启动时展开，所以 `allowed_paths` 里列的仍是文件，永远不是目录。视图读取
  `read_parquet([…], union_by_name = true)`。
- 每天都有新的交易日文件，所以在 `datasource sync` 时以及表的目录发生变化（mtime）时重新展开，并重建实例。
- `stock_basic` 按名称创建或找到每家上市公司，把代码作为别名。之后采样到的 `daily.ts_code` 通过这些别名解析到
  同一家公司（`resolveEntityIdByNameOrAlias`）并获得 locator，planner 就能为宁德时代写出读 `daily` 的查询
  （[05](05-agent-context-db.zh-CN.md) §6）。
- 关联时每列只采样 100 个不同值（`src/datasource/sync.ts:317`），对一张包含全部上市公司的表来说太少。因此实体列
  增加 `sample`：一个数字，或对低于规模上限的表取 `"all"`。
- 各列的含义写进 capability 说明 `playbooks/capabilities/rt-market.md`：`trade_date` 是 `YYYYMMDD`、价格未复权
  需乘 `adj_factor`、T+1、涨跌停价在 `stk_limit` 里。rookie-trade 最了解这些数据，所以这份说明在那边编写和维护
  版本。

### 5.2 标的身份

只有当一个标的是同一个实体时，claim 才能和价格关联。两样东西为它提供输入：上面的 datasource 绑定代码；生产端
为每条条目提到的标的声明带别名的 `entities`（`{ name: "宁德时代", type: organization, aliases: ["300750", "300750.SZ", "CATL"] }`）。
这样说「CATL」的帖子和说「300750」的帖子会落到同一个实体上。

### 5.3 运行登记表

在写回任何东西之前，rookie-trade 先记录它的运行：每次试验一行，而不只是最后保留的那次。

| 字段 | 含义 |
| --- | --- |
| `run_id`、`study_id` | 一个 study 把同一假设的所有试验归为一组 |
| `strategy`、`params`、`params_sha` | 运行的内容 |
| `code_commit` | rookie-trade 的提交 |
| `data_manifest` | 运行时的 `data/market/_manifest/v2.json` |
| `in_sample`、`out_of_sample` | 时间窗口 |
| `knowledge` | 快照清单（§4.4），或无 |
| `metrics` | 报告里的指标部分 |
| `artifacts` | 曲线和成交记录的路径 |
| `preregistration` | 测试之前写好的计划，如果有的话（`docs/research/qqq-spy-regime/multisignal_research_plan.md` 就是一份） |

以 Parquet 存在 `data/research/runs/` 下，并在 knode-os 里注册为另一张 DuckDB 表，agent 不需要每次运行写一篇
文档，就能问一个 study 做了多少次试验。

## 6. 生产端契约：rookie-trade 的导出，第 2 版

本节在与 [08](08-fragment-import.zh-CN.md) §4–§5 不一致之处取代它。08 里的渲染器 `crawler/archive-markdown.mjs`
已被 `rt export markdown`（rookie-trade 的 `backend/src/rookie_trade/content_v3/export.py`）取代。

### 6.1 现状

- 每个来源每个周期一个文件。周期是上海时间的一天或一个 ISO 周，取更接近 12,000 字符的那个。只渲染审核为相关的
  条目，外加每条已导出评论所属的帖子；帖子会带上它的评论，不论评论写于哪天。
- 路径：`<author>/<platform>/<slug>/<year>/<YYYY-MM-DD | YYYY-Www>.md`，slug 是来源名（至多 40 个字符）+ `__` +
  `sha1(source_id)[:12]`。
- frontmatter：`title`、`platform`、`source`、`period`、`date`（周期的开始）、`date_end`（仅周文件）、
  `entries`（一个数量）。
- 每个条目：`<a id="e-<sha1(entry_id)[:8]>"></a>`（`export.py:96`），然后是 `## <时间> · <作者>`。时间在日文件里
  是 `HH:MM`，在周文件里是 `MM-DD HH:MM`，为上海时间，不带时区。
- 文件不带生成时间戳，所以哈希稳定。

### 6.2 改动

1. **为知识库单设一个导出根目录。** `rt export markdown` 增加 `kb` 目标。它只把标了 `kb_export`（`data_sources`
   上的新列）的来源写进一个目录，相对布局与现在相同。finance 把 32 个链接换成一个：把这个根目录链接到同一个目标
   位置 `raw/docs/content-markdown/`，文档的键保持不变。哪些内容进入知识库就成了 rookie-trade 的一项设置。
2. **条目索引**（§4.2），即 frontmatter 的 `anchors`：每个锚点一项，含条目 id、来自 `content_v3.entry` 的
   `posted_at` 和 `captured_at`、平台没给时间时的 `posted_at_kind`、评论的 `reply_to`，以及补抓条目的
   `available_at`（`posted_at` 加平台的基础轮询间隔：900 秒，微信为 3,600 秒）。
3. **生产端的 claim 和标的**，来自审核（§6.3），写成带 `anchor` 的 frontmatter `claims`，以及带别名的 `entities`。
4. `generated: { by: "rookie-trade/export@2" }`，不带 `at`，以保持哈希稳定。

标题保持不变。人读标题，索引给机器读。

### 6.3 来自审核的 claim

相关性审核本来就会对照一个 JSON schema 读每一条条目，包括图片（`content_v3/review/schema.json`：
`decisions[{ id, relevant, reason, images[] }]`）。对每条相关条目，它增加：

```json
{ "instruments": [{ "code": "300750.SZ", "name": "宁德时代" }],
  "stance": "bullish | bearish | neutral | mixed | none",
  "claims": [{ "subject": "宁德时代", "type": "opinion", "statement": "…", "eventDate": "2026-09-29" }] }
```

- claim 按条目给出，并带着条目的精确时间，这是 12,000 字符的 tier-1 分段给不了的。
- 提示词要求只用条目本身说的内容，不用模型对后来事件的了解（§4.5）。
- 输出 token 会增加；输入 token（包含图片后最贵的部分）不变。这让纳入少数几个飞书群变得负担得起，tier 1 则从
  主路径变成审核遗漏内容的兜底。

### 6.4 重建索引的成本

只有当整个文件的 SHA-256 不变时，文档的 tier-1 结果才会被回放（`src/ingest/apply.ts:133`，`src/fs/sidecar.ts`
里的 `replayableTier1`）。加入 `anchors` 会改变每个文件，所以按现状，第 2 版会让全部 13,607 篇文档重新抽取。
因此 knode-os 先改：只要 tier-1 提示词读取的输入（正文、标题和文档日期）不变，就回放 tier 1。这样只改
frontmatter 时只会重跑 tier 0。

## 7. 写回

### 7.1 实验记录

`knode_sdk.record_experiment()` 用 agent token 为每个 study 写一篇文档 `raw/docs/rookie-trade/experiments/<study>.md`，
所以它落为 quarantined。随着试验增加，它会被重写。

```yaml
---
type: "Experiment"
title: "情绪周期 · 退潮期空仓 · sentiment-cycle-exit"
date: "2026-10-21"
actor: "agent/rookie-trade"
generated: { by: "rookie-trade/strategy-lab@3c1e9a0" }
sources:
  - { id: "runs", resource: "rt-runs:runs?study_id=sentiment-cycle-exit", title: "run registry" }
  - { id: "plan", resource: "rookie-trade:docs/research/sentiment-cycle-exit/plan.md", title: "pre-registration" }
experiment:
  study: "sentiment-cycle-exit"
  trials: 14
  chosen: "7f3a2c"
  in_sample: ["2024-01-02", "2025-06-30"]
  out_of_sample: ["2025-07-01", "2026-10-17"]
  knowledge: { snapshot: "snap_01J…", as_of: "2026-10-21T02:00:00Z" }
  metrics: { sharpe: 1.12, cagr: 0.21, max_drawdown: -0.18, num_trades: 63 }
relations:
  tests: ["[[舒九的情绪周期理论]]"]
  trades: ["[[创业板指]]"]
claims:
  - subject: "舒九的情绪周期理论"
    type: "backtest_result"
    status: "suspected"
    statement: "退潮期空仓规则 2025-07..2026-10 样本外夏普 1.12，14 次试验中最好的一次"
    startDate: "2025-07-01"
    endDate: "2026-10-17"
---
假设、方法、结果、失败之处、注意事项。
```

- **按 study 写，而不是按运行。** 记录写明它报告的是哪次试验、一共做了多少次；每次试验都在登记表里。从 14 次
  试验里挑出的结果比只做 1 次的弱，试验次数随结果一起走。
- **claim 带着测试窗口。** 只有窗口重叠的 claim 才互相矛盾（[05](05-agent-context-db.zh-CN.md) §9.3），所以不同
  窗口的结果可以共存。与 trusted claim 矛盾的回测会开出 dispute，而不是覆盖它。
- **提升之前一直隔离。** 读过记录的人用 `knode_trust` 或 UI 里该来源的 “adopt” 来提升它。
- **永远不作为特征。** 构建信号的读取通过 `sources` 排除 `raw/docs/rookie-trade/`，或要求 `trust: trusted`，
  这样任何策略都不会被喂进它自己早先的结论。
- `tests` 和 `trades` 是新的谓词。rookie-trade 把它们作为 `playbooks/ontology/research.yaml` 提供（§9）；在那之前，
  本体会把它们归入 `related_to`。

### 7.2 作者战绩

rookie-trade 拥有给作者打分所需的一切：带时间和标的的条目、审核给出的立场，以及价格。它按作者、按窗口度量其观点
之后发生了什么（固定期限的远期收益、命中率、观点数量），写成 `raw/docs/rookie-trade/track-records/<author>.md`，
方法版本记在 `generated.by` 里（`rookie-trade/track-record@1`）：

- 作者实体上类型为 `track_record` 的 claim，每个窗口一条，`startDate` / `endDate` 设为该窗口；
- `available_at` 设为窗口结束时刻，所以 `t` 时刻的回测只能看到那时已经结束的窗口；
- 方法经过复核之后用 producer token 写入。第一版走 agent token，让它的记录等人来看。

这是闭环里真正带来回报的部分：知识库根据结果而不是根据来源的自我陈述，学会对每个来源信任到什么程度。

## 8. 客户端

### 8.1 Python SDK

```
sdk/python/
  pyproject.toml          knode-sdk；只依赖 httpx；pandas 和 pyarrow 放在 `frames` extra 里
  src/knode_sdk/
    client.py             KnodeClient：health、whoami、documents、search、claims、evidence、mentions、
                          entities、graph、sql、resolve、feedback、worksets、subscriptions、live
    models.py             对应 contract/schemas 的 dataclass
    errors.py             KnodeError、ContractVersionError、Forbidden、NotFound、Conflict
    snapshot.py           分页读取证据和 mention → Parquet + 清单
    experiments.py        Experiment → §7.1 的文档
  tests/test_contract_alignment.py    模型字段对照 contract/schemas，与 AgentMux 的做法相同
```

在 rookie-trade 的 `backend/pyproject.toml` 里：

```toml
[tool.uv.sources]
knode-sdk = { path = "../../knode-os/sdk/python", editable = true }
```

```python
from knode_sdk import KnodeClient

kb = KnodeClient("http://127.0.0.1:12000", token=os.environ["KNODE_TOKEN"], workspace="admin/finance")
ws = kb.checkout(note="sentiment-cycle-exit")
snap = kb.snapshot(
    kind="evidence", entities=universe, types=["opinion"],
    available=("2024-01-01", "2026-10-17"), as_of=ws.as_of,
    out="data/research/snapshots/",
)
for claim in kb.iter_claims(subject="宁德时代", known_at="2025-06-30T15:00:00+08:00", as_of=ws.as_of):
    ...
kb.record_experiment(study)
```

- 先做同步客户端，因为 Strategy Lab 和研究脚本都是同步的。有需要时再加异步客户端。
- 错误对应契约里的状态码；`if_sha` 引起的 `409` 抛出 `Conflict`。
- rookie-trade 用一组 `rt kb` 命令封装 SDK：`whoami`、`export`、`snapshot`、`experiment push <study>`、
  `track-records`。
- knode-os 宕机时 rookie-trade 照常工作。SDK 有超时，下单路径上没有任何东西调用它。

### 8.2 为在 rookie-trade 里工作的 agent 提供 MCP

项目级 `.mcp.json`，提交进仓库，token 从环境变量读取：

```json
{
  "mcpServers": {
    "knode-os": {
      "type": "http",
      "url": "http://127.0.0.1:12000/mcp",
      "headers": { "Authorization": "Bearer ${KNODE_AGENT_TOKEN}" }
    }
  }
}
```

- token 就是 §3.5 里的 `agent` token，绑定 `admin/finance`，所以请求不需要指定工作区。会话可以读取、检索、
  resolve，并写入 quarantined 的笔记，但不能提升它们。
- Claude Code 从它自己的环境里展开 `${KNODE_AGENT_TOKEN}`，而不是从 rookie-trade 的 `.env`，所以这个变量应该
  放进 shell profile。
- Codex：`codex mcp add knode-os --url http://127.0.0.1:12000/mcp --bearer-token-env-var KNODE_AGENT_TOKEN`。
- knode-os 的指南（`AGENTS.md`）照旧作为 server 的 instructions 送达。

MCP 给 agent 用，SDK 给代码用。一次工具调用会把它返回的每一行都放进模型的上下文。需要 5 万行证据的回测应该在
DataFrame 里拿到它们；做这种分析的 agent 应该用 SDK 写 Python，而不是在循环里调用工具。

### 8.3 CLI

CLI 仍是管理员的工具：token、`connect`、datasource、sync、rebuild。它自己打开数据目录，绕开 `serve` 的登录和锁，
`--data` 写错时还会悄悄打开一个全新的 schema。任何项目都不应该调用它。

## 9. 为交易研究配置 finance

- **`purpose.md`** 仍是模板。wiki 生成器和夜间 dream 都会读它，所以它应写明这个知识库服务于 A 股和美股策略研究、
  谁会读它、哪些内容不在范围内。
- **Intent。** finance 只有一个 `entity-overview`。三个 intent 能撑起这个闭环：
  - `instrument-thesis`：身份、所关注作者近期的立场、来自 `rt-market` 的价格反应、此前的实验、未解决的 dispute；
  - `author-profile`：方法页面、战绩、活跃题材；
  - `strategy-review`：规则的来源、相关实验、与它矛盾的 claim。
- **本体。** `playbooks/ontology/research.yaml` 增加 `tests`（实验 → 概念）和 `trades`（实验 → 标的），以及
  claim 类型 `opinion`、`backtest_result` 和 `track_record`。
- `rt-market` 的 **capability 说明**（§5.1）。

这些由管理员安装。API 的写入 scope 只能到达 `raw/docs`、`wiki` 和 `playbooks/packs`（§11）。

## 10. 阶段

1. **身份与信任。** token 的角色和层级；远程写入记录写入者；`knr_` token 以 agent 身份用于 `/mcp`；
   `connect --project`。
   *完成标准*：用 agent token 写入的文档被隔离，并与 trusted claim 冲突时开出 dispute；用这个 token 调用
   `knode_trust` 被拒绝；带环境变量 token 的项目 `.mcp.json` 恰好打开它的工作区。测试：`remote-api.test.ts`、
   `mcp-http.test.ts`、`quarantine.test.ts`。
2. **契约骨架。** `src/contract/` 收纳 `/remote/v1` 已有的操作；生成 `contract/`；golden 测试和 `contract_version`。
   *完成标准*：现有的远程 API 测试不改即通过；改动一个字段却不运行 `pnpm contract:emit` 会让 `contract.test.ts`
   失败。
3. **按输入回放 tier 1**（§6.4）。
   *完成标准*：给已抽取的文档加一个 frontmatter 键，会重跑 tier 0，并在不调用模型的情况下保留它的 tier-1 claim。
4. **`known_at`。** 条目索引和 claim 锚点；chunk 和证据上的 `available_at`（schema v16）；resolver 中的新轴；
   search、claims、graph、evidence 和 mentions；排除生成页面。
   *完成标准*：一个合成语料通过测试：帖子 A 在 t1 说 X，帖子 B 在 t3 反驳它；`known_at` 为 t2 时，X 是 fact 且
   没有 dispute，为 t4 时变为 disputed；周文件里周日的帖子在该周周一不可见；帖子文件里的评论只在它自己的时间之后
   出现。
5. **契约扩展。** claim 过滤和分页、evidence、mentions、resolve / plan / feedback、工作集、订阅、
   `documents/batch`、`live` scope 下的实时查询；DuckDB 的 `files` 表和实体列 `sample`。
6. **SDK。** 带对齐测试、`snapshot()` 和 `record_experiment()` 的 `sdk/python`。
7. **rookie-trade。** 带 `kb_export` 的第 2 版导出；审核的新字段；运行登记表；实验记录；`.mcp.json`；`rt kb`。
   在 finance 中：datasource、capability 说明、intent、本体和 purpose。
8. **作者战绩**，每晚运行，作为第一个自己运转的闭环。

无论还要做什么，阶段 1–3 都排在最前。只拿人工提炼的规则对照价格做检验的 study，只需要阶段 1、2、6 和运行登记表：
知识塑造了规则，却不提供信号，所以 `known_at` 可以等。这样的 study 仍应在规则来源帖子之后的时间窗口上检验。任何由
知识派生的特征进入回测之前，必须完成阶段 4。

## 11. 已知限制与待定问题

- **战绩的信任层级。** 它们由代码度量，而不是由 agent 断言，但方法一旦有误，会影响每个参考它们的 pack。在方法被
  复核一次之前保持隔离（§7.2）。之后改为 trusted？
- **谁可以写 capability 说明、intent 和本体包。** 它们会改变 planner 的行为，目前只有管理员能手工安装。一个只限于
  `playbooks/capabilities/` 和 `playbooks/ontology/` 的 `domain` scope 可以让 rookie-trade 自己提供它们；intent
  可以仍由人手工维护。
- **飞书。** 126 个群共 169 万条。哪些群标 `kb_export`？只靠审核给出的 claim、不跑 tier 1 是否够用？
- **purge 与引用。** `knode-os purge` 会抹掉已处置的历史，这可能让实验引用的 `as_of` 无法复现。快照文件（§4.4）
  不受 purge 影响；purge 也可以在仍有工作集覆盖该区间时发出警告。
- **一个工作区里的多个项目。** rookie-trade 写在 `raw/docs/rookie-trade/` 和 `raw/docs/content-markdown/` 下。
  第二个项目应使用自己的前缀，或自己的工作区；目前没有跨工作区查询。
- **离开本机。** `/mcp` 只响应本机。别处的项目通过 HTTPS 用同样的 token 和 SDK 访问 `/remote/v1`。它的 agent
  需要 HTTPS 上的 `/mcp`，本设计不提议这一点。
- **编辑与撤回**（§4.5）：`t` 时刻的原文需要 rookie-trade 的原始归档。
- **`/api` 与契约。** UI 可以调用同一批操作，去掉自己的参数解析。本设计不需要这样做。

## 12. 改动位置

| 范围 | 文件 |
| --- | --- |
| 契约 | `contract/`（新增）；`src/contract/`（新增：`op.ts`、`ops/*`、`remote.ts`、`mcp.ts`、`emit.ts`）；`tests/contract.test.ts`（新增）；`package.json`（`contract:emit`） |
| 远程 API | `src/remote/api.ts`（由操作挂载路由；记录写入者；批量写入）；`src/remote/tokens.ts`（`role`、`tier`、scope `mcp` 和 `live`） |
| MCP | `src/server/mcp-http.ts`（带 `mcp` 的 `knr_` token）；`src/mcp/tools.ts`（随着操作迁移，改由操作注册） |
| 信任 | `src/lineage/trust.ts`；`src/fs/sidecar.ts`（远程路由调用 `recordOrigin`） |
| `known_at` | `src/store/resolver.ts`；`src/store/migrations.ts`（v16：`chunks` 和 `evidence` 上的 `available_at`，`v_entries`）；`src/ingest/chunker.ts` 和 `src/lineage/writer.ts`（锚点、可获得性）；`src/graph/frontmatter.ts`（`anchors`、claim 的 `anchor`）；`src/graph/llm-extract.ts`；`src/store/claims.ts`；`src/search/search.ts`、`src/search/sag.ts`；`src/graph/query.ts` |
| tier-1 回放 | `src/ingest/apply.ts`、`src/fs/sidecar.ts`（按提示词的输入回放） |
| 数据源 | `src/config.ts`（表上的 `files`、实体列上的 `sample`）；`src/datasource/duckdb.ts`（glob 表、重新展开）；`src/datasource/sync.ts`（采样数量） |
| CLI | `src/cli.ts`（`remote token create --role`、`connect --project --token-env`） |
| SDK | `sdk/python/`（新增） |
| rookie-trade | `content_v3/export.py`（第 2 版、`kb` 目标）；`content_v3/review/schema.json` 和 `prompt.md`；`data_sources.kb_export` 的迁移；运行登记表和 `rt kb` 命令；`.mcp.json`；`backend/pyproject.toml`（`knode-sdk` 的 path source） |
| finance 工作区 | `knode.config.json`（一个链接目录、`rt-market`）；`purpose.md`；`playbooks/intents/`、`playbooks/ontology/research.yaml`、`playbooks/capabilities/rt-market.md` |
| 测试 | `tests/remote-api.test.ts`、`tests/mcp-http.test.ts`、`tests/quarantine.test.ts`、`tests/temporal-claims.test.ts`；新增 `known_at` 和 DuckDB glob 的测试 |
