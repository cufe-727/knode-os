# 11 — Plugins: pluggable processing stages, storage and models

> Status: **implemented** (2026‑10‑18). Chinese version: [11-plugins-and-udfs.zh-CN.md](11-plugins-and-udfs.zh-CN.md).
> How-to with examples: [docs/plugins.md](../plugins.md).

## 0. Background

knode-os is heading for a public release. Three things were hard-wired that a
stranger's installation will want to change:

1. **Which models answer.** `provider` was a closed union — one OpenAI-compatible
   HTTP client and three coding-agent CLIs — and `LlmClient` branched on it.
   Anthropic's Messages API, Gemini, Bedrock, a company relay with its own wire,
   a Python script that calls a vendor SDK: none could be configured without
   editing the client.
2. **Where the index lives.** `database.kind` was `pglite | postgres`, and the
   Postgres path took host/port/user/password only — no connection string, no
   TLS, no pool size, nothing a managed Postgres or a connection proxy hands
   you.
3. **What happens to a document.** Convert → Index → tier‑0 → Extract →
   Summarize were fixed functions. There was no way to strip boilerplate before
   hashing, change chunking, add domain terms to the tier‑0 pass, add a rule to
   the extraction prompt, filter what the model returned, write a summary in a
   house style, or be told when a document landed — the user-defined functions
   (UDFs) a data pipeline normally offers at every stage.

## 1. Decisions

| Decision | Outcome |
| --- | --- |
| D1 One registry per process | `src/plugins/registry.ts` holds providers, backends, converters and hook handlers. Every facade that used to branch on a provider id looks it up there: `LlmClient`, `createEmbeddingProvider`, `openBackend`, `convertDocumentToMarkdown` / `isConvertibleFile`, `listChatModels`. The registry is process-wide because plugins are code and the ESM module cache is per process; a workspace's config selects *which* registered id it uses |
| D2 Built-ins are plugins | `src/plugins/builtin.ts` registers the OpenAI-compatible client, the three CLIs, the new `command` provider, the three embedders, `pglite` / `postgres`, and the PDF / image converters through the same API a plugin uses. A plugin can therefore do anything the built-ins do, including replacing one by registering its id; the replacement is recorded and shown by `knode-os plugins` |
| D3 Provider ids are open strings | `LlmProvider`, `EmbeddingConfig.provider` and `DatabaseConfig.kind` are `string`. A config may name a provider the running process has not loaded: the client is then *disabled* and names the provider when something calls it, so a workspace whose plugin went missing degrades the way a deleted connection already did, instead of failing to open |
| D4 Storage is Postgres-shaped | The store speaks PostgreSQL + pgvector to whatever a backend's `open()` returns (`Backend`: `query` / `exec` / `transaction` / `close`). A storage plugin is a way of *reaching* such a database — a managed service's driver, a Unix socket, a proxy, an embedded engine — not a different query language. The built-in `postgres` backend gained `url`, `ssl` and `poolSize`; `pglite` gained `path` |
| D5 Hooks are filters, in stage order | `source.text` → `chunk` → `tier0.concepts` → `extract.request` → `extract.result` → `summary.request`, plus the `document.applied` notification. A filter receives the stage's value and returns the one the stage goes on with; several plugins chain in registration order; a handler that returns nothing leaves the value alone. A failing filter fails the document (status `error`, message kept) — a wrong answer from a user function must not be indexed quietly. `document.applied` handlers are logged, never fatal |
| D6 `source.text` is synchronous | It runs inside `loadSourceText`, which the prepare pass, the apply, the tier‑1 planner and the summary generator all call, some of them from code that cannot await. What the hook returns *is* the content: hashed as the scope sha, chunked, extracted, replayed. A hook that changes its mind changes the document, which is the honest outcome |
| D7 Plugins are file-only configuration | `plugins: [{ module, options?, enabled? }]` in `knode.config.json`, or `KNODE_PLUGINS`. The settings API never writes it, the file APIs never reach `knode.config.json` or `plugins/`, so a member cannot make the server load code; an administrator edits the file |
| D8 Nothing re-converts on upgrade | A conversion's cache key used to be `v1\|<vision>\|pages:N\|image:N`. The built-in PDF and image converters keep exactly that key; a plugin converter's key names it (`<id>@<version>\|…`), so it can never collide with them and a bump of its `version` re-converts only what it owns |

