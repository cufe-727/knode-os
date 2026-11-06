import fs from 'node:fs';
import path from 'node:path';
import { KnodeConfig } from '../../config.js';
import { titleOf } from './render.js';
import { ConversationAgent, fileLines, isTemporaryDir, projectOf, readConversationFile } from './transcript.js';

/**
 * This machine's agent conversations, for picking the ones a workspace
 * should keep (docs/design/24 D1, D2). Claude Code keeps one transcript per
 * session under `~/.claude/projects/<slug>/<id>.jsonl` (the slug is the
 * working directory with `/` and `.` as `-`); Codex under
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, and archived ones
 * under `~/.codex/archived_sessions/`.
 *
 * Reading a transcript for its prompts is cheap next to reading it whole —
 * the agent's records are skipped before they are parsed — and each one read
 * is remembered by its size and modification time, so a second listing reads
 * only what changed. One-shot runs are recognised without reading them where
 * the path says so (a temporary folder's slug) or from the first line
 * (`codex exec`).
 */

export interface ConversationSummary {
  agent: ConversationAgent;
  id: string;
  /** The agent app's name for it, else the first prompt's first line. */
  title: string;
  /** The agent's app named it (the title is not made up from the prompt). */
  named: boolean;
  project: string | null;
  cwd: string | null;
  branch: string | null;
  startedAt: string | null;
  /** The last activity: the transcript's last record, else its modification time. */
  updatedAt: string;
  exchanges: number;
  /** The first thing asked, shortened. */
  firstPrompt: string;
  /** The transcript on this machine. */
  path: string;
  bytes: number;
  automated: boolean;
}

export interface CatalogQuery {
  /** Words that must all appear in the title, project, working directory, branch or one of the prompts (any case). */
  q?: string;
  agent?: ConversationAgent;
  /** A project name, matched whole (case ignored). */
  project?: string;
  /** Include one-shot runs by programs. */
  automated?: boolean;
  /** Only sessions whose id starts with this (any case); files are passed over by name, unread. */
  id?: string;
  /** At most this many, newest first (default 200). */
  limit?: number;
}

export interface CatalogResult {
  conversations: ConversationSummary[];
  /** Matching conversations before the limit. */
  total: number;
  /** One-shot runs left out (counted without being read). */
  automatedHidden: number;
}

interface Cached {
  size: number;
  mtimeMs: number;
  summary: ConversationSummary | null;
  /** Lower-cased title, project, folder, branch and prompts, for matching. */
  haystack: string;
}

/** Transcript path → what was read of it. Per process: the server keeps it, a CLI run starts afresh. */
const cache = new Map<string, Cached>();
const SEARCH_CHARS = 40_000;
const FIRST_PROMPT_CHARS = 280;

/** Claude Code's folder for sessions run in a temporary folder: never a person's conversation. */
const TEMP_SLUG = /^-(?:private-)?(?:var-folders|tmp)-/;

export function claudeRoot(config: KnodeConfig): string {
  return config.trace.claudeProjectsDir;
}

export function codexRoots(config: KnodeConfig): string[] {
  const sessions = config.trace.codexSessionsDir;
  return [sessions, path.join(path.dirname(sessions), 'archived_sessions')];
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walkJsonl(dir: string, out: string[] = []): string[] {
  for (const e of listDir(dir)) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(abs, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(abs);
  }
  return out;
}

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Codex's own names for its threads: `session_index.jsonl`, the last entry for an id winning. */
function codexTitles(config: KnodeConfig): Map<string, string> {
  const titles = new Map<string, string>();
  const index = path.join(path.dirname(config.trace.codexSessionsDir), 'session_index.jsonl');
  if (!fs.existsSync(index)) return titles;
  try {
    for (const line of fileLines(index)) {
      try {
        const rec = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
        if (typeof rec.id === 'string' && typeof rec.thread_name === 'string' && rec.thread_name.trim()) titles.set(rec.id, rec.thread_name.trim());
      } catch {
        // a line being written
      }
    }
  } catch {
    // unreadable: titles come from the prompts
  }
  return titles;
}

/** Rollouts known to be a program's, by path, at the size they were seen at: hidden ones are never read whole. */
const programRuns = new Map<string, number>();

/** A Codex rollout's first line says whether a program ran it (`codex exec`). */
function codexAutomated(file: string): boolean {
  let size = -1;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false;
  }
  if (programRuns.get(file) === size) return true;
  const automated = firstLineAutomated(file);
  if (automated) programRuns.set(file, size);
  return automated;
}

function firstLineAutomated(file: string): boolean {
  for (const line of fileLines(file)) {
    try {
      const rec = JSON.parse(line) as { type?: string; payload?: { source?: unknown; originator?: unknown; cwd?: unknown } };
      if (rec.type !== 'session_meta') return false;
      const p = rec.payload ?? {};
      return p.source === 'exec' || p.originator === 'codex_exec' || isTemporaryDir(typeof p.cwd === 'string' ? p.cwd : null);
    } catch {
      return false;
    }
  }
  return false;
}

