import fs from 'node:fs';
import path from 'node:path';

/**
 * Agent transcripts as episodes (L0 → L1 for `raw/traces`).
 *
 * A session JSONL is a stream of provider-shaped records; what is worth
 * remembering is the *turn*: what was asked, which tools ran, what came back,
 * and how it ended. Cooking one into markdown turns a transcript nothing can
 * search into an ordinary source — chunked, embedded, entity-linked, and
 * revertible with the file it came from.
 *
 * The two supported shapes (Claude Code and Codex CLI) are read leniently: a
 * record whose structure is not recognized contributes nothing rather than
 * failing the file, because transcript formats change without warning and a
 * broken episode must not break a sync.
 */

export interface EpisodeTurn {
  index: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  toolCalls: { name: string; input: string }[];
  observations: string[];
}

export interface Episode {
  sessionId: string | null;
  source: 'claude' | 'codex' | 'unknown';
  startedAt: string | null;
  project: string | null;
  turns: EpisodeTurn[];
}

const MAX_TEXT = 4000;
const MAX_OBSERVATION = 800;

function clip(s: string, max: number): string {
  const trimmed = s.replace(/\r/g, '').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Pull readable text out of a string, an array of content blocks, or an object. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (!block || typeof block !== 'object') return '';
        const b = block as Record<string, unknown>;
        if (typeof b.text === 'string') return b.text;
        if (typeof b.content === 'string') return b.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c.text === 'string') return c.text;
  }
  return '';
}

function toolCallsOf(content: unknown): { name: string; input: string }[] {
  if (!Array.isArray(content)) return [];
  const out: { name: string; input: string }[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const type = String(b.type ?? '');
    if (type !== 'tool_use' && type !== 'function_call') continue;
    const name = String(b.name ?? b.tool_name ?? 'tool');
    const input = b.input ?? b.arguments ?? {};
    out.push({ name, input: clip(typeof input === 'string' ? input : JSON.stringify(input), 600) });
  }
  return out;
}

function observationsOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const type = String(b.type ?? '');
    if (type !== 'tool_result' && type !== 'function_call_output') continue;
    const body = b.content ?? b.output ?? '';
    const text = typeof body === 'string' ? body : textOf(body) || JSON.stringify(body);
    if (text.trim()) out.push(clip(text, MAX_OBSERVATION));
  }
  return out;
}

function normalizeRole(raw: unknown): EpisodeTurn['role'] | null {
  const r = String(raw ?? '').toLowerCase();
  if (r === 'user' || r === 'human') return 'user';
  if (r === 'assistant' || r === 'model') return 'assistant';
  if (r === 'tool' || r === 'function') return 'tool';
  if (r === 'system' || r === 'developer') return 'system';
  return null;
}

export function parseEpisode(raw: string, hint: { source?: Episode['source']; project?: string | null } = {}): Episode {
  const episode: Episode = {
    sessionId: null,
    source: hint.source ?? 'unknown',
    startedAt: null,
    project: hint.project ?? null,
    turns: [],
  };

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // a partially written last line is normal for a live session
    }

    const ts = record.timestamp ?? record.ts ?? record.created_at;
    if (!episode.startedAt && typeof ts === 'string') episode.startedAt = ts;
    const sid = record.sessionId ?? record.session_id ?? record.id;
    if (!episode.sessionId && typeof sid === 'string') episode.sessionId = sid;
    if (!episode.project) {
      const cwd = record.cwd ?? record.project;
      if (typeof cwd === 'string') episode.project = cwd;
    }

    // Claude Code nests the turn under `message`; Codex under `payload`.
    const inner = (record.message ?? record.payload ?? record) as Record<string, unknown>;
    const role = normalizeRole(inner.role ?? record.role ?? record.type);
    if (!role) continue;
    const content = inner.content ?? inner.text ?? record.content;
    const text = clip(textOf(content), MAX_TEXT);
    const toolCalls = toolCallsOf(content);
    const observations = observationsOf(content);
    if (!text && toolCalls.length === 0 && observations.length === 0) continue;

    episode.turns.push({ index: episode.turns.length, role, text, toolCalls, observations });
  }
  return episode;
}

