import crypto from 'node:crypto';
import path from 'node:path';
import { KnodeConfig } from '../config.js';
import { applyScope, disposeScope } from '../lineage/scope.js';
import { TrustTier } from '../lineage/trust.js';
import { breather } from '../pool.js';
import { Store } from '../store/db.js';
import { nameCode } from './resolve.js';

/**
 * Back-references across one series of periodic reports, resolved without a
 * model. Off unless a workspace turns it on (review.backReferences).
 *
 * A weekly report says "上周那起配置下发失败已由方杰修复" and never the
 * incident's id: the id is only in the previous week's report of the same
 * team ("INC-006-T1（P1）配置下发失败"). The extraction of one document cannot
 * know it, so the fix, and whoever made it, stayed unlinked from the incident
 * (75 such lines on the 10× benchmark, none linked).
 *
 * Only where documents are periodic reports: a folder the workspace lists
 * (`periodic`), or — with `detect` — a folder whose dated documents
 * demonstrably are a series: four or more, one title pattern (the title with
 * its numbers taken out), consecutive dates at a regular interval. Outside a
 * series "上周的交付延迟已由王传福在业绩会上解释" in one analyst's notes is not
 * a reference to the B737 delay of the note before.
 *
 * A claim takes part when it states a fix (修复 / 解决 / 排除 / fixed …) of
 * something it describes without an identifier: "上周那起X…", "X事故已由Y修复".
 * The previous report of its series — or, for an unmarked description dated in
 * an earlier period, the report of that period — must mention exactly one
 * identified event (an incident: an event whose name is an identifier) whose
 * claims there contain X and do not state it fixed; and the claim's own report
 * must not name such an event too (the fix may be this period's). Then the
 * people the claim names are linked to it (related_to, as an id'd fix line
 * links its fixer) — only the person the sentence gives as the one who fixed
 * it (fixerSpans), not anyone it names. None, or two candidates, link nothing.
 *
 * Each link is a scope of kind 'backref', keyed by the claim, a child of the
 * scope that carries the claim in its document: disposed with that document
 * (removed, replaced, re-extracted), with its trust and acl, its document and
 * passage as the relation's source. A run reads only the claims of documents
 * applied since the last run and of the report after each of them (cursor in
 * meta 'backrefs'), and the claims whose link rests on an earlier report that
 * changed or went since; it disposes the links among those that no longer
 * hold, every link whose report is no longer in a periodic folder, and — the
 * step turned off — every link.
 */

/** "上周那起配置下发失败", "上周发生的登录失败事故", "last week's cache stampede": the description after the back-reference. */
const BACKREF_ZH = /(?:上周(?!期|末)|上一周|上个?星期|上期(?![所货]))(?:那起|那次|那个|那场|的|发生的|出现的|报告的)?\s*([\p{Script=Han}A-Za-z0-9]{2,20}?)(?:事故|故障|问题|事件)?(?=已|被|由|，|,|。|；|的?根因|的?原因|$)/u;
const BACKREF_EN = /\blast week's ([A-Za-z][\w -]{2,40}?)\s+(?:was|has been|is)\b/i;
const TOKEN = /[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]/g;

/**
 * "推送重复事故已由夏杰修复", "2025年6月2日至6月8日发生的推送重复事故已由叶敏修复": an
 * incident told by its kind and fixed, without an identifier. An extraction
 * often drops the "上周" of "上周那起…" or writes it as that week's dates.
 */
const DESCRIBED_FIX_ZH = /([\p{Script=Han}A-Za-z0-9]{2,30}?)(?:事故|故障)(?:已由|已被|由|被)[^，。,；;]{0,12}?(?:修复|解决|处理)/u;
const DESCRIBED_FIX_ZH2 = /(?:修复|解决)(?:了)?([\p{Script=Han}A-Za-z0-9]{2,30}?)(?:事故|故障)/u;
/** What a back-reference must say happened to the thing: a fix. */
const FIXED = /修复|解决|排除|已恢复|\bfixed\b|\bresolved\b/i;

