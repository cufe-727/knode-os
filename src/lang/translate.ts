import fs from 'node:fs';
import { safePath } from '../fs/files.js';
import { readTranslation, readTranslationParts, TranslationCache, TranslationPart, writeTranslation, writeTranslationPart } from '../fs/sidecar.js';
import { Segment, segmentText } from '../graph/segment.js';
import { isDerivedTextSource, loadSourceText } from '../ingest/source.js';
import { ChatMessage, LlmClient } from '../llm/client.js';
import { Queryable } from '../store/migrations.js';
import { DocumentRow } from '../types.js';
import { detectLanguage, detectTextLanguage, scriptCounts, wordCount } from './detect.js';
import { ContentLanguages, contentLanguages, languageInfo, promptLanguage, sameLanguage } from './languages.js';
import { protectSpans, restoreSpans } from './protect.js';
import { parseFrontmatter } from '../markdown.js';

/**
 * The Translate stage (docs/design/17): what a model is asked to translate,
 * and what is made of its answers. Shared by the leased work source
 * (src/work/translate.ts) and the one-shot runner behind `knode-os translate`,
 * so a translation comes out the same whoever ran the calls.
 *
 * What is translated is a document's indexed text — the file itself for
 * Markdown and text, the Markdown knode-os derived for a PDF, a picture or a
 * web page; the original is never touched. The text's frontmatter stays as
 * it is, and the body is cut into segments with the extraction segmenter
 * (content-defined cuts, so an edit moves only the cuts next to it), one call
 * each, its links, anchors and code held out of the model's reach
 * (src/lang/protect.ts). A segment's translation is kept by the hash of the
 * segment: a digest that grows every day pays only for its new segment, an
 * interrupted document resumes with what it has, and a reader sees the
 * translated segments while the rest is still out. Once every segment is in,
 * the whole translation is written beside them.
 *
 * Progress lives in the `translations` table — a row per document and
 * language, for the content it translated — so the stage's scan finds what
 * is due without opening a sidecar per document, and a file view can say how
 * far a translation got. The table is derived: a rebuild loses it and the
 * scan writes it again from the sidecars.
 */

/**
 * Data, not prose: indexed as text, but a translation would only garble its
 * keys and values — and a CSV of backtest numbers reads as any language its
 * column names happen to suggest. Everything else under raw/docs is prose or
 * the Markdown converted from a PDF, a picture or a page.
 */
const DATA_FILE = /\.(json|jsonl|ya?ml|csv|tsv|xml)$/i;
const DATA_FILE_SQL = `lower(d.path) !~ '\\.(json|jsonl|ya?ml|csv|tsv|xml)$'`;

export function isDataFile(rel: string): boolean {
  return DATA_FILE.test(rel);
}

/**
 * What a reader may have translated: the sources under raw/docs, and wiki
 * pages. A wiki page is translated only on request — it is mostly written in
 * the primary language already, and its summary pages are (D9) — so only
 * raw/docs sources are translated into the primary language in the background.
 */
const TRANSLATABLE_SQL = `((d.root = 'docs' AND d.kind = 'source') OR d.root = 'wiki')`;

/** The indexed document at `path` a translation can be asked for, data files among them (`isDataFile` says which); null for any other. */
export async function translatableDocument(q: Queryable, path: string): Promise<DocumentRow | null> {
  const [doc] = await q.query<DocumentRow>(`SELECT d.* FROM documents d WHERE d.path = $1 AND d.status = 'indexed' AND ${TRANSLATABLE_SQL}`, [path]);
  return doc ?? null;
}

/** A document's attempts at a translation of its current content before the stage gives up on it until it changes. */
export const MAX_TRANSLATE_ATTEMPTS = 3;
/** Output budget of one call: a segment's translation runs about as long as the segment, in tokens. */
export const TRANSLATE_MAX_TOKENS = 16_000;

/**
 * Characters one call translates. A CJK character carries about a word, so a
 * Chinese or Japanese segment is cut shorter for about the same amount of text
 * — and about the same length of answer — as an English one.
 */
