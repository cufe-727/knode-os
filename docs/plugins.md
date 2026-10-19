# Plugins and user-defined functions

knode-os can be extended without forking it: a plugin module adds **LLM
providers**, **embedding providers**, **storage backends**, **document
converters** and **hooks** at the document-processing stages. The built-ins
are registered through the same API, so anything they do a plugin can do too.
Design and rationale: [docs/design/11](design/11-plugins-and-udfs.md).

## Quick start

1. Write a module in the data directory:

   ```js
   // <data>/plugins/house-rules.mjs
   export default {
     name: 'house-rules',
     hooks: {
       // strip a boilerplate header before the text is hashed and indexed
       'source.text': (text) => text.replace(/^Internal use only\.\n/m, ''),
       // keep generic nouns out of the tier-0 concept graph
       'tier0.concepts': (terms) => terms.filter((t) => !['公司', '附件', '今天'].includes(t)),
       // one rule for every extraction call, wherever it runs
       'extract.request': (request) => ({
         ...request,
         messages: request.messages.map((m) => (m.role === 'system'
           ? { ...m, content: `${m.content}\n- Ticker symbols are aliases of the company, never entities of their own.` }
           : m)),
       }),
     },
   };
   ```

2. Name it in `knode.config.json` (or set `KNODE_PLUGINS=./plugins/house-rules.mjs`):

   ```jsonc
   "plugins": [{ "module": "./plugins/house-rules.mjs", "options": {} }]
   ```

3. Check what loaded:

   ```bash
   knode-os plugins
   ```

Under `serve`, each workspace's config is a copy of the root data directory's;
a relative `module` path that is not in the workspace is looked for beside the
root config, so one `plugins/` directory at the data root serves every
workspace. A package name (`@acme/knode-anthropic`) is resolved from the data
directory's `node_modules`, then from knode-os's own.

The module is imported once per process. The first config that names it passes
its `options` to `setup(api, options)`; other workspaces share that
installation. A module that fails to load fails the workspace that named it,
with the module spec in the error.

## The plugin object

```ts
export default {
  name: 'my-plugin',            // required
  version: '1.2.0',
  description: 'what it adds',
  llmProviders: [],             // LlmProviderPlugin[]
  embeddingProviders: [],       // EmbeddingProviderPlugin[]
  storageBackends: [],          // StorageBackendPlugin[]
  converters: [],               // DocumentConverterPlugin[]
  hooks: {},                    // { [hookName]: handler }
  async setup(api, options) {   // the same registrations, imperatively
    api.registerLlmProvider(...); api.on('chunk', ...); api.log('ready');
  },
};
```

Types are exported from the package root (`import type { KnodePlugin } from 'knode-os'`),
as are `LlmClient`, `openPglite`, `openPostgres`, `withProvenance` and the
registry itself (`pluginRegistry()`), for programs that embed knode-os and
register in-process instead of through a module.

## Hooks

Filters receive the stage's value and return the value the stage continues
with. Several plugins chain in registration order. A handler that returns
`undefined` leaves the value unchanged (handy for observers). A filter that
throws fails the document — its `error` says which plugin and why — because a
wrong answer from a user function must not be indexed quietly.

| Hook | When | `(value, ctx)` |
| --- | --- | --- |
| `source.text` | every time a source's text is read, before hashing — **synchronous** | `(text: string, { path, root, dataDir })` → `string` |
| `chunk` | Index, after the built-in splitter | `(pieces: { content, tokenCount }[], { path, root, dataDir, text, config })` → pieces |
| `tier0.concepts` | tier-0 concept mining of a raw/docs source | `(terms: string[], { path, root, dataDir, text, frontmatter })` → terms |
| `extract.request` | one tier-1 extraction call, before it is sent or leased to a worker | `(request: { messages, maxTokens, withClaims, askSubject }, { path, title, segment? })` → request |
| `extract.result` | the checked result of one extraction call | `(result: { entities, relations, claims, subject? }, { path, title, model, segment? })` → result |
| `summary.request` | the Summarize stage's prompt | `(messages, { path, title, text })` → messages |
| `document.applied` | a document scope landed (chunks, keyword index, tier-0 graph) | `({ path, root, dataDir, chunks, entities, relations, scopeId })`, no return; errors are logged |

What `source.text` returns *is* the content: it is hashed as the document's
identity, chunked, extracted and replayed. Changing the hook changes every
document it touches on the next sync.

## LLM providers

```js
export default {
  name: 'anthropic',
  llmProviders: [{
    id: 'anthropic',
    label: 'Anthropic Messages API',
    kind: 'api',                                   // 'api' | 'cli' | 'custom'
    fields: ['baseUrl', 'apiKey', 'model'],        // what the settings form shows
    note: 'Claude models through the Messages API.',
    create: (cfg) => ({
      enabled: Boolean(cfg.model),
      label: cfg.model,
      async complete(messages, opts) {
        const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
        const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': resolveKey(cfg.apiKey), 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: opts.model || cfg.model,
            max_tokens: opts.maxTokens ?? 4096,
            system: opts.json ? `${system}\nRespond with a single JSON object only.` : system,
            messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
          }),
        });
        if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const body = await res.json();
        return body.content.map((c) => c.text ?? '').join('');
      },
    }),
    // optional: what the model picker offers
    listModels: async () => ({ ok: true, source: 'builtin', models: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-opus-5-5' }] }),
  }],
};
const resolveKey = (v) => (v.startsWith('env:') ? process.env[v.slice(4)] ?? '' : v);
```

