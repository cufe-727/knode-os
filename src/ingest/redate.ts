import { readSidecarPart, replayableTier1, SidecarTier1 } from '../fs/sidecar.js';
import { META_KEY as REKEY_META, RekeyState } from '../graph/claim-rekey.js';
import { frontmatterExtraction } from '../graph/frontmatter.js';
import { claimId, readingWeek } from '../graph/store.js';
import { propagate } from '../lineage/deps.js';
import { foldTouched } from '../lineage/fold.js';
import { lockLedger } from '../lineage/ledger.js';
import { findLiveScope, foldOptions, liveChildren } from '../lineage/scope.js';
import { emptyTouched, ScopeRow } from '../lineage/types.js';
import { ParsedMarkdown } from '../markdown.js';
import { dateEnd, dateStart } from '../store/dates.js';
import { Store } from '../store/db.js';
import { Queryable } from '../store/migrations.js';
import { toIso } from '../store/temporal.js';
import { DocRoot } from '../types.js';
import { docDateOf } from './docdate.js';

/**
 * The version of the rules that read a document's date (docDateOf), kept in
 * its doc scope's meta as `dateRules`: 1 frontmatter and path; 2 a raw
 * document's dateline too. Bump it whenever docDateOf reads dates
 * differently: the next sync pass reads every document's date again and
 * re-dates, in place, those whose date reads otherwise now (redateDocument).
 */
export const DOC_DATE_RULES = 2;

/** A document's date as applying it reads it: a raw document may date itself in its first lines; anything else by its metadata alone. */
export function documentDate(file: string, root: DocRoot, parsed: ParsedMarkdown, at?: string | null): string | null {
  return docDateOf(file, parsed.frontmatter, root === 'docs' ? parsed.body : null, at ?? null);
}

export interface RedateOutcome {
  /** `same`: the date reads as stored; `redated`: changed in place; `unreadable`: a stored extraction could not be read again, nothing changed. */
  status: 'same' | 'redated' | 'unreadable';
  was: string | null;
  now: string | null;
  /** Evidence rows given new dates. */
  claims: number;
  relations: number;
  /** Evidence whose stored dates are not what the old date gave (left as it is), or whose words read two ways. */
  unmatched: number;
  /** A claim whose dates now make it a weekly reading of another id: the claim re-key (src/graph/claim-rekey.ts) is set to visit it. */
  rekey: boolean;
}

type ClaimDates = { valid_from: string | null; valid_to: string | null; event_at: string | null; observed_at: string | null; date_source: string | null };
type RelationDates = { valid_from: string | null; valid_to: string | null };

/** What applyExtraction (src/graph/llm-extract.ts) dates a claim with, on reference date `ref`. */
function claimDates(c: { startDate?: unknown; endDate?: unknown; eventDate?: unknown }, ref: string | null): ClaimDates {
  const validFrom = dateStart(c.startDate, ref);
  const eventAt = dateStart(c.eventDate, ref);
  return {
    valid_from: toIso(validFrom),
    valid_to: toIso(dateEnd(c.endDate, ref)),
    event_at: toIso(eventAt),
    observed_at: toIso(ref),
    date_source: eventAt || validFrom ? 'stated' : ref ? 'document' : null,
  };
}