export function translationSegmentChars(source: string): number {
  return /^(zh|ja|ko)/.test(source) ? 4_000 : 8_000;
}

export type TranslationStatus = 'requested' | 'partial' | 'done' | 'failed' | 'skipped';

export interface TranslationRow {
  document_id: string;
  language: string;
  content_sha: string;
  status: TranslationStatus;
  parts: number;
  done: number;
  attempts: number;
  requested: boolean;
  model: string | null;
  error: string | null;
  updated_at: string;
}

export type TranslationDoc = Pick<DocumentRow, 'id' | 'path' | 'root' | 'sha256'> & Partial<Pick<DocumentRow, 'title' | 'chars' | 'language'>>;

/* -------------------------------- plans --------------------------------- */

/** One document's translation into one language, planned: what to send, what is in already. */
export interface TranslationWork {
  doc: TranslationDoc;
  source: string;
  target: string;
  /** The frontmatter block a reader sees on the original, kept verbatim ahead of the translated body; '' when it has none. */
  frontmatter: string;
  /** The body, cut for translation. */
  segments: Segment[];
  /** Translated segments the sidecar holds, by segment hash. */
  cached: Map<string, TranslationPart>;
}

export type TranslationPlan =
  | ({ kind: 'work' } & TranslationWork)
  | { kind: 'none'; reason: 'no-text' | 'no-language' | 'same-language' | 'empty' | 'data'; source: string | null };

const FRONTMATTER_BLOCK = /^﻿?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** A text as its frontmatter block (verbatim) and the body after it. */
export function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const m = FRONTMATTER_BLOCK.exec(text);
  return m ? { frontmatter: m[0], body: text.slice(m[0].length) } : { frontmatter: '', body: text };
}

/**
 * The frontmatter a reader sees on the original: a text file's own — the
 * indexed text carries the OKF lines normalization adds (src/okf/normalize.ts),
 * which only ever adds to the frontmatter, so the body is the same — and the
 * derived Markdown's for a converted source.
 */
function readerFrontmatter(dataDir: string, doc: TranslationDoc, indexed: string): string {
  if (!isDerivedTextSource(doc.path)) {
    try {
      return splitFrontmatter(fs.readFileSync(safePath(dataDir, doc.path), 'utf8')).frontmatter;
    } catch {
      // gone since it was indexed: the indexed text's own will do
    }
  }
  return splitFrontmatter(indexed).frontmatter;
}

/** What translating `doc` into `target` takes, from its current indexed text. */
export function planTranslation(dataDir: string, doc: TranslationDoc, target: string): TranslationPlan {
  if (isDataFile(doc.path)) return { kind: 'none', reason: 'data', source: null };
  const loaded = loadSourceText(dataDir, doc.path, doc.root);
  if (!loaded) return { kind: 'none', reason: 'no-text', source: null };
  const source = detectLanguage(loaded.text, parseFrontmatter(loaded.text).frontmatter);
  if (!source) return { kind: 'none', reason: 'no-language', source: null };
  if (sameLanguage(source, target)) return { kind: 'none', reason: 'same-language', source };
  const { body } = splitFrontmatter(loaded.text);
  if (!body.trim()) return { kind: 'none', reason: 'empty', source };
  const frontmatter = readerFrontmatter(dataDir, doc, loaded.text);
  const segments = segmentText(body, translationSegmentChars(source));
  const parts = readTranslationParts(dataDir, doc.path, target);
  const cached = new Map<string, TranslationPart>();
  for (const s of segments) {
    const part = parts.get(s.sha);
    if (part) cached.set(s.sha, part);
  }
  return { kind: 'work', doc, source, target, frontmatter, segments, cached };
}

/** The segments still to translate. */
export function pendingSegments(work: TranslationWork): Segment[] {
  return work.segments.filter((s) => !work.cached.has(s.sha));
}

export function segmentLabel(work: TranslationWork, segment: Segment): string {
  const part = work.segments.length > 1 ? ` (part ${segment.index + 1} of ${work.segments.length})` : '';
  return `${work.doc.path} → ${work.target}${part}`;
}