/**
 * The spans a sentence gives as whoever did the fixing: "已由方杰修复", "方杰已修复",
 * "fixed by Fang Jie". A person counts only when one of these is their name:
 * "上周那起支付超时已修复，客户张三确认" names 张三, but not as the fixer.
 */
export function fixerSpans(statement: string): string[] {
  const text = statement.normalize('NFKC');
  const out: string[] = [];
  // a list of names joined inside the fixer phrase ("由方杰、李明修复", "fixed by Fang Jie and Li Ming"): each of them.
  // A comma joins clauses, not fixers ("客户 张三，由方杰修复"), except in a list after "fixed by".
  const NAMES_ZH = '[\\p{Script=Han}A-Za-z·]{2,12}?(?:\\s*(?:、|和|与|及|以及|跟)\\s*[\\p{Script=Han}A-Za-z·]{2,12}?)*';
  const NAME_EN = '[A-Z][\\w.-]*(?:\\s+[A-Z][\\w.-]*){0,2}';
  const NAMES_BY_EN = `${NAME_EN}(?:\\s*(?:,|,?\\s*and|&)\\s*${NAME_EN})*`;
  const NAMES_EN = `${NAME_EN}(?:\\s+(?:and|&)\\s+${NAME_EN})*`;
  const each = (list: string) => {
    // "李明协助方杰": the one helped did the fixing
    const helped = /(?:协助|配合|帮助|支持)(.+)$/u.exec(list);
    const names = (helped ? helped[1] : list).split(/\s*(?:、|,|和|与|及|以及|跟|&|\band\b)\s*/u);
    for (const n of names) {
      const name = n.replace(/^(?:由|被)/u, '').replace(/(?:共同|一起|联合|合力|等人?)$/u, '').trim();
      if (name.length >= 2) out.push(name);
    }
  };
  for (const m of text.matchAll(new RegExp(`(?:由|被)\\s*(${NAMES_ZH})\\s*(?:共同|一起|联合|合力)?\\s*(?:在[^，。,；;]{0,20}?)?(?:修复|解决|排除|处理)`, 'gu'))) each(m[1]);
  for (const m of text.matchAll(new RegExp(`(?:^|[，,。；;\\s])(${NAMES_ZH})\\s*(?:共同|一起|联合|合力)?\\s*(?:已经|已|于[^，。,；;]{0,20}?)?(?:修复|解决|排除)了?`, 'gu'))) each(m[1]);
  for (const m of text.matchAll(new RegExp(`\\b(?:fixed|resolved)\\s+by\\s+(${NAMES_BY_EN})`, 'g'))) each(m[1]);
  for (const m of text.matchAll(new RegExp(`\\b(${NAMES_EN})\\s+(?:fixed|resolved)\\b`, 'g'))) each(m[1]);
  return [...new Set(out)];
}

export interface BackReference {
  /** What the statement calls the earlier thing: 配置下发失败. */
  term: string;
  /** It says "上周" (or last week's): the period before its document's, whatever its dates say. */
  relative: boolean;
}

/** What a statement refers back to, or null — also when it names an identifier itself, or states no fix. */
export function backReferenceIn(statement: string): string | null {
  return backReference(statement)?.term ?? null;
}

export function backReference(statement: string): BackReference | null {
  const text = statement.normalize('NFKC');
  if (!FIXED.test(text)) return null;
  for (const t of text.match(TOKEN) ?? []) if (nameCode(t)) return null;
  const m = BACKREF_ZH.exec(text) ?? BACKREF_EN.exec(text);
  const fixed = m ? null : DESCRIBED_FIX_ZH.exec(text) ?? DESCRIBED_FIX_ZH2.exec(text);
  const raw = m?.[1] ?? fixed?.[1];
  if (!raw) return null;
  // what stands before the description: a date, "发生的", the team
  const tail = raw.split(/的|发生|出现|期间|所在周|那周|之间/u).pop() ?? raw;
  const term = tail.replace(/^(?:了)?(?:一起|一次|一个)?/u, '').replace(/(?:事故|故障|问题|事件)$/u, '').trim();
  return term.length >= 2 ? { term, relative: Boolean(m) } : null;
}

