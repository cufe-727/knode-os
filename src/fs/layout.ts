import fs from 'node:fs';
import path from 'node:path';

/**
 * Data-directory layout — the one place directory names are declared.
 *
 *   <data>/
 *   ├── raw/{docs,traces,skills}   originals; the raw path is the canonical key of every source
 *   ├── .sidecar/<key>/            derived, system-owned state mirroring the data dir (keep it)
 *   ├── wiki/                      curated knowledge (OKF bundle + Obsidian vault)
 *   ├── playbooks/{packs,capabilities,intents,ontology,research,concepts}   agent-editable configuration
 *   ├── ledger/                    events.jsonl + attic (machine truth)
 *   └── .knode/db                  PGlite index (disposable), only with database.kind "pglite" —
 *                                  by default the index is a schema on a PostgreSQL server
 *
 * This module has no knode-os imports so every other module can depend on it.
 */

export const RAW_DIR = 'raw';
export const RAW_DOCS = 'raw/docs';
export const RAW_TRACES = 'raw/traces';
export const RAW_SKILLS = 'raw/skills';
export const WIKI_DIR = 'wiki';

/** Agent-editable configuration, all Markdown/YAML. */
export const CONFIG_DIR = 'playbooks';
/** Context-pack playbooks: retrieval workflows revised by the learning loop (see src/pack). */
export const PACKS_DIR = `${CONFIG_DIR}/packs`;
/** Semantic layer over live sources: metric definitions, joins, pitfalls (see src/capability). */
export const CAPABILITIES_DIR = `${CONFIG_DIR}/capabilities`;
/** Intent specs: the slots an answer needs (see src/compiler). */
export const INTENTS_DIR = `${CONFIG_DIR}/intents`;
/** Ontology packs: the entity and relation vocabulary the graph is written in (see src/graph/ontology). */
export const ONTOLOGY_DIR = `${CONFIG_DIR}/ontology`;
/** Deep-research templates: what an external agent is told when asked to write a wiki page (see src/research). */
export const RESEARCH_DIR = `${CONFIG_DIR}/research`;
/** Tier-0 concept mining: the editable stop list and the learned frequent-term list (see src/graph/concept-stoplist). */
export const CONCEPTS_DIR = `${CONFIG_DIR}/concepts`;

/**
 * Named agents. Not to be confused with the `AGENTS.md` at the data root,
 * which is the knowledge-base guide an agent reads (see fs/datadir).
 */
export const AGENTS_DIR = `${CONFIG_DIR}/agents`;
/** The chat entry's protocol and per-turn prompt (src/chat). */
export const CHAT_DIR = `${CONFIG_DIR}/chat`;

export const LEDGER_DIR = 'ledger';
export const ATTIC_DIR = `${LEDGER_DIR}/attic`;
export const DB_DIR = '.knode/db';

/**
 * Folders the file tree leaves out, though they stay on disk and open by path:
 * the ledger is machine truth nobody browses, lint reports and datasource
 * problems reach people as notices (src/server/notices.ts), and playbooks are
 * edited in Settings. Dataset pages stay searchable and cited.
 */
export const TREE_HIDDEN: ReadonlySet<string> = new Set([LEDGER_DIR, `${WIKI_DIR}/lint`, `${WIKI_DIR}/datasets`, CONFIG_DIR]);

/**
 * What each folder knode-os makes is for, shown beside it in the file tree.
 * Plain English: the Mac app translates these exact strings, so a change here
 * wants the same change in its Localization table.
 */
export const FOLDER_ABOUT: Readonly<Record<string, string>> = {
  [RAW_DIR]: 'Originals, never rewritten',
  [RAW_DOCS]: 'Your documents: uploads, imports, linked folders',
  [`${RAW_DOCS}/research`]: 'Web pages and files research studies saved',
  [`${RAW_DOCS}/notes`]: 'Notes agents saved: research logs, what Ask was taught',
  [`${RAW_DOCS}/okf`]: 'Imported OKF bundles',
  [RAW_TRACES]: 'Agent sessions, read by the nightly review',
  [`${RAW_TRACES}/claude`]: 'Claude Code sessions',
  [`${RAW_TRACES}/codex`]: 'Codex sessions',
  [RAW_SKILLS]: 'Skills and prompts your agents used',
  [WIKI_DIR]: 'Curated pages; also an Obsidian vault',
  [`${WIKI_DIR}/entities`]: 'People, organizations, products',
  [`${WIKI_DIR}/concepts`]: 'Methods, theories, conventions',
  [`${WIKI_DIR}/sources`]: 'A summary of each document',
  [`${WIKI_DIR}/timelines`]: 'Chronologies',
  [`${WIKI_DIR}/comparisons`]: 'Side-by-side comparisons',
  [`${WIKI_DIR}/questions`]: 'Researched answers to questions',
  [`${WIKI_DIR}/reviews`]: 'Fact-checks of existing pages',
  [`${WIKI_DIR}/research`]: 'Research studies: reports and their sections',
  [`${WIKI_DIR}/dreams`]: 'Nightly review reports',
  [`${WIKI_DIR}/learning`]: 'What the planner learned from past answers',
  [`${WIKI_DIR}/attachments`]: 'Images and files pages embed',
};

/**
 * Root of the derived layer. `.sidecar/<key>/` holds everything knode-os
 * derives from the source at `<key>` (converted Markdown, chunk map, tier-0/1
 * extraction, usage stats, cached LLM views). Unlike `.knode/`, it is *not*
 * disposable: tier-1 results and heat history live here and are replayed for
 * free on a rebuild.
 */
export const SIDECAR_ROOT = '.sidecar';
export const SIDECAR_ROOT_SEGMENT = path.posix.basename(SIDECAR_ROOT);

/** Top-level entries that identify a pre-v3 data directory (no migration exists). */
export const LEGACY_TOP_LEVEL = ['cooked', 'packs', 'capabilities', 'intents'];

function cleanRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Sidecar directory (relative to the data dir) for a source key such as `raw/docs/a.pdf`. */
export function sidecarRelFor(key: string): string {
  return `${SIDECAR_ROOT}/${cleanRel(key)}`;
}

/** True when any path segment names the sidecar root — such paths are never user-writable. */
export function hasSidecarSegment(rel: string): boolean {
  return cleanRel(rel).split('/').some((segment) => segment === SIDECAR_ROOT_SEGMENT);
}

const MARKER_FILES = new Set(['meta.json', 'content.md']);

/**
 * Source keys that have a sidecar directory under `<data>/.sidecar/<underRel>`.
 * A directory is a sidecar when it holds a `meta.json` or `content.md` *file*
 * (a source literally named `meta.json` yields a directory of that name one
 * level up, which is why the file check matters). Subdirectories other than
 * `views/` are still visited, so a key that is both a file and a directory
 * prefix (`raw/docs/notes` and `raw/docs/notes/x.md`) lists both.
 */
export function listSidecarKeys(dataDir: string, underRel: string): string[] {
  const under = cleanRel(underRel);
  const start = path.join(dataDir, SIDECAR_ROOT, ...under.split('/'));
  const out: string[] = [];
  const visit = (abs: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    const isSidecar = entries.some((e) => e.isFile() && MARKER_FILES.has(e.name));
    if (isSidecar) out.push(rel);
    for (const e of entries) {
      if (!e.isDirectory() || (isSidecar && e.name === 'views')) continue;
      visit(path.join(abs, e.name), `${rel}/${e.name}`);
    }
  };
  if (fs.existsSync(start) && fs.statSync(start).isDirectory()) visit(start, under);
  return out;
}