function relationDates(r: { validFrom?: unknown; validTo?: unknown }, ref: string | null): RelationDates {
  return { valid_from: toIso(dateStart(r.validFrom, ref)), valid_to: toIso(dateEnd(r.validTo, ref)) };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const sameDates = (a: Record<string, string | null>, b: Record<string, string | null>) => Object.keys(a).every((k) => (a[k] ?? null) === (b[k] ?? null));

interface Words {
  claims: { statement: string; startDate?: unknown; endDate?: unknown; eventDate?: unknown }[];
  relations: { description?: string; validFrom?: unknown; validTo?: unknown }[];
}

/** A stored tier-1 extraction that can be read again: the one the live scope carries, whole. */
function readableTier1(t1: SidecarTier1 | null, child: ScopeRow, sha: string): Words | null {
  if (!t1 || child.sha !== sha || (t1.segmenter && child.meta.extractedAt !== t1.extractedAt)) return null;
  if (!Array.isArray(t1.entities) || !Array.isArray(t1.relations) || (t1.claims !== undefined && !Array.isArray(t1.claims))) return null;
  return { claims: t1.claims ?? [], relations: t1.relations };
}

interface EvidenceRow { id: string; kind: 'claim' | 'relation'; target_id: string; attrs: Record<string, unknown>; subject_id: string | null }

/**
 * Re-date one scope's evidence from the words it was read from: every row
 * whose stored dates are what the old reference date gave gets what the new
 * one gives. A row the words do not account for, or account for two ways
 * (one statement twice with other dates), is left as it is.
 */
async function redateScope(q: Queryable, scopeId: string, words: Words, extractor: string | null, was: string | null, now: string | null, out: RedateOutcome, touched: ReturnType<typeof emptyTouched>, moved: string[]): Promise<void> {
  const claims = new Map<string, { old: ClaimDates; next: ClaimDates }[]>();
  for (const c of words.claims) {
    const s = typeof c.statement === 'string' ? c.statement.trim() : '';
    if (!s) continue;
    const list = claims.get(s) ?? [];
    list.push({ old: claimDates(c, was), next: claimDates(c, now) });
    claims.set(s, list);
  }
  const relations = new Map<string, { old: RelationDates; next: RelationDates }[]>();
  for (const r of words.relations) {
    const old = relationDates(r, was);
    const next = relationDates(r, now);
    if (sameDates(old, next)) continue; // a stated date, or none: the reference date changes nothing
    const key = r.description ?? '';
    relations.set(key, [...(relations.get(key) ?? []), { old, next }]);
  }
  const rows = await q.query<EvidenceRow>(
    `SELECT e.id::text AS id, e.kind, e.target_id, e.attrs, c.subject_id FROM evidence e
     LEFT JOIN claims c ON e.kind = 'claim' AND c.id = e.target_id
     WHERE e.scope_id = $1 AND e.tx_to IS NULL AND e.kind IN ('claim', 'relation') ${extractor ? 'AND e.extractor = $2' : ''}`,
    extractor ? [scopeId, extractor] : [scopeId],
  );
  for (const row of rows) {
    const a = row.attrs ?? {};
    if (row.kind === 'claim') {
      const stored: ClaimDates = { valid_from: str(a.valid_from), valid_to: str(a.valid_to), event_at: str(a.event_at), observed_at: str(a.observed_at), date_source: str(a.date_source) };
      const fits = (claims.get(String(a.statement ?? '')) ?? []).filter((x) => sameDates(x.old, stored));
      const next = [...new Map(fits.map((x) => [JSON.stringify(x.next), x.next])).values()];
      if (next.length !== 1) {
        out.unmatched++;
        continue;
      }
      if (sameDates(next[0], stored)) continue;
      const { date_source, ...dates } = next[0];
      const attrs: Record<string, unknown> = { ...a, ...dates };
      delete attrs.date_source;
      if (date_source) attrs.date_source = date_source;
      await q.query(`UPDATE evidence SET attrs = $2::jsonb WHERE id = $1`, [row.id, JSON.stringify(attrs)]);
      out.claims++;
      touched.claims.add(row.target_id);
      // the id the writer would give it now (a weekly reading carries its week): the re-key's to move, not this
      const statement = String(a.statement ?? '');
      const id = row.subject_id ? claimId(row.subject_id, statement, readingWeek({
        statement, attribute: str(a.attribute), valueNum: typeof a.value_num === 'number' ? a.value_num : null,
        dateSource: date_source, eventAt: dates.event_at, validFrom: dates.valid_from, validTo: dates.valid_to,
      })) : row.target_id;
      if (id !== row.target_id) moved.push(row.target_id);
    } else {
      const candidates = relations.get(String(a.description ?? ''));
      if (!candidates) continue;
      const stored: RelationDates = { valid_from: str(a.valid_from), valid_to: str(a.valid_to) };
      const fits = candidates.filter((x) => sameDates(x.old, stored));
      const next = [...new Map(fits.map((x) => [JSON.stringify(x.next), x.next])).values()];
      if (next.length !== 1) {
        if (fits.length) out.unmatched++;
        continue;
      }
      await q.query(`UPDATE evidence SET attrs = $2::jsonb WHERE id = $1`, [row.id, JSON.stringify({ ...a, ...next[0] })]);
      out.relations++;
      touched.relations.add(row.target_id);
    }
  }
}

/**
 * A document applied under older date rules (its doc scope's `dateRules` is
 * not DOC_DATE_RULES): read its date again, the way applying it reads it, and
 * when it reads otherwise than the stored doc_date re-date it in place, under
 * its existing scopes and ids: the document's date; the dates of the evidence
 * of its own frontmatter and of its stored tier-1 extraction (relative dates
 * read again from the stored words, `observed_at`, a claim stating none dated
 * by the document); and what folds from them, so its pages are re-planned and
 * the next refine supersedes by the new dates. Nothing is applied again: no
 * entity is resolved again, no scope replaced, no evidence row opened or
 * closed, and nothing anyone decided moves. A claim whose new dates make it
 * a weekly reading of its own week keeps its id here and is left to the claim
 * re-key, which is set to visit it.
 *
 * A document whose date reads the same is only marked as checked. When a
 * stored extraction its live scope carries cannot be read again (missing, being
 * redone, damaged), nothing is changed: it is marked and said once. One
 * transaction per re-dated document; null when the scope is already current.
 */
export async function redateDocument(
  store: Store,
  live: ScopeRow,
  doc: { file: string; root: DocRoot; raw: string; sha: string; docId: string; at?: string },
  parse: () => ParsedMarkdown,
  log: (msg: string) => void = () => {},
): Promise<RedateOutcome | null> {
  if (live.meta.dateRules === DOC_DATE_RULES) return null;
  const parsed = parse();
  const now = toIso(documentDate(doc.file, doc.root, parsed, doc.at));
  const [row] = await store.query<{ doc_date: string | Date | null }>(`SELECT doc_date FROM documents WHERE id = $1`, [doc.docId]);
  const was = toIso(row?.doc_date ?? null);
  const out: RedateOutcome = { status: 'same', was, now, claims: 0, relations: 0, unmatched: 0, rekey: false };
  const mark = (q: Queryable) => q.query(`UPDATE scopes SET meta = meta || $2::jsonb WHERE id = $1`, [live.id, JSON.stringify({ dateRules: DOC_DATE_RULES })]);
  if (now === was) {
    await mark(store);
    return out;
  }

  // the words each scope's dated evidence was read from
  const sources: { scopeId: string; words: Words; extractor: string | null }[] = [];
  const declared = doc.root === 'codebase' ? null : frontmatterExtraction(parsed.frontmatter);
  if (declared) sources.push({ scopeId: live.id, words: { claims: declared.claims, relations: declared.relations }, extractor: 'tier0.frontmatter' });
  for (const child of await liveChildren(store, live.id)) {
    if (child.kind !== 'tier1') continue;
    const words = readableTier1(replayableTier1(readSidecarPart(store.dataDir, doc.file, 'tier1'), doc.sha, doc.raw.length), child, doc.sha);
    if (words) {
      sources.push({ scopeId: child.id, words, extractor: null });
      continue;
    }
    const [held] = await store.query(`SELECT 1 FROM evidence WHERE scope_id = $1 AND tx_to IS NULL AND kind IN ('claim', 'relation') LIMIT 1`, [child.id]);
    if (!held) continue;
    await mark(store);
    log(`${doc.file}: its date reads ${now?.slice(0, 10) ?? 'none'} now, was ${was?.slice(0, 10) ?? 'none'}, but its stored extraction cannot be read again: left as it is until it is applied again`);
    return { ...out, status: 'unreadable' };
  }

  const done = await store.tx(async (q) => {
    await lockLedger(q);
    // applied again since the caller looked: that apply read the date itself
    if ((await findLiveScope(q, 'doc', doc.file))?.id !== live.id) return false;
    // counted afresh: a transaction rolled back for a deadlock runs again
    Object.assign(out, { claims: 0, relations: 0, unmatched: 0, rekey: false });
    const touched = emptyTouched();
    const moved: string[] = [];
    for (const s of sources) await redateScope(q, s.scopeId, s.words, s.extractor, was, now, out, touched, moved);
    await q.query(`UPDATE documents SET doc_date = $2::timestamptz WHERE id = $1`, [doc.docId, now]);
    touched.documents.add(doc.file);
    const txTime = new Date().toISOString();
    const fold = await foldTouched(q, touched, txTime, foldOptions(store.dataDir));
    await propagate(q, fold.changed, fold.tombstoned, txTime);
    if (moved.length) {
      const [st] = await q.query<{ value: RekeyState }>(`SELECT value FROM meta WHERE key = $1`, [REKEY_META]);
      const state = st?.value ?? { cursor: null, done: false };
      const first = moved.reduce((m, id) => (id < m ? id : m));
      if (state.done || (state.cursor !== null && first <= state.cursor)) {
        await q.query(`INSERT INTO meta (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [REKEY_META, JSON.stringify({ cursor: null, done: false })]);
      }
      out.rekey = true;
    }
    await mark(q);
    return true;
  });
  if (!done) return null;
  log(`re-dated ${doc.file}: ${was?.slice(0, 10) ?? 'none'} → ${now?.slice(0, 10) ?? 'none'} (${out.claims} claim, ${out.relations} relation dates${out.unmatched ? `, ${out.unmatched} left as stored` : ''})`);
  return { ...out, status: 'redated' };
}