/** How far back the previous document of a series may lie. */
export const BACKREF_MAX_DAYS = 14;

/** A title as a pattern: its numbers taken out ("平台组周报 · 第28周" → "平台组周报 · 第#周"). */
export function titlePattern(title: string): string {
  return title.normalize('NFKC').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/**
 * Whether dated documents of one folder are a series: four or more, at least
 * four in five sharing one title pattern, and at least four in five of the
 * gaps between consecutive dates within two days of the median gap (a week, a
 * month).
 */
export function isSeries(docs: readonly { title: string | null; date: string }[]): boolean {
  if (docs.length < 4) return false;
  const patterns = new Map<string, number>();
  for (const d of docs) patterns.set(titlePattern(d.title ?? ''), (patterns.get(titlePattern(d.title ?? '')) ?? 0) + 1);
  if (Math.max(...patterns.values()) < 0.8 * docs.length) return false;
  const days = [...docs].map((d) => new Date(d.date).getTime() / 86_400_000).sort((a, b) => a - b);
  const gaps = days.slice(1).map((d, i) => d - days[i]);
  const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  if (median < 1) return false;
  return gaps.filter((g) => Math.abs(g - median) <= 2).length >= 0.8 * gaps.length;
}

export interface BackrefStats {
  /** Claims read that refer back, state a fix and name no identifier. */
  references: number;
  /** Of those, resolved to exactly one identified incident of the previous report. */
  resolved: number;
  /** Links (one per person and incident) written or kept. */
  linked: number;
  /** Earlier links disposed because their reading no longer holds. */
  disposed: number;
}

interface Ref {
  claimId: string;
  statement: string;
  subjectId: string;
  objectId: string | null;
  docId: string;
  docPath: string;
  docDate: string;
  /** The scope that carries the claim in that document, its evidence passage, trust and acl. */
  scopeId: string;
  segmentId: string | null;
  trust: TrustTier;
  acl: string[];
}

export type BackrefOutcome = 'not a series' | 'no previous document' | 'no identified match' | 'several identified matches' | 'names no person' | 'linked';

const META_KEY = 'backrefs';

/** Whether a document lies in a folder the workspace marked, or (detect) in one that is a series. */
type SeriesTest = (docPath: string) => Promise<boolean>;

export async function linkBackReferences(
  store: Store,
  opts: {
    config?: Pick<KnodeConfig, 'review'>;
    onProgress?: (msg: string) => void;
    /** What became of each claim that refers back (for measuring the step). */
    trace?: (claimId: string, outcome: BackrefOutcome, detail: string) => void;
    /** Read every claim, not only those of documents applied since the last run. */
    full?: boolean;
  } = {},
): Promise<BackrefStats> {
  const trace = opts.trace ?? (() => {});
  const progress = opts.onProgress ?? (() => {});
  const stats: BackrefStats = { references: 0, resolved: 0, linked: 0, disposed: 0 };
  const setting = opts.config?.review?.backReferences;
  const periodic = (setting?.periodic ?? []).map((p) => p.replace(/\/+$/, ''));
  const live = await store.query<{ id: string; key: string; sha: string; document: string | null; previous: string | null; document_id: string | null }>(
    `SELECT id, key, sha, meta->>'document' AS document, meta->>'previous' AS previous, meta->>'documentId' AS document_id
     FROM scopes WHERE kind = 'backref' AND status = 'active' ORDER BY id COLLATE "C"`,
  );
  const dispose = async (id: string) => {
    await disposeScope(store, id, { actor: 'backref', reason: 'removed', log: false });
    stats.disposed++;
  };
  // turned off: no link stays
  if (!setting || (periodic.length === 0 && !setting.detect)) {
    for (const s of live) await dispose(s.id);
    if (live.length > 0) progress(`backref: off, ${live.length} links disposed`);
    return stats;
  }

  // the documents to read: applied since the last run, and the report after each of them
  const started = new Date().toISOString();
  const cursor = opts.full ? undefined : (await store.getMeta<{ at?: string }>(META_KEY))?.at;
  const changed = await store.query<{ id: string; path: string; doc_date: string | Date | null }>(
    `SELECT DISTINCT d.id, d.path, d.doc_date FROM documents d JOIN scopes s ON s.key = d.path AND s.kind IN ('doc', 'tier1') AND s.status = 'active'
     ${cursor ? 'WHERE s.applied_at > $1::timestamptz' : ''}`,
    cursor ? [cursor] : [],
  );
  const read = new Set(changed.map((d) => d.id));
  // a link rests on two reports: the one with the fix (its parent scope goes with it) and the earlier one it
  // was resolved from — a link whose earlier report changed or went is read again
  if (cursor) {
    const gone = await store.query<{ key: string }>(
      `SELECT DISTINCT key FROM scopes WHERE kind IN ('doc', 'tier1') AND (applied_at > $1::timestamptz OR disposed_at > $1::timestamptz)`,
      [cursor],
    );
    const touched = new Set(gone.map((g) => g.key));
    for (const s of live) if (s.previous && touched.has(s.previous) && s.document_id) read.add(s.document_id);
  }
  for (const d of changed) {
    if (!d.doc_date) continue;
    const dir = path.posix.dirname(d.path);
    const [next] = await store.query<{ id: string }>(
      `SELECT id FROM documents WHERE path LIKE $1 AND path NOT LIKE $2 AND id <> $3 AND doc_date > $4::timestamptz
         AND doc_date <= $4::timestamptz + make_interval(days => $5)
       ORDER BY doc_date, path COLLATE "C" LIMIT 1`,
      [`${likeEscape(dir)}/%`, `${likeEscape(dir)}/%/%`, d.id, new Date(d.doc_date).toISOString(), BACKREF_MAX_DAYS],
    );
    if (next) read.add(next.id);
  }

  // a folder is in or out once per run
  const folders = new Map<string, boolean>();
  const inSeries: SeriesTest = async (docPath) => {
    const dir = path.posix.dirname(docPath);
    if (periodic.some((p) => dir === p || dir.startsWith(`${p}/`))) return true;
    if (!setting.detect) return false;
    const known = folders.get(dir);
    if (known !== undefined) return known;
    const docs = await store.query<{ title: string | null; doc_date: string | Date }>(
      `SELECT title, doc_date FROM documents WHERE path LIKE $1 AND path NOT LIKE $2 AND doc_date IS NOT NULL`,
      [`${likeEscape(dir)}/%`, `${likeEscape(dir)}/%/%`],
    );
    const yes = isSeries(docs.map((d) => ({ title: d.title, date: new Date(d.doc_date).toISOString() })));
    folders.set(dir, yes);
    return yes;
  };

  // a link whose report is no longer in a periodic folder goes
  for (const s of live) if (s.document && !(await inSeries(s.document))) await dispose(s.id);

  const rows = read.size === 0 ? [] : await store.query<Omit<Ref, 'docDate' | 'acl'> & { doc_date: string | Date; said_at: string | Date | null; acl: unknown }>(
    `SELECT c.id AS "claimId", c.statement, c.subject_id AS "subjectId", c.object_id AS "objectId",
            d.id AS "docId", d.path AS "docPath", d.doc_date, COALESCE(c.event_at, c.valid_from) AS said_at,
            s.id AS "scopeId", e.segment_id AS "segmentId", s.trust, s.acl
     FROM claims c
     JOIN evidence e ON e.kind = 'claim' AND e.target_id = c.id AND e.tx_to IS NULL
     JOIN scopes s ON s.id = e.scope_id AND s.kind IN ('doc', 'tier1') AND s.status = 'active'
     JOIN documents d ON d.path = s.key AND d.doc_date IS NOT NULL
     WHERE c.tx_to IS NULL AND c.canonical_id IS NULL AND d.id = ANY($1::text[])
       AND c.statement ~* '(修复|解决|排除|已恢复|fixed|resolved)'
     ORDER BY c.id, d.doc_date, d.path COLLATE "C", s.id`,
    [[...read]],
  );
  // one document per claim, the earliest by date, then path (code-point order), then scope
  const refs: (Ref & BackReference & { saidAt: string | null })[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.claimId)) continue;
    seen.add(r.claimId);
    const ref = backReference(r.statement);
    if (!ref) continue;
    refs.push({ ...r, ...ref, acl: Array.isArray(r.acl) ? (r.acl as string[]) : [], docDate: new Date(r.doc_date).toISOString(), saidAt: r.said_at ? new Date(r.said_at).toISOString() : null });
  }
  stats.references = refs.length;
  const want = new Map<string, { incident: string; people: string[]; ref: Ref & BackReference; previous: string }>();
  const pause = breather();
  // a document's identified events with what it says of them, read once per document
  const cache = new Map<string, { id: string; name: string; aliases: string[] | null; statements: string[] }[]>();
  const identifiedIn = async (docId: string, docPath: string) => {
    const hit = cache.get(docId);
    if (hit) return hit;
    const ents = await store.query<{ id: string; name: string; aliases: string[] | null }>(
      `SELECT e.id, e.name, e.aliases FROM entities e
       WHERE e.tx_to IS NULL AND e.canonical_id IS NULL AND e.type = 'event' AND e.name ~ '[0-9]'
         AND e.id IN (SELECT m.entity_id FROM entity_mentions m WHERE m.document_id = $1)
       ORDER BY e.id`,
      [docId],
    );
    const coded = ents.filter((e) => nameCode(e.name));
    const said = coded.length === 0 ? [] : await store.query<{ subject_id: string; object_id: string | null; statement: string }>(
      `SELECT c.subject_id, c.object_id, c.statement FROM claims c
       JOIN evidence ev ON ev.kind = 'claim' AND ev.target_id = c.id AND ev.tx_to IS NULL
       JOIN scopes s ON s.id = ev.scope_id AND s.key = $1 AND s.status = 'active'
       WHERE c.tx_to IS NULL AND (c.subject_id = ANY($2::text[]) OR c.object_id = ANY($2::text[]))`,
      [docPath, coded.map((e) => e.id)],
    );
    const out = coded.map((e) => ({ ...e, statements: said.filter((c) => c.subject_id === e.id || c.object_id === e.id).map((c) => c.statement) }));
    cache.set(docId, out);
    return out;
  };
  const describes = (e: { aliases: string[] | null; statements: string[] }, term: string) => [...e.statements, ...(e.aliases ?? [])].some((t) => t.includes(term));
  for (const ref of refs) {
    await pause();
    if (!(await inSeries(ref.docPath))) {
      trace(ref.claimId, 'not a series', ref.docPath);
      continue;
    }
    const dir = path.posix.dirname(ref.docPath);
    // the report before this one; for an unmarked description dated in an earlier period, the report of that period
    const before = !ref.relative && ref.saidAt && ref.saidAt < ref.docDate ? new Date(new Date(ref.saidAt).getTime() + 6 * 86_400_000).toISOString() : ref.docDate;
    const [previous] = await store.query<{ id: string; path: string; title: string | null }>(
      `SELECT id, path, title FROM documents
       WHERE path LIKE $1 AND path NOT LIKE $2 AND id <> $3 AND doc_date IS NOT NULL
         AND doc_date < $4::timestamptz AND doc_date <= $6::timestamptz AND doc_date >= $4::timestamptz - make_interval(days => $5)
       ORDER BY doc_date DESC, path COLLATE "C" DESC LIMIT 1`,
      [`${likeEscape(dir)}/%`, `${likeEscape(dir)}/%/%`, ref.docId, ref.docDate, BACKREF_MAX_DAYS, before],
    );
    if (!previous) {
      trace(ref.claimId, 'no previous document', ref.docPath);
      continue;
    }
    // an incident the previous report describes and does not report fixed
    const hits = (await identifiedIn(previous.id, previous.path)).filter((e) => describes(e, ref.term) && !e.statements.some((t) => FIXED.test(t)));
    if (hits.length !== 1) {
      trace(ref.claimId, hits.length ? 'several identified matches' : 'no identified match', `${ref.term} @ ${previous.path}: ${hits.map((h) => h.name).join(', ')}`);
      continue;
    }
    // not when its own report names an incident of that description too (then it may be this period's)
    const own = (await identifiedIn(ref.docId, ref.docPath)).filter((e) => e.id !== hits[0].id && describes(e, ref.term));
    if (own.length > 0) {
      trace(ref.claimId, 'several identified matches', `${ref.term}: its own report names ${own.map((e) => e.name).join(', ')} too`);
      continue;
    }
    const incident = hits[0];
    // the people the claim names: its subject or object, and the people its document mentions by a name it contains
    const people = await store.query<{ id: string; name: string; aliases: string[] | null }>(
      `SELECT e.id, e.name, e.aliases FROM entities e
       WHERE e.tx_to IS NULL AND e.canonical_id IS NULL AND e.type = 'person'
         AND (e.id = ANY($2::text[]) OR e.id IN (SELECT m.entity_id FROM entity_mentions m WHERE m.document_id = $1))
       ORDER BY e.id`,
      [ref.docId, [ref.subjectId, ...(ref.objectId ? [ref.objectId] : [])]],
    );
    const bare = (n: string) => n.replace(/[（(][^）)]*[）)]$/u, '').trim();
    // the person the sentence says did the fixing, not anyone it names
    const spans = fixerSpans(ref.statement);
    const fixer = (p: { name: string; aliases: string[] | null }) => [p.name, ...(p.aliases ?? [])].map(bare).some((n) => n.length >= 2 && spans.includes(n));
    const named = people.filter((p) => fixer(p));
    if (named.length === 0) {
      trace(ref.claimId, 'names no person', ref.statement);
      continue;
    }
    trace(ref.claimId, 'linked', incident.name);
    stats.resolved++;
    want.set(ref.claimId, { incident: incident.id, people: [...new Set(named.map((p) => p.id))].sort(), ref, previous: previous.path });
  }
  // among the claims read, links whose reading no longer holds go first
  const readClaims = [...new Set(rows.map((r) => r.claimId))];
  const current = readClaims.length === 0 ? [] : await store.query<{ id: string; key: string; sha: string }>(
    `SELECT id, key, sha FROM scopes WHERE kind = 'backref' AND status = 'active' AND key = ANY($1::text[]) ORDER BY id COLLATE "C"`,
    [readClaims],
  );
  const shaOf = (w: { incident: string; people: string[]; ref: Ref }) => crypto.createHash('sha256').update(`${w.incident}|${w.people.join(',')}|${w.ref.scopeId}`).digest('hex').slice(0, 24);
  for (const s of current) {
    const w = want.get(s.key);
    if (w && shaOf(w) === s.sha) continue;
    await disposeScope(store, s.id, { actor: 'backref', reason: 'replaced', log: false });
    stats.disposed++;
  }
  for (const [claimId, w] of want) {
    const reason = `「${w.ref.statement}」所指上一期的${w.ref.term}：${w.previous} 中唯一带编号且提到它、未报修复的事件是 ${w.incident}`;
    const res = await applyScope(
      store,
      { kind: 'backref', key: claimId },
      shaOf(w),
      {
        actor: 'backref',
        parentId: w.ref.scopeId,
        trust: w.ref.trust,
        acl: w.ref.acl,
        meta: { documentId: w.ref.docId, claimId, incident: w.incident, people: w.people, document: w.ref.docPath, previous: w.previous, term: w.ref.term, reason },
        log: false,
      },
      async (wr) => {
        for (const p of w.people) await wr.relation(p, w.incident, { type: 'related_to', description: `修复上一期报告的${w.ref.term}`, extractor: 'backref', weight: 0.5, segmentId: w.ref.segmentId });
      },
    );
    stats.linked += w.people.length;
    if (res.outcome === 'applied') progress(`backref: ${w.people.join('、')} → ${w.incident} — ${reason}`);
  }
  await store.setMeta(META_KEY, { at: started });
  return stats;
}

/** A path as a LIKE prefix: %, _ and \ taken literally. */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
