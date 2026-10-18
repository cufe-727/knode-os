# 11 — 插件：可插拔的处理阶段、存储与模型

> 状态：**已实现**（2026‑10‑18）。English version: [11-plugins-and-udfs.md](11-plugins-and-udfs.md)。
> 使用指南与示例：[docs/plugins.md](../plugins.md)。

## 0. 背景

knode-os 准备公开发布。此前有三处写死在代码里，别人的安装环境一定会想改：

1. **由哪个模型来回答。** `provider` 是一个封闭的联合类型 —— 一个 OpenAI 兼容的 HTTP 客户端加三个编程
   Agent CLI —— `LlmClient` 按它分支。Anthropic Messages API、Gemini、Bedrock、公司内部自有协议的中转、
   一段调用厂商 SDK 的 Python 脚本，都无法在不改客户端代码的情况下配置进来。
2. **索引放在哪里。** `database.kind` 只有 `pglite | postgres`，而 Postgres 一路只接受 host/port/user/password ——
   没有连接串、没有 TLS、没有连接池大小，托管 Postgres 或连接代理给你的东西一个也用不上。
3. **一份文档会经历什么。** Convert → Index → tier‑0 → Extract → Summarize 是固定函数。没有办法在哈希之前
   去掉模板文字、换一种切块方式、给 tier‑0 加领域词、给抽取提示词加一条规则、过滤模型返回的结果、
   用自家风格写摘要、或者在文档落库时得到通知 —— 也就是数据流水线通常在每个阶段都提供的用户自定义函数（UDF）。

## 1. 决策

| 决策 | 结果 |
| --- | --- |
| D1 每个进程一个注册表 | `src/plugins/registry.ts` 持有 provider、后端、转换器和钩子处理器。原先按 provider id 分支的每个入口都改为到这里查找：`LlmClient`、`createEmbeddingProvider`、`openBackend`、`convertDocumentToMarkdown` / `isConvertibleFile`、`listChatModels`。注册表是进程级的，因为插件是代码，ESM 模块缓存也是进程级的；工作区配置只负责选择*使用*哪个已注册的 id |
| D2 内建实现也是插件 | `src/plugins/builtin.ts` 用插件同一套 API 注册 OpenAI 兼容客户端、三个 CLI、新的 `command` provider、三种 embedder、`pglite` / `postgres` 以及 PDF / 图片转换器。因此插件能做内建实现能做的一切，包括注册同一个 id 来替换它；替换会被记录并由 `knode-os plugins` 显示 |
| D3 provider id 是开放字符串 | `LlmProvider`、`EmbeddingConfig.provider`、`DatabaseConfig.kind` 都是 `string`。配置可以指向当前进程没有加载的 provider：此时客户端处于*禁用*状态，被调用时报出 provider 名称 —— 插件丢失的工作区像删掉连接一样降级，而不是打不开 |
| D4 存储是 Postgres 形状的 | Store 对后端 `open()` 返回的任何对象说 PostgreSQL + pgvector（`Backend`：`query` / `exec` / `transaction` / `close`）。存储插件是*到达*这样一个数据库的方式 —— 托管服务的驱动、Unix socket、代理、嵌入式引擎 —— 而不是另一种查询语言。内建 `postgres` 新增 `url`、`ssl`、`poolSize`；`pglite` 新增 `path` |
| D5 钩子是按阶段顺序串联的过滤器 | `source.text` → `chunk` → `tier0.concepts` → `extract.request` → `extract.result` → `summary.request`，加上通知型的 `document.applied`。过滤器接收阶段的值，返回阶段继续使用的值；多个插件按注册顺序串联；不返回值的处理器保留原值。过滤器失败会让该文档失败（状态 `error`，保留错误信息）—— 用户函数给出的错误答案不能被悄悄索引。`document.applied` 的处理器出错只记日志，不致命 |
| D6 `source.text` 是同步的 | 它运行在 `loadSourceText` 里，prepare、apply、tier‑1 规划器和摘要生成器都调用它，其中一些代码无法 await。钩子返回的*就是*内容：作为 scope sha 被哈希、被切块、被抽取、被重放。钩子改变主意就等于文档变了，这是诚实的结果 |
| D7 插件只能通过文件配置 | `knode.config.json` 里的 `plugins: [{ module, options?, enabled? }]`，或环境变量 `KNODE_PLUGINS`。设置 API 从不写它，文件 API 到不了 `knode.config.json` 和 `plugins/`，所以成员无法让服务器加载代码；由管理员编辑文件 |
| D8 升级不会重新转换 | 转换的缓存键原先是 `v1\|<vision>\|pages:N\|image:N`。内建 PDF / 图片转换器保持完全相同的键；插件转换器的键带上自己的名字（`<id>@<version>\|…`），永不与之冲突，提升它的 `version` 只会重转它自己拥有的文件 |

