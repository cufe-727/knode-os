import fs from 'node:fs';
import path from 'node:path';
import { AppContext } from '../context.js';
import { checkout } from '../compiler/workset.js';
import { llmTargets } from '../config.js';
import { safePath, writeFileBytes } from '../fs/files.js';
import { recordOrigin } from '../fs/sidecar.js';
import { sync } from '../ingest/sync.js';
import { setScopeTrust, TrustTier } from '../lineage/trust.js';
import { pool } from '../pool.js';
import { Params } from '../store/temporal.js';
import { agentForSpec, ResearchAgent, resolveResearchAgent } from './agent.js';
import { captureUrl, registerPath, studyCaptures, studyFolder, waitForCaptureIndexing } from './capture.js';
import { runDeepResearch } from './deep-research.js';
import { createJobRow, getJob, listJobs, ResearchJob, TERMINAL_STATUSES, updateJob } from './jobs.js';
import { isCancelled, JobCancelledError, killAgentsFor, launchSession } from './launch.js';
import { PhaseRecord } from './pipeline.js';
import { activeProfile, effectiveEffort, effectiveSpeed, loadProfile, ResearchProfile, webAllowed } from './profile.js';
import { detectLanguage, localizeNoteHeadings, normalizeBrief, noteHeadings, refineBrief, sourceMarker, sourcesHeading, StudyBrief, StudyPage, templateBrief } from './refine.js';
import { loadResearchSources, mcpServersFor, ExtraMcpServer, ResearchSource, sourcesBrief } from './sources.js';
import { loadPhasePrompt, loadResearchProtocol, researchSlug } from './templates.js';
import { knowledgeNotes, McpEndpoint, runsRoot, writeAgentFiles } from './workspace.js';
import { webSearchEnabled } from './web.js';

/**
 * Studies (docs/design/15): a topic researched into several wiki pages.
 *
 * A study is one row of `research_jobs` (kind = study) whose payload carries
 * the brief, the runner and the sources; the pages it plans are jobs of their
 * own (kind = section) that run through the ordinary runner — templates,
 * pipelines, validation, quarantine and all — and point back at it.
 *
 *   draft      the topic, refined into a brief the person edits (refine → edit → refine …)
 *   queued     started; the loop claims it like any job
 *   running    collect: seed URLs are captured, then collector sessions (or a
 *              deep-research model) gather material into raw/docs/research/<study>/
 *              and write notes; the material is indexed
 *   waiting    one section job per planned page is queued; the study waits for them
 *   queued     every page is done (or failed): the report stage is queued
 *   running    the report — the study's own page, wiki/research/<study>.md — is written
 *   done
 *
 * Everything a study fetched or wrote is on record as its agent's, so it lands
 * quarantined; promoting the pages (and the captured sources) is a person's
 * review, as everywhere else.
 */

export type StudyMode = 'agent' | 'deep-research';

export interface StudyRunner {
  /** 'agent': collector sessions on `agent`; 'deep-research': a deep-research model collects, `agent` writes the pages. */
  mode: StudyMode;
  /** Agent name, connection id or CLI ('' = research.agent). */
  agent: string;
  model: string;
  /** Research profile for the pages ('' = research.profile). */
  profile: string;
  /** deep-research mode: the OpenAI-compatible connection and the model on it. */
  deepResearch: { connection: string; model: string } | null;
}

export interface StudySources {
  /** The open web, within review.external. */
  web: boolean;
  /** Research sources (playbooks/research/sources/<id>.yaml). */
  ids: string[];
}

export type StudyStage = 'draft' | 'collect' | 'pages' | 'report' | 'done';
export type StudyStepName = 'seed' | 'collect' | 'index' | 'pages' | 'report';

export interface StudyStep {
  name: StudyStepName;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  detail?: string;
}

export interface StudyRefinement {
  at: string;
  refiner: string;
  feedback?: string;
  error?: string | null;
  ms: number;
}

export interface StudyPayload {
  topic: string;
  brief: StudyBrief;
  runner: StudyRunner;
  sources: StudySources;
  stage: StudyStage;
  steps: StudyStep[];
  refinements: StudyRefinement[];
  children: string[];
  notes: string[];
  collect: PhaseRecord[];
}

export const STUDY_STEPS: StudyStepName[] = ['seed', 'collect', 'index', 'pages', 'report'];
export const STUDY_WIKI_DIR = 'wiki/research';

const DEFAULT_RUNNER: StudyRunner = { mode: 'agent', agent: '', model: '', profile: '', deepResearch: null };

/* ------------------------------------------------------------- payload */

export function studyPayload(job: ResearchJob): StudyPayload {
  const p = job.payload as Partial<StudyPayload>;
  const runner = { ...DEFAULT_RUNNER, ...(p.runner ?? {}) };
  return {
    topic: typeof p.topic === 'string' ? p.topic : job.query ?? '',
    brief: p.brief ?? templateBrief(job.query ?? job.target ?? '', 6),
    runner,
    sources: { web: p.sources?.web !== false, ids: Array.isArray(p.sources?.ids) ? p.sources!.ids.map(String) : [] },
    stage: p.stage ?? (job.status === 'draft' ? 'draft' : 'collect'),
    steps: Array.isArray(p.steps) && p.steps.length ? p.steps : STUDY_STEPS.map((name) => ({ name, status: 'pending' as const })),
    refinements: Array.isArray(p.refinements) ? p.refinements : [],
    children: Array.isArray(p.children) ? p.children.map(String) : [],
    notes: Array.isArray(p.notes) ? p.notes.map(String) : [],
    collect: Array.isArray(p.collect) ? p.collect : [],
  };
}

function cleanRunner(input: Partial<StudyRunner> | undefined, prev: StudyRunner = DEFAULT_RUNNER): StudyRunner {
  const r = { ...prev, ...(input ?? {}) };
  const mode: StudyMode = r.mode === 'deep-research' ? 'deep-research' : 'agent';
  const dr = r.deepResearch && typeof r.deepResearch === 'object'
    ? { connection: String(r.deepResearch.connection ?? '').trim(), model: String(r.deepResearch.model ?? '').trim() }
    : null;
  return { mode, agent: String(r.agent ?? '').trim(), model: String(r.model ?? '').trim(), profile: String(r.profile ?? '').trim(), deepResearch: mode === 'deep-research' ? dr : null };
}

