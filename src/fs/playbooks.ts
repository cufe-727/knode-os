import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { CHAT_PROTOCOL, CHAT_PROTOCOL_FILE, CHAT_TURN, CHAT_TURN_FILE } from '../chat/templates.js';
import { DEFAULT_INTENT_YAML } from '../compiler/intents.js';
import { STOPLIST_TEMPLATE } from '../graph/concept-stoplist.js';
import { builtinPackYaml } from '../graph/ontology.js';
import { DEFAULT_PLAYBOOK } from '../pack/playbook.js';
import { builtinResearchText, parseResearchTemplate, PROTOCOL_FILE } from '../research/templates.js';
import { cleanRelPath, safePath } from './files.js';
import { AGENTS_DIR, CAPABILITIES_DIR, CHAT_DIR, CONCEPTS_DIR, INTENTS_DIR, ONTOLOGY_DIR, PACKS_DIR, RESEARCH_DIR } from './layout.js';
import { writeAtomic } from './sidecar.js';

/**
 * playbooks/ as Settings shows it. The file tree leaves the folder out
 * (TREE_HIDDEN), so this is where a person reads and edits it: the files
 * grouped the way knode-os reads them, each saying whether a built-in stands
 * behind it (a reset puts that back) and whether it was edited. Files another
 * page owns — named agents, research profiles, research sources — name that
 * page and are written only there, through its own checks.
 */

export type PlaybookGroupId = 'research' | 'phases' | 'packs' | 'intents' | 'ontology' | 'concepts' | 'capabilities' | 'chat' | 'agents' | 'profiles' | 'sources';

/** The page that edits a file instead: Settings → Providers & Agents, Settings → Research, Research → Sources. */
export type PlaybookOwner = 'providers' | 'research' | 'sources';

export interface PlaybookFile {
  path: string;
  name: string;
  bytes: number;
  mtime: string;
  /** knode-os ships a version of this file: a reset writes it back. */
  builtin: boolean;
  /** The file differs from that version (false without one): edited, or seeded from an older one. */
  modified: boolean;
  /** knode-os regenerates the file, so an edit would not last. */
  readonly: boolean;
  /** Edited on another settings page, not here. */
  managedIn: PlaybookOwner | null;
}

export interface PlaybookGroup {
  id: PlaybookGroupId;
  dir: string;
  /** The page that edits the whole group, as its files say too. */
  managedIn: PlaybookOwner | null;
  files: PlaybookFile[];
}

interface GroupSpec {
  id: PlaybookGroupId;
  dir: string;
  /** The files this group lists, directly in `dir` (subfolders are groups of their own). */
  match: RegExp;
  builtin?: (name: string) => string | undefined;
  /** Every file of the group is edited on that page instead. */
  managedIn?: PlaybookOwner;
  /** Files knode-os writes itself. */
  generated?: string[];
}

const GROUPS: GroupSpec[] = [
  { id: 'research', dir: RESEARCH_DIR, match: /\.md$/, builtin: (n) => builtinResearchText(n) },
  { id: 'phases', dir: `${RESEARCH_DIR}/phases`, match: /\.md$/, builtin: (n) => builtinResearchText(`phases/${n}`) },
  { id: 'packs', dir: PACKS_DIR, match: /\.md$/, builtin: (n) => (n === 'default.md' ? DEFAULT_PLAYBOOK : undefined) },
  { id: 'intents', dir: INTENTS_DIR, match: /\.ya?ml$/, builtin: (n) => (n === 'entity-overview.yaml' ? DEFAULT_INTENT_YAML : undefined) },
  { id: 'ontology', dir: ONTOLOGY_DIR, match: /\.ya?ml$/, builtin: (n) => builtinPackYaml(n.replace(/\.ya?ml$/, '')) },
  { id: 'concepts', dir: CONCEPTS_DIR, match: /\.ya?ml$/, builtin: (n) => (n === 'stoplist.yaml' ? STOPLIST_TEMPLATE : undefined), generated: ['frequent.yaml'] },
  { id: 'capabilities', dir: CAPABILITIES_DIR, match: /\.(md|ya?ml)$/ },
  { id: 'chat', dir: CHAT_DIR, match: /\.md$/, builtin: (n) => (n === CHAT_TURN_FILE ? CHAT_TURN : n === CHAT_PROTOCOL_FILE ? CHAT_PROTOCOL : undefined) },
  { id: 'agents', dir: AGENTS_DIR, match: /\.ya?ml$/, managedIn: 'providers' },
  { id: 'profiles', dir: `${RESEARCH_DIR}/profiles`, match: /\.ya?ml$/, managedIn: 'research' },
  { id: 'sources', dir: `${RESEARCH_DIR}/sources`, match: /\.ya?ml$/, managedIn: 'sources' },
];