## 2. 一个插件

插件是一个 ES 模块，默认导出一个 `KnodePlugin`（`src/plugins/types.ts`）；除 `name` 外全部可选：

```js
// <data>/plugins/finance.mjs
export default {
  name: 'finance',
  version: '1.0.0',
  llmProviders: [/* LlmProviderPlugin */],
  embeddingProviders: [/* EmbeddingProviderPlugin */],
  storageBackends: [/* StorageBackendPlugin */],
  converters: [/* DocumentConverterPlugin */],
  hooks: {
    'source.text': (text, ctx) => text.replace(/^Confidential.*$/gm, ''),
    'tier0.concepts': (terms, ctx) => terms.filter((t) => !/^(公司|附件)$/.test(t)),
  },
  async setup(api, options) {
    // 同样的注册动作，命令式写法，带上配置里的 options
    api.on('document.applied', (event) => api.log(`indexed ${event.path}`));
  },
};
```

```jsonc
// knode.config.json
"plugins": [
  { "module": "./plugins/finance.mjs", "options": { "stoplist": "playbooks/concepts/stoplist.yaml" } },
  { "module": "@acme/knode-anthropic" }
]
```

先注册声明式成员，再运行 `setup(api, options)`。模块每个进程只导入一次：第一个点名它的配置把 `options`
交给它，其他工作区共享这次安装。

## 3. 扩展点

### 3.1 LLM provider

```ts
interface LlmProviderPlugin {
  id: string;                       // `provider` 填的值
  label: string;
  kind: 'api' | 'cli' | 'custom';   // 设置页按它分组
  fields?: LlmProviderField[];      // 它读取 LlmConfig 的哪些字段
  note?: string;
  create(config: LlmConfig): LlmBackend;          // { enabled, label, complete(messages, opts) }
  listModels?(config: LlmConfig): Promise<ModelListResult>;
}
```

`LlmClient` 包装 `create` 返回的后端；`enabled`、`label` 和 `complete` 都是后端的。每个阶段、Ask、Dream、
各类审核以及标注槽位都经过 `LlmClient`，所以 provider 在任何指定模型的地方都能用。有两样东西天然留在内建
`openai` provider：deepagents 循环（`loop: 'deepagents'`，需要 LangChain 的 `ChatOpenAI` 端点）和研究 Agent 的内建执行器。

内建 **`command`** provider 不需要写插件代码：`cliPath` 指向一个可执行文件，每次调用运行一次，标准输入是一个 JSON
请求（`{ messages, model, json, maxTokens, images }`），标准输出就是回答；连接的 `baseUrl` / `apiKey` 以
`KNODE_LLM_BASE_URL` / `KNODE_LLM_API_KEY` 环境变量传入（`env:VAR` 已解析）。这是从"我有一段调用厂商 X 的
Python 脚本"到 knode-os 某个阶段的最短路径。

### 3.2 Embedding provider

```ts
interface EmbeddingProviderPlugin {
  id: string; label: string; kind: 'api' | 'local' | 'custom';
  fields?: EmbeddingProviderField[]; note?: string;
  create(config: EmbeddingConfig): EmbeddingProvider;   // { model, dimensions, embed(texts) }
  listModels?(config): Promise<ModelListResult>;
}
```

`model` 是向量空间的身份（`embeddings.model`）；向量不再可比时 provider 必须换一个新的。embedding 池
（`embeddingPool`）仍是 OpenAI 形状的：它只轮换 `openai` provider 的 key。

### 3.3 存储后端

```ts
interface StorageBackendPlugin {
  id: string; label: string; note?: string;
  open(dataDir: string, config: DatabaseConfig): Promise<Backend>;
}
```

`DatabaseConfig` 除内建字段外新增 `url`、`ssl`、`poolSize`（postgres）、`path`（pglite），以及给插件自用的
`options` 对象。`openPglite` 与 `openPostgres` 已导出，插件可以包装它们（不同的目录布局、先打开一条隧道、
一个通过 HTTP 说 pg 协议的驱动）。

### 3.4 文档转换器

```ts
interface DocumentConverterPlugin {
  id: string; label?: string;
  extensions: string[];        // '.docx', '.epub', …
  version?: string | number;   // 提升 → 重转它拥有的文件
  usesVision?: boolean;        // vision 模型的标签加入缓存键
  convert(input: { absPath, rel, vision?, maxPdfPages?, maxImageDimension? }): Promise<ConversionResult>;
}
```

