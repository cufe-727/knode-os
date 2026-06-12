import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, defaultConfig, saveConfig } from '../config.js';

/**
 * Data directory layout (markdown is the system of record; the database is a
 * rebuildable derived index — see gbrain / llm_wiki):
 *
 *   <data>/
 *   ├── knode.config.json     embedding / llm / server / dream settings
 *   ├── purpose.md            what this knowledge base is for (steers wiki generation)
 *   ├── schema.md             wiki structure rules (entity types, link types)
 *   ├── raw/                  immutable-ish inputs
 *   │   ├── docs/             user-uploaded documents
 *   │   ├── traces/           agent traces, auto-synced
 *   │   │   ├── claude/       Claude Code session transcripts (~/.claude/projects)
 *   │   │   └── codex/        Codex CLI session rollouts (~/.codex/sessions)
 *   │   └── skills/           skills/prompts the agents have used
 *   ├── wiki/                 LLM-curated, interlinked knowledge
 *   │   ├── index.md          navigation entry
 *   │   ├── log.md            append-only operation log
 *   │   ├── overview.md       rolling global summary
 *   │   ├── entities/         people / orgs / products / components
 *   │   ├── concepts/         theories, methods, designs
 *   │   ├── sources/          per-source summaries
 *   │   └── dreams/           nightly dream reports
 *   └── .knode/               derived state (PGlite database) — safe to delete & reindex
 */

export const RAW_DIRS = ['raw/docs', 'raw/traces/claude', 'raw/traces/codex', 'raw/skills'];
export const WIKI_DIRS = ['wiki/entities', 'wiki/concepts', 'wiki/sources', 'wiki/dreams'];
export const DB_DIR = '.knode/db';

const PURPOSE_TEMPLATE = `# Purpose

Describe what this knowledge base is for. The wiki generator and the nightly
dream both read this file to decide what matters.

- Audience: me and my coding agents (Claude Code, Codex)
- Goals: …
- Out of scope: …
`;

const SCHEMA_TEMPLATE = `# Wiki schema

Structural rules the wiki follows. Edit freely — generators respect this file.

## Page types

| directory        | type    | what goes here                          |
| ---------------- | ------- | --------------------------------------- |
| wiki/entities/   | entity  | people, orgs, products, components      |
| wiki/concepts/   | concept | theories, methods, designs, conventions |
| wiki/sources/    | source  | one summary page per raw document       |
| wiki/dreams/     | dream   | nightly trace-analysis reports          |

## Conventions

- Every page starts with YAML frontmatter (\`title\`, \`type\`, \`aliases\`).
- Cross-reference with \`[[wikilinks]]\`; links are extracted into the knowledge graph.
- Relation types: related_to, part_of, uses, depends_on, works_at, authored, mentions.
`;

const INDEX_TEMPLATE = `# Index

Navigation entry for this wiki. Updated by ingestion and by you.

- [Overview](overview.md)
- [Operation log](log.md)
- Entities: see \`entities/\`
- Concepts: see \`concepts/\`
- Sources: see \`sources/\`
- Dreams: see \`dreams/\`
`;

const OVERVIEW_TEMPLATE = `# Overview

Rolling global summary of everything in this knowledge base. Regenerated as
content grows; safe to edit.
`;

const LOG_TEMPLATE = `# Operation log

Append-only, newest first. One line per operation: \`- <ISO time> <op>: <detail>\`
`;

export interface InitResult {
  created: string[];
  dataDir: string;
}

/** Create the data directory layout. Idempotent — never overwrites existing files. */
export function initDataDir(dataDir: string): InitResult {
  const created: string[] = [];
  const ensureDir = (rel: string) => {
    const abs = path.join(dataDir, rel);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(abs, { recursive: true });
      created.push(rel + '/');
    }
  };
  const ensureFile = (rel: string, content: string) => {
    const abs = path.join(dataDir, rel);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      created.push(rel);
    }
  };

  fs.mkdirSync(dataDir, { recursive: true });
  for (const d of [...RAW_DIRS, ...WIKI_DIRS, '.knode']) ensureDir(d);
  ensureFile('purpose.md', PURPOSE_TEMPLATE);
  ensureFile('schema.md', SCHEMA_TEMPLATE);
  ensureFile('wiki/index.md', INDEX_TEMPLATE);
  ensureFile('wiki/overview.md', OVERVIEW_TEMPLATE);
  ensureFile('wiki/log.md', LOG_TEMPLATE);
  if (!fs.existsSync(path.join(dataDir, CONFIG_FILE))) {
    saveConfig(dataDir, defaultConfig());
    created.push(CONFIG_FILE);
  }
  return { created, dataDir };
}

/** Append a line to wiki/log.md, newest entries right under the header. */
export function appendLog(dataDir: string, op: string, detail: string): void {
  const file = path.join(dataDir, 'wiki', 'log.md');
  const line = `- ${new Date().toISOString()} ${op}: ${detail}`;
  let body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : LOG_TEMPLATE;
  const lines = body.split('\n');
  // insert after the first blank line following the header block
  let insertAt = lines.findIndex((l) => l.startsWith('- '));
  if (insertAt === -1) insertAt = lines.length;
  lines.splice(insertAt, 0, line);
  fs.writeFileSync(file, lines.join('\n'));
}
