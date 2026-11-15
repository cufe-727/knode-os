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

/** The description a statement refers back to, or null — also when it names an identifier itself. */
export function backReferenceIn(statement: string): string | null {
  const text = statement.normalize('NFKC');
  for (const t of text.match(TOKEN) ?? []) if (nameCode(t)) return null;
  const m = BACKREF_ZH.exec(text) ?? BACKREF_EN.exec(text);
  if (!m) return null;
  const term = m[1].replace(/^(?:发生|出现|报告)?了?(?:一起|一次|一个)?/u, '').replace(/(?:事故|故障|问题|事件)$/u, '').trim();
  return term.length >= 2 ? term : null;
}

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
  const rows = await store.query<Ref & { doc_date: string | Date }>(
    `SELECT DISTINCT c.id AS "claimId", c.statement, c.subject_id AS "subjectId", c.object_id AS "objectId",
            d.id AS "docId", d.path AS "docPath", d.doc_date
     FROM claims c
     JOIN evidence e ON e.kind = 'claim' AND e.target_id = c.id AND e.tx_to IS NULL
     JOIN scopes s ON s.id = e.scope_id AND s.kind IN ('doc', 'tier1') AND s.status = 'active'
     JOIN documents d ON d.path = s.key AND d.doc_date IS NOT NULL
     WHERE c.tx_to IS NULL AND c.canonical_id IS NULL
       AND (c.statement ~ '(上周|上一周|上个?星期|上期)' OR c.statement ~* 'last week''s')`,
  );
  const refs: (Ref & { term: string })[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.claimId)) continue;
    const term = backReferenceIn(r.statement);
    if (!term) continue;
    seen.add(r.claimId);
    refs.push({ ...r, docDate: new Date(r.doc_date).toISOString(), term });
  }
  stats.references = refs.length;
  const want = new Map<string, { incident: string; people: string[]; ref: Ref & { term: string }; previous: string }>();
  const pause = breather();
  for (const ref of refs) {
    await pause();
    const dir = path.posix.dirname(ref.docPath);
    const [previous] = await store.query<{ id: string; path: string }>(
      `SELECT id, path FROM documents
       WHERE path LIKE $1 AND path NOT LIKE $2 AND id <> $3 AND doc_date IS NOT NULL
         AND doc_date < $4::timestamptz AND doc_date >= $4::timestamptz - make_interval(days => $5)
       ORDER BY doc_date DESC, path LIMIT 1`,
      [`${dir}/%`, `${dir}/%/%`, ref.docId, ref.docDate, BACKREF_MAX_DAYS],
    );
    if (!previous) {
      trace(ref.claimId, 'no previous document', ref.docPath);
      continue;
    }
    // the identified entities the previous document mentions, with what it says of them
    const coded = await store.query<{ id: string; name: string; aliases: string[] | null; statements: string[] | null }>(
      `SELECT e.id, e.name, e.aliases,
              (SELECT array_agg(c.statement) FROM claims c
                 JOIN evidence ev ON ev.kind = 'claim' AND ev.target_id = c.id AND ev.tx_to IS NULL
                 JOIN scopes s ON s.id = ev.scope_id AND s.key = $2 AND s.status = 'active'
               WHERE c.tx_to IS NULL AND (c.subject_id = e.id OR c.object_id = e.id)) AS statements
       FROM entities e
       WHERE e.tx_to IS NULL AND e.canonical_id IS NULL AND e.name ~ '[0-9]'
         AND e.id IN (SELECT m.entity_id FROM entity_mentions m WHERE m.document_id = $1)`,
      [previous.id, previous.path],
    );
    const hits = coded.filter((e) => nameCode(e.name) && [...(e.statements ?? []), ...(e.aliases ?? [])].some((t) => t.includes(ref.term)));
    if (hits.length !== 1) {
      trace(ref.claimId, hits.length ? 'several identified matches' : 'no identified match', `${ref.term} @ ${previous.path}: ${hits.map((h) => h.name).join(', ')}`);
      continue;
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
