import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolatedCopy, runAgent } from '../agent.js';
import { listFiles } from '../pack.js';
import { citationsIn } from '../prompts.js';
import type { KnowledgeUnit } from '../types.js';
import { AGENT_BRIEF } from './agents.js';
import type { MeterEvent } from '../meter.js';
import { recordAgent, SystemEnv, SystemUnderTest } from './types.js';
import { evalTempDir } from '../tmp.js';

/**
 * The LLM Wiki pattern (Karpathy, April 2026) built faithfully and plainly
 * (docs/design/23 §3): the sources sit in `raw/`, an agent maintains a wiki
 * of Markdown pages beside them — one page per source, pages for the
 * entities and concepts they mention, an `index.md` that lists every page
 * and a `log.md` of what each ingest changed — following a schema file, and
 * ingests a few sources per session in date order, so later sources update
 * pages earlier ones wrote. Answers come from the same Codex agent as the
 * grep baseline, reading the wiki alone (`agent-wiki`).
 */

export const WIKI_SCHEMA = `# Wiki maintenance rules

You maintain a wiki in \`wiki/\` that compiles the knowledge in the source documents under \`raw/\` (read-only; never edit them).

Pages (Markdown, one topic per page):
- \`wiki/sources/<name>.md\` — one per source: what it says, its date and author when known, the key facts with numbers and dates kept exact.
- \`wiki/entities/<name>.md\` — a person, organization, product, place, law or other named thing: what the sources say about it, across sources.
- \`wiki/concepts/<name>.md\` — a theme, method, problem or recurring idea: a synthesis across sources, including disagreements and open questions.
- \`wiki/index.md\` — every page with a one-line description, grouped by kind. Keep it complete.
- \`wiki/log.md\` — append one line per ingest: date, sources ingested, pages created or updated.

Conventions:
- Link pages with [[wikilinks]] (the page name without .md).
- Cite every statement's source as (raw/<path>), the source file's path.
- When a new source updates or contradicts a page, revise the page and say what changed and according to which source.
- Write in the language of the sources (keep names and terms as the sources write them).`;

const INGEST_PROMPT = (files: string[]) => `${WIKI_SCHEMA}

Ingest these new sources into the wiki now: ${files.map((f) => `raw/${f}`).join(', ')}.
Read each one, write its source page, create or update the entity and concept pages it bears on, update wiki/index.md and append to wiki/log.md. Edit files with shell commands (e.g. cat > file <<'EOF', or apply a patch). Do not touch raw/. When done, reply with one line listing the pages you changed.`;

const wikiDirs = new Map<string, string>();

function wikiDir(env: SystemEnv): string {
  return wikiDirs.get(env.workDir) ?? path.join(env.workDir, 'wiki');
}

/** Sources in the order they were written (date, then path), so the wiki grows the way a person's would. */
function ingestOrder(env: SystemEnv): string[] {
  return [...env.staged.docs].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.path.localeCompare(b.path)).map((d) => d.path);
}

export function llmWikiBuild(env: SystemEnv, perSession = 3): Promise<{ notes: Record<string, unknown>; kbDir: string }> {
  return buildWiki(env, perSession);
}

/** How far a build got: the sources ingested from the front of the order, and what each finished session used. */
interface WikiProgress {
  order: string;
  done: number;
  failed: number;
  capped: number;
  sessions: Omit<MeterEvent, 'at'>[];
}

/**
 * Each build works in a fixed directory beside a progress file, so a run that
 * stops mid-build goes on from the last finished session instead of starting
 * over; the sessions it skips are metered again as replays at their original
 * cost, as the shim does for cached replies, so the build reports its full cost.
 */
async function buildWiki(env: SystemEnv, perSession: number): Promise<{ notes: Record<string, unknown>; kbDir: string }> {
  const root = path.join(os.tmpdir(), `knode-eval-wiki-${crypto.createHash('sha256').update(env.workDir).digest('hex').slice(0, 16)}`);
  const progressFile = `${root}.progress.json`;
  const order = ingestOrder(env);
  const fingerprint = crypto.createHash('sha256').update(order.join('\n')).digest('hex');
  let progress = readProgress(progressFile);
  if (!progress || progress.order !== fingerprint || !fs.existsSync(path.join(root, 'wiki', 'index.md'))) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(env.staged.dir, path.join(root, 'raw'), { recursive: true });
    fs.mkdirSync(path.join(root, 'wiki', 'sources'), { recursive: true });
    fs.writeFileSync(path.join(root, 'AGENTS.md'), WIKI_SCHEMA + '\n');
    fs.writeFileSync(path.join(root, 'wiki', 'index.md'), '# Index\n');
    fs.writeFileSync(path.join(root, 'wiki', 'log.md'), '# Log\n');
    progress = { order: fingerprint, done: 0, failed: 0, capped: 0, sessions: [] };
  } else {
    env.log(`llm-wiki: resuming at ${progress.done}/${order.length} sources`);
    for (const ev of progress.sessions) env.meter.record({ ...ev, replayed: true });
  }
  for (let i = progress.done; i < order.length; i += perSession) {
    const files = order.slice(i, i + perSession);
    await env.quota.wait();
    const r = await runAgent({
      cwd: root,
      sandbox: 'workspace-write',
      model: env.models.model,
      effort: env.models.buildEffort,
      maxSteps: 80,
      timeoutMs: 30 * 60_000,
      prompt: INGEST_PROMPT(files),
    });
    recordAgent(env.meter, { system: 'llm-wiki', stage: 'build' }, env.models.model, r);
    progress.done = i + files.length;
    if (r.error) progress.failed++;
    if (r.capped) progress.capped++;
    progress.sessions.push({ system: 'llm-wiki', stage: 'build', model: env.models.model || 'codex', ms: r.ms, ok: !r.error, replayed: false, usage: r.usage });
    fs.writeFileSync(progressFile, JSON.stringify(progress));
    if (progress.sessions.length % 5 === 0) env.log(`llm-wiki: ${progress.done}/${order.length} sources ingested`);
  }
  const out = path.join(env.workDir, 'wiki');
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(root, 'wiki'), out, { recursive: true });
  wikiDirs.set(env.workDir, out);
  const pages = listFiles(out).filter((f) => f.endsWith('.md'));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(progressFile, { force: true });
  return { kbDir: out, notes: { sessions: progress.sessions.length, failedSessions: progress.failed, cappedSessions: progress.capped, pages: pages.length } };
}

