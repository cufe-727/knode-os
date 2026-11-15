import crypto from 'node:crypto';
import path from 'node:path';
import { applyScope, disposeScope } from '../lineage/scope.js';
import { breather } from '../pool.js';
import { Store } from '../store/db.js';
import { nameCode } from './resolve.js';

/**
 * Back-references across one series of documents, resolved without a model.
 *
 * A weekly report says "上周那起配置下发失败已由方杰修复" and never the
 * incident's id: the id is only in the previous week's report of the same
 * team ("INC-006-T1（P1）配置下发失败"). The extraction of one document cannot
 * know it, so the fix, and whoever made it, stayed unlinked from the incident
 * (75 such lines on the 10× benchmark, none linked).
 *
 * This step reads, for each live claim that refers back to the previous
 * period ("上周那起X", "上周发生的X", "last week's X") and names no
 * identifier itself, the document before its own in the same series — the
 * same folder, dated before it and no more than 14 days earlier — and the
 * entities that document mentions whose name is an identifier (nameCode).
 * When exactly one of those has, in that document, a claim or a spelling that
 * contains the description X, the people the claim names are linked to it
 * (related_to, the way an id'd fix line links its fixer). None, or two
 * candidates, link nothing: a wrong link is worse than a missing one.
 *
 * Each link is a scope of its own (kind 'backref', keyed by the claim), so it
 * is reversible and visible as what it is; a run disposes the links whose
 * claim or reading no longer holds. Refine runs it after entity resolution.
 */

/** "上周那起配置下发失败", "上周发生的登录失败事故", "last week's cache stampede": the description after the back-reference. */
const BACKREF_ZH = /(?:上周|上一周|上个?星期|上期)(?:那起|那次|那个|那场|的|发生的|出现的|报告的)?\s*([\p{Script=Han}A-Za-z0-9]{2,20}?)(?:事故|故障|问题|事件)?(?=已|被|由|，|,|。|；|的?根因|的?原因|$)/u;
const BACKREF_EN = /\blast week's ([A-Za-z][\w -]{2,40}?)\s+(?:was|has been|is)\b/i;
const TOKEN = /[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]/g;

/**
 * "推送重复事故已由夏杰修复", "2025年6月2日至6月8日发生的推送重复事故已由叶敏修复": an
 * incident told by its kind and fixed, without an identifier. An extraction
 * often drops the "上周" of "上周那起…" or writes it as that week's dates.
 */
const DESCRIBED_FIX_ZH = /([\p{Script=Han}A-Za-z0-9]{2,30}?)(?:事故|故障)(?:已由|已被|由|被)[^，。,；;]{0,12}?(?:修复|解决|处理)/u;
const DESCRIBED_FIX_ZH2 = /(?:修复|解决)(?:了)?([\p{Script=Han}A-Za-z0-9]{2,30}?)(?:事故|故障)/u;

export interface BackReference {
  /** What the statement calls the earlier thing: 配置下发失败. */
  term: string;
  /** It says "上周" (or last week's): the period before its document's, whatever its dates say. */
  relative: boolean;
}

/** What a statement refers back to, or null — also when it names an identifier itself. */
export function backReferenceIn(statement: string): string | null {
  return backReference(statement)?.term ?? null;
}

