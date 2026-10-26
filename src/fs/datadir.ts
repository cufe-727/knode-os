import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, defaultConfig, saveConfig } from '../config.js';
import { initObsidianVault } from '../obsidian/vault.js';
import { ensureDefaultPlaybooks } from '../pack/playbook.js';
import { ensureDefaultIntents } from '../compiler/intents.js';
import { ensureDefaultConceptStoplist } from '../graph/concept-stoplist.js';
import { ensureDefaultOntology } from '../graph/ontology.js';
import { ensureDefaultResearchTemplates } from '../research/templates.js';
import { ensureDefaultChatPlaybooks } from '../chat/templates.js';
import { ensureDefaultAgents } from '../research/agents.js';
import { ensureDefaultProfiles } from '../research/profile.js';
import { CAPABILITIES_DIR, DB_DIR, INTENTS_DIR, LEGACY_TOP_LEVEL, PACKS_DIR } from './layout.js';

/**
 * Data directory layout (markdown is the system of record; the database is a
 * rebuildable derived index — see gbrain / llm_wiki):
 *
 *   <data>/
 *   ├── knode.config.json     embedding / llm / server / dream settings
 *   ├── purpose.md            what this knowledge base is for (steers wiki generation)
 *   ├── schema.md             wiki structure rules (entity types, link types)
 *   ├── raw/                  immutable-ish inputs (L0 — originals, never rewritten)
 *   │   ├── docs/             user-uploaded documents
 *   │   ├── traces/           agent traces, auto-synced
 *   │   │   ├── claude/       Claude Code session transcripts (~/.claude/projects)
 *   │   │   └── codex/        Codex CLI session rollouts (~/.codex/sessions)
 *   │   └── skills/           skills/prompts the agents have used
 *   ├── .sidecar/             derived layer (L1 — system-managed, keep it): one directory per
 *   │                         source key mirroring the tree above — content.md for converted
 *   │                         originals, meta / tier0 / tier1 / usage JSON, cached LLM views
 *   ├── wiki/                 LLM-curated, interlinked knowledge (L3)
 *   │   ├── .obsidian/        vault-local Obsidian configuration
 *   │   ├── attachments/      Obsidian-managed attachments
 *   │   ├── index.md          navigation entry
 *   │   ├── log.md            append-only operation log
 *   │   ├── overview.md       rolling global summary
 *   │   ├── entities/         people / orgs / products / components
 *   │   ├── concepts/         theories, methods, designs
 *   │   ├── sources/          per-source summaries
 *   │   └── dreams/           nightly dream reports
 *   ├── playbooks/            agent-editable configuration (Markdown / YAML)
 *   │   ├── packs/            context-pack playbooks, revised by the learning loop
 *   │   ├── concepts/         tier-0 concept stop list (editable) and learned frequent terms
 *   │   ├── capabilities/     semantic layer over live sources (metric definitions, joins, pitfalls)
 *   │   └── intents/          intent specs: the slots an answer needs (Context Compiler)
 *   ├── ledger/               machine truth: events.jsonl (apply/dispose/purge/feedback)
 *   │   └── attic/            sidecars + previous file versions of disposed sources
 *   └── .knode/               local state; with database.kind "pglite" also the index itself
 *                             (L2, db/) — by default the index is this workspace's PostgreSQL schema
 */

const RAW_DIRS = ['raw/docs', 'raw/traces/claude', 'raw/traces/codex', 'raw/skills'];
const WIKI_DIRS = ['wiki/entities', 'wiki/concepts', 'wiki/sources', 'wiki/dreams', 'wiki/datasets'];
/** Agent-editable configuration: playbooks, capability notes, intent specs (see src/fs/layout.ts). */
const CONFIG_DIRS = [PACKS_DIR, CAPABILITIES_DIR, INTENTS_DIR];
/** Lineage ledger (append-only events + attic). Not derived — it is how the DB is rebuilt with history. */
const LEDGER_DIRS = ['ledger', 'ledger/attic'];
export { DB_DIR };

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