## 2. A plugin

A plugin is an ES module whose default export is a `KnodePlugin`
(`src/plugins/types.ts`); everything but `name` is optional:

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
    // the same registrations, imperatively, with the options from the config
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

Declared members are registered first, then `setup(api, options)` runs. The
module is imported once per process: the first config that names it hands it
its `options`, every other workspace shares that installation.

## 3. Extension points

### 3.1 LLM providers

```ts
interface LlmProviderPlugin {
  id: string;                       // what `provider` names
  label: string;
  kind: 'api' | 'cli' | 'custom';   // how Settings groups it
  fields?: LlmProviderField[];      // which LlmConfig fields it reads
  note?: string;
  create(config: LlmConfig): LlmBackend;          // { enabled, label, complete(messages, opts) }
  listModels?(config: LlmConfig): Promise<ModelListResult>;
}
```

`LlmClient` wraps the backend `create` returns; `enabled`, `label` and
`complete` are the backend's. Every stage, Ask, Dream, the reviews and the
labeling slots go through `LlmClient`, so a provider works everywhere a model
is named. Two things stay with the built-in `openai` provider by nature: the
deepagents loop (`loop: 'deepagents'`, which needs a LangChain `ChatOpenAI`
endpoint) and the research agents' built-in executor.

The built-in **`command`** provider needs no plugin code: `cliPath` names an
executable that is run once per call with a JSON request on stdin
(`{ messages, model, json, maxTokens, images }`) and answers on stdout; the
connection's `baseUrl` / `apiKey` reach it as `KNODE_LLM_BASE_URL` /
`KNODE_LLM_API_KEY`, with `env:VAR` resolved. It is the shortest path from "I
have a Python script that calls vendor X" to a knode-os stage.

### 3.2 Embedding providers

```ts
interface EmbeddingProviderPlugin {
  id: string; label: string; kind: 'api' | 'local' | 'custom';
  fields?: EmbeddingProviderField[]; note?: string;
  create(config: EmbeddingConfig): EmbeddingProvider;   // { model, dimensions, embed(texts) }
  listModels?(config): Promise<ModelListResult>;
}
```

`model` is the identity of the vector space (`embeddings.model`); a provider
must return a new one when its vectors stop being comparable. The embedding
pool (`embeddingPool`) stays OpenAI-shaped: it rotates keys of the `openai`
provider only.

### 3.3 Storage backends

```ts
interface StorageBackendPlugin {
  id: string; label: string; note?: string;
  open(dataDir: string, config: DatabaseConfig): Promise<Backend>;
  drop?(dataDir: string, config: DatabaseConfig): Promise<void>;   // the workspace's whole index
}
```

`DatabaseConfig` carries the built-in fields plus `url`, `ssl`, `poolSize`
(postgres), `path` (pglite) and an `options` object for whatever a plugin
needs. `openPglite` and `openPostgres` are exported, so a plugin can wrap them
(a different directory layout, a tunnel it opens first, a driver that speaks
the pg wire over HTTP), and so are `dropPglite` and `dropPostgres` for its
`drop`. Clearing a workspace and `knode-os rebuild` drop the index through it
(`dropBackend`): pglite removes its directory, postgres drops the workspace's
schema with CASCADE, and a backend without `drop` makes both fail with an
error instead of deleting the files and leaving the old index behind.

### 3.4 Document converters

```ts
interface DocumentConverterPlugin {
  id: string; label?: string;
  extensions: string[];        // '.docx', '.epub', …
  version?: string | number;   // bump → re-convert what this converter owns
  usesVision?: boolean;        // the vision model's label joins the cache key
  convert(input: { absPath, rel, vision?, maxPdfPages?, maxImageDimension? }): Promise<ConversionResult>;
}
```

Owning an extension makes a file a *convertible original*: prepare writes the
Markdown into the source's sidecar (`content.md`), the indexed text is read
from there, the file is shown as that Markdown in the UI and through
`knode_read`, and the original is never written back over. `withProvenance`
is exported for the frontmatter the built-ins put on converted text.