function summarize(file: string, agent: ConversationAgent, stat: fs.Stats, codexTitle: (id: string) => string | undefined): Cached {
  const base = { size: stat.size, mtimeMs: stat.mtimeMs };
  let conv;
  try {
    conv = readConversationFile(file, agent, { promptsOnly: true });
  } catch {
    return { ...base, summary: null, haystack: '' };
  }
  const id = conv.id ?? file.match(UUID)?.[1] ?? path.basename(file, '.jsonl');
  // nothing was ever asked: a session opened and left, or a run that only fed context
  if (conv.exchanges.length === 0) return { ...base, summary: null, haystack: '' };
  const agentTitle = agent === 'codex' ? codexTitle(id) ?? conv.title : conv.title;
  const first = conv.exchanges[0].prompt;
  // one line to recognise it by: pasted material is quoted in the copy, not here
  const firstLine = first.replace(/^>[ \t]?/gm, '').replace(/\s+/g, ' ').trim();
  const summary: ConversationSummary = {
    agent,
    id,
    title: titleOf({ ...conv, title: agentTitle ?? null }, first),
    named: Boolean(agentTitle),
    project: projectOf(conv.cwd),
    cwd: conv.cwd,
    branch: conv.branch,
    startedAt: conv.startedAt,
    updatedAt: conv.updatedAt ?? new Date(stat.mtimeMs).toISOString(),
    exchanges: conv.exchanges.length,
    firstPrompt: firstLine.length > FIRST_PROMPT_CHARS ? `${firstLine.slice(0, FIRST_PROMPT_CHARS - 1)}…` : firstLine,
    path: file,
    bytes: stat.size,
    automated: conv.automated,
  };
  const haystack = [summary.title, summary.project, conv.cwd, conv.branch, ...conv.exchanges.map((e) => e.prompt)]
    .filter(Boolean)
    .join('\n')
    .slice(0, SEARCH_CHARS)
    .toLowerCase();
  return { ...base, summary, haystack };
}

function cached(file: string, agent: ConversationAgent, codexTitle: (id: string) => string | undefined): Cached | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    cache.delete(file);
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
    // Codex names a thread in its index, not its rollout: a rename shows without reading the rollout again
    if (hit.summary && agent === 'codex') {
      const named = codexTitle(hit.summary.id);
      if (named && named !== hit.summary.title) hit.summary = { ...hit.summary, title: named, named: true };
    }
    return hit;
  }
  const fresh = summarize(file, agent, stat, codexTitle);
  cache.set(file, fresh);
  return fresh;
}

function matches(entry: Cached, query: CatalogQuery, terms: string[]): boolean {
  const s = entry.summary;
  if (!s) return false;
  if (query.agent && s.agent !== query.agent) return false;
  if (query.project && (s.project ?? '').toLowerCase() !== query.project.trim().toLowerCase()) return false;
  if (!query.automated && s.automated) return false;
  return terms.every((t) => entry.haystack.includes(t));
}

/** This machine's conversations matching `query`, newest first. */
export function listConversations(config: KnodeConfig, query: CatalogQuery = {}): CatalogResult {
  const terms = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const idStart = query.id?.trim().toLowerCase() ?? '';
  // a session's id is in its file name: Claude Code's `<id>.jsonl`, Codex's `rollout-<time>-<id>.jsonl`
  const named = (file: string) => !idStart || (file.match(UUID)?.[1] ?? path.basename(file, '.jsonl')).toLowerCase().startsWith(idStart);
  const titles = query.agent === 'claude' ? new Map<string, string>() : codexTitles(config);
  const codexTitle = (id: string) => titles.get(id);
  const found: ConversationSummary[] = [];
  let automatedHidden = 0;

  if (query.agent !== 'codex') {
    for (const slug of listDir(claudeRoot(config))) {
      if (!slug.isDirectory()) continue;
      const dir = path.join(claudeRoot(config), slug.name);
      // only the session files themselves: a session's folder holds its sub-agents and tool output
      const files = listDir(dir).filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => path.join(dir, e.name)).filter(named);
      if (!query.automated && TEMP_SLUG.test(slug.name)) {
        automatedHidden += files.length;
        continue;
      }
      for (const file of files) {
        const entry = cached(file, 'claude', codexTitle);
        if (entry?.summary?.automated && !query.automated) automatedHidden++;
        if (entry && matches(entry, query, terms)) found.push(entry.summary!);
      }
    }
  }

  if (query.agent !== 'claude') {
    for (const root of codexRoots(config)) {
      for (const file of walkJsonl(root).filter(named)) {
        if (!query.automated && !cache.has(file) && codexAutomated(file)) {
          automatedHidden++;
          continue;
        }
        const entry = cached(file, 'codex', codexTitle);
        if (entry?.summary?.automated && !query.automated) automatedHidden++;
        if (entry && matches(entry, query, terms)) found.push(entry.summary!);
      }
    }
  }

  found.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const limit = query.limit && query.limit > 0 ? query.limit : 200;
  return { conversations: found.slice(0, limit), total: found.length, automatedHidden };
}

/** Where a session's transcript is now, by agent and id: it moves when Codex archives it. Null when it is gone. */
export function findTranscript(config: KnodeConfig, agent: ConversationAgent, id: string): string | null {
  if (!/^[0-9A-Za-z_-]{6,80}$/.test(id)) return null;
  if (agent === 'claude') {
    for (const slug of listDir(claudeRoot(config))) {
      if (!slug.isDirectory()) continue;
      const file = path.join(claudeRoot(config), slug.name, `${id}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
    return null;
  }
  for (const root of codexRoots(config)) {
    const file = walkJsonl(root).find((f) => f.endsWith(`-${id}.jsonl`) || path.basename(f) === `${id}.jsonl`);
    if (file) return file;
  }
  return null;
}

/** One conversation's summary, read fresh. */
export function describeTranscript(config: KnodeConfig, agent: ConversationAgent, file: string): ConversationSummary | null {
  const titles = agent === 'codex' ? codexTitles(config) : new Map<string, string>();
  return cached(file, agent, (id) => titles.get(id))?.summary ?? null;
}

/** Forget what was read (tests). */
export function clearCatalogCache(): void {
  cache.clear();
  programRuns.clear();
}