- The \`wiki/\` directory is an OKF v0.2 knowledge bundle and a standalone
  Obsidian Vault. Open that folder directly in Obsidian; Vault settings live
  in \`wiki/.obsidian/\`, and attachments go to \`wiki/attachments/\`.
- Every concept page starts with YAML frontmatter; \`type\` is required, while
  \`title\`, \`description\`, \`resource\`, and \`tags\` are recommended.
- Provenance and trust are optional frontmatter families: \`sources\`,
  \`generated: { by, at }\`, \`verified\`, \`status\`, \`stale_after\`. \`by\` is an
  actor: \`human:<id>\`, \`process:<id>\`, or \`<producer>/<version>\`. Generated
  pages carry \`generated\`; v0.1's bare \`timestamp\` is still read as a fallback.
- \`index.md\` and \`log.md\` are reserved OKF files. Only the root index may
  carry frontmatter, where it declares \`okf_version: "0.2"\`.
- Cross-reference with ordinary markdown links (OKF + Obsidian) or Obsidian
  \`[[wikilinks]]\`, aliases, heading/block links and embeds; all are understood
  by the knowledge graph.
- Relation types: related_to, part_of, uses, depends_on, works_at, authored,
  mentions, links_to (OKF markdown links).
`;

const INDEX_TEMPLATE = `---
okf_version: "0.2"
---

# Index

Navigation entry for this wiki. Updated by ingestion and by you.

* [Overview](overview.md) - Rolling global summary.
* [Operation log](log.md) - Chronological knowledge updates.
* [Entities](entities/) - People, organizations, products, and components.
* [Concepts](concepts/) - Theories, methods, designs, and conventions.
* [Sources](sources/) - Source-document summaries.
* [Dreams](dreams/) - Trace-analysis reports and suggestions.
`;

const OVERVIEW_TEMPLATE = `---
type: Overview
title: Overview
description: Rolling global summary of this knowledge bundle.
---

# Overview

Rolling global summary of everything in this knowledge base. Regenerated as
content grows; safe to edit.
`;

const LOG_TEMPLATE = `# Directory Update Log
`;

/** Files initDataDir seeds with a template; a file that still equals its template was never edited. */
export const SEED_FILES: Record<string, string> = {
  'purpose.md': PURPOSE_TEMPLATE,
  'schema.md': SCHEMA_TEMPLATE,
  'wiki/overview.md': OVERVIEW_TEMPLATE,
};

function squashTemplate(text: string): string {
  return text.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim();
}

/** True when `text` is still the template `initDataDir` wrote at `rel` (line endings and trailing whitespace ignored). */
export function isSeedTemplate(rel: string, text: string): boolean {
  const template = SEED_FILES[rel.replace(/\\/g, '/').replace(/^\/+/, '')];
  return template !== undefined && squashTemplate(template) === squashTemplate(text);
}

/**
 * The knowledge-base guide an initialization job writes at the data root:
 * what this base holds, how to query it, how to write into it. `CLAUDE.md`
 * is an identical copy so Claude Code picks it up when started in the data
 * directory; every research / chat workspace and the MCP server's
 * `instructions` carry the same text. Never indexed as a source.
 */
export const GUIDE_FILE = 'AGENTS.md';
export const GUIDE_COPY = 'CLAUDE.md';

