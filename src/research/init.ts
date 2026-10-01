import fs from 'node:fs';
import path from 'node:path';
import { resolveRoutedLlmConfig, routeTargets } from '../config.js';
import { AppContext } from '../context.js';
import { GUIDE_COPY, GUIDE_FILE } from '../fs/datadir.js';
import { runDocumentPass } from '../ingest/background.js';
import { sync } from '../ingest/sync.js';
import { LlmClient } from '../llm/client.js';
import { ensureEntityStubs, ensureHotTopics, ensureSourcesIndex, reconcileViews } from '../wiki/pages.js';
import { queueJob, ResearchJob, updateJob } from './jobs.js';
import { extractJson } from './pipeline.js';
import { GuideStamp, KbSurvey, surveyKnowledgeBase } from './survey.js';
import { HUMAN_NOTES_HEADING, RunWorkspace } from './workspace.js';

/**
 * Knowledge-base initialization (research kind `init`) — the parts around the
 * agent run:
 *
 *   prepareInit    before the agent: reconcile sources, drain tier-1 extraction
 *                  (within a time cap), regenerate the deterministic
 *                  views, survey the base. Each step lands on the job's payload
 *                  so the UI can show where a run is.
 *   topicsFrom     the planner's `topics` → follow-up pages worth their own job
 *   finalizeInit   after validation: carry a person's `## 人工备注` over from the
 *                  previous guide, stamp the guide, copy it to CLAUDE.md, queue
 *                  the follow-up topic pages as ordinary research jobs.
 */

export type InitStepName = 'sync' | 'extract' | 'views' | 'survey';

export interface InitStep {
  name: InitStepName;
  status: 'running' | 'done' | 'skipped' | 'failed';
  startedAt: string;
  finishedAt?: string;
  detail?: string;
}

export const INIT_TOPIC_KINDS = ['concept', 'entity', 'timeline', 'comparison'] as const;
export type InitTopicKind = (typeof INIT_TOPIC_KINDS)[number];

export interface InitTopic {
  kind: InitTopicKind;
  target: string;
  why: string;
  /** Id of the follow-up job once queued. */
  queued?: string;
}