const squash = (text: string) => text.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim();

/** A built-in's text, guarded against names an object literal answers for (`constructor.yaml`). */
function builtinText(spec: GroupSpec, name: string): string | undefined {
  const text = spec.builtin?.(name);
  return typeof text === 'string' ? text : undefined;
}


function describe(dataDir: string, spec: GroupSpec, name: string, text?: string): PlaybookFile {
  const rel = `${spec.dir}/${name}`;
  const abs = safePath(dataDir, rel);
  const st = fs.statSync(abs);
  const builtin = builtinText(spec, name);
  return {
    path: rel,
    name,
    bytes: st.size,
    mtime: st.mtime.toISOString(),
    builtin: builtin !== undefined,
    modified: builtin !== undefined && squash(builtin) !== squash(text ?? fs.readFileSync(abs, 'utf8')),
    readonly: spec.generated?.includes(name) ?? false,
    managedIn: spec.managedIn ?? null,
  };
}

export function listPlaybooks(dataDir: string): PlaybookGroup[] {
  return GROUPS.map((spec) => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(safePath(dataDir, spec.dir), { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith('.') && spec.match.test(e.name))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      /* a group nothing has seeded yet */
    }
    return { id: spec.id, dir: spec.dir, managedIn: spec.managedIn ?? null, files: names.map((name) => describe(dataDir, spec, name)) };
  });
}

/** The group a path is a playbook of, and its name there; throws for anything else. */
function locate(rel: string): { spec: GroupSpec; name: string } {
  const clean = cleanRelPath(rel);
  const dir = path.posix.dirname(clean);
  const name = path.posix.basename(clean);
  const spec = GROUPS.find((g) => g.dir === dir && g.match.test(name) && !name.startsWith('.'));
  if (!spec) throw new Error(`${rel} is not a playbook`);
  return { spec, name };
}

export function readPlaybook(dataDir: string, rel: string): PlaybookFile & { text: string } {
  const { spec, name } = locate(rel);
  const abs = safePath(dataDir, `${spec.dir}/${name}`);
  if (!fs.existsSync(abs)) throw new Error(`${rel} does not exist`);
  const text = fs.readFileSync(abs, 'utf8');
  return { ...describe(dataDir, spec, name, text), text };
}

/** Why `text` would break the playbook at `name`, or null when it reads. */
function problem(spec: GroupSpec, name: string, text: string): string | null {
  try {
    if (/\.ya?ml$/.test(name)) matter(`---\n${text.replace(/^﻿/, '').replace(/^---\s*\n/, '')}\n---\n`);
    else if (/^﻿?---\s*\n/.test(text)) matter(text);
  } catch (e) {
    // js-yaml's first line ends where its excerpt of the text begins
    return `${name} does not parse as YAML: ${e instanceof Error ? e.message.split('\n')[0].replace(/:\s*$/, '') : e}`;
  }
  if (spec.id === 'research' && name !== PROTOCOL_FILE && !parseResearchTemplate(text, name.replace(/\.md$/, ''), `${spec.dir}/${name}`)) {
    return `${name} needs frontmatter with type: research-template and the kind it writes (entity, concept, timeline, …)`;
  }
  return null;
}

function assertEditable(spec: GroupSpec, name: string): void {
  if (spec.managedIn) throw new Error(`${spec.dir}/${name} is edited on its own page (${spec.managedIn})`);
  if (spec.generated?.includes(name)) throw new Error(`${spec.dir}/${name} is regenerated by knode-os; edits would not last`);
}

export function savePlaybook(dataDir: string, rel: string, text: string): PlaybookFile & { text: string } {
  const { spec, name } = locate(rel);
  assertEditable(spec, name);
  const abs = safePath(dataDir, `${spec.dir}/${name}`);
  if (!fs.existsSync(abs)) throw new Error(`${rel} does not exist`);
  const body = text.endsWith('\n') ? text : `${text}\n`;
  const why = problem(spec, name, body);
  if (why) throw new Error(why);
  writeAtomic(abs, body);
  return readPlaybook(dataDir, rel);
}

/** Put the built-in version back. */
export function resetPlaybook(dataDir: string, rel: string): PlaybookFile & { text: string } {
  const { spec, name } = locate(rel);
  assertEditable(spec, name);
  const builtin = builtinText(spec, name);
  if (builtin === undefined) throw new Error(`${rel} has no built-in version to reset to`);
  writeAtomic(safePath(dataDir, `${spec.dir}/${name}`), builtin);
  return readPlaybook(dataDir, rel);
}