### 3.5 Hooks

| Hook | Stage | Value in → out | Context |
| --- | --- | --- | --- |
| `source.text` (sync) | every read of a source's text, before hashing | `string` | `path`, `root`, `dataDir` |
| `chunk` | Index, after the built-in splitter | `ChunkPiece[]` | + `text`, `config { chunkSize, chunkOverlap }` |
| `tier0.concepts` | tier‑0, raw/docs sources | `string[]` concept terms | + `text`, `frontmatter` |
| `extract.request` | Extract, before a call is sent or leased | `ExtractRequest { messages, maxTokens, … }` | + `title`, `segment?` |
| `extract.result` | Extract, after the reply is checked | `ExtractResult { entities, relations, claims }` | + `title`, `model`, `segment?` |
| `summary.request` | Summarize | `ChatMessage[]` | + `title`, `text` |
| `document.applied` | after a document scope lands | event (no return) | `path`, `root`, `chunks`, `entities`, `relations`, `scopeId` |

`extract.request` runs in `segmentExtractRequest`, which both the batch pass
(`knode-os extract`) and the labeling scheduler use, so a worker on another
machine runs exactly the messages the hook produced; `extract.result` runs in
`checkExtractReply`, shared the same way, and its output is checked again by
`parseExtractReply` so a loosely shaped answer never reaches the sidecar.

## 4. Loading

- `module` resolution: a path (`./plugins/x.mjs`, `/abs/x.mjs`, `~/x.mjs`) is
  relative to the data directory; a bare name is resolved from the data
  directory's `node_modules`, then from knode-os's own install.
- Under `serve`, every workspace's config is a copy of the root's. A relative
  path that is not in the workspace is looked for beside the **root** config
  (`createContext(dir, { pluginRoots: [root] })`), so one `plugins/` directory
  at the data root serves every workspace.
- `createContext` loads plugins before opening the store and before building
  the embedder and the Judge client — a backend or provider they add must be
  there first.
- A module that cannot be imported, or whose default export is not a plugin,
  fails the context that asked for it with the module spec in the message. A
  failed load is not remembered: fix the file and reopen.

## 5. Surfaces

- `GET /api/config/providers` — the catalog: every LLM / embedding provider,
  storage backend and converter with its `kind`, `fields`, `note` and which
  plugin registered it, and per hook who handles it. The web Settings screen
  reads it: an LLM connection row offers every non-agent provider and draws
  the fields that provider declares.
- `GET /api/plugins` — what this process loaded (`describe()`), the configured
  specs, and the registry's warnings (replacements, extension takeovers).
- `knode-os plugins [--json]` — the same from the CLI, without opening the store.
- `PUT /api/config` accepts any registered provider id on a connection, a
  route or an embedding entry, and ignores an unregistered one the way it
  ignored a misspelt built-in.

## 6. What is not pluggable (and why)

- The SQL schema and the queries: the store is Postgres + pgvector by design
  (HNSW, `tsvector`, bitemporal columns). A backend changes how that database
  is reached, not what it is.
- Search fusion, the ledger, scopes and folds, wiki page generators, the
  research pipelines: they are the product, not a seam; a hook before or
  after them is the right place for most customisation.
- The deepagents loop and the built-in research executor run on an
  OpenAI-compatible endpoint only; a plugin LLM provider serves the one-shot
  stages and Ask through them, not those loops.

## 7. Security

A plugin runs in the server process with its privileges. `plugins` lives in
`knode.config.json`, which the file APIs refuse to write and the settings API
does not touch; `plugins/` is not a writable tree either. Only someone with
access to the data directory can make knode-os load code. Hook errors in
filters fail the document (visible in the document's `error`), notification
errors are logged with the plugin's name.

## 8. Tests

`tests/plugins.test.ts`: a module loaded from the config providing an LLM
provider, an embedder, a converter and every hook, exercised through
`createContext`, a `sync`, a tier‑1 pass, model listing and the settings API;
the `command` provider against a shell script; the storage registry with the
pglite `path`, an in-process backend and an unknown kind; pg pool settings
from a connection string; redaction of a URL's password; registry chaining,
replacement and the synchronous-hook rule; module resolution with roots; the
preserved conversion cache key.
