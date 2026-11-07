import { embeddingProviderLabel } from '../config.js';
import { epubConverter } from '../ingest/converters/epub.js';
import { htmlConverter } from '../ingest/converters/html.js';
import { imageConverter } from '../ingest/converters/image.js';
import { pdfConverter } from '../ingest/converters/pdf.js';
import { ArkMultimodalEmbeddingProvider, LocalHashEmbeddingProvider, OpenAIEmbeddingProvider } from '../ingest/embeddings.js';
import { cliProviders } from '../llm/providers/cli.js';
import { commandProvider } from '../llm/providers/command.js';
import { openAiProvider } from '../llm/providers/openai.js';
import { dropPglite, dropPostgres, openPglite, openPostgres } from '../store/backend.js';
import type { PluginRegistry } from './registry.js';

/**
 * What knode-os ships with, registered through the same API a plugin uses.
 * Installed by `pluginRegistry()` on first use — never at import time: this
 * module sits in an import cycle with the facades whose implementations it
 * registers, and a cycle is only safe while nobody reads across it during
 * evaluation.
 */

export const BUILTIN_PLUGIN = 'builtin';

export function registerBuiltins(registry: PluginRegistry): void {
  registry.installSync({
    name: BUILTIN_PLUGIN,
    description: 'The providers, storage backends and converters knode-os ships with.',
    llmProviders: [openAiProvider(), ...cliProviders(), commandProvider()],
    embeddingProviders: [
      {
        id: 'local',
        label: embeddingProviderLabel('local'),
        kind: 'local',
        fields: ['dimensions'],
        note: 'Feature-hashing embedder: offline, deterministic, no key. Far below a real model in quality, but vector recall works out of the box.',
        create: (cfg) => new LocalHashEmbeddingProvider(cfg.dimensions),
      },
      {
        id: 'openai',
        label: embeddingProviderLabel('openai'),
        kind: 'api',
        fields: ['baseUrl', 'apiKey', 'model', 'dimensions', 'batchSize', 'sendDimensions'],
        note: 'Any OpenAI-compatible /embeddings endpoint (OpenAI, Ollama, vLLM, SiliconFlow, Cloudflare Workers AI, …).',
        create: (cfg) => new OpenAIEmbeddingProvider(cfg),
      },
      {
        id: 'ark-multimodal',
        label: embeddingProviderLabel('ark-multimodal'),
        kind: 'api',
        fields: ['baseUrl', 'apiKey', 'model', 'dimensions', 'batchSize', 'sendDimensions'],
        note: 'Volcengine Ark /embeddings/multimodal: one fused vector per request, so Base URL ends at /api/v3, Model is the endpoint id (ep-…) and batchSize is the concurrency window.',
        create: (cfg) => new ArkMultimodalEmbeddingProvider(cfg),
      },
    ],
    storageBackends: [
      {
        id: 'pglite',
        label: 'Embedded PGlite',
        note: 'Postgres + pgvector embedded in the process, one database per workspace under .knode/db (database.path moves it). Zero setup; one process at a time.',
        open: (dataDir, cfg) => openPglite(dataDir, cfg),
        drop: (dataDir, cfg) => dropPglite(dataDir, cfg),
      },
      {
        id: 'postgres',
        label: 'PostgreSQL server',
        note: 'One shared database, one schema per workspace. Reached through database.url (a connection string; "env:VAR" allowed) or host/port/user/password/database, with ssl and poolSize.',
        open: (dataDir, cfg) => openPostgres(dataDir, cfg),
        drop: (dataDir, cfg) => dropPostgres(dataDir, cfg),
      },
    ],
    converters: [pdfConverter, imageConverter, htmlConverter, epubConverter],
  }, BUILTIN_PLUGIN);
}