function readProgress(file: string): WikiProgress | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as WikiProgress;
  } catch {
    return null;
  }
}

export function llmWiki(): SystemUnderTest {
  return {
    id: 'agent-wiki',
    label: 'LLM Wiki (Karpathy pattern), Codex agent reading it',
    group: 'llm-wiki',
    kind: 'kb',
    answers: true,
    // five sources a session: the pattern's ingest, at a cost a pilot can carry (each session is a long agent run)
    build: (env) => buildWiki(env, Number(process.env.KNODE_EVAL_WIKI_PER_SESSION ?? 5)),
    async reopen(env) {
      const dir = path.join(env.workDir, 'wiki');
      if (!fs.existsSync(dir)) throw new Error(`no llm-wiki build to reopen at ${dir}`);
      wikiDirs.set(env.workDir, dir);
    },
    async answer(task, prompt, env) {
      await env.quota.wait();
      const copy = isolatedCopy(wikiDir(env), 'wiki');
      try {
        const r = await runAgent({
          cwd: copy.dir,
          sandbox: 'read-only',
          model: env.models.model,
          effort: env.models.answerEffort,
          prompt: `${AGENT_BRIEF('The current directory is a wiki compiled from the documents: start from index.md. The source documents themselves are not here; pages cite them as raw/<path> — cite those paths.')}\n\n${prompt}`,
        });
        recordAgent(env.meter, { system: 'agent-wiki', stage: 'agent', task: task.id }, env.models.model, r);
        return { text: r.text, citations: citationsIn(r.text, new Set(env.staged.docs.map((d) => d.path))), toolCalls: r.toolCalls, capped: r.capped, leaked: r.leaked, error: r.error };
      } finally {
        copy.cleanup();
      }
    },
    async exportKnowledge(env) {
      const dir = wikiDir(env);
      const docs = new Set(env.staged.docs.map((d) => d.path));
      const units: KnowledgeUnit[] = [];
      for (const rel of listFiles(dir).filter((f) => f.endsWith('.md') && f !== 'index.md' && f !== 'log.md')) {
        const text = fs.readFileSync(path.join(dir, rel), 'utf8').trim();
        if (!text) continue;
        const kind: KnowledgeUnit['kind'] = rel.startsWith('sources/') ? 'summary' : rel.startsWith('concepts/') ? 'community' : 'page';
        units.push({
          id: `page:${rel}`,
          kind,
          title: rel,
          text,
          sources: citationsIn(text, docs).map((c) => c.doc),
          links: [...text.matchAll(/\[\[([^\]|#]+)/g)].map((m) => `page:${m[1].trim()}`),
        });
      }
      return units;
    },
    async update(files, env) {
      // ingest the new or changed sources into the existing wiki, as the pattern does
      const tmp = evalTempDir('wiki');
      const root = tmp.root;
      try {
        fs.cpSync(env.staged.dir, path.join(root, 'raw'), { recursive: true });
        fs.cpSync(wikiDir(env), path.join(root, 'wiki'), { recursive: true });
        fs.writeFileSync(path.join(root, 'AGENTS.md'), WIKI_SCHEMA + '\n');
        await env.quota.wait();
        const r = await runAgent({ cwd: root, sandbox: 'workspace-write', model: env.models.model, effort: env.models.buildEffort, maxSteps: 80, timeoutMs: 30 * 60_000, prompt: INGEST_PROMPT(files) });
        recordAgent(env.meter, { system: 'llm-wiki', stage: 'update' }, env.models.model, r);
        fs.rmSync(wikiDir(env), { recursive: true, force: true });
        fs.cpSync(path.join(root, 'wiki'), wikiDir(env), { recursive: true });
      } finally {
        tmp.cleanup();
      }
    },
  };
}