/* ------------------------------- requests ------------------------------- */

export interface TranslationRequest {
  messages: ChatMessage[];
  maxTokens: number;
  /** What the request's tokens stand for (src/lang/protect.ts). */
  spans: string[];
}

const TEXT_MARK = '=== TEXT ===';

/** The call that translates one segment. */
export function translationRequest(work: TranslationWork, segment: Segment): TranslationRequest {
  const target = promptLanguage(work.target);
  const source = promptLanguage(work.source);
  const { text, spans } = protectSpans(segment.text.trim());
  const part = work.segments.length > 1 ? `This is part ${segment.index + 1} of ${work.segments.length} of the document.` : '';
  const system = [
    `You translate documents of a knowledge base from ${source} into ${target}. ${part}`.trim(),
    '',
    `Translate everything a reader reads — headings, paragraphs, list items, table cells, quotations, the text of links and images — completely and faithfully. Do not summarize, shorten, add, explain or comment.`,
    `Keep the Markdown exactly as it is: the same headings, lists, tables, emphasis, blank lines and line breaks, in the same order.`,
    `Tokens such as ⟦12⟧ stand for links, anchors, code and markup that must stay unchanged: copy every token exactly as it is, once, where it belongs in the translated text.`,
    `Write names of people, companies, products and places the way ${target} texts usually do; a name with no common ${target} form stays as it is. Numbers, dates, amounts, tickers and units stay exact. Text already in ${target} stays as it is.`,
    `Answer with the translated text only: no preamble, no notes, no code fence around it.`,
  ].join('\n');
  const heading = segment.heading ? ` It continues the section “${segment.heading}”.` : '';
  const user = `Document: ${work.doc.path}.${heading}\nTranslate the text after the line ${TEXT_MARK} into ${target}.\n\n${TEXT_MARK}\n${text}`;
  return {
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    maxTokens: TRANSLATE_MAX_TOKENS,
    spans,
  };
}

export type FinishedSegment = { ok: true; body: string } | { ok: false; error: string };

/** Unwrap what models wrap an answer in: a code fence around the whole of it, the marker the text came after. */
function unwrapAnswer(answer: string, sourceText: string): string {
  let a = answer.trim();
  if (a.startsWith(TEXT_MARK)) a = a.slice(TEXT_MARK.length).trim();
  const fenced = /^(```|~~~)[\w-]*\n([\s\S]*?)\n\1\s*$/.exec(a);
  if (fenced && !/^\s*(```|~~~)/.test(sourceText)) a = fenced[2].trim();
  return a;
}

/**
 * A segment's translation from the model's answer: the tokens swapped back,
 * the original's surrounding whitespace kept — or why the answer will not do.
 * A translation that lost a token would lose a link or a cited anchor; one
 * much shorter than the text left something out; one still in the source
 * language translated nothing.
 */
export function finishSegment(work: TranslationWork, segment: Segment, spans: string[], answer: string): FinishedSegment {
  const unwrapped = unwrapAnswer(answer, segment.text);
  if (!unwrapped) return { ok: false, error: 'the model answered with an empty translation' };
  const { text, missing } = restoreSpans(unwrapped, spans);
  if (missing.length > 0) {
    return { ok: false, error: `the translation lost ${missing.length} of the ${spans.length} links, anchors and code spans it was to keep` };
  }
  const prose = (s: string) => wordCount(scriptCounts(protectSpans(s).text.replace(/⟦\d+⟧/g, ' ')));
  const before = prose(segment.text);
  const after = prose(text);
  if (before >= 40 && after < before * 0.3) {
    return { ok: false, error: `the translation is much shorter than the text (about ${Math.round(after)} words for ${Math.round(before)})` };
  }
  if (before >= 80) {
    const got = detectTextLanguage(text);
    if (got && !sameLanguage(got, work.target) && sameLanguage(got, work.source)) {
      return { ok: false, error: `the answer is still in ${languageInfo(work.source)?.english ?? work.source}` };
    }
  }
  const lead = /^\s*/.exec(segment.text)![0];
  const trail = /\s*$/.exec(segment.text)![0];
  return { ok: true, body: `${lead}${text.trim()}${trail}` };
}

