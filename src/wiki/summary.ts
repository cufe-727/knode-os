import path from 'node:path';
import { KnodeConfig } from '../config.js';
import { LLM_WIKI_INPUT_CHARS } from '../constants.js';
import { readSourceSummaryParts, SourceSummaryCache, SourceSummaryCoverage, SourceSummaryPart, writeSourceSummary, writeSourceSummaryPart } from '../fs/sidecar.js';
import { keyOf } from '../graph/normalize.js';
import { Segment, segmentSha, segmentText } from '../graph/segment.js';
import { loadSourceText } from '../ingest/source.js';
import { ChatMessage, LlmClient } from '../llm/client.js';
import { parseFrontmatter } from '../markdown.js';
import { pluginRegistry } from '../plugins/registry.js';
import { Queryable } from '../store/migrations.js';
import { DocumentRow } from '../types.js';

/**
 * What the Summarize stage asks a model, and what it makes of the answer
 * (docs/design/14). Shared by the one-shot pass (`ensureSourceSummaries`)
 * and the leased work source (src/work/summarize.ts), so a page comes out the
 * same whoever ran the calls.
 *
 * A document's summary is planned once (`planSummary`): nothing at all for a
 * document under `extraction.summaryMinChars`; one call for a document that
 * fits one (`LLM_WIKI_INPUT_CHARS`); for a longer one a call per segment —
 * cut the way extraction cuts it, so the parts share its hashes — and one
 * merge call, with the segments sampled evenly when there are more than
 * `extraction.summaryMaxSegments`, in which case the page says how much of
 * the document it read.
 *
 * Every call is told the page's language (detected from the text, or declared
 * in frontmatter), the graph's names it may put inside [[…]] — the entities
 * this document mentions, under the names the graph has for them after
 * resolution — and the document's own channel (platform, author), which is
 * not an entity of the page. The answer is then held to that: a link to a
 * name outside the vocabulary becomes plain text, an alias becomes a link
 * to its entity, the section headings are the scaffold's, and a long
 * document's page ends with what it covered.
 */

/* ------------------------------ language ------------------------------ */

export type SummaryLanguage = 'zh' | 'ja' | 'ko' | 'en';

interface Scaffold {
  /** How the prompt names the language to the model. */
  name: string;
  keyPoints: string;
  entities: string;
  description: (docPath: string) => string;
  coverage: (c: SourceSummaryCoverage) => string;
}

const fmt = (n: number) => n.toLocaleString('en-US');
const pct = (share: number) => `${Math.round(share * 100)}%`;

const SCAFFOLDS: Record<SummaryLanguage, Scaffold> = {
  zh: {
    name: "Chinese, in the document's own variety (simplified or traditional)",
    keyPoints: '要点',
    entities: '实体',
    description: (p) => `${p} 的摘要。`,
    coverage: (c) => c.read >= c.parts
      ? `分段摘要：全文约 ${fmt(c.chars)} 字、${c.parts} 段，逐段摘要后合并。`
      : `分段摘要：全文约 ${fmt(c.chars)} 字、${c.parts} 段，本页只读了其中 ${c.read} 段（约 ${pct(c.share)}${c.sections ? `，${c.sections} 节中的 ${c.sectionsRead} 节` : ''}）。`,
  },
  ja: {
    name: 'Japanese',
    keyPoints: '要点',
    entities: '関連エンティティ',
    description: (p) => `${p} の要約。`,
    coverage: (c) => c.read >= c.parts
      ? `分割要約：全文約 ${fmt(c.chars)} 文字・${c.parts} 部分を部分ごとに要約して統合。`
      : `分割要約：全文約 ${fmt(c.chars)} 文字・${c.parts} 部分のうち ${c.read} 部分（約 ${pct(c.share)}${c.sections ? `、${c.sections} 節中 ${c.sectionsRead} 節` : ''}）のみを読んで作成。`,
  },
  ko: {
    name: 'Korean',
    keyPoints: '핵심 요점',
    entities: '엔티티',
    description: (p) => `${p} 요약.`,
    coverage: (c) => c.read >= c.parts
      ? `분할 요약: 전문 약 ${fmt(c.chars)}자, ${c.parts}개 부분을 각각 요약한 뒤 병합.`
      : `분할 요약: 전문 약 ${fmt(c.chars)}자, ${c.parts}개 부분 중 ${c.read}개(약 ${pct(c.share)}${c.sections ? `, ${c.sections}개 절 중 ${c.sectionsRead}개` : ''})만 읽고 작성.`,
  },
  en: {
    name: 'English',
    keyPoints: 'Key points',
    entities: 'Entities',
    description: (p) => `Summary of ${p}.`,
    coverage: (c) => c.read >= c.parts
      ? `Segmented summary: the full text (about ${fmt(c.chars)} characters in ${c.parts} parts) was summarized part by part and merged.`
      : `Segmented summary: of about ${fmt(c.chars)} characters in ${c.parts} parts, this page read ${c.read} (about ${pct(c.share)}${c.sections ? `; ${c.sectionsRead} of ${c.sections} sections` : ''}).`,
  },
};

