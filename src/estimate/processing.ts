import { KnodeConfig, LlmConfig, processingSettings, resolveRoutedLlmConfig, routeTargets } from '../config.js';
import { LLM_WIKI_INPUT_CHARS } from '../constants.js';
import { buildExtractRequest } from '../graph/llm-extract.js';
import { loadOntology } from '../graph/ontology.js';
import { extractionSegmentChars } from '../graph/tier1.js';
import { localJudgeSpec, localSummarySpec, localTranslateSpec, localWorkerSpecs } from '../labeling/local.js';
import { contentLanguages, languageInfo } from '../lang/languages.js';
import { dueTranslations, translationSegmentChars } from '../lang/translate.js';
import { renderCliPrompt } from '../llm/cli.js';
import { LlmClient } from '../llm/client.js';
import { estimateTokens } from '../llm/tokens.js';
import { Store } from '../store/db.js';
import { summaryPagesByDocument } from '../wiki/pages.js';
import { summaryAfterExtraction, summaryMaxSegments, summaryMinChars } from '../wiki/summary.js';
import { DEFAULT_SHARES, WorkerStatus } from '../work/broker.js';
import { offeredRemotely } from '../work/config.js';
import { isSharedKind, SHARED_KINDS, SharedKind } from '../work/kinds.js';
import { costWork, EstimateLine, RouteSpec, serviceShares, TaskEstimate, totalsOf, WorkSpec } from './estimate.js';
import { CallLedger } from './ledger.js';
import { QuotaSources } from './quota.js';
import { modelOfLabel, serviceOfLabel, serviceOfLlm } from './services.js';

/**
 * What starting the processing would take (docs/design/18): extracting every
 * document in the queue, writing the summary pages that are due and those its
 * documents will be due once extracted, the judge calls of the duplicate
 * reviews in between, and — with content languages on — the translations
 * due (docs/design/17) — on this machine's slots, which start, and on the
 * remote workers already taking work, which share it.
 *
 * Counting reads only the index: the queue's segment counts, the chunks'
 * token counts (each chunk's tokens were counted when it was indexed), the
 * summary pages that exist. Nothing is opened, planned or written.
 */

export interface ProcessingEstimateInput {
  store: Store;
  config: KnodeConfig;
  ledger: Pick<CallLedger, 'route' | 'stats'> | null;
  /** Every worker the broker saw (src/work/broker.ts): remote ones already take work. */
  workers: WorkerStatus[];
  quota: QuotaSources;
  /** Whether the caller may see an account's credits balance. */
  showBalance?: boolean;
  now?: number;
}

/** A remote worker counts as taking work when it asked for some this recently. */
const REMOTE_SEEN_MS = 10 * 60_000;
/** Tokens a call adds for the entities it is told the graph already knows (up to 30 names). */
const KNOWN_ENTITY_TOKENS = 350;
/** Output per call before any is measured: entities, relations and claims with reasoning (src/graph/tier1.ts). */
const EXTRACT_OUTPUT_TOKENS = 4_500;
/** A summary call's instructions and link vocabulary; a merge reads each part's summary. */
const SUMMARY_SYSTEM_TOKENS = 700;
const SUMMARY_PART_TOKENS = 450;
const SUMMARY_OUTPUT = { single: 1_200, part: 900, merge: 1_500 } as const;
const JUDGE = { prompt: 1_500, output: 400 } as const;
/** About this many UTF-8 bytes per token: a CJK character is 3 bytes and 0.6 of a token, four Latin letters one. */
const BYTES_PER_TOKEN = 4.4;
/** Segments are cut at headings and paragraphs, short of `segmentChars`, until the queue says how short. */
const SEGMENT_FILL = 0.8;
const TOKENS_PER_CHAR = 0.3;
/** A translation call's instructions; its answer runs about as long as its text, in tokens, whichever way it goes. */
const TRANSLATE_SYSTEM_TOKENS = 400;
/** Tokens per character of the text a translation reads: CJK about 0.6, Latin script about a quarter. */
const translationTokensPerChar = (language: string) => (/^(zh|ja|ko)/.test(language) ? 0.6 : 0.25);