/* ------------------------------- assembly ------------------------------- */

export interface AssembledTranslation {
  /** The translated text; a segment not yet translated reads as the original. */
  text: string;
  done: number;
  parts: number;
}

export function assembleTranslation(work: TranslationWork): AssembledTranslation {
  let done = 0;
  const body = work.segments.map((s) => {
    const part = work.cached.get(s.sha);
    if (!part) return s.text;
    done++;
    return part.body;
  }).join('');
  // a file with no frontmatter of its own was indexed behind the block normalization adds and the blank line after it
  return { text: work.frontmatter ? work.frontmatter + body : body.replace(/^\r?\n/, ''), done, parts: work.segments.length };
}

/** The models a translation's parts came from, once each. */
export function partModels(work: TranslationWork): string {
  return [...new Set(work.segments.map((s) => work.cached.get(s.sha)?.model).filter((m): m is string => Boolean(m)))].join(', ');
}

/**
 * Record one translated segment, and the whole translation once it is
 * complete. Returns how far the document's translation is.
 */
export function storeSegment(dataDir: string, work: TranslationWork, segment: Segment, body: string, model: string, at = new Date()): AssembledTranslation & { complete: boolean } {
  const part: TranslationPart = { body, model, generatedAt: at.toISOString() };
  writeTranslationPart(dataDir, work.doc.path, work.target, segment.sha, part, work.segments.map((s) => s.sha));
  // other workers' segments of the same document may have landed since this plan was made
  const parts = readTranslationParts(dataDir, work.doc.path, work.target);
  work.cached.clear();
  for (const s of work.segments) {
    const p = parts.get(s.sha);
    if (p) work.cached.set(s.sha, p);
  }
  const assembled = assembleTranslation(work);
  const complete = assembled.done === assembled.parts;
  if (complete) {
    const cache: TranslationCache = {
      contentSha: work.doc.sha256, source: work.source, language: work.target, model: partModels(work),
      generatedAt: at.toISOString(), parts: assembled.parts, body: assembled.text,
    };
    writeTranslation(dataDir, work.doc.path, cache);
  }
  return { ...assembled, complete };
}

/* ------------------------------ the table ------------------------------- */

export async function translationRows(q: Queryable, documentId: string): Promise<TranslationRow[]> {
  return q.query<TranslationRow>(`SELECT * FROM translations WHERE document_id = $1 ORDER BY language`, [documentId]);
}

export async function translationRow(q: Queryable, documentId: string, language: string): Promise<TranslationRow | null> {
  const [row] = await q.query<TranslationRow>(`SELECT * FROM translations WHERE document_id = $1 AND language = $2`, [documentId, language]);
  return row ?? null;
}

/**
 * Where a document's translation into `language` stands now. `attempts`
 * counts on the same content and starts over on new content; `requested`
 * stays once someone asked, whatever the content does.
 */
export async function recordTranslationState(
  q: Queryable,
  doc: Pick<TranslationDoc, 'id' | 'sha256'>,
  language: string,
  state: { status: TranslationStatus; parts?: number; done?: number; failed?: boolean; requested?: boolean; model?: string | null; error?: string | null },
): Promise<void> {
  await q.query(
    `INSERT INTO translations (document_id, language, content_sha, status, parts, done, attempts, requested, model, error, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (document_id, language) DO UPDATE SET
       status = EXCLUDED.status,
       parts = EXCLUDED.parts,
       done = EXCLUDED.done,
       attempts = CASE WHEN translations.content_sha = EXCLUDED.content_sha THEN translations.attempts ELSE 0 END + EXCLUDED.attempts,
       requested = translations.requested OR EXCLUDED.requested,
       model = COALESCE(EXCLUDED.model, translations.model),
       error = EXCLUDED.error,
       content_sha = EXCLUDED.content_sha,
       updated_at = now()`,
    [doc.id, language, doc.sha256, state.status, state.parts ?? 0, state.done ?? 0, state.failed ? 1 : 0, state.requested ?? false, state.model ?? null, state.error ?? null],
  );
}

