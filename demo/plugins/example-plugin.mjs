/**
 * An example knode-os plugin: one of each extension point, small enough to
 * read in one sitting. Copy it to <data>/plugins/, name it in knode.config.json
 *
 *   "plugins": [{ "module": "./plugins/example-plugin.mjs", "options": { "redact": ["CONFIDENTIAL"] } }]
 *
 * and run `knode-os plugins` to see it registered. Guide: docs/plugins.md.
 */

const rot13 = (s) => s.replace(/[a-z]/gi, (c) => {
  const base = c <= 'Z' ? 65 : 97;
  return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
});

export default {
  name: 'example',
  version: '1.0.0',
  description: 'one of each extension point, for reading',

  // `provider: "echo"` on a connection: answers extraction calls with an empty
  // result and everything else with the last user message — a stand-in while
  // wiring a stage, never a model
  llmProviders: [{
    id: 'echo',
    label: 'Echo (example)',
    kind: 'custom',
    fields: ['model'],
    note: 'Returns the last user message. For trying a stage out, not for answers.',
    create: (cfg) => ({
      enabled: true,
      label: `echo${cfg.model ? `:${cfg.model}` : ''}`,
      async complete(messages, opts) {
        if (opts.json) return JSON.stringify({ entities: [], relations: [], claims: [] });
        return messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      },
    }),
  }],

  // `provider: "char-hash"` on an embedding entry: a character-histogram
  // vector, deterministic and offline (the built-in `local` embedder is better)
  embeddingProviders: [{
    id: 'char-hash',
    label: 'Character histogram (example)',
    kind: 'local',
    fields: ['dimensions'],
    create: (cfg) => ({
      model: `char-hash-v1/${cfg.dimensions}`,
      dimensions: cfg.dimensions,
      async embed(texts) {
        return texts.map((text) => {
          const v = new Array(cfg.dimensions).fill(0);
          for (const ch of text) v[ch.codePointAt(0) % cfg.dimensions] += 1;
          const norm = Math.hypot(...v) || 1;
          return v.map((x) => x / norm);
        });
      },
    }),
  }],

  // files ending in .rot13 become Markdown in the sidecar and are indexed from there
  converters: [{
    id: 'rot13',
    label: 'ROT13 text (example)',
    extensions: ['.rot13'],
    version: 1,
    async convert({ absPath, rel }) {
      const fs = await import('node:fs');
      const text = rot13(fs.readFileSync(absPath, 'utf8'));
      return { markdown: `# ${rel}\n\n${text}\n`, kind: 'rot13', model: 'rot13', warnings: [] };
    },
  }],

  hooks: {
    // keep generic nouns out of the tier-0 concept graph
    'tier0.concepts': (terms) => terms.filter((t) => !['公司', '附件', '今天', 'TODO'].includes(t)),
    // one rule for every extraction call, wherever it runs
    'extract.request': (request) => ({
      ...request,
      messages: request.messages.map((m) => (m.role === 'system'
        ? { ...m, content: `${m.content}\n- Ticker symbols are aliases of the company they denote, never entities of their own.` }
        : m)),
    }),
    // drop claims the model marked as suspected
    'extract.result': (result) => ({ ...result, claims: result.claims.filter((c) => c.status !== 'suspected') }),
  },

  // `options.redact`: words replaced before a source is hashed and indexed
  setup(api, options) {
    const words = Array.isArray(options.redact) ? options.redact.filter((w) => typeof w === 'string' && w) : [];
    if (words.length) {
      const pattern = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
      api.on('source.text', (text) => text.replace(pattern, '[redacted]'));
    }
    api.on('document.applied', (event) => api.log(`${event.path}: ${event.chunks} chunks, ${event.entities} entities`));
    api.log(`ready${words.length ? `, redacting ${words.length} word(s)` : ''}`);
  },
};