export async function estimateProcessing(input: ProcessingEstimateInput): Promise<TaskEstimate> {
  const { store, config } = input;
  const now = input.now ?? Date.now();
  const notes: string[] = [];
  const overlapShare = chunkOverlapShare(config);

  /* ---------------------------- extraction ---------------------------- */
  const queue = await store.query<{ segments_total: number; segments_done: number; chars: number | null; chunks: number; tokens: string | number }>(
    `SELECT q.segments_total, q.segments_done, d.chars, count(c.id)::int AS chunks, COALESCE(sum(c.token_count), 0)::bigint AS tokens
     FROM extraction_queue q
     JOIN documents d ON d.id = q.document_id
     LEFT JOIN chunks c ON c.document_id = q.document_id
     WHERE q.tier = 1 AND d.status = 'indexed'
     GROUP BY q.document_id, q.segments_total, q.segments_done, d.chars`,
  );
  const textTokens = (r: { chunks: number; tokens: string | number }) => Number(r.tokens) * (1 - overlapShare(r.chunks));
  // how many text tokens a segment holds here, from the documents the queue has already cut
  const planned = queue.filter((r) => r.segments_total > 1);
  const plannedTokens = planned.reduce((n, r) => n + textTokens(r), 0);
  const plannedSegments = planned.reduce((n, r) => n + r.segments_total, 0);
  const tokensPerSegment = plannedSegments > 0 && plannedTokens > 0
    ? plannedTokens / plannedSegments
    : extractionSegmentChars(config) * SEGMENT_FILL * TOKENS_PER_CHAR;
  let segments = 0;
  let segmentTokens = 0;
  for (const r of queue) {
    const tokens = textTokens(r);
    if (r.segments_total > 0) {
      const left = Math.max(0, r.segments_total - r.segments_done);
      segments += left;
      segmentTokens += tokens * (left / r.segments_total);
    } else {
      segments += Math.max(1, Math.ceil(tokens / tokensPerSegment));
      segmentTokens += tokens;
    }
  }
  const template = extractTemplate(store.dataDir, config);
  const extract: WorkSpec = {
    kind: 'extract', label: 'Extraction', calls: segments,
    promptTokens: segments ? segmentTokens / segments + template.tokens + KNOWN_ENTITY_TOKENS : 0,
    promptBytes: segments ? (segmentTokens / segments + KNOWN_ENTITY_TOKENS) * BYTES_PER_TOKEN + template.bytes : 0,
    outputTokens: EXTRACT_OUTPUT_TOKENS,
  };

  /* ---------------------------- summaries ---------------------------- */
  const minChars = summaryMinChars(config);
  const maxSegments = summaryMaxSegments(config);
  const docs = await store.query<{ path: string; chars: number | null; chunks: number; tokens: string | number; queued: boolean }>(
    `SELECT d.path, d.chars, count(c.id)::int AS chunks, COALESCE(sum(c.token_count), 0)::bigint AS tokens,
            EXISTS (SELECT 1 FROM extraction_queue q WHERE q.document_id = d.id) AS queued
     FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
     WHERE d.root = 'docs' AND d.status = 'indexed' AND d.kind = 'source'
     GROUP BY d.id, d.path, d.chars`,
  );
  const pages = await summaryPagesByDocument(store);
  // a document indexed before its length was kept is measured by its chunks
  const known = docs.filter((d) => d.chars !== null && Number(d.tokens) > 0);
  const tokensPerChar = known.length ? known.reduce((n, d) => n + textTokens(d), 0) / known.reduce((n, d) => n + d.chars!, 0) : TOKENS_PER_CHAR;
  const summary = { now: 0, later: 0, calls: 0, prompt: 0, output: 0 };
  // a workspace that writes summaries before extraction (`summaryAfterExtraction: false`) has its queued documents due now
  const waits = summaryAfterExtraction(config);
  for (const d of docs) {
    const page = pages.get(d.path);
    if (page && page.status !== 'dirty') continue;
    const tokens = textTokens(d);
    const chars = d.chars ?? tokens / Math.max(0.05, tokensPerChar);
    if (chars < minChars || tokens <= 0) continue;
    if (d.queued && waits) summary.later++;
    else summary.now++;
    if (chars <= LLM_WIKI_INPUT_CHARS) {
      summary.calls += 1;
      summary.prompt += tokens + SUMMARY_SYSTEM_TOKENS;
      summary.output += SUMMARY_OUTPUT.single;
    } else {
      const parts = Math.min(maxSegments, Math.max(2, Math.ceil(tokens / tokensPerSegment)));
      const read = Math.min(tokens, parts * tokensPerSegment);
      summary.calls += parts + 1;
      summary.prompt += read + parts * SUMMARY_SYSTEM_TOKENS + parts * SUMMARY_PART_TOKENS + SUMMARY_SYSTEM_TOKENS;
      summary.output += parts * SUMMARY_OUTPUT.part + SUMMARY_OUTPUT.merge;
    }
  }
  const summarize: WorkSpec = {
    kind: 'summarize', label: 'Summary pages', calls: summary.calls,
    promptTokens: summary.calls ? summary.prompt / summary.calls : 0,
    promptBytes: summary.calls ? (summary.prompt / summary.calls) * BYTES_PER_TOKEN : 0,
    outputTokens: summary.calls ? summary.output / summary.calls : 0,
  };

  /* ---------------------------- judge calls ---------------------------- */
  // how many judge calls an extraction call has led to here before, if any has
  const stats = input.ledger?.stats() ?? [];
  const sum = (kind: string, f: (s: (typeof stats)[number]) => number) => stats.filter((s) => s.kind === kind).reduce((n, s) => n + f(s), 0);
  const extractedBefore = sum('extract', (s) => s.ok);
  const judgedBefore = sum('judge', (s) => s.calls);
  const judgePrompt = sum('judge', (s) => s.promptTokens) / Math.max(1, sum('judge', (s) => s.ok));
  const judge: WorkSpec = {
    kind: 'judge', label: 'Duplicate reviews', calls: 0,
    promptTokens: judgePrompt || JUDGE.prompt, promptBytes: (judgePrompt || JUDGE.prompt) * BYTES_PER_TOKEN, outputTokens: JUDGE.output,
  };
  const judging = config.review?.llmJudge !== 'off' || config.review?.claims === 'suggest';
  if (judging && extractedBefore >= 20) judge.calls = Math.round((judgedBefore / extractedBefore) * segments);
  else if (judging && segments > 0) notes.push('The duplicate reviews add judge calls as extraction finds candidates; they are not counted until a run here has measured how many.');

  /* ---------------------------- translations ---------------------------- */
  // what the Translate stage would hand out now: requests first, then what is foreign to the primary language
  const languages = contentLanguages(config);
  const translation = { docs: 0, calls: 0, prompt: 0, output: 0 };
  if (languages.on) {
    const { due } = await dueTranslations(store, languages, { limit: 1_000_000 });
    // a document indexed before its length was kept is measured by its chunks, as extraction and summaries are
    const unsized = due.filter((d) => d.doc.chars === null || d.doc.chars === undefined).map((d) => d.doc.id);
    const measured = new Map((unsized.length ? await store.query<{ id: string; chunks: number; tokens: string | number }>(
      `SELECT document_id AS id, count(*)::int AS chunks, COALESCE(sum(token_count), 0)::bigint AS tokens FROM chunks WHERE document_id = ANY($1::text[]) GROUP BY document_id`,
      [unsized],
    ) : []).map((r) => [r.id, r]));
    for (const { doc } of due) {
      const source = doc.language || 'en';
      const perChar = translationTokensPerChar(source);
      const chunks = measured.get(doc.id);
      const text = typeof doc.chars === 'number' ? doc.chars * perChar : chunks ? textTokens(chunks) : 0;
      if (text <= 0) continue;
      const chars = typeof doc.chars === 'number' ? doc.chars : text / perChar;
      const calls = Math.max(1, Math.ceil(chars / (translationSegmentChars(source) * SEGMENT_FILL)));
      translation.docs++;
      translation.calls += calls;
      translation.prompt += text + calls * TRANSLATE_SYSTEM_TOKENS;
      translation.output += text;
    }
  }
  const translate: WorkSpec = {
    kind: 'translate', label: 'Translations', calls: translation.calls,
    promptTokens: translation.calls ? translation.prompt / translation.calls : 0,
    promptBytes: translation.calls ? (translation.prompt / translation.calls) * BYTES_PER_TOKEN : 0,
    outputTokens: translation.calls ? translation.output / translation.calls : 0,
  };

  /* ------------------------------ routes ------------------------------ */
  const targets = routeTargets(config);
  // no stage here runs more calls at once than the machine's cap, every stage together (src/labeling/local.ts)
  const cap = processingSettings(config).maxLocalCalls;
  const local = (specs: ({ slots: number; llm: LlmConfig } | null)[]): RouteSpec[] =>
    specs.flatMap((s) => {
      if (!s) return [];
      const client = new LlmClient(s.llm);
      const slots = cap > 0 ? Math.min(s.slots, cap) : s.slots;
      return client.enabled ? [{ route: client.label, service: serviceOfLlm(s.llm), model: s.llm.model, slots, remote: false }] : [];
    });
  const remote = remoteRoutes(input.workers, config, now);
  const routes: Record<RemoteKind, RouteSpec[]> = {
    extract: [...local(localWorkerSpecs(config)), ...remote.extract],
    summarize: [...local([localSummarySpec(config)]), ...remote.summarize],
    judge: [...local([localJudgeSpec(config)]), ...remote.judge],
    translate: [...local([localTranslateSpec(config)]), ...remote.translate],
  };
  const stage = (llm: LlmConfig): RouteSpec => {
    const client = new LlmClient(llm);
    return { route: client.label, service: serviceOfLlm(llm), model: llm.model, slots: 0, remote: false };
  };
  const waiting = {
    extract: stage(resolveRoutedLlmConfig(config.llm, config.extraction.entityLlm, targets, config.extraction.tier1Model)),
    summarize: stage(resolveRoutedLlmConfig(config.llm, config.extraction.summaryLlm, targets)),
    judge: stage(resolveRoutedLlmConfig(config.llm, config.extraction.judgeLlm, targets)),
    translate: stage(resolveRoutedLlmConfig(config.llm, config.extraction.translateLlm, targets)),
  };

  const lines: EstimateLine[] = [
    ...costWork(extract, routes.extract, input.ledger, config, waiting.extract),
    ...costWork(summarize, routes.summarize, input.ledger, config, waiting.summarize),
    ...costWork(judge, routes.judge, input.ledger, config, waiting.judge),
    ...costWork(translate, routes.translate, input.ledger, config, waiting.translate),
  ];
  for (const [kind, label] of [['extract', 'Extraction'], ['summarize', 'Summary pages'], ['judge', 'Judge calls'], ['translate', 'Translations']] as const) {
    if (lines.some((l) => l.kind === kind && l.slots === 0)) {
      notes.push(`${label}: no slot takes this work now — this machine has none for it and no remote worker asked lately — so it waits, and the time leaves it out.`);
    }
  }
  if (cap > 0 && new Set(lines.filter((l) => !l.remote && l.slots > 0).map((l) => l.kind)).size > 1) {
    notes.push(`This machine runs at most ${cap} model call${cap === 1 ? '' : 's'} at once, every stage together: stages that have work at the same time share them, so they take longer than each one's time says.`);
  }
  if (lines.some((l) => l.remote)) notes.push('Remote workers that asked for work in the last ten minutes take part of it, whether or not processing runs here; their calls are paid from their own machines\' logins, counted here under the same services.');

  const [codex, cursorPlan] = await Promise.all([
    lines.some((l) => l.service === 'codex') ? input.quota.codex() : Promise.resolve(null),
    lines.some((l) => l.service === 'cursor') ? input.quota.cursorPlan() : Promise.resolve(null),
  ]);

  const queuedDocs = queue.length;
  const work: TaskEstimate['work'] = [
    { label: 'Extraction', detail: queuedDocs ? `${fmt(queuedDocs)} documents waiting · ${fmt(segments)} segments, one call each` : 'nothing waiting' },
    { label: 'Summary pages', detail: summary.now + summary.later ? `${fmt(summary.now)} due now${summary.later ? ` · ${fmt(summary.later)} more once extracted` : ''} · ${fmt(summary.calls)} calls` : 'none due' },
  ];
  if (judge.calls) work.push({ label: 'Duplicate reviews', detail: `about ${fmt(judge.calls)} judge calls, at the rate earlier runs here needed them` });
  if (translation.calls) {
    const into = languages.primary ? languageInfo(languages.primary)?.english ?? languages.primary : '';
    work.push({ label: 'Translations', detail: `${fmt(translation.docs)} document${translation.docs === 1 ? '' : 's'} due${into ? `, into ${into} first` : ''} · about ${fmt(translation.calls)} calls, one per segment` });
  }

  return {
    task: 'processing',
    title: 'Processing',
    at: new Date(now).toISOString(),
    work,
    lines,
    totals: totalsOf(lines, summary.later ? { summarize: 'extract' } : {}),
    services: serviceShares(lines, { config, codex, cursorPlan, stats, showBalance: input.showBalance ?? false }),
    notes,
  };
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/**
 * Of a document's chunk tokens, the share that is overlap: each chunk after
 * the first repeats `chunkOverlap` characters of the one before.
 */
function chunkOverlapShare(config: KnodeConfig): (chunks: number) => number {
  const size = Math.max(1, config.ingest.chunkSize);
  const overlap = Math.max(0, Math.min(config.ingest.chunkOverlap, size - 1));
  return (chunks) => (chunks > 1 ? ((chunks - 1) * overlap) / (chunks * size) : 0);
}

/** The instructions an extraction call carries beside its segment, for this workspace's ontology and claims setting. */
function extractTemplate(dataDir: string, config: KnodeConfig): { tokens: number; bytes: number } {
  const request = buildExtractRequest({ path: 'raw/docs/x.md', title: 'x' }, '', {
    claims: config.extraction.claims,
    ontology: loadOntology(dataDir, config.graph?.ontologyPacks),
    segment: { index: 1, total: 2, heading: null },
    docDate: null,
  });
  const prompt = renderCliPrompt(request.messages, true);
  return { tokens: estimateTokens(prompt), bytes: Buffer.byteLength(prompt) };
}

/**
 * The remote workers taking work: those that asked within ten minutes, by
 * backend and kind. A worker's slot that takes extraction and summaries both
 * splits its time by `server.remote.shares`; judge calls go first and are few.
 */
type RemoteKind = 'extract' | 'summarize' | 'judge' | 'translate';

function remoteRoutes(workers: WorkerStatus[], config: KnodeConfig, now: number): Record<RemoteKind, RouteSpec[]> {
  const shares = { ...DEFAULT_SHARES, ...(config.server.remote?.shares ?? {}) };
  const out: Record<RemoteKind, Map<string, RouteSpec>> = { extract: new Map(), summarize: new Map(), judge: new Map(), translate: new Map() };
  for (const w of workers) {
    if (!w.remote || now - Date.parse(w.lastSeen) > REMOTE_SEEN_MS) continue;
    const shared = w.kinds.filter(isSharedKind);
    const weight = shared.reduce((n, k) => n + (shares[k] ?? 1), 0) || 1;
    for (const kind of w.kinds) {
      if (kind !== 'extract' && kind !== 'summarize' && kind !== 'judge' && kind !== 'translate') continue;
      if (!offeredRemotely(config, kind)) continue;
      const share = (SHARED_KINDS as readonly string[]).includes(kind) ? (shares[kind as SharedKind] ?? 1) / weight : 1;
      const r = out[kind].get(w.backend) ?? { route: w.backend, service: serviceOfLabel(w.backend), model: modelOfLabel(w.backend), slots: 0, remote: true, share };
      r.slots++;
      out[kind].set(w.backend, r);
    }
  }
  return { extract: [...out.extract.values()], summarize: [...out.summarize.values()], judge: [...out.judge.values()], translate: [...out.translate.values()] };
}