Then a connection with `"provider": "anthropic"` can run any stage, Ask, Dream
and the reviews. `complete` receives `{ json, maxTokens, model, images }`;
honour `json` by returning a single JSON object, and `images` (`{ path,
mimeType }`) when the provider can see.

### Without a plugin: the `command` provider

Any executable can be a model. Set `provider: "command"` on a connection and
point `cliPath` at the program:

- stdin: one JSON object `{ "messages": [{ "role", "content" }], "model", "json", "maxTokens", "images": [{ "path", "mimeType" }] }`
- stdout: the reply text (for a `json` request, the JSON object itself)
- exit code 0 on success; otherwise the call fails with stderr's tail
- environment: `KNODE_LLM_MODEL`, `KNODE_LLM_JSON` (`1`/`0`), and the connection's
  `KNODE_LLM_BASE_URL` / `KNODE_LLM_API_KEY` (an `env:VAR` key is resolved)
- the process runs in the OS temp directory and is killed after `cliTimeoutMs`

```python
#!/usr/bin/env python3
import json, os, sys
req = json.load(sys.stdin)
# call any SDK here; the key came through the environment
answer = my_vendor.chat(model=os.environ["KNODE_LLM_MODEL"], messages=req["messages"], json=req["json"])
print(answer)
```

## Embedding providers

```js
embeddingProviders: [{
  id: 'my-embed',
  label: 'My embedder',
  kind: 'api',                                       // 'api' | 'local' | 'custom'
  fields: ['baseUrl', 'apiKey', 'model', 'dimensions', 'batchSize'],
  create: (cfg) => ({
    model: `my-embed/${cfg.model}`,                  // the identity of the vector space
    dimensions: cfg.dimensions,
    async embed(texts) { /* return number[][] with cfg.dimensions each */ },
  }),
}]
```

`model` names the vector space: vectors are only comparable within one, and the
embeddings table is keyed by it, so return a new name when the vectors change.
The embedding pool (`embeddingPool`) rotates `openai`-provider keys only.

## Storage backends

The store speaks PostgreSQL + pgvector to whatever `open` returns, so a backend
is a way of *reaching* such a database. Most cases need no plugin: the built-in
`postgres` backend takes a connection string, TLS and a pool size —

```jsonc
"database": {
  "kind": "postgres",
  "url": "env:DATABASE_URL",      // postgres://user:pass@host:5432/knode?sslmode=require
  "ssl": "require",               // true | "require" verify the certificate; "no-verify" encrypts only
  "poolSize": 5,
  "schemaPrefix": "ws"
}
```

— and `pglite` takes `"path": ".knode/db"` (relative to the workspace, or
absolute). A plugin backend wraps one of them, or brings its own driver:

```js
import { dropPostgres, openPostgres } from 'knode-os';
storageBackends: [{
  id: 'neon',
  label: 'Neon (pooled)',
  async open(dataDir, cfg) {
    const url = await resolvePooledUrl(cfg.options?.project);   // whatever the service needs
    return openPostgres(dataDir, { ...cfg, kind: 'postgres', url, ssl: 'require' });
  },
  async drop(dataDir, cfg) {                                    // clearing the workspace, `knode-os rebuild`
    const url = await resolvePooledUrl(cfg.options?.project);
    return dropPostgres(dataDir, { ...cfg, kind: 'postgres', url, ssl: 'require' });
  },
}]
```

`database.options` is free-form for a plugin's own settings. `drop` deletes
everything the backend keeps for one workspace, so the next `open` starts
empty: the built-ins remove the PGlite directory or `DROP SCHEMA … CASCADE` the
workspace's schema (`dropPglite`, `dropPostgres`). It is optional, but clearing
a workspace and `knode-os rebuild` refuse to run on a backend without one
rather than delete the files and leave the old index for the next open.

## Document converters

```js
converters: [{
  id: 'docx',
  label: 'Word documents',
  extensions: ['.docx'],
  version: 1,                 // bump to re-convert existing .docx files
  usesVision: false,
  async convert({ absPath, rel, vision }) {
    const markdown = await docxToMarkdown(absPath);
    return { markdown, kind: 'docx', model: 'mammoth', warnings: [] };
  },
}]
```

Owning an extension makes those files convertible originals: prepare writes
the Markdown into the source's sidecar (`.sidecar/<key>/content.md`), the text
is indexed from there, and the file is shown as that Markdown in the UI and
through `knode_read`. `withProvenance(rel, kind, model, body)` (exported)
produces the frontmatter the built-in converters put on converted text. The
Convert stage's vision model is passed as `vision` when one is configured;
declare `usesVision: true` so a model change re-converts.

## Seeing what is loaded

- `knode-os plugins [--json]` — every plugin (built-ins first), what each
  registered, and warnings such as a plugin replacing a built-in provider.
- `GET /api/plugins` — the same for the web UI.
- `GET /api/config/providers` — the provider catalog with each provider's
  `kind`, `fields` and `note`; Settings draws LLM connection forms from it.

## Security

A plugin runs inside the knode-os process with its privileges. `plugins` is
set only in `knode.config.json` (or the environment): the settings API never
writes it, the file APIs refuse `knode.config.json` and `plugins/`, so only
someone with access to the data directory can make the server load code.