/** Forget that anyone asked for this translation: the stage then leaves it to the primary language's rule. */
export async function withdrawTranslationRequest(q: Queryable, documentId: string, language: string): Promise<void> {
  await q.query(`UPDATE translations SET requested = false WHERE document_id = $1 AND language = $2`, [documentId, language]);
}

/**
 * Fill in the language of documents indexed before the column existed
 * (schema v17), reading each text once — and its length where that was
 * never kept either (schema v15), from the same read, so the stage's size
 * limit and the estimates know it too. A cache fill, not a change of
 * record: a row an apply holds is left to it, and the next apply writes both
 * columns for good. '' records "no language". Says how many rows it read
 * and how many it filled.
 */
export async function backfillLanguages(q: Queryable, dataDir: string, limit = 500): Promise<{ read: number; filled: number }> {
  const rows = await q.query<Pick<DocumentRow, 'id' | 'path' | 'root' | 'sha256'>>(
    `SELECT id, path, root, sha256 FROM documents WHERE language IS NULL AND status = 'indexed' AND root = 'docs' AND kind = 'source' LIMIT $1`,
    [limit],
  );
  let filled = 0;
  for (const row of rows) {
    const loaded = loadSourceText(dataDir, row.path, row.root);
    const language = loaded ? detectLanguage(loaded.text, parseFrontmatter(loaded.text).frontmatter) ?? '' : '';
    const updated = await q.query<{ id: string }>(
      `UPDATE documents SET language = $2, chars = COALESCE(chars, $4::int)
       WHERE id IN (SELECT id FROM documents WHERE id = $1 AND sha256 = $3 AND language IS NULL FOR UPDATE SKIP LOCKED)
       RETURNING id`,
      [row.id, language, row.sha256, loaded ? loaded.text.length : null],
    );
    filled += updated.length;
  }
  return { read: rows.length, filled };
}

/** A document due a translation, and into which language. */
export interface DueTranslation {
  doc: DocumentRow;
  target: string;
  requested: boolean;
}

/**
 * The documents due a translation: someone's requests first (any offered
 * language, a wiki page too), then — for the primary language — every source
 * under raw/docs written in another language and no longer than `maxChars`,
 * the translations under way first, then the latest documents. Leaves out
 * what is translated for the current content and what failed on it too often.
 */