interface StepOutcome<T> {
  detail: string;
  skipped?: boolean;
  value?: T;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run tier-1 extraction until the queue is empty, nothing moves, or the time cap hits. */
export async function drainTier1(ctx: AppContext, opts: { maxMs: number; log: (m: string) => void }): Promise<StepOutcome<void>> {
  const { config, store } = ctx;
  const entityLlm = config.extraction.entityLlm
    ? new LlmClient(resolveRoutedLlmConfig(config.llm, config.extraction.entityLlm, routeTargets(config), config.extraction.tier1Model))
    : ctx.llm;
  const count = async () => (await store.query<{ n: number }>(`SELECT count(*)::int AS n FROM extraction_queue`))[0]?.n ?? 0;
  if (!entityLlm.enabled) {
    const n = await count();
    return { detail: n ? `${n} document(s) await LLM extraction, but no extraction LLM is configured (Settings → Ingest)` : 'no extraction LLM configured; nothing queued', skipped: true };
  }
  const t0 = Date.now();
  let processed = 0;
  let failed = 0;
  let passes = 0;
  let reason = 'queue drained';
  for (;;) {
    // the whole background pass: what it extracts is also audited for duplicates and summarized
    const st = await runDocumentPass(ctx, { onProgress: opts.log });
    passes++;
    processed += st.processed;
    failed += st.failed;
    if (st.queued === 0) break;
    if (st.processed === 0 && st.failed === 0) {
      reason = 'no progress';
      break;
    }
    if (Date.now() - t0 > opts.maxMs) {
      reason = `time cap of ${Math.round(opts.maxMs / 60_000)} min reached`;
      break;
    }
  }
  const remaining = await count();
  return { detail: `${processed} extracted, ${failed} failed in ${passes} pass(es); ${remaining} remaining (${reason})`, skipped: passes === 1 && processed === 0 && failed === 0 && remaining === 0 };
}

export async function prepareInit(ctx: AppContext, jobIn: ResearchJob, opts: { log: (m: string) => void }): Promise<{ job: ResearchJob; survey: KbSurvey }> {
  const { log } = opts;
  const init = ctx.config.research.init ?? { followUps: 6, extractionMaxMs: 900_000 };
  const steps: InitStep[] = [];
  let job = jobIn;
  const record = async () => {
    job = (await updateJob(ctx.store, job.id, { payload: { ...job.payload, steps: steps.map((s) => ({ ...s })) } })) ?? job;
  };
  const step = async <T>(name: InitStepName, fn: () => Promise<StepOutcome<T>>): Promise<T | undefined> => {
    const s: InitStep = { name, status: 'running', startedAt: new Date().toISOString() };
    steps.push(s);
    await record();
    try {
      const r = await fn();
      s.status = r.skipped ? 'skipped' : 'done';
      s.detail = r.detail;
      s.finishedAt = new Date().toISOString();
      await record();
      log(`init ${job.id}: ${name} ${s.status} — ${r.detail}`);
      return r.value;
    } catch (err) {
      s.status = 'failed';
      s.detail = message(err);
      s.finishedAt = new Date().toISOString();
      await record();
      throw err;
    }
  };

  await step('sync', async () => {
    const st = await sync(ctx, { actor: 'init', onProgress: log });
    return { detail: `${st.indexed} applied, ${st.unchanged} unchanged, ${st.disposed} disposed, ${st.chunks} chunks` };
  });
  // whatever the sync left unextracted is caught up here; an empty queue
  // makes this a no-op, so there is nothing to switch off
  await step('extract', async () => {
    const r = await drainTier1(ctx, { maxMs: init.extractionMaxMs, log });
    if (!r.skipped) {
      const views = await reconcileViews(ctx, { actor: 'init', llm: false, onProgress: log });
      return { detail: `${r.detail}; ${views.regenerated} views regenerated` };
    }
    return r;
  });
  await step('views', async () => {
    const stubs = await ensureEntityStubs(ctx, { actor: 'init' });
    await ensureHotTopics(ctx, { actor: 'init', force: true });
    await ensureSourcesIndex(ctx, { actor: 'init' });
    return { detail: `${stubs.length} entity stub(s) created; hot topics and sources index refreshed` };
  });
  const survey = await step('survey', async () => {
    const s = await surveyKnowledgeBase(ctx);
    if (s.stats.documents === 0) throw new Error('the knowledge base is empty — add documents under raw/docs (or wiki/) before initializing');
    return { detail: `${s.documents.total} docs, ${s.entities.total} entities, ${s.relations.total} relations, ${s.claims.total} claims`, value: s };
  });
  return { job, survey: survey! };
}

/** The planner's `topics` (kind whitelisted, deduplicated by target), at most `max`. */
export function topicsFrom(text: string, max = 12): InitTopic[] {
  const parsed = text ? extractJson<{ topics?: unknown }>(text) : null;
  const out: InitTopic[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(parsed?.topics) ? parsed!.topics : []) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const kind = typeof o.kind === 'string' ? o.kind.trim().toLowerCase() : '';
    const target = typeof o.target === 'string' ? o.target.trim().slice(0, 120) : '';
    if (!(INIT_TOPIC_KINDS as readonly string[]).includes(kind) || !target) continue;
    const key = `${kind}:${target.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: kind as InitTopicKind, target, why: typeof o.why === 'string' ? o.why.trim().slice(0, 300) : '' });
    if (out.length >= max) break;
  }
  return out;
}

function sectionRange(lines: string[], heading: string): { start: number; end: number } | null {
  const want = heading.trim().toLowerCase();
  const start = lines.findIndex((l) => l.trim().toLowerCase() === want);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Replace the new guide's `## 人工备注` body with the previous guide's, verbatim (a person's notes survive a re-init). */
export function carryOverHumanNotes(next: string, previous: string | null): string {
  if (!previous) return next;
  const prevLines = previous.split('\n');
  const prev = sectionRange(prevLines, HUMAN_NOTES_HEADING);
  if (!prev) return next;
  const notes = prevLines.slice(prev.start + 1, prev.end).join('\n').trim();
  if (!notes) return next;
  const block = [HUMAN_NOTES_HEADING, '', notes, ''];
  const lines = next.split('\n');
  const cur = sectionRange(lines, HUMAN_NOTES_HEADING);
  // spliced verbatim: a person's notes (and any fenced block around them) are not reformatted
  const merged = cur
    ? [...lines.slice(0, cur.start), ...block, ...lines.slice(cur.end)]
    : [...lines.join('\n').replace(/\s+$/, '').split('\n'), '', ...block];
  return merged.join('\n');
}

/** First line of the guide: who wrote it and when (read back by the survey). */
export function stampGuide(text: string, stamp: GuideStamp): string {
  const body = text.replace(/^\s*<!--\s*knode-init:[^\n]*-->\n?/, '').replace(/^\n+/, '');
  return `<!-- knode-init: ${JSON.stringify(stamp)} -->\n${body}`;
}

export async function finalizeInit(ctx: AppContext, job: ResearchJob, ws: RunWorkspace, opts: { agent: string; log: (m: string) => void }): Promise<{ topics: InitTopic[]; queued: string[] }> {
  const guideAbs = path.join(ctx.dataDir, GUIDE_FILE);
  const companion = (ws.companions ?? []).find((c) => c.path === GUIDE_FILE);
  if (fs.existsSync(guideAbs)) {
    const previous = companion?.backupPath && fs.existsSync(companion.backupPath) ? fs.readFileSync(companion.backupPath, 'utf8') : null;
    let text = carryOverHumanNotes(fs.readFileSync(guideAbs, 'utf8'), previous);
    text = stampGuide(text, { job: job.id, at: new Date().toISOString(), agent: opts.agent });
    if (!text.endsWith('\n')) text += '\n';
    fs.writeFileSync(guideAbs, text);
    fs.writeFileSync(path.join(ctx.dataDir, GUIDE_COPY), text);
  }
  const topics: InitTopic[] = Array.isArray(job.payload.topics) ? (job.payload.topics as InitTopic[]).map((t) => ({ ...t })) : [];
  const cap = Math.max(0, ctx.config.research.init?.followUps ?? 6);
  const queued: string[] = [];
  for (const t of topics.slice(0, cap)) {
    try {
      const res = await queueJob(ctx.store, { kind: t.kind, target: t.target, requestedBy: 'init', payload: { from: job.id, why: t.why } });
      t.queued = res.job.id;
      if (res.created) queued.push(res.job.id);
    } catch (err) {
      opts.log(`init ${job.id}: could not queue ${t.kind} ${t.target}: ${message(err)}`);
    }
  }
  return { topics, queued };
}