export function summaryScaffold(language: SummaryLanguage): { keyPoints: string; entities: string; description: (docPath: string) => string; coverage: (c: SourceSummaryCoverage) => string } {
  return SCAFFOLDS[language];
}

const isLanguage = (code: string): code is SummaryLanguage => code === 'zh' || code === 'ja' || code === 'ko' || code === 'en';

/** A stored language code as one the scaffolds know, or null. */
export function asSummaryLanguage(code: string | null | undefined): SummaryLanguage | null {
  return typeof code === 'string' && isLanguage(code) ? code : null;
}

/**
 * The language a document's page is written in: what its frontmatter
 * declares (`lang` / `language`), else the script most of its text is in.
 * A CJK character carries about a word; Latin words run five or six
 * letters, so the two are compared as words, and a Chinese post full of
 * tickers and English terms still reads as Chinese. Latin-script text of
 * any language gets the English scaffold.
 */
export function detectSummaryLanguage(text: string, frontmatter: Record<string, unknown> = {}): SummaryLanguage {
  for (const key of ['lang', 'language']) {
    const v = frontmatter[key];
    if (typeof v !== 'string') continue;
    const code = v.trim().toLowerCase().split(/[-_]/)[0];
    if (isLanguage(code)) return code;
  }
  const sample = text.length > 40_000 ? text.slice(0, 20_000) + text.slice(-20_000) : text;
  let han = 0;
  let kana = 0;
  let hangul = 0;
  let latin = 0;
  for (const ch of sample) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x20000 && cp <= 0x2a6df)) han++;
    else if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff)) kana++;
    else if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f)) hangul++;
    else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f)) latin++;
  }
  const cjk = han + kana + hangul;
  if (cjk === 0 || cjk < latin * 0.3) return 'en';
  if (kana >= cjk * 0.1) return 'ja';
  if (hangul >= cjk * 0.3) return 'ko';
  return 'zh';
}

/* ------------------------------ vocabulary ------------------------------ */

export interface SummaryEntity {
  /** The graph's name — what goes inside [[…]]. */
  name: string;
  type: string;
  /** Other spellings the document may use: the graph's aliases and the names it was extracted under before resolution. */
  aliases: string[];
}

/** The names a summary may link: this document's entities, as the graph names them. */
export class LinkVocabulary {
  private readonly byKey = new Map<string, string>();

  constructor(readonly entities: SummaryEntity[]) {
    for (const e of entities) {
      // the entity mentioned most keeps a spelling two of them share
      for (const s of [e.name, ...e.aliases]) {
        const k = keyOf(s);
        if (k && !this.byKey.has(k)) this.byKey.set(k, e.name);
      }
    }
  }

  get size(): number {
    return this.entities.length;
  }

  /** The graph's name behind a spelling (its own, an alias, another case), or null when it belongs to no entity here. */
  canonical(spelling: string): string | null {
    const k = keyOf(spelling);
    return k ? this.byKey.get(k) ?? null : null;
  }