export function readGuide(dataDir: string): string | null {
  const file = path.join(dataDir, GUIDE_FILE);
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

const DIRECTORY_INDEXES: Record<string, string> = {
  'wiki/entities/index.md': '# Entities\n\nPeople, organizations, products, components, and other named entities.\n',
  'wiki/concepts/index.md': '# Concepts\n\nTheories, methods, designs, conventions, and generated topic clusters.\n',
  'wiki/sources/index.md': '# Sources\n\nSummaries and navigation for indexed source documents.\n',
  'wiki/dreams/index.md': '# Dreams\n\nAgent trace-analysis reports and knowledge-maintenance suggestions.\n',
  'wiki/datasets/index.md': '# Datasets\n\nLive external tables (schema + entity links only — rows stay in their source systems).\n',
};

export interface InitResult {
  created: string[];
  dataDir: string;
}

/** A data directory laid out the pre-v3 way (cooked/ copies, top-level packs/ capabilities/ intents/). */
export class LegacyLayoutError extends Error {
  constructor(dataDir: string, found: string[]) {
    super([
      `${dataDir} uses the pre-v3 data layout (found ${found.map((f) => `${f}/`).join(', ')}).`,
      'knode-os no longer reads cooked/ copies or the top-level packs/, capabilities/ and intents/ directories, and there is no automatic migration.',
      'Move the directory aside (e.g. rename it to <dir>.old), run `knode-os init` for a fresh layout, then re-import your originals from <dir>.old/raw/docs.',
      'Local development directories such as .dev-data or .demo-data are affected in the same way.',
    ].join(' '));
    this.name = 'LegacyLayoutError';
  }
}

/** Refuse a pre-v3 directory outright rather than mixing two layouts in one tree. */
export function assertSupportedLayout(dataDir: string): void {
  if (!fs.existsSync(dataDir)) return;
  const found = LEGACY_TOP_LEVEL.filter((name) => fs.existsSync(path.join(dataDir, name)));
  if (found.length > 0) throw new LegacyLayoutError(dataDir, found);
}

/** Create the data directory layout. Idempotent — never overwrites existing files. */
export function initDataDir(dataDir: string): InitResult {
  assertSupportedLayout(dataDir);
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
  for (const d of [...RAW_DIRS, ...WIKI_DIRS, ...CONFIG_DIRS, ...LEDGER_DIRS, '.knode']) ensureDir(d);
  ensureFile('purpose.md', PURPOSE_TEMPLATE);
  ensureFile('schema.md', SCHEMA_TEMPLATE);
  ensureFile('wiki/index.md', INDEX_TEMPLATE);
  ensureFile('wiki/overview.md', OVERVIEW_TEMPLATE);
  ensureFile('wiki/log.md', LOG_TEMPLATE);
  for (const [rel, content] of Object.entries(DIRECTORY_INDEXES)) ensureFile(rel, content);
  const obsidian = initObsidianVault(path.join(dataDir, 'wiki'));
  created.push(...obsidian.created.map((rel) => `wiki/${rel}`));
  // starters for the two configurable layers: how to retrieve (playbook) and
  // what an answer needs (intent). Both are examples to edit, never overwritten.
  created.push(...ensureDefaultPlaybooks(dataDir), ...ensureDefaultIntents(dataDir), ...ensureDefaultOntology(dataDir), ...ensureDefaultConceptStoplist(dataDir), ...ensureDefaultResearchTemplates(dataDir), ...ensureDefaultProfiles(dataDir), ...ensureDefaultAgents(dataDir), ...ensureDefaultChatPlaybooks(dataDir));
  if (!fs.existsSync(path.join(dataDir, CONFIG_FILE))) {
    saveConfig(dataDir, defaultConfig());
    created.push(CONFIG_FILE);
  }
  return { created, dataDir };
}

/** Append an OKF date-grouped entry to wiki/log.md, newest first. */
export function appendLog(dataDir: string, op: string, detail: string): void {
  const file = path.join(dataDir, 'wiki', 'log.md');
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const safeOp = op.replace(/[\r\n*]/g, ' ').trim() || 'Update';
  const safeDetail = detail.replace(/[\r\n]+/g, ' ').trim();
  const line = `* **${safeOp}**: ${safeDetail}`;
  let body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : LOG_TEMPLATE;

  // One-time, lossless upgrade of the legacy "- <timestamp> op: detail"
  // system log. This keeps existing data directories exportable as OKF.
  if (/^\s*[-*]\s+\d{4}-\d{2}-\d{2}T\S+\s+/m.test(body)) {
    const groups = new Map<string, string[]>();
    for (const oldLine of body.split(/\r?\n/)) {
      const match = /^\s*[-*]\s+(\d{4}-\d{2}-\d{2})T\S+\s+([^:]+):\s*(.*)$/.exec(oldLine);
      if (!match) continue;
      const [, oldDate, oldOp, oldDetail] = match;
      if (!groups.has(oldDate)) groups.set(oldDate, []);
      groups.get(oldDate)!.push(`* **${oldOp.trim()}**: ${oldDetail.trim()}`);
    }
    const migrated = ['# Directory Update Log', ''];
    for (const oldDate of [...groups.keys()].sort().reverse()) {
      migrated.push(`## ${oldDate}`, '', ...groups.get(oldDate)!, '');
    }
    body = migrated.join('\n');
  }

  const lines = body.split('\n');
  const heading = `## ${date}`;
  const groupAt = lines.findIndex((l) => l.trim() === heading);
  if (groupAt >= 0) {
    let insertAt = groupAt + 1;
    while (insertAt < lines.length && !lines[insertAt].trim()) insertAt++;
    lines.splice(insertAt, 0, line);
  } else {
    const firstGroup = lines.findIndex((l) => /^##\s+\d{4}-\d{2}-\d{2}\s*$/.test(l));
    const insertAt = firstGroup >= 0 ? firstGroup : lines.length;
    lines.splice(insertAt, 0, heading, '', line, '');
  }
  fs.writeFileSync(file, lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n');
}