function cleanSources(input: Partial<StudySources> | undefined, prev: StudySources): StudySources {
  return { web: input?.web === undefined ? prev.web : Boolean(input.web), ids: Array.isArray(input?.ids) ? [...new Set(input!.ids.map(String).map((s) => s.trim()).filter(Boolean))] : prev.ids };
}

/** Whether a brief's slug is taken by another study (its folder, or another study's row). */
async function slugTaken(ctx: AppContext, slug: string, self: string | null): Promise<boolean> {
  if (fs.existsSync(safePath(ctx.dataDir, studyFolder(slug))) || fs.existsSync(safePath(ctx.dataDir, `${STUDY_WIKI_DIR}/${slug}.md`))) {
    // the study's own folder is not a clash
    if (self) {
      const job = await getJob(ctx.store, self);
      if (job?.target === slug && job.status !== 'draft') return false;
    }
    return true;
  }
  const rows = await ctx.store.query<{ id: string }>(`SELECT id FROM research_jobs WHERE kind = 'study' AND target = $1 AND id <> $2 AND status <> 'cancelled' LIMIT 1`, [slug, self ?? '']);
  return rows.length > 0;
}

async function uniqueSlug(ctx: AppContext, slug: string, self: string | null): Promise<string> {
  const base = researchSlug(slug) || 'study';
  for (let n = 1; n < 200; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!(await slugTaken(ctx, candidate, self))) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/* --------------------------------------------------------------- agents */

/** The agent a study (or one of its pages) runs on: its runner's, else research.agent. */
export function studyAgent(ctx: AppContext, job: ResearchJob): ResearchAgent | null {
  const runner = (job.payload.runner ?? null) as Partial<StudyRunner> | null;
  if (runner?.agent) return agentForSpec(ctx.config, runner.agent, runner.model ?? '', ctx.dataDir);
  return resolveResearchAgent(ctx.config, ctx.dataDir);
}

/** The profile a study's job runs with: the runner's (else research.profile), its web switch set by the study. */
export function studyProfile(ctx: AppContext, job: ResearchJob): ResearchProfile {
  const runner = (job.payload.runner ?? null) as Partial<StudyRunner> | null;
  const base = (runner?.profile ? loadProfile(ctx.dataDir, runner.profile) : null) ?? activeProfile(ctx.dataDir, ctx.config);
  const sources = job.payload.sources as Partial<StudySources> | undefined;
  if (!sources) return base;
  // the study's switch, within review.external (webAllowed still applies the workspace gate)
  return { ...base, search: { ...base.search, web: sources.web === false ? 'off' : 'on' } };
}

export function studySources(ctx: AppContext, job: ResearchJob): ResearchSource[] {
  const ids = Array.isArray((job.payload.sources as Partial<StudySources> | undefined)?.ids) ? (job.payload.sources as StudySources).ids : [];
  if (ids.length === 0) return [];
  const all = loadResearchSources(ctx.dataDir);
  return ids.map((id) => all.find((s) => s.id === id)).filter((s): s is ResearchSource => Boolean(s));
}

export function studyMcpServers(ctx: AppContext, job: ResearchJob): ExtraMcpServer[] {
  return mcpServersFor(studySources(ctx, job));
}

/* ----------------------------------------------------------- lifecycle */

export interface CreateStudyInput {
  topic: string;
  runner?: Partial<StudyRunner>;
  sources?: Partial<StudySources>;
  language?: string;
  requestedBy?: string;
  /** Refine right away (one model call); false = a template brief to fill in; 'background' = start it and return the draft. */
  refine?: boolean | 'background';
  /** For 'background': who keeps the refinement alive (serve's shutdown waits for it). */
  track?: <T>(p: Promise<T>) => Promise<T>;
}

export async function createStudy(ctx: AppContext, input: CreateStudyInput): Promise<ResearchJob> {
  const topic = input.topic.trim();
  if (topic.length < 8) throw new Error('describe what you want to research in a sentence or more');
  const maxPages = ctx.config.research.study.maxPages;
  const language = input.language || detectLanguage(topic);
  const runner = cleanRunner(input.runner);
  const enabled = loadResearchSources(ctx.dataDir).filter((s) => s.enabled).map((s) => s.id);
  const sources = cleanSources(input.sources, { web: true, ids: enabled });
  let brief = templateBrief(topic, maxPages, language);
  const refinements: StudyRefinement[] = [];
  let job = await createJobRow(ctx.store, {
    kind: 'study', status: 'draft', target: brief.slug, query: topic, template: 'study', requestedBy: input.requestedBy ?? 'web',
    payload: { topic, brief, runner, sources, stage: 'draft', steps: STUDY_STEPS.map((name) => ({ name, status: 'pending' })), refinements, children: [], notes: [], collect: [] },
  });
  if (input.refine === 'background') return refineStudyInBackground(ctx, job.id, {}, input.track);
  if (input.refine !== false) job = await refineStudy(ctx, job.id, {});
  else {
    brief = { ...brief, slug: await uniqueSlug(ctx, brief.slug, job.id) };
    job = (await updateJob(ctx.store, job.id, { target: brief.slug, query: brief.title, payload: { ...job.payload, brief } }))!;
  }
  return job;
}

async function draftOf(ctx: AppContext, id: string): Promise<ResearchJob> {
  const job = await getJob(ctx.store, id);
  if (!job || job.kind !== 'study') throw new Error(`no study ${id}`);
  if (job.status !== 'draft') throw new Error(`study ${id} has started (${job.status}); only a draft can be refined or edited`);
  return job;
}

export interface RefineStudyInput {
  feedback?: string;
  answers?: Record<string, string>;
  /** The brief as the person edited it, refined from there. */
  brief?: StudyBrief;
  runner?: Partial<StudyRunner>;
  sources?: Partial<StudySources>;
}

/** One refinement round: the model rewrites the brief from the topic, the current brief and the person's feedback. */
export async function refineStudy(ctx: AppContext, id: string, input: RefineStudyInput): Promise<ResearchJob> {
  let job = await draftOf(ctx, id);
  const p = studyPayload(job);
  const runner = cleanRunner(input.runner, p.runner);
  const sources = cleanSources(input.sources, p.sources);
  const current = input.brief ?? (p.refinements.some((r) => !r.error) ? p.brief : null);
  const agent = runner.agent ? agentForSpec(ctx.config, runner.agent, runner.model, ctx.dataDir) : resolveResearchAgent(ctx.config, ctx.dataDir);
  const all = loadResearchSources(ctx.dataDir);
  const r = await refineBrief(ctx, {
    topic: p.topic, brief: current, feedback: input.feedback, answers: input.answers,
    sources: sources.ids.map((sid) => all.find((s) => s.id === sid)).filter((s): s is ResearchSource => Boolean(s)),
    web: sources.web, agent, maxPages: ctx.config.research.study.maxPages, language: current?.language,
  });
  const brief = { ...r.brief, slug: await uniqueSlug(ctx, current?.slug || r.brief.slug, job.id) };
  const refinement: StudyRefinement = { at: new Date().toISOString(), refiner: r.refiner, ms: r.ms, error: r.error, ...(input.feedback?.trim() ? { feedback: input.feedback.trim().slice(0, 2000) } : {}) };
  // re-read: the person may have edited runner or sources while the model thought; only the brief is the model's
  const latest = (await getJob(ctx.store, job.id)) ?? job;
  const { refining: _done, ...rest } = latest.payload as Record<string, unknown>;
  job = (await updateJob(ctx.store, job.id, {
    target: brief.slug,
    query: brief.title,
    error: r.error,
    payload: { ...rest, brief, runner, sources, refinements: [...p.refinements, refinement] },
  }))!;
  return job;
}

/** A refinement under way, as the draft shows it (null when none is). */
export function refiningSince(job: ResearchJob): string | null {
  const r = job.payload.refining as { at?: string } | undefined;
  if (!r?.at) return null;
  // a refinement the process lost (a restart) does not hold the draft forever
  return Date.now() - Date.parse(r.at) < 20 * 60_000 ? r.at : null;
}

/**
 * Refine without holding the caller: the draft is marked `refining` and the
 * model runs in the background (a CLI one-shot can take minutes); the web UI
 * polls the draft until the new brief is in. Returns the marked draft.
 */
export async function refineStudyInBackground(ctx: AppContext, id: string, input: RefineStudyInput, track: <T>(p: Promise<T>) => Promise<T> = (p) => p): Promise<ResearchJob> {
  const job = await draftOf(ctx, id);
  if (refiningSince(job)) throw new Error('a refinement is already under way for this draft');
  const marked = (await updateJob(ctx.store, id, { payload: { ...job.payload, refining: { at: new Date().toISOString(), feedback: input.feedback ?? '' } } }))!;
  void track(refineStudy(ctx, id, input).catch(async (err) => {
    const now = await getJob(ctx.store, id);
    if (!now) return;
    const { refining: _r, ...rest } = now.payload as Record<string, unknown>;
    await updateJob(ctx.store, id, { error: `refine: ${err instanceof Error ? err.message : err}`, payload: rest });
  }));
  return marked;
}

export interface UpdateStudyInput {
  brief?: StudyBrief;
  runner?: Partial<StudyRunner>;
  sources?: Partial<StudySources>;
}

/** The person's edits to a draft: the brief is normalized the same way a model's is. */
export async function updateStudy(ctx: AppContext, id: string, input: UpdateStudyInput): Promise<ResearchJob> {
  const job = await draftOf(ctx, id);
  // the model's brief would land on top of these edits a moment later
  if (input.brief && refiningSince(job)) throw new Error('the brief is being refined — wait for the new one, then edit it');
  const p = studyPayload(job);
  let brief = p.brief;
  if (input.brief) {
    brief = normalizeBrief(input.brief as unknown as Record<string, unknown>, { topic: p.topic, maxPages: ctx.config.research.study.maxPages, language: input.brief.language || p.brief.language });
    brief.slug = await uniqueSlug(ctx, researchSlug(input.brief.slug || brief.slug) || p.brief.slug, job.id);
  }
  return (await updateJob(ctx.store, job.id, {
    target: brief.slug,
    query: brief.title,
    payload: { ...job.payload, brief, runner: cleanRunner(input.runner, p.runner), sources: cleanSources(input.sources, p.sources) },
  }))!;
}

/** What would stop a draft from starting, or null. */
export function startProblem(ctx: AppContext, job: ResearchJob): string | null {
  const p = studyPayload(job);
  if (p.brief.pages.length === 0) return 'the brief plans no pages';
  if (p.brief.questions.length === 0) return 'the brief asks no questions';
  const agent = studyAgent(ctx, job);
  if (!agent) return 'no agent to run it: pick one for the study, or set research.agent (Settings → Research)';
  if (p.runner.mode === 'deep-research') {
    const dr = p.runner.deepResearch;
    if (!p.sources.web || (ctx.config.review?.external ?? 'verify') === 'off') return 'a deep-research model searches the web: turn the web on for this study (and in the workspace\'s web access)';
    if (!dr?.connection || !dr.model) return 'deep-research mode needs a connection and a model (e.g. o3-deep-research)';
    const connection = llmTargets(ctx.config).find((c) => c.id === dr.connection);
    if (!connection) return `no connection "${dr.connection}"`;
    if (!connection.baseUrl) return `connection "${dr.connection}" is not an API endpoint`;
  }
  return null;
}

export async function startStudy(ctx: AppContext, id: string): Promise<ResearchJob> {
  const job = await draftOf(ctx, id);
  if (refiningSince(job)) throw new Error('the brief is still being refined — wait for it, then start');
  const problem = startProblem(ctx, job);
  if (problem) throw new Error(problem);
  const p = studyPayload(job);
  const slug = await uniqueSlug(ctx, p.brief.slug, job.id);
  return (await updateJob(ctx.store, job.id, {
    status: 'queued', target: slug, query: p.brief.title, error: null,
    payload: { ...job.payload, brief: { ...p.brief, slug }, stage: 'collect', steps: STUDY_STEPS.map((name) => ({ name, status: 'pending' })) },
  }))!;
}

/** Cancel a study and every page job it queued that has not finished. */
export async function cancelStudy(ctx: AppContext, id: string): Promise<{ cancelled: boolean; killed: number; pages: number }> {
  const job = await getJob(ctx.store, id);
  if (!job || job.kind !== 'study') throw new Error(`no study ${id}`);
  let killed = 0;
  let pages = 0;
  for (const child of await listJobs(ctx.store, { study: id, limit: 100 })) {
    if (TERMINAL_STATUSES.includes(child.status)) continue;
    const rows = await ctx.store.query<{ id: string }>(`UPDATE research_jobs SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status NOT IN ('done', 'failed', 'cancelled') RETURNING id`, [child.id]);
    if (rows.length) {
      pages++;
      killed += killAgentsFor(child.id);
    }
  }
  const rows = await ctx.store.query<{ id: string }>(`UPDATE research_jobs SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status NOT IN ('done', 'failed', 'cancelled') RETURNING id`, [id]);
  if (rows.length) killed += killAgentsFor(id);
  return { cancelled: rows.length > 0, killed, pages };
}

/** A draft nobody started can go; a study that ran stays, with its pages and sources. */
export async function deleteStudyDraft(ctx: AppContext, id: string): Promise<boolean> {
  const rows = await ctx.store.query<{ id: string }>(`DELETE FROM research_jobs WHERE id = $1 AND kind = 'study' AND status IN ('draft', 'cancelled') AND COALESCE(payload ->> 'stage', 'draft') = 'draft' RETURNING id`, [id]);
  return rows.length > 0;
}

/* ---------------------------------------------------------------- views */

export interface StudyPageView {
  id: string;
  title: string;
  path: string;
  job: string | null;
  status: string;
  trust: string | null;
  error: string | null;
  warnings: string[];
}

export interface StudyView {
  job: ResearchJob;
  payload: StudyPayload;
  reportPath: string;
  reportExists: boolean;
  reportTrust: string | null;
  pages: StudyPageView[];
  captures: { path: string; title: string | null; site: string; kind: string; published: string | null; url: string; why: string }[];
  registerPath: string;
  notes: string[];
  /** The files each Promote covers, by tier: `quarantined` is what it would make trusted; `unindexed` it cannot promote yet. */
  tiers: Record<Exclude<StudyFiles, 'all'>, { trusted: number; quarantined: number; unindexed: number }>;
}

/** What a Promote covers: the pages and the report, the sources (captures, notes, register), or both. */
export type StudyFiles = 'pages' | 'sources' | 'all';

export function reportPathFor(slug: string): string {
  return `${STUDY_WIKI_DIR}/${slug}.md`;
}

export function pagePathFor(slug: string, page: Pick<StudyPage, 'slug'>): string {
  return `${STUDY_WIKI_DIR}/${slug}/${page.slug}.md`;
}

/** The tier of each file's live document, by path; a file not indexed yet has none. */
async function trustOf(ctx: AppContext, rels: string[]): Promise<Map<string, TrustTier>> {
  if (rels.length === 0) return new Map();
  const p = new Params();
  const rows = await ctx.store.query<{ key: string; trust: TrustTier }>(
    `SELECT DISTINCT ON (key) key, trust FROM scopes WHERE kind = 'doc' AND key IN (${rels.map((r) => p.add(r)).join(',')}) AND status = 'active'
     ORDER BY key, applied_at DESC`,
    p.list,
  );
  return new Map(rows.map((r) => [r.key, r.trust]));
}

/** A study's files as its two Promote buttons cover them: the pages and the report; the captures, notes and register. */
function studyFiles(job: ResearchJob, captures: string[]): Record<Exclude<StudyFiles, 'all'>, string[]> {
  const p = studyPayload(job);
  const slug = job.target ?? p.brief.slug;
  return {
    pages: [...p.brief.pages.map((page) => pagePathFor(slug, page)), reportPathFor(slug)],
    sources: [...captures, registerPath(slug), ...p.notes],
  };
}

export async function studyView(ctx: AppContext, job: ResearchJob): Promise<StudyView> {
  const p = studyPayload(job);
  const slug = job.target ?? p.brief.slug;
  const children = p.children.length ? await listJobs(ctx.store, { study: job.id, limit: 100 }) : [];
  const captures = studyCaptures(ctx.dataDir, job.id).map((e) => ({
    path: e.path, title: e.title, site: e.site, kind: e.kind, published: e.published, url: e.urls[e.urls.length - 1] ?? e.url,
    why: e.studies.find((s) => s.id === job.id)?.why ?? '',
  }));
  const files = studyFiles(job, captures.map((c) => c.path));
  const existing = new Set([...files.pages, ...files.sources].filter((rel) => fs.existsSync(safePath(ctx.dataDir, rel))));
  const trust = await trustOf(ctx, [...existing]);
  const tierOf = (rel: string) => (existing.has(rel) ? trust.get(rel) ?? null : null);
  const pages: StudyPageView[] = p.brief.pages.map((page) => {
    const rel = pagePathFor(slug, page);
    const child = children.find((c) => (c.payload.page as StudyPage | undefined)?.id === page.id) ?? null;
    return {
      id: page.id, title: page.title, path: rel, job: child?.id ?? null, status: child?.status ?? (job.status === 'draft' ? 'planned' : 'pending'),
      trust: tierOf(rel),
      error: child?.error ?? null, warnings: Array.isArray(child?.payload.warnings) ? (child!.payload.warnings as string[]) : [],
    };
  });
  const report = reportPathFor(slug);
  const tiers = (rels: string[]) => {
    const present = rels.filter((rel) => existing.has(rel));
    const of = (tier: TrustTier | null) => present.filter((rel) => tierOf(rel) === tier).length;
    return { trusted: of('trusted'), quarantined: of('quarantined'), unindexed: of(null) };
  };
  return {
    job, payload: p, reportPath: report, reportExists: existing.has(report), reportTrust: tierOf(report), pages,
    captures,
    registerPath: registerPath(slug),
    notes: p.notes,
    tiers: { pages: tiers(files.pages), sources: tiers(files.sources) },
  };
}

export interface StudyPromotion {
  to: TrustTier;
  /** Files whose tier changed; files already at it; files not indexed yet (nothing to promote until they are); errors. */
  changed: string[];
  unchanged: string[];
  notIndexed: string[];
  failed: { path: string; error: string }[];
}

/** A person's review of what a study produced: its pages and report, or the sources it captured, made trusted (or quarantined again). */
export async function promoteStudy(ctx: AppContext, job: ResearchJob, opts: { what: StudyFiles; to: TrustTier; actor?: string }): Promise<StudyPromotion> {
  const all = studyFiles(job, studyCaptures(ctx.dataDir, job.id).map((e) => e.path));
  const files = (opts.what === 'all' ? [...all.pages, ...all.sources] : all[opts.what]).filter((rel) => fs.existsSync(safePath(ctx.dataDir, rel)));
  const trust = await trustOf(ctx, files);
  const out: StudyPromotion = { to: opts.to, changed: [], unchanged: [], notIndexed: [], failed: [] };
  for (const rel of files) {
    const tier = trust.get(rel);
    if (!tier) out.notIndexed.push(rel);
    else if (tier === opts.to) out.unchanged.push(rel);
    else {
      try {
        await setScopeTrust(ctx.store, { key: rel, to: opts.to, actor: opts.actor });
        out.changed.push(rel);
      } catch (e) {
        out.failed.push({ path: rel, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return out;
}

export async function listStudies(ctx: AppContext, limit = 50): Promise<ResearchJob[]> {
  return listJobs(ctx.store, { kind: 'study', limit });
}

/* --------------------------------------------------------------- brief */

const LANGUAGE_NAMES: Record<string, string> = { en: 'English', zh: '中文' };

function languageName(tag: string): string {
  return LANGUAGE_NAMES[tag.slice(0, 2).toLowerCase()] ?? tag;
}

/**
 * The study as an agent reads it — in every collector's prompt, and in the
 * brief of every page and of the report: what is being researched, for what,
 * within which bounds, which pages exist, and what has been gathered so far.
 * It names the source marker (and, for collectors, the note headings) in the
 * study's language: the protocol and templates a workspace was seeded with
 * show the Chinese ones, and a page in English copied them.
 */
export function studyDocument(ctx: AppContext, job: ResearchJob, opts: { focusPage?: string | null; sources: ResearchSource[]; web: boolean; webSearchTool: boolean; notes?: boolean }): string {
  const p = studyPayload(job);
  const b = p.brief;
  const slug = job.target ?? b.slug;
  const zh = b.language.startsWith('zh');
  const lines = [
    `## 研究课题（study \`${job.id}\`）`,
    '',
    `- 课题：${b.title}`,
    `- 输出语言：${languageName(b.language)}——页面标题、正文与章节标题都用这个语言（frontmatter 的键名不变）`,
    `- 正文出处写 \`${sourceMarker(b.language)}\`${zh ? '' : '：协议与模板里的「（来源：…）」是中文写法，本课题不用'}`,
    opts.notes ? `- 笔记的四个固定标题依次写 ${noteHeadings(b.language).map((h) => `\`${h}\``).join(' / ')}${zh ? '' : '，不用模板里的中文标题'}` : null,
    `- 目标：${b.objective}`,
    b.restatement ? `- 研究请求（改写）：${b.restatement}` : null,
    `- 范围：${b.scope.include.length ? `包含 ${b.scope.include.join('；')}` : '（未限定）'}${b.scope.exclude.length ? `；不含 ${b.scope.exclude.join('；')}` : ''}${b.scope.timeframe ? `；时间 ${b.scope.timeframe}` : ''}；截至 ${b.scope.asOf}`,
    b.assumptions.length ? `- 前提：${b.assumptions.join('；')}` : null,
    ...b.clarifications.filter((c) => c.answer).map((c) => `- 已确认：${c.question} → ${c.answer}`),
    '',
    '### 原始请求',
    '',
    p.topic.trim(),
    '',
    '### 页面与问题',
    '',
  ].filter((l): l is string => l !== null);
  for (const page of b.pages) {
    const focus = opts.focusPage === page.id;
    lines.push(`- ${focus ? '**【本页】** ' : ''}\`${page.id}\` [[research/${slug}/${page.slug}|${page.title}]]（\`${pagePathFor(slug, page)}\`）${page.purpose ? `：${page.purpose}` : ''}`);
    for (const qid of page.questions) {
      const q = b.questions.find((x) => x.id === qid);
      if (q) lines.push(`  - ${q.id} ${q.text}${focus && q.why ? `（为什么重要：${q.why}）` : ''}${focus && q.queries.length ? `；检索：${q.queries.join('、')}` : ''}`);
    }
    if (focus && page.charts.length) lines.push(`  - 适合的图表：${page.charts.join('；')}`);
    if (focus && page.entities.length) lines.push(`  - 主要实体：${page.entities.join('、')}`);
  }
  lines.push('', `总报告：[[research/${slug}|${b.report.title}]]（\`${reportPathFor(slug)}\`）`, '');
  const captures = studyCaptures(ctx.dataDir, job.id);
  lines.push('### 已收集的资料', '');
  if (captures.length) {
    lines.push(`资料登记表：\`${registerPath(slug)}\`（${captures.length} 份）；收集员笔记：${p.notes.length ? p.notes.map((n) => `\`${n}\``).join('、') : '（无）'}`, '');
    for (const c of captures.slice(0, 80)) lines.push(`- \`${c.path}\` — ${c.title ?? c.site}${c.published ? `（${c.published}）` : ''}`);
    if (captures.length > 80) lines.push(`- …另有 ${captures.length - 80} 份，见资料登记表`);
  } else {
    lines.push('（还没有收集到资料）');
  }
  lines.push('', ...sourcesBrief(opts.sources, { web: opts.web, webSearchTool: opts.webSearchTool }));
  lines.push(`保存资料：knode_capture(url, study="${job.id}", why="…")；它返回的 raw/docs/research/${slug}/… 路径就是引用的来源。`);
  lines.push(`页面互链用知识库根路径：\`[[research/${slug}/<页面 slug>|标题]]\`；总报告是 \`[[research/${slug}|…]]\`。`);
  return lines.join('\n');
}

/** The extra brief a study's page job, or its report, gets. */
export async function studyBriefLines(ctx: AppContext, job: ResearchJob, opts: { allowNetwork: boolean }): Promise<string[]> {
  const study = job.kind === 'study' ? job : typeof job.payload.study === 'string' ? await getJob(ctx.store, job.payload.study) : null;
  if (!study) return [];
  const page = job.kind === 'section' ? (job.payload.page as StudyPage | undefined) ?? null : null;
  const sources = studySources(ctx, study);
  const lines = [studyDocument(ctx, study, { focusPage: page?.id ?? null, sources, web: opts.allowNetwork, webSearchTool: webSearchEnabled(ctx.config.research.web) }), ''];
  lines.push(`frontmatter 固定值：\`study: ${study.id}\``, '');
  if (job.kind === 'study') {
    const children = await listJobs(ctx.store, { study: study.id, limit: 100 });
    const p = studyPayload(study);
    lines.push('### 本课题的页面（分页已写完，你写总报告）', '');
    for (const pg of p.brief.pages) {
      const child = children.find((c) => (c.payload.page as StudyPage | undefined)?.id === pg.id);
      const rel = pagePathFor(study.target ?? p.brief.slug, pg);
      const exists = fs.existsSync(safePath(ctx.dataDir, rel));
      lines.push(`- \`${rel}\` — ${pg.title}：${child?.status ?? 'missing'}${exists ? '' : '（文件不存在）'}${child?.error ? `；错误：${child.error.slice(0, 200)}` : ''}`);
    }
    lines.push('');
  }
  return lines;
}

/* -------------------------------------------------------------- collect */

function setStep(steps: StudyStep[], name: StudyStepName, status: StudyStep['status'], detail?: string): StudyStep[] {
  return steps.map((s) => (s.name === name ? { name, status, ...(detail ? { detail } : {}) } : s));
}

export interface CollectDeps {
  mcp: McpEndpoint;
  agent: ResearchAgent;
  profile: ResearchProfile;
  readDirs: string[];
  log: (msg: string) => void;
}

/** raw/docs paths a collector's notes cite. */
function citedPaths(text: string): string[] {
  return [...new Set([...text.matchAll(/raw\/docs\/[^\s`'"<>)\]|，。；、（）]+/g)].map((m) => m[0].replace(/[.,;:]+$/, '')))];
}

function notesFile(dataDir: string, input: { rel: string; title: string; study: string; page: string | null; actor: string; sources: string[]; body: string; language: string }): void {
  const text = [
    '---',
    `title: ${JSON.stringify(input.title)}`,
    'type: research-notes',
    `study: ${JSON.stringify(input.study)}`,
    ...(input.page ? [`page: ${JSON.stringify(input.page)}`] : []),
    `date: ${JSON.stringify(new Date().toISOString().slice(0, 10))}`,
    `lang: ${JSON.stringify(input.language)}`,
    `actor: ${JSON.stringify(input.actor)}`,
    `sources: ${JSON.stringify(input.sources)}`,
    '---',
    '',
    `# ${input.title}`,
    '',
    input.body.trim(),
    '',
  ].join('\n');
  recordOrigin(dataDir, input.rel, text, input.actor);
  writeFileBytes(dataDir, input.rel, Buffer.from(text));
}

function deepResearchPrompt(ctx: AppContext, job: ResearchJob): string {
  const p = studyPayload(job);
  const b = p.brief;
  const zh = b.language.startsWith('zh');
  const lines = zh
    ? [`请就下面的课题做一次深度研究，用中文写一份详尽、结构清楚的研究报告。今天是 ${new Date().toISOString().slice(0, 10)}。`]
    : [`Research the following topic in depth and write a detailed, well-structured research report in ${languageName(b.language)}. Today is ${new Date().toISOString().slice(0, 10)}.`];
  lines.push('', `# ${b.title}`, '', b.objective, '', p.topic.trim(), '');
  for (const page of b.pages) {
    lines.push(`## ${page.title}`);
    for (const qid of page.questions) {
      const q = b.questions.find((x) => x.id === qid);
      if (q) lines.push(`- ${q.text}`);
    }
    lines.push('');
  }
  lines.push(zh
    ? '要求：一手来源优先（监管文件、公司披露、财报、官方页面），其次是可靠媒体与研究机构；每个事实与数字都给出处（链接）与日期；区分公司披露的事实与他人的观点或预测；互相矛盾的数字并列写出并说明口径；最后列出仍不清楚的问题。'
    : 'Requirements: prefer primary sources (regulatory filings, company disclosures, financial statements, official pages), then reputable media and research firms; cite a link and a date for every fact and number; keep company-reported facts apart from other people\'s opinions and forecasts; when figures conflict, give both with their basis; end with the questions that remain open.');
  return lines.join('\n');
}

/**
 * The collect stage of a study: capture the seed URLs, gather material (agent
 * collectors in parallel, or one deep-research call), index it, then queue one
 * page job per planned page and wait for them.
 */
export async function runStudyCollect(ctx: AppContext, jobIn: ResearchJob, deps: CollectDeps): Promise<ResearchJob> {
  const { log } = deps;
  let job = jobIn;
  let p = studyPayload(job);
  const slug = job.target ?? p.brief.slug;
  const studyRef = { id: job.id, slug, title: p.brief.title };
  const actor = `agent/${deps.agent.provider}`;
  const save = async (patch: Partial<StudyPayload>, extra: Parameters<typeof updateJob>[2] = {}) => {
    p = { ...p, ...patch };
    job = (await updateJob(ctx.store, job.id, { ...extra, payload: { ...job.payload, ...p } }))!;
  };
  const cancelled = async () => isCancelled(job.id) || (await getJob(ctx.store, job.id))?.status === 'cancelled';
  await save({ stage: 'collect' }, { agent: deps.agent.provider, model: deps.agent.model || null });
  fs.mkdirSync(safePath(ctx.dataDir, studyFolder(slug)), { recursive: true });
  const maxCaptures = ctx.config.research.study.maxCaptures;
  const web = webAllowed({ gate: ctx.config.review?.external ?? 'verify', kind: 'study', profile: deps.profile, agent: deps.agent, search: webSearchEnabled(ctx.config.research.web) });

  /* ---- seed: the URLs the brief and the selected sites name ---- */
  const sources = studySources(ctx, job);
  const seeds = [
    ...p.brief.seedUrls,
    ...sources.filter((s) => s.kind === 'site').flatMap((s) => s.urls.map((url) => ({ url, why: `${s.title}（预置来源）` }))),
  ];
  const fetchAllowed = p.sources.web && (ctx.config.review?.external ?? 'verify') !== 'off';
  if (seeds.length && fetchAllowed) {
    await save({ steps: setStep(p.steps, 'seed', 'running', `${seeds.length} URL(s)`) });
    const outcomes = await pool(seeds, 3, async (s) => {
      try {
        const r = await captureUrl(ctx, { url: s.url, study: studyRef, why: s.why, actor, maxCaptures, index: 'background' });
        return { ok: true, url: s.url, path: r.path };
      } catch (err) {
        log(`study ${job.id}: seed ${s.url} — ${err instanceof Error ? err.message : err}`);
        return { ok: false, url: s.url, error: err instanceof Error ? err.message : String(err) };
      }
    });
    const ok = outcomes.filter((o) => o.ok).length;
    await save({ steps: setStep(p.steps, 'seed', ok ? 'done' : 'failed', `${ok}/${seeds.length} captured${ok < seeds.length ? `; failed: ${outcomes.filter((o) => !o.ok).map((o) => o.url).slice(0, 3).join(', ')}` : ''}`) });
  } else {
    await save({ steps: setStep(p.steps, 'seed', 'skipped', seeds.length ? 'the web is off for this study' : 'no seed URLs') });
  }
  if (await cancelled()) throw new JobCancelledError(job.id);

  /* ---- collect ---- */
  const lang = p.brief.language;
  const zh = lang.startsWith('zh');
  const notes: string[] = [];
  const phases: PhaseRecord[] = [];
  await save({ steps: setStep(p.steps, 'collect', 'running', p.runner.mode === 'deep-research' ? `deep research (${p.runner.deepResearch?.model})` : `${p.brief.pages.length} collector(s) on ${deps.agent.provider}`) });
  if (p.runner.mode === 'deep-research') {
    const dr = p.runner.deepResearch!;
    const connection = llmTargets(ctx.config).find((c) => c.id === dr.connection);
    if (!connection) throw new Error(`no connection "${dr.connection}" for deep research`);
    const t0 = Date.now();
    const result = await runDeepResearch({
      connection, model: dr.model, prompt: deepResearchPrompt(ctx, job), web: ctx.config.research.web,
      timeoutMs: Math.max(ctx.config.research.timeoutMs, 3_600_000), jobId: job.id, log: (m) => log(`study ${job.id}: ${m}`),
    });
    phases.push({ name: 'collect', label: 'deep-research', role: 'deep-research', agent: `deep-research:${result.model}`, turns: null, costUsd: null, error: null, ms: Date.now() - t0 });
    const rel = `${studyFolder(slug)}/reports/${new Date().toISOString().slice(0, 10)}-${researchSlug(result.model) || 'deep-research'}.md`;
    const reportActor = `agent/deep-research:${result.model}`;
    const body = [
      result.text,
      '',
      zh ? '## 引用' : '## Citations',
      '',
      ...result.citations.map((c, i) => `${i + 1}. [${(c.title ?? c.url).replace(/[[\]]/g, '')}](${c.url})`),
    ].join('\n');
    notesFile(ctx.dataDir, { rel, title: `${zh ? '深度研究报告' : 'Deep research report'} — ${p.brief.title}`, study: job.id, page: null, actor: reportActor, sources: result.citations.map((c) => c.url), body, language: lang });
    notes.push(rel);
    log(`study ${job.id}: deep research returned ${result.text.length} chars and ${result.citations.length} citation(s); capturing them`);
    if (fetchAllowed) {
      const cited = result.citations.slice(0, maxCaptures);
      await pool(cited, 4, async (c) => {
        try {
          await captureUrl(ctx, { url: c.url, study: studyRef, why: zh ? '深度研究报告引用' : 'cited by the deep-research report', title: c.title ?? undefined, actor: reportActor, maxCaptures, index: 'background' });
        } catch (err) {
          log(`study ${job.id}: citation ${c.url} — ${err instanceof Error ? err.message : err}`);
        }
      });
    }
  } else {
    const dir = path.join(runsRoot(ctx.dataDir, ctx.config.research.runsDir ?? '.runs'), `${job.id}-collect`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const workset = (await checkout(ctx.store, { actor, note: `study ${job.id}: collect` })).id;
    const extraMcp = studyMcpServers(ctx, job);
    writeAgentFiles(dir, {
      schema: [loadResearchProtocol(ctx.dataDir).trim(), '', knowledgeNotes(ctx.dataDir)].filter(Boolean).join('\n'),
      mcp: deps.mcp,
      readme: `Collector sessions of study ${job.id}. transcript-collect-<n>.jsonl are their outputs; the notes land in ${studyFolder(slug)}/notes/.\n`,
      extraMcp,
    });
    const document = studyDocument(ctx, job, { sources, web, webSearchTool: webSearchEnabled(ctx.config.research.web), notes: true });
    const collectors = Math.max(1, ctx.config.research.study.collectors);
    const perCollector = Math.max(4, Math.ceil(maxCaptures / Math.max(1, p.brief.pages.length)));
    const results = await pool(p.brief.pages, collectors, async (page, i) => {
      if (await cancelled()) return null;
      const questions = page.questions.map((qid) => p.brief.questions.find((q) => q.id === qid)).filter(Boolean);
      const prompt = loadPhasePrompt(ctx.dataDir, 'collect', {
        page: page.title, title: p.brief.title, study: job.id, objective: p.brief.objective,
        questions: questions.map((q) => `- ${q!.id} ${q!.text}`).join('\n') || `- ${page.purpose || page.title}`,
        queries: [...new Set(questions.flatMap((q) => q!.queries))].join('、') || page.title,
        language: languageName(lang), maxCaptures: String(perCollector),
      });
      const label = `collect-${i + 1}`;
      const t0 = Date.now();
      const r = await launchSession({
        agent: deps.agent, maxTurns: Math.max(40, ctx.config.research.maxTurns), timeoutMs: ctx.config.research.timeoutMs,
        cwd: dir, prompt: `${prompt}\n\n---\n\n${document}`, mcp: deps.mcp, readDirs: deps.readDirs, jobId: job.id,
        outputPath: '', worksetId: workset, allowNetwork: web, tools: 'read', files: true,
        effort: effectiveEffort(deps.profile, null), speed: effectiveSpeed(deps.profile, null), webFreshness: deps.profile.search.freshness,
        extraMcp, label,
      });
      phases.push({ name: 'collect', label, role: 'collector', agent: deps.agent.provider, turns: r.turns, costUsd: r.costUsd, error: r.error, ms: Date.now() - t0 });
      const text = r.text.trim();
      if (!text) {
        log(`study ${job.id}: ${label} (${page.title}) returned nothing${r.error ? `: ${r.error}` : ''}`);
        return null;
      }
      const rel = `${studyFolder(slug)}/notes/${String(i + 1).padStart(2, '0')}-${page.slug}.md`;
      notesFile(ctx.dataDir, { rel, title: `${zh ? '收集笔记' : 'Notes'} — ${page.title}`, study: job.id, page: page.id, actor, sources: citedPaths(text), body: localizeNoteHeadings(text, lang), language: lang });
      return rel;
    });
    notes.push(...results.filter((r): r is string => Boolean(r)));
    fs.writeFileSync(path.join(dir, 'phases.json'), JSON.stringify(phases, null, 2) + '\n');
  }
  if (await cancelled()) throw new JobCancelledError(job.id);
  const captured = studyCaptures(ctx.dataDir, job.id).length;
  if (notes.length === 0 && captured === 0) {
    const errors = phases.map((ph) => ph.error).filter(Boolean);
    await save({ collect: phases, steps: setStep(p.steps, 'collect', 'failed', errors[0] ?? 'nothing was collected') });
    throw new Error(`collect: nothing was gathered${errors.length ? ` — ${errors[0]}` : ''}`);
  }
  await save({ collect: phases, notes, steps: setStep(p.steps, 'collect', 'done', `${captured} source(s) captured, ${notes.length} note(s)`) });

  /* ---- index what was gathered ---- */
  await save({ steps: setStep(p.steps, 'index', 'running') });
  await waitForCaptureIndexing(ctx.dataDir);
  try {
    const stats = await sync(ctx, { only: [studyFolder(slug)], actor: 'research', onProgress: () => {} });
    await save({ steps: setStep(p.steps, 'index', 'done', `${stats.indexed} indexed, ${stats.unchanged} unchanged`) });
  } catch (err) {
    await save({ steps: setStep(p.steps, 'index', 'failed', err instanceof Error ? err.message : String(err)) });
  }

  /* ---- one page job per planned page ---- */
  const existing = await listJobs(ctx.store, { study: job.id, limit: 100 });
  const children: string[] = [];
  for (const page of p.brief.pages) {
    const prior = existing.find((c) => (c.payload.page as StudyPage | undefined)?.id === page.id);
    if (prior && prior.status !== 'cancelled') {
      children.push(prior.id);
      continue;
    }
    const child = await createJobRow(ctx.store, {
      kind: 'section', status: 'queued', target: `${slug}/${page.slug}`, query: page.title, template: 'section', requestedBy: 'study',
      payload: {
        study: job.id, page, language: lang,
        sections: [...page.sections, sourcesHeading(lang)],
        runner: p.runner.mode === 'deep-research' ? { ...p.runner, mode: 'agent' } : p.runner,
        sources: p.sources,
      },
    });
    children.push(child.id);
  }
  await save({ children, stage: 'pages', steps: setStep(p.steps, 'pages', 'running', `${children.length} page job(s) queued`) }, { status: 'waiting' });
  log(`study ${job.id}: collected ${captured} source(s); ${children.length} page job(s) queued`);
  return job;
}

/**
 * Studies whose pages have all finished go on to their report: called on
 * every tick of the research loop and whenever a job ends, so a study never
 * waits on a page that is gone.
 */
export async function continueStudies(ctx: AppContext, log: (msg: string) => void = () => {}): Promise<number> {
  const waiting = await listJobs(ctx.store, { kind: 'study', status: 'waiting', limit: 20 });
  let moved = 0;
  for (const study of waiting) {
    const p = studyPayload(study);
    const children = await listJobs(ctx.store, { study: study.id, limit: 100 });
    if (children.some((c) => !TERMINAL_STATUSES.includes(c.status))) {
      const done = children.filter((c) => c.status === 'done').length;
      const detail = `${done}/${children.length} page(s) written`;
      if (p.steps.find((s) => s.name === 'pages')?.detail !== detail) {
        await updateJob(ctx.store, study.id, { payload: { ...study.payload, steps: setStep(p.steps, 'pages', 'running', detail) } });
      }
      continue;
    }
    const done = children.filter((c) => c.status === 'done').length;
    const steps = setStep(p.steps, 'pages', done ? 'done' : 'failed', `${done}/${children.length} page(s) written`);
    // a fresh attempt count: the report gets its own retry; its outline is the brief's, closed by the sources heading
    const sections = [...p.brief.report.sections, sourcesHeading(p.brief.language)];
    await updateJob(ctx.store, study.id, { status: 'queued', attempts: 0, payload: { ...study.payload, stage: 'report', sections, steps: setStep(steps, 'report', 'pending') } });
    log(`study ${study.id}: ${done}/${children.length} page(s) written — report queued`);
    moved++;
  }
  return moved;
}

/** The report stage's bookkeeping once the runner has written it. */
export async function markStudyReport(ctx: AppContext, job: ResearchJob): Promise<void> {
  const p = studyPayload(job);
  const ok = job.status === 'done';
  await updateJob(ctx.store, job.id, {
    payload: { ...job.payload, stage: ok ? 'done' : p.stage, steps: setStep(p.steps, 'report', ok ? 'done' : job.status === 'queued' ? 'pending' : 'failed', ok ? job.outputPath ?? undefined : job.error?.slice(0, 200) ?? undefined) },
  });
}