  /** The entities named in `text` by any of their spellings, most mentioned first. */
  appearingIn(text: string, limit = 60): SummaryEntity[] {
    const lc = text.toLowerCase();
    const out: SummaryEntity[] = [];
    for (const e of this.entities) {
      if (out.length >= limit) break;
      if ([e.name, ...e.aliases].some((s) => s.length > 0 && lc.includes(s.toLowerCase()))) out.push(e);
    }
    return out;
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);

/**
 * The entities the graph holds for a document — the ones its tier-0 and
 * tier-1 passes wrote mentions for, each under the name of the entity it
 * was merged into, if any — most mentioned in the document first. Tier-0's
 * mined concept placeholders are left out: they are not names anyone would
 * link, and tier-1 retires them anyway.
 */
export async function linkVocabulary(q: Queryable, documentId: string, limit = 80): Promise<LinkVocabulary> {
  const rows = await q.query<{ id: string; name: string; type: string; aliases: unknown; mentioned_as: string; mentioned_aliases: unknown }>(
    `SELECT COALESCE(c.id, e.id) AS id, COALESCE(c.name, e.name) AS name, COALESCE(c.type, e.type) AS type,
            COALESCE(c.aliases, e.aliases) AS aliases, e.name AS mentioned_as, e.aliases AS mentioned_aliases,
            count(*)::int AS hits, max(COALESCE(c.mention_count, e.mention_count))::int AS mentions
     FROM entity_mentions m
     JOIN entities e ON e.id = m.entity_id AND e.tx_to IS NULL
     LEFT JOIN entities c ON c.id = e.canonical_id AND c.tx_to IS NULL
     WHERE m.document_id = $1
       AND EXISTS (SELECT 1 FROM evidence ev WHERE ev.kind = 'entity' AND ev.target_id = e.id AND ev.tx_to IS NULL AND ev.extractor <> 'tier0.concept')
     GROUP BY 1, 2, 3, 4, 5, 6
     ORDER BY hits DESC, mentions DESC, name
     LIMIT $2`,
    [documentId, limit * 2],
  );
  const byId = new Map<string, SummaryEntity>();
  for (const r of rows) {
    const name = r.name.trim();
    if (!name) continue;
    const cur = byId.get(r.id) ?? byId.set(r.id, { name, type: r.type, aliases: [] }).get(r.id)!;
    const seen = new Set([keyOf(cur.name), ...cur.aliases.map(keyOf)]);
    for (const a of [...strings(r.aliases), r.mentioned_as, ...strings(r.mentioned_aliases)]) {
      const k = keyOf(a);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      cur.aliases.push(a.trim());
    }
  }
  return new LinkVocabulary([...byId.values()].slice(0, limit));
}

/* ------------------------------- channel -------------------------------- */

const CHANNEL_KEYS = ['platform', 'source', 'author', 'channel', 'account', 'publisher'];

/** Display names of the platform ids digests commonly carry, so `platform: xueqiu` also keeps 雪球 out of the entities. */
const PLATFORM_NAMES: Record<string, string[]> = {
  xueqiu: ['雪球'],
  tgb: ['淘股吧'],
  feishu: ['飞书'],
  wechat: ['微信', '微信公众号', '公众号'],
  weixin: ['微信', '微信公众号', '公众号'],
  weibo: ['微博', '新浪微博'],
  zhihu: ['知乎'],
  bilibili: ['哔哩哔哩', 'B站'],
  douyin: ['抖音'],
  xiaohongshu: ['小红书'],
  twitter: ['Twitter'],
  x: ['Twitter'],
  youtube: ['YouTube'],
  telegram: ['Telegram'],
  substack: ['Substack'],
  medium: ['Medium'],
  reddit: ['Reddit'],
};

/**
 * The document's own channel, from its frontmatter: the platform it was
 * published on and the account or author that published it. Paths and URLs
 * are not names and are skipped.
 */
export function channelNames(frontmatter: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const s = value.trim();
    if (!s || s.length > 80 || /[/\\]|:\/\//.test(s) || seen.has(keyOf(s))) return;
    seen.add(keyOf(s));
    out.push(s);
  };
  for (const key of CHANNEL_KEYS) {
    const v = frontmatter[key];
    for (const x of Array.isArray(v) ? v : [v]) {
      if (typeof x !== 'string') continue;
      add(x);
      for (const name of PLATFORM_NAMES[x.trim().toLowerCase()] ?? []) add(name);
    }
  }
  return out;
}

/* ------------------------------ thresholds ------------------------------ */

/** `extraction.summaryMinChars`: documents shorter than this get no summary page (0: every document gets one). */
export function summaryMinChars(config: KnodeConfig): number {
  const n = Number(config.extraction.summaryMinChars);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** `extraction.summaryMaxSegments`: segments one summary reads at most. */
export function summaryMaxSegments(config: KnodeConfig): number {
  const n = Number(config.extraction.summaryMaxSegments);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 12;
}

/** The segment size a long document is summarized in: extraction's, within what one summary call reads. */
export function summarySegmentChars(config: KnodeConfig): number {
  const n = Number(config.extraction.segmentChars);
  return Math.max(1000, Math.min(Number.isFinite(n) && n > 0 ? Math.floor(n) : LLM_WIKI_INPUT_CHARS, LLM_WIKI_INPUT_CHARS));
}

/**
 * Whether a document is under the threshold, from its row alone: by `chars`
 * when the row has it, else by `bytes` where that settles it (a character is
 * one to four UTF-8 bytes). Null when only the text can tell.
 */
export function shortByRow(doc: Pick<DocumentRow, 'bytes' | 'chars'>, minChars: number): boolean | null {
  if (minChars <= 0) return false;
  if (typeof doc.chars === 'number') return doc.chars < minChars;
  if (doc.bytes < minChars) return true;
  if (doc.bytes >= 4 * minChars) return false;
  return null;
}

/**
 * The length of a document's indexed text, from its row or — for a row
 * indexed before the column existed (schema v14) — from the text, written
 * back so it is read once. Null when the document has no text.
 */
export async function documentChars(q: Queryable, dataDir: string, doc: Pick<DocumentRow, 'id' | 'path' | 'root' | 'sha256' | 'chars'>): Promise<number | null> {
  if (typeof doc.chars === 'number') return doc.chars;
  const source = loadSourceText(dataDir, doc.path, doc.root);
  if (!source) return null;
  const chars = source.text.length;
  // a cache fill, not a change of record: the next apply writes the column for good, and a row
  // another transaction holds (an apply in flight) is left to it
  await q.query(
    `UPDATE documents SET chars = $2 WHERE id IN (SELECT id FROM documents WHERE id = $1 AND sha256 = $3 AND chars IS NULL FOR UPDATE SKIP LOCKED)`,
    [doc.id, chars, doc.sha256],
  );
  return chars;
}

/** Whether a document gets no summary page for its size. */
export async function isShortDocument(q: Queryable, dataDir: string, doc: Pick<DocumentRow, 'id' | 'path' | 'root' | 'sha256' | 'bytes' | 'chars'>, minChars: number): Promise<boolean> {
  const byRow = shortByRow(doc, minChars);
  if (byRow !== null) return byRow;
  const chars = await documentChars(q, dataDir, doc);
  return chars !== null && chars < minChars;
}

/* -------------------------------- plans --------------------------------- */

export type SummaryDoc = Pick<DocumentRow, 'id' | 'path' | 'root' | 'title' | 'sha256'>;

/** One document's summary, planned: what to read, in which language, with which names. */
export interface SummaryWork {
  kind: 'single' | 'segmented';
  doc: SummaryDoc;
  title: string;
  text: string;
  language: SummaryLanguage;
  channels: string[];
  vocabulary: LinkVocabulary;
  /** The segments this summary reads: the whole text of a document that fits one call; all, or an even sample, of a long one's. */
  segments: Segment[];
  /** Set for a segmented summary. */
  coverage: SourceSummaryCoverage | null;
  /** Part summaries the sidecar already holds for these segments, by segment hash. */
  cached: Map<string, SourceSummaryPart>;
}

export type SummaryPlan =
  | { kind: 'none'; reason: 'no-text' }
  | { kind: 'none'; reason: 'short'; chars: number; minChars: number }
  | SummaryWork;

/** Pick `max` of `all` evenly, the first and the last among them. */
export function sampleSegments<T>(all: T[], max: number): T[] {
  const n = Math.max(1, Math.floor(max));
  if (all.length <= n) return all;
  if (n === 1) return [all[0]];
  const picks = new Set<number>();
  for (let i = 0; i < n; i++) picks.add(Math.round((i * (all.length - 1)) / (n - 1)));
  return [...picks].sort((a, b) => a - b).map((i) => all[i]);
}

/** Sub-headings (`##` and below): a digest's posts, a report's sections. */
function countSections(text: string): number {
  return (text.match(/^#{2,6}\s/gm) ?? []).length;
}

/**
 * Plan a document's summary: none for a document without text or under the
 * size threshold, one call for one that fits a call, else a call per
 * segment (all of them, or an even sample past `summaryMaxSegments`) and a
 * merge. The vocabulary is read from the graph here, so the same plan serves
 * however many calls follow.
 */
export async function planSummary(q: Queryable, dataDir: string, config: KnodeConfig, doc: SummaryDoc): Promise<SummaryPlan> {
  const source = loadSourceText(dataDir, doc.path, doc.root);
  if (!source) return { kind: 'none', reason: 'no-text' };
  const text = source.text;
  const minChars = summaryMinChars(config);
  if (text.length < minChars) return { kind: 'none', reason: 'short', chars: text.length, minChars };
  const { frontmatter } = parseFrontmatter(text);
  const base = {
    doc,
    title: doc.title ?? path.basename(doc.path),
    text,
    language: detectSummaryLanguage(text, frontmatter),
    channels: channelNames(frontmatter),
    vocabulary: await linkVocabulary(q, doc.id),
  };
  if (text.length <= LLM_WIKI_INPUT_CHARS) {
    return { ...base, kind: 'single', segments: [{ index: 0, start: 0, end: text.length, text, sha: segmentSha(text), heading: null }], coverage: null, cached: new Map() };
  }
  const all = segmentText(text, summarySegmentChars(config));
  const chosen = sampleSegments(all, summaryMaxSegments(config));
  const read = chosen.reduce((n, s) => n + (s.end - s.start), 0);
  const coverage: SourceSummaryCoverage = {
    chars: text.length,
    parts: all.length,
    read: chosen.length,
    share: Math.round((read / text.length) * 1000) / 1000,
    sections: countSections(text),
    sectionsRead: chosen.reduce((n, s) => n + countSections(s.text), 0),
  };
  const cached = readSourceSummaryParts(dataDir, doc.path);
  for (const sha of [...cached.keys()]) if (!chosen.some((s) => s.sha === sha)) cached.delete(sha);
  return { ...base, kind: 'segmented', segments: chosen, coverage, cached };
}

/* -------------------------------- steps --------------------------------- */

/** One model call of a summary: the whole document, one segment of it, or the merge of the parts. */
export type SummaryStep = { kind: 'single' } | { kind: 'part'; sha: string } | { kind: 'reduce' };

/** The calls still to make: the one call; the segments without a cached part; once every part is in, the merge. */
export function pendingSteps(work: SummaryWork): SummaryStep[] {
  if (work.kind === 'single') return [{ kind: 'single' }];
  const parts = work.segments.filter((s) => !work.cached.has(s.sha)).map((s) => ({ kind: 'part' as const, sha: s.sha }));
  return parts.length ? parts : [{ kind: 'reduce' }];
}

function segmentOf(work: SummaryWork, sha: string): Segment {
  const seg = work.segments.find((s) => s.sha === sha);
  if (!seg) throw new Error(`no segment ${sha} in the summary of ${work.doc.path}`);
  return seg;
}

/** What a worker's log calls a step: the path, with the part for a segment. */
export function stepLabel(work: SummaryWork, step: SummaryStep): string {
  if (step.kind === 'single') return work.doc.path;
  if (step.kind === 'reduce') return `${work.doc.path} [merge]`;
  return `${work.doc.path} [${segmentOf(work, step.sha).index + 1}/${work.coverage?.parts ?? work.segments.length}]`;
}

export interface SummaryCall {
  messages: ChatMessage[];
  maxTokens: number;
}

const SUMMARIZE = 'You maintain a personal wiki. Summarize the document into a wiki source page.';

const describeEntity = (e: SummaryEntity) => (e.aliases.length ? `${e.name} (also ${e.aliases.slice(0, 4).join(', ')})` : e.name);

function linkRule(entities: SummaryEntity[]): string {
  return entities.length
    ? `- Wikilinks: only the entities listed here may be linked, spelled exactly as listed — [[Name]], or [[Name|as the document spells it]] when the document uses another spelling; every other name stays plain text, with no brackets.\n  Entities: ${entities.map(describeEntity).join('; ')}`
    : "- Wikilinks: none of this document's names is in the knowledge graph yet, so write every name as plain text, with no [[double brackets]].";
}

function channelRule(work: SummaryWork): string | null {
  return work.channels.length
    ? `- The document is its own channel's record (${work.channels.join(', ')}): do not list the platform or the author as entities or key points.`
    : null;
}

function pageSystem(work: SummaryWork, entities: SummaryEntity[], part: { index: number; total: number; heading: string | null } | null): string {
  const s = SCAFFOLDS[work.language];
  const lead = part
    ? `${SUMMARIZE} This call reads part ${part.index + 1} of ${part.total} of a long document${part.heading ? ` (section: ${part.heading})` : ''}; summarize this part only — the parts are merged afterwards.`
    : SUMMARIZE;
  const rules = [
    '- Markdown only, no preamble, no title line.',
    `- Start with a one-paragraph abstract, then a "## ${s.keyPoints}" section of ${part ? 'up to 8 bullets' : 'bullets'}, then a "## ${s.entities}" section listing the important entities as [[Entity Name]] wikilinks. Use exactly these two headings.`,
    `- Write in ${s.name}.`,
    linkRule(entities),
    channelRule(work),
    `- Max ~${part ? 250 : 400} words.`,
  ].filter((r): r is string => r !== null);
  return `${lead}\n\nOutput rules:\n${rules.join('\n')}`;
}

function mergeSystem(work: SummaryWork, read: number): string {
  const s = SCAFFOLDS[work.language];
  const total = work.coverage?.parts ?? read;
  const rules = [
    '- Markdown only, no preamble, no title line.',
    `- Start with a one-paragraph abstract of the whole document, then a "## ${s.keyPoints}" section of up to 12 bullets in the document's order, then a "## ${s.entities}" section listing the important entities as [[Entity Name]] wikilinks. Use exactly these two headings.`,
    `- Write in ${s.name}.`,
    '- Keep the [[wikilinks]] exactly as the parts spell them and add no new ones; list each entity once.',
    '- Write about the document, not about the parts or the merging.',
    channelRule(work),
    '- Max ~500 words.',
  ].filter((r): r is string => r !== null);
  return `${SUMMARIZE} A long document was summarized part by part; the user message holds the ${read} part summaries${read < total ? ` (${read} of its ${total} parts were read; the page will say so)` : ''}. Merge them into one page about the whole document.\n\nOutput rules:\n${rules.join('\n')}`;
}

/**
 * The messages one step sends — the same whether this process makes the call
 * or a worker leases it. `summary.request` hooks (docs/design/11) see every
 * step and may rewrite it: a house style, another language, extra context.
 */
export async function summaryStepRequest(work: SummaryWork, step: SummaryStep, dataDir: string): Promise<SummaryCall> {
  let system: string;
  let text: string;
  let user: string;
  let maxTokens: number;
  let entities: SummaryEntity[];
  let segment: { index: number; total: number; heading: string | null } | undefined;
  if (step.kind === 'reduce') {
    const parts = work.segments.filter((s) => work.cached.has(s.sha));
    if (parts.length === 0) throw new Error(`no part summaries to merge for ${work.doc.path}`);
    const total = work.coverage?.parts ?? parts.length;
    entities = work.vocabulary.entities;
    text = parts.map((s) => `### Part ${s.index + 1} of ${total}${s.heading ? ` — ${s.heading}` : ''}\n\n${work.cached.get(s.sha)!.body.trim()}`).join('\n\n');
    system = mergeSystem(work, parts.length);
    user = `Source file: ${work.doc.path}\nTitle: ${work.title}\n\n${text}`;
    maxTokens = 1500;
  } else if (step.kind === 'part') {
    const seg = segmentOf(work, step.sha);
    const total = work.coverage?.parts ?? work.segments.length;
    segment = { index: seg.index, total, heading: seg.heading };
    entities = work.vocabulary.appearingIn(seg.text, 40);
    text = seg.text;
    system = pageSystem(work, entities, segment);
    user = `Source file: ${work.doc.path} (part ${seg.index + 1} of ${total}${seg.heading ? `, section: ${seg.heading}` : ''})\n\n${text}`;
    maxTokens = 900;
  } else {
    entities = work.vocabulary.entities.slice(0, 60);
    text = work.segments[0]?.text ?? work.text.slice(0, LLM_WIKI_INPUT_CHARS);
    system = pageSystem(work, entities, null);
    user = `Source file: ${work.doc.path}\n\n${text}`;
    maxTokens = 1200;
  }
  const messages = await pluginRegistry().filter('summary.request', [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], {
    path: work.doc.path, root: work.doc.root, dataDir, title: work.title, text,
    step: step.kind, language: work.language, entities: entities.map((e) => e.name), channels: work.channels, segment,
  });
  return { messages, maxTokens };
}

/* ------------------------------ finishing ------------------------------- */

const KEY_POINT_HEADINGS = new Set(
  ['key points', 'key takeaways', 'main points', 'highlights', 'takeaways', 'summary points', '要点', '关键要点', '核心要点', '主要观点', '要点总结', '重点', '核心观点', '主要内容', '要約', '主なポイント', '핵심 요점', '주요 내용', '핵심 내용']
    .map(keyOf),
);
const ENTITY_HEADINGS = new Set(
  ['entities', 'key entities', 'entities mentioned', 'named entities', 'related entities', '实体', '关键实体', '涉及实体', '相关实体', '主要实体', '实体列表', 'エンティティ', '関連エンティティ', '엔티티', '관련 엔티티']
    .map(keyOf),
);

/** A reply wrapped in a code fence is unwrapped. */
function unfence(body: string): string {
  const m = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/.exec(body);
  return m ? m[1] : body;
}

/** The two section headings, however the model spelled them, become the scaffold's. */
function normalizeHeadings(body: string, scaffold: Scaffold): string {
  return body.replace(/^(#{2,3})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (line, _hashes: string, title: string) => {
    const k = keyOf(title);
    if (KEY_POINT_HEADINGS.has(k)) return `## ${scaffold.keyPoints}`;
    if (ENTITY_HEADINGS.has(k)) return `## ${scaffold.entities}`;
    return line;
  });
}

/**
 * Every [[link]] is held to the vocabulary: a link to an entity keeps its
 * name; one written under an alias becomes [[Name|alias]]; one to a name the
 * graph does not have, or to the document's own channel, becomes the text it
 * showed. Embeds (![[…]]) are left alone.
 */
export function normalizeLinks(body: string, vocabulary: LinkVocabulary, channels: string[] = []): string {
  const channelKeys = new Set(channels.map(keyOf));
  return body.replace(/(!?)\[\[([^\]\n]+)\]\]/g, (whole, bang: string, inner: string) => {
    if (bang) return whole;
    const pipe = inner.indexOf('|');
    const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
    const label = pipe >= 0 ? inner.slice(pipe + 1).trim() : '';
    const shown = label || target;
    if (!target || channelKeys.has(keyOf(target)) || channelKeys.has(keyOf(shown))) return shown;
    const canonical = vocabulary.canonical(target) ?? vocabulary.canonical(shown);
    if (!canonical) return shown;
    if (shown === canonical) return `[[${canonical}]]`;
    return `[[${canonical}|${shown}]]`;
  });
}

/** In the entities section, a bullet that only names the document's channel (with or without a gloss) goes. */
function dropChannelBullets(body: string, channels: string[], entitiesHeading: string): string {
  if (channels.length === 0) return body;
  const keys = new Set(channels.map(keyOf));
  let inEntities = false;
  return body
    .split('\n')
    .filter((line) => {
      const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
      if (heading) {
        inEntities = keyOf(heading[1]) === keyOf(entitiesHeading);
        return true;
      }
      if (!inEntities) return true;
      const item = /^\s*[-*+]\s+(.+)$/.exec(line);
      if (!item) return true;
      const head = /^(?:\*\*)?([^:：—–,，、(（]+?)(?:\*\*)?\s*(?:[:：—–]\s*.*)?$/.exec(item[1].trim());
      return !(head && keys.has(keyOf(head[1])));
    })
    .join('\n');
}

/**
 * The page body from a model's final answer: unwrapped, its headings the
 * scaffold's, its links held to the vocabulary, the channel out of the
 * entities, and — for a long document — what the summary covered.
 */
export function finishSummary(work: SummaryWork, raw: string): { body: string; coverage: SourceSummaryCoverage | null } {
  const scaffold = SCAFFOLDS[work.language];
  let body = unfence(raw.trim());
  body = normalizeHeadings(body, scaffold);
  body = normalizeLinks(body, work.vocabulary, work.channels);
  body = dropChannelBullets(body, work.channels, scaffold.entities);
  if (work.coverage) body = `${body.trimEnd()}\n\n> ${scaffold.coverage(work.coverage)}`;
  return { body: body.replace(/\n{3,}/g, '\n\n').trim(), coverage: work.coverage };
}

/**
 * Make a document's summary with `llm`, step by step: the one call for a
 * document that fits one; for a long one a call per segment without a cached
 * part — each written to the sidecar as it arrives, so an interruption
 * resumes where it stopped — then the merge. The finished summary goes to
 * the document's summary cache, keyed by its content, and is returned.
 */
export async function produceSummary(dataDir: string, work: SummaryWork, llm: LlmClient): Promise<SourceSummaryCache> {
  if (work.kind === 'segmented') {
    for (const seg of work.segments) {
      if (work.cached.has(seg.sha)) continue;
      const call = await summaryStepRequest(work, { kind: 'part', sha: seg.sha }, dataDir);
      const text = (await llm.complete(call.messages, { maxTokens: call.maxTokens })).trim();
      if (!text) throw new Error(`the model answered with an empty summary for part ${seg.index + 1} of ${work.coverage?.parts ?? work.segments.length}`);
      const part: SourceSummaryPart = { body: text, model: llm.label, generatedAt: new Date().toISOString() };
      writeSourceSummaryPart(dataDir, work.doc.path, seg.sha, part, work.segments.map((s) => s.sha));
      work.cached.set(seg.sha, part);
    }
  }
  const call = await summaryStepRequest(work, work.kind === 'segmented' ? { kind: 'reduce' } : { kind: 'single' }, dataDir);
  const text = (await llm.complete(call.messages, { maxTokens: call.maxTokens })).trim();
  if (!text) throw new Error('the model answered with an empty summary');
  const { body, coverage } = finishSummary(work, text);
  const cache: SourceSummaryCache = { contentSha: work.doc.sha256, model: llm.label, generatedAt: new Date().toISOString(), body, language: work.language, ...(coverage ? { coverage } : {}) };
  writeSourceSummary(dataDir, work.doc.path, cache);
  return cache;
}