/**
 * Render an episode as markdown, one section per turn. Tool calls and their
 * observations stay attached to the turn that made them, so a chunk retrieved
 * later carries the whole "asked → ran → saw" unit rather than a fragment.
 */
export function renderEpisode(episode: Episode, rel: string): string {
  const title = episode.sessionId ? `Session ${episode.sessionId}` : path.basename(rel);
  const front = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `source: ${episode.source}`,
    episode.sessionId ? `sessionId: ${JSON.stringify(episode.sessionId)}` : null,
    episode.startedAt ? `startedAt: ${JSON.stringify(episode.startedAt)}` : null,
    episode.project ? `project: ${JSON.stringify(episode.project)}` : null,
    `turns: ${episode.turns.length}`,
    '---',
    '',
  ].filter((l) => l !== null).join('\n');

  const body = episode.turns.map((t) => {
    const parts = [`## Turn ${t.index + 1} — ${t.role}`];
    if (t.text) parts.push(t.text);
    for (const call of t.toolCalls) parts.push(`**tool call** \`${call.name}\`\n\n\`\`\`json\n${call.input}\n\`\`\``);
    for (const obs of t.observations) parts.push(`**observation**\n\n\`\`\`\n${obs}\n\`\`\``);
    return parts.join('\n\n');
  }).join('\n\n');

  return `${front}# ${title}\n\n${body}\n`;
}

export const RAW_TRACES = 'raw/traces';
export const COOKED_TRACES = 'cooked/traces';

export function tracesCookedPath(rawRel: string): string {
  return `${COOKED_TRACES}${rawRel.slice(RAW_TRACES.length)}.md`;
}

export interface EpisodeCookStats {
  cooked: number;
  unchanged: number;
  skipped: number;
  /** Cooked paths whose raw transcript still exists — the declared episode set. */
  wanted: string[];
}

/**
 * Cook every synced transcript into `cooked/traces/**.md`.
 *
 * Off by default: a machine with months of agent history would otherwise turn
 * one `sync` into thousands of embedding calls. `trace.episodes: true` in the
 * config opts in.
 */
export function cookEpisodes(dataDir: string, opts: { maxBytes?: number; onProgress?: (m: string) => void } = {}): EpisodeCookStats {
  const stats: EpisodeCookStats = { cooked: 0, unchanged: 0, skipped: 0, wanted: [] };
  const root = path.join(dataDir, RAW_TRACES);
  if (!fs.existsSync(root)) return stats;
  const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
  const progress = opts.onProgress ?? (() => {});

  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(dataDir, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!entry.name.endsWith('.jsonl')) continue;
      const abs = path.join(dataDir, child);
      if (fs.statSync(abs).size > maxBytes) {
        stats.skipped++;
        continue;
      }
      const cookedRel = tracesCookedPath(child);
      const source: Episode['source'] = child.includes('/claude/') ? 'claude' : child.includes('/codex/') ? 'codex' : 'unknown';
      const episode = parseEpisode(fs.readFileSync(abs, 'utf8'), { source });
      if (episode.turns.length === 0) {
        stats.skipped++;
        continue;
      }
      stats.wanted.push(cookedRel);
      const markdown = renderEpisode(episode, child);
      const cookedAbs = path.join(dataDir, cookedRel);
      if (fs.existsSync(cookedAbs) && fs.readFileSync(cookedAbs, 'utf8') === markdown) {
        stats.unchanged++;
        continue;
      }
      fs.mkdirSync(path.dirname(cookedAbs), { recursive: true });
      fs.writeFileSync(cookedAbs, markdown);
      stats.cooked++;
      progress(`episode ${cookedRel}`);
    }
  };
  walk(RAW_TRACES);
  return stats;
}