拥有一个扩展名就让该文件成为*可转换原件*：prepare 把 Markdown 写进来源的 sidecar（`content.md`），索引文本从那里
读取，UI 和 `knode_read` 都把该文件显示为这份 Markdown，原件永不被写回。`withProvenance` 已导出，可用来生成内建
转换器在转换文本上放的 frontmatter。

### 3.5 钩子

| 钩子 | 阶段 | 输入 → 输出 | 上下文 |
| --- | --- | --- | --- |
| `source.text`（同步） | 每次读取来源文本，哈希之前 | `string` | `path`、`root`、`dataDir` |
| `chunk` | Index，内建切分器之后 | `ChunkPiece[]` | + `text`、`config { chunkSize, chunkOverlap }` |
| `tier0.concepts` | tier‑0，raw/docs 来源 | `string[]` 概念词 | + `text`、`frontmatter` |
| `extract.request` | Extract，调用发出或租出之前 | `ExtractRequest { messages, maxTokens, … }` | + `title`、`segment?` |
| `extract.result` | Extract，回复校验之后 | `ExtractResult { entities, relations, claims }` | + `title`、`model`、`segment?` |
| `summary.request` | Summarize | `ChatMessage[]` | + `title`、`text` |
| `document.applied` | 文档 scope 落库之后 | 事件（无返回） | `path`、`root`、`chunks`、`entities`、`relations`、`scopeId` |

`extract.request` 运行在 `segmentExtractRequest` 里，批处理通道（`knode-os extract`）和标注调度器都用它，所以另一台机器
上的 worker 运行的正是钩子产出的消息；`extract.result` 运行在同样共享的 `checkExtractReply` 里，其输出再经
`parseExtractReply` 校验一遍，形状松散的答案不会进入 sidecar。

## 4. 加载

- `module` 的解析：路径（`./plugins/x.mjs`、`/abs/x.mjs`、`~/x.mjs`）相对数据目录；裸名称先从数据目录的
  `node_modules` 解析，再从 knode-os 自身的安装解析。
- `serve` 下每个工作区的配置都是根配置的副本。工作区里不存在的相对路径会到**根**配置旁边去找
  （`createContext(dir, { pluginRoots: [root] })`），所以数据根目录下的一个 `plugins/` 目录服务所有工作区。
- `createContext` 在打开 Store、构建 embedder 和 Judge 客户端之前加载插件 —— 它们新增的后端或 provider 必须先到位。
- 无法导入的模块，或默认导出不是插件的模块，会让提出请求的上下文失败，错误信息里带着模块名。失败的加载不会被记住：
  修好文件重新打开即可。

## 5. 对外表面

- `GET /api/config/providers` —— 目录：每个 LLM / embedding provider、存储后端和转换器，带 `kind`、`fields`、`note`
  以及由哪个插件注册；每个钩子由谁处理。Web 设置页读取它：LLM 连接行提供所有非 Agent 的 provider，并按该
  provider 声明的字段绘制表单。
- `GET /api/plugins` —— 本进程加载了什么（`describe()`）、配置了哪些条目、注册表的警告（替换、扩展名接管）。
- `knode-os plugins [--json]` —— 命令行版本，不打开 Store。
- `PUT /api/config` 接受连接、路由或 embedding 条目上任何已注册的 provider id，未注册的 id 像拼错的内建名一样被忽略。

## 6. 不可插拔的部分（以及原因）

- SQL schema 与查询：Store 按设计就是 Postgres + pgvector（HNSW、`tsvector`、双时态列）。后端改变的是到达这个数据库的
  方式，不是它是什么。
- 检索融合、ledger、scope 与 fold、wiki 页面生成器、研究流水线：它们是产品本身，不是接缝；在它们之前或之后放一个
  钩子是大多数定制的正确位置。
- deepagents 循环和内建研究执行器只能跑在 OpenAI 兼容端点上；插件 LLM provider 服务于一次性阶段和经过它们的 Ask，
  不服务于这些循环。

## 7. 安全

插件在服务进程内以其权限运行。`plugins` 位于 `knode.config.json`，文件 API 拒绝写它，设置 API 不碰它；`plugins/`
也不是可写目录。只有能访问数据目录的人才能让 knode-os 加载代码。过滤器里的钩子错误使文档失败（在文档的 `error` 中可见），
通知型钩子的错误带插件名记入日志。

## 8. 测试

`tests/plugins.test.ts`：一个从配置加载的模块，提供 LLM provider、embedder、转换器和全部钩子，经由 `createContext`、
一次 `sync`、一次 tier‑1 通道、模型列表和设置 API 验证；`command` provider 对一个 shell 脚本；存储注册表配合 pglite
的 `path`、进程内后端和未知 kind；由连接串生成的 pg 连接池设置；URL 密码的脱敏；注册表的串联、替换和同步钩子规则；
带 roots 的模块解析；保持不变的转换缓存键。