export async function dueTranslations(
  q: Queryable,
  languages: ContentLanguages,
  opts: { limit: number; exclude?: ReadonlySet<string> },
): Promise<{ due: DueTranslation[]; count: number }> {
  if (!languages.on || !languages.primary) return { due: [], count: 0 };
  const settled = `(t.content_sha = d.sha256 AND (t.status IN ('done', 'skipped') OR (t.status = 'failed' AND t.attempts >= ${MAX_TRANSLATE_ATTEMPTS})))`;
  const asked = `${TRANSLATABLE_SQL} AND d.status = 'indexed' AND ${DATA_FILE_SQL}`;
  const live = `d.root = 'docs' AND d.status = 'indexed' AND d.kind = 'source' AND ${DATA_FILE_SQL}`;
  const wanted = Math.max(1, opts.limit) + (opts.exclude?.size ?? 0);
  const requested = await q.query<DocumentRow & { t_language: string }>(
    `SELECT d.*, t.language AS t_language FROM translations t JOIN documents d ON d.id = t.document_id
     WHERE t.requested AND t.language = ANY($1::text[]) AND ${asked} AND NOT ${settled}
     ORDER BY t.updated_at, d.path
     LIMIT $2`,
    [languages.offered, wanted],
  );
  const primary = languages.primary;
  const foreign = `d.language IS NOT NULL AND d.language <> '' AND split_part(d.language, '-', 1) <> split_part($1, '-', 1)`;
  const sized = `($2::int <= 0 OR d.chars IS NULL OR d.chars <= $2::int)`;
  const where = `${live} AND ${foreign} AND ${sized} AND (t.document_id IS NULL OR NOT (${settled} OR t.requested))`;
  const [{ n }] = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM documents d LEFT JOIN translations t ON t.document_id = d.id AND t.language = $1 WHERE ${where}`,
    [primary, languages.maxChars],
  );
  const bulk = await q.query<DocumentRow>(
    `SELECT d.* FROM documents d LEFT JOIN translations t ON t.document_id = d.id AND t.language = $1
     WHERE ${where}
     ORDER BY COALESCE(t.status = 'partial', false) DESC, d.updated_at DESC, d.path
     LIMIT $3`,
    [primary, languages.maxChars, wanted],
  );
  const out: DueTranslation[] = [];
  const key = (path: string, target: string) => `${path}\u0000${target}`;
  for (const r of requested) {
    if (!opts.exclude?.has(key(r.path, r.t_language))) out.push({ doc: r, target: r.t_language, requested: true });
  }
  for (const d of bulk) {
    if (!opts.exclude?.has(key(d.path, primary))) out.push({ doc: d, target: primary, requested: false });
  }
  return { due: out.slice(0, Math.max(0, opts.limit)), count: requested.length + n };
}

/** What the file views say about a document's languages. */
export interface DocumentLanguages {
  /** The language the document is written in; null when it has none (or is not indexed yet). */
  source: string | null;
  primary: string | null;
  /** The languages a reader may pick: the workspace's offered ones, and the document's own. */
  offered: string[];
  /**
   * Whether the stage translates the document into the primary language by
   * itself (D6): a source under raw/docs in another language, no longer than
   * `maxChars`. Every other translation waits for someone to ask.
   */
  background: boolean;
  translations: Record<string, { status: TranslationStatus | 'none' | 'source'; parts: number; done: number; model?: string | null; generatedAt?: string | null; requested?: boolean; error?: string | null }>;
}

/** A document's languages as a file view shows them: none for a workspace with content languages off. */
export async function documentLanguages(q: Queryable, dataDir: string, config: { languages?: unknown }, path: string): Promise<DocumentLanguages | null> {
  const languages = contentLanguages(config);
  if (!languages.on || isDataFile(path)) return null;
  const doc = await translatableDocument(q, path);
  if (!doc) return null;
  let source = doc.language ?? null;
  if (source === null) {
    const loaded = loadSourceText(dataDir, doc.path, doc.root);
    source = loaded ? detectLanguage(loaded.text, parseFrontmatter(loaded.text).frontmatter) : null;
  }
  const rows = new Map((await translationRows(q, doc.id)).map((r) => [r.language, r]));
  // a workspace language the document is already written in is the document's own: a traditional-Chinese
  // workspace lists a simplified-Chinese document once, as its original
  const offered: string[] = [];
  for (const lang of [...languages.offered, ...(source ? [source] : [])]) {
    const code = source && sameLanguage(lang, source) ? source : lang;
    if (!offered.includes(code)) offered.push(code);
  }
  // the same rule as dueTranslations' background pass
  const background = doc.root === 'docs' && Boolean(source) && !sameLanguage(source, languages.primary)
    && (languages.maxChars <= 0 || doc.chars == null || doc.chars <= languages.maxChars);
  const out: DocumentLanguages = { source: source || null, primary: languages.primary, offered, background, translations: {} };
  for (const lang of offered) {
    if (source && sameLanguage(lang, source)) {
      out.translations[lang] = { status: 'source', parts: 0, done: 0 };
      continue;
    }
    const row = rows.get(lang);
    const cache = readTranslation(dataDir, doc.path, lang);
    if (cache && cache.contentSha === doc.sha256) {
      out.translations[lang] = { status: 'done', parts: cache.parts, done: cache.parts, model: cache.model, generatedAt: cache.generatedAt, requested: row?.requested ?? false };
    } else if (row && row.content_sha === doc.sha256) {
      out.translations[lang] = { status: row.status, parts: row.parts, done: row.done, model: row.model, generatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null, requested: row.requested, error: row.error };
    } else if (row?.requested) {
      out.translations[lang] = { status: 'requested', parts: 0, done: 0, requested: true };
    } else {
      out.translations[lang] = { status: 'none', parts: 0, done: 0 };
    }
  }
  return out;
}

/**
 * A document's text in `language` for a reader: the whole translation, or
 * what is in of one still under way with the original standing in for the
 * rest; null when nothing is translated yet.
 */
export function translatedText(dataDir: string, doc: TranslationDoc, language: string): (AssembledTranslation & { model: string }) | null {
  const cache = readTranslation(dataDir, doc.path, language);
  if (cache && cache.contentSha === doc.sha256) return { text: cache.body, done: cache.parts, parts: cache.parts, model: cache.model };
  const plan = planTranslation(dataDir, doc, language);
  if (plan.kind !== 'work' || plan.cached.size === 0) return null;
  return { ...assembleTranslation(plan), model: partModels(plan) };
}

/* ------------------------------- one-shot -------------------------------- */

/**
 * Translate a document here and now, segment after segment, on `llm` — for
 * `knode-os translate`, and for tests. Leased work goes through
 * src/work/translate.ts instead. Segments already translated are not paid
 * again; a segment whose answer will not do is tried `retries` more times.
 */
export async function translateNow(
  q: Queryable,
  dataDir: string,
  doc: TranslationDoc,
  target: string,
  llm: LlmClient,
  opts: { retries?: number; onProgress?: (msg: string) => void } = {},
): Promise<{ status: TranslationStatus | 'none'; reason?: string; done: number; parts: number; calls: number }> {
  const plan = planTranslation(dataDir, doc, target);
  if (plan.kind === 'none') {
    if (plan.reason === 'same-language' || plan.reason === 'no-language') await recordTranslationState(q, doc, target, { status: 'skipped' });
    return { status: 'none', reason: plan.reason, done: 0, parts: 0, calls: 0 };
  }
  let calls = 0;
  let progress = assembleTranslation(plan);
  for (const segment of pendingSegments(plan)) {
    let lastError = '';
    for (let attempt = 0; attempt <= (opts.retries ?? 1); attempt++) {
      const request = translationRequest(plan, segment);
      calls++;
      const answer = await llm.complete(request.messages, { maxTokens: request.maxTokens });
      const finished = finishSegment(plan, segment, request.spans, answer);
      if (finished.ok) {
        const stored = storeSegment(dataDir, plan, segment, finished.body, llm.label);
        progress = stored;
        lastError = '';
        opts.onProgress?.(`${segmentLabel(plan, segment)} translated`);
        break;
      }
      lastError = finished.error;
      opts.onProgress?.(`${segmentLabel(plan, segment)}: ${finished.error}`);
    }
    if (lastError) {
      await recordTranslationState(q, doc, target, { status: 'failed', parts: progress.parts, done: progress.done, failed: true, error: lastError });
      return { status: 'failed', reason: lastError, done: progress.done, parts: progress.parts, calls };
    }
  }
  const status: TranslationStatus = progress.done === progress.parts ? 'done' : 'partial';
  if (status === 'done' && !readTranslation(dataDir, doc.path, target)) storeComplete(dataDir, plan);
  await recordTranslationState(q, doc, target, { status, parts: progress.parts, done: progress.done, model: partModels(plan) });
  return { status, done: progress.done, parts: progress.parts, calls };
}

/** Write the whole translation of a document whose segments are all in (they were, from an earlier run). */
export function storeComplete(dataDir: string, work: TranslationWork, at = new Date()): void {
  const assembled = assembleTranslation(work);
  if (assembled.done !== assembled.parts) return;
  writeTranslation(dataDir, work.doc.path, {
    contentSha: work.doc.sha256, source: work.source, language: work.target, model: partModels(work),
    generatedAt: at.toISOString(), parts: assembled.parts, body: assembled.text,
  });
}