export function backReference(statement: string): BackReference | null {
  const text = statement.normalize('NFKC');
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

/*
 * An extraction does not always keep the "上周": "推送重复事故已由夏杰修复", or
 * the week written out as dates. A fix of an incident told by its kind
 * (X事故 / X故障 已由…修复) with no identifier is read the same way, against
 * the report of the period its claim is dated in when that is earlier, else
 * the previous report — and not when its own report names an identified
 * incident of that description (the fix may be this week's).
 */

/** How far back the previous document of a series may lie. */
export const BACKREF_MAX_DAYS = 14;

export interface BackrefStats {
  /** Claims that refer back and name no identifier. */
  references: number;
  /** Of those, resolved to exactly one identified entity of the previous document. */
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
}

export type BackrefOutcome = 'no previous document' | 'no identified match' | 'several identified matches' | 'names no person' | 'linked';

export async function linkBackReferences(
  store: Store,
  /** `trace`: what became of each claim that refers back (for measuring the step). */
  opts: { onProgress?: (msg: string) => void; trace?: (claimId: string, outcome: BackrefOutcome, detail: string) => void } = {},
): Promise<BackrefStats> {
  const trace = opts.trace ?? (() => {});
  const progress = opts.onProgress ?? (() => {});
  const stats: BackrefStats = { references: 0, resolved: 0, linked: 0, disposed: 0 };
  const rows = await store.query<Ref & { doc_date: string | Date; said_at: string | Date | null }>(
    `SELECT DISTINCT c.id AS "claimId", c.statement, c.subject_id AS "subjectId", c.object_id AS "objectId",
            d.id AS "docId", d.path AS "docPath", d.doc_date, COALESCE(c.event_at, c.valid_from) AS said_at
     FROM claims c
     JOIN evidence e ON e.kind = 'claim' AND e.target_id = c.id AND e.tx_to IS NULL
     JOIN scopes s ON s.id = e.scope_id AND s.kind IN ('doc', 'tier1') AND s.status = 'active'
     JOIN documents d ON d.path = s.key AND d.doc_date IS NOT NULL
     WHERE c.tx_to IS NULL AND c.canonical_id IS NULL
       AND (c.statement ~ '(上周|上一周|上个?星期|上期)|(事故|故障)(已由|已被|由|被)|(修复|解决)了?.{0,30}(事故|故障)' OR c.statement ~* 'last week''s')`,
  );
  const refs: (Ref & BackReference & { saidAt: string | null })[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.claimId)) continue;
    const ref = backReference(r.statement);
    if (!ref) continue;
    seen.add(r.claimId);
    refs.push({ ...r, ...ref, docDate: new Date(r.doc_date).toISOString(), saidAt: r.said_at ? new Date(r.said_at).toISOString() : null });
  }
  stats.references = refs.length;
  const want = new Map<string, { incident: string; people: string[]; ref: Ref & BackReference; previous: string }>();
  const pause = breather();
  // a document's identified entities with what it says of them, read once per document
  const cache = new Map<string, { id: string; name: string; aliases: string[] | null; statements: string[] }[]>();
  const identifiedIn = async (docId: string, docPath: string) => {
    const hit = cache.get(docId);
    if (hit) return hit;
    const ents = await store.query<{ id: string; name: string; aliases: string[] | null }>(
      `SELECT e.id, e.name, e.aliases FROM entities e
       WHERE e.tx_to IS NULL AND e.canonical_id IS NULL AND e.name ~ '[0-9]'
         AND e.id IN (SELECT m.entity_id FROM entity_mentions m WHERE m.document_id = $1)`,
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
  for (const ref of refs) {
    await pause();
    const dir = path.posix.dirname(ref.docPath);
    // the report before this one; for an unmarked description dated in an earlier period, the report of that period
    const before = !ref.relative && ref.saidAt && ref.saidAt < ref.docDate ? new Date(new Date(ref.saidAt).getTime() + 6 * 86_400_000).toISOString() : ref.docDate;
    const [previous] = await store.query<{ id: string; path: string }>(
      `SELECT id, path FROM documents
       WHERE path LIKE $1 AND path NOT LIKE $2 AND id <> $3 AND doc_date IS NOT NULL
         AND doc_date < $4::timestamptz AND doc_date <= $6::timestamptz AND doc_date >= $4::timestamptz - make_interval(days => $5)
       ORDER BY doc_date DESC, path LIMIT 1`,
      [`${dir}/%`, `${dir}/%/%`, ref.docId, ref.docDate, BACKREF_MAX_DAYS, before],
    );
    if (!previous) {
      trace(ref.claimId, 'no previous document', ref.docPath);
      continue;
    }
    // the identified entities the previous document mentions, with what it says of them
    const coded = await identifiedIn(previous.id, previous.path);
    const hits = coded.filter((e) => [...e.statements, ...(e.aliases ?? [])].some((t) => t.includes(ref.term)));
    if (hits.length !== 1) {
      trace(ref.claimId, hits.length ? 'several identified matches' : 'no identified match', `${ref.term} @ ${previous.path}: ${hits.map((h) => h.name).join(', ')}`);
      continue;
    }
    if (!ref.relative) {
      // told without "上周": not when its own report names an incident of that description too (then it may be this week's)
      const own = (await identifiedIn(ref.docId, ref.docPath)).filter((e) => (e.statements ?? []).some((t) => t.includes(ref.term)));
      if (own.length > 0) {
        trace(ref.claimId, 'several identified matches', `${ref.term}: its own report names ${own.map((e) => e.name).join(', ')} too`);
        continue;
      }
    }
    const incident = hits[0];
    // the people the claim names: its subject or object, and the people its document mentions by a name it contains
    const people = await store.query<{ id: string; name: string; aliases: string[] | null }>(
      `SELECT e.id, e.name, e.aliases FROM entities e
       WHERE e.tx_to IS NULL AND e.canonical_id IS NULL AND e.type = 'person'
         AND (e.id = ANY($2::text[]) OR e.id IN (SELECT m.entity_id FROM entity_mentions m WHERE m.document_id = $1))`,
      [ref.docId, [ref.subjectId, ...(ref.objectId ? [ref.objectId] : [])]],
    );
    const bare = (n: string) => n.replace(/[（(][^）)]*[）)]$/u, '').trim();
    const filed = (id: string) => id === ref.subjectId || id === ref.objectId;
    const said = (p: { name: string; aliases: string[] | null }) => [p.name, ...(p.aliases ?? [])].map(bare).some((n) => n.length >= 2 && ref.statement.includes(n));
    const named = people.filter((p) => filed(p.id) || said(p));
    if (named.length === 0) {
      trace(ref.claimId, 'names no person', ref.statement);
      continue;
    }
    trace(ref.claimId, 'linked', incident.name);
    stats.resolved++;
    want.set(ref.claimId, { incident: incident.id, people: [...new Set(named.map((p) => p.id))].sort(), ref, previous: previous.path });
  }
  // links whose reading no longer holds go first
  const live = await store.query<{ id: string; key: string; sha: string }>(`SELECT id, key, sha FROM scopes WHERE kind = 'backref' AND status = 'active'`);
  const shaOf = (w: { incident: string; people: string[] }) => crypto.createHash('sha256').update(`${w.incident}|${w.people.join(',')}`).digest('hex').slice(0, 24);
  for (const s of live) {
    const w = want.get(s.key);
    if (w && shaOf(w) === s.sha) continue;
    await disposeScope(store, s.id, { actor: 'backref', reason: 'replaced', log: false });
    stats.disposed++;
  }
  for (const [claimId, w] of want) {
    const reason = `「${w.ref.statement}」所指上一期的${w.ref.term}：${w.previous} 中唯一带编号且提到它的是 ${w.incident}`;
    const res = await applyScope(
      store,
      { kind: 'backref', key: claimId },
      shaOf(w),
      { actor: 'backref', meta: { claimId, incident: w.incident, people: w.people, document: w.ref.docPath, previous: w.previous, term: w.ref.term, reason }, log: false },
      async (wr) => {
        for (const p of w.people) await wr.relation(p, w.incident, { type: 'related_to', description: w.ref.statement, extractor: 'backref', weight: 0.5 });
      },
    );
    stats.linked += w.people.length;
    if (res.outcome === 'applied') progress(`backref: ${w.people.join('、')} → ${w.incident} — ${reason}`);
  }
  return stats;
}
