import { KnodeConfig } from '../config.js';
import { readSidecarPart } from '../fs/sidecar.js';
import { writeDeps } from '../lineage/deps.js';
import { breather } from '../pool.js';
import { Store } from '../store/db.js';
import { Queryable } from '../store/migrations.js';
import { groupBy, toIso } from '../store/temporal.js';
import { mergeSuggestionId } from './dedupe.js';
import { applyMerge } from './merge.js';
import { tier0Known, weakLinkKey } from './concepts.js';
import { NamesakeRule } from './identity.js';
import { keyOf, nameKey } from './normalize.js';
import { ExtractedEntity, slugify } from './store.js';

/**
 * Entity resolution by context (docs/design/29 §5), run by refine before the
 * duplicate audit. All of it deterministic and conservative — a wrong merge
 * is worse than a missed one — and each decision records its reason:
 *
 *   rename   a fact says one entity was renamed to another and gives both
 *            names itself ("Atlas项目更名为Orion", "Orion（原Atlas）", "renamed
 *            to", "formerly"): the old name merges into the new (reversible,
 *            `entities unmerge`). Every one of these must hold:
 *              - the old name is written where the renamed thing stands: at
 *                the head of the marker's own clause ("万业企业后更名为…"),
 *                after a reporting verb ("文中称Clawdbot现已更名为…"), a
 *                possessive ("阿里巴巴的通义千问已经改名为…") or 将/把
 *                ("将Sales Cloud更名为…": Sales Cloud, not who renamed it),
 *                or in a "formerly" form. A name that only occurs earlier in
 *                the sentence is not it, and a clause that names nothing
 *                ("…，并于2017年更名为X", "将其更名为X", "该子公司更名为X")
 *                gives no merge;
 *              - each spelling is the own name of one live, unmerged entity,
 *                as written or with a corporate form taken off (隆基股份 /
 *                隆基). An alias does not count: a parent may list its
 *                subsidiary's name, and the alias rule below is the weaker
 *                evidence already;
 *              - the two have the same specific type (not concept, not
 *                other) and neither is a generic word or a weak spelling
 *                (公司, 上市公司, 标的, a two-letter abbreviation, a word in
 *                the stop list; for the old name also a corpus-frequent one);
 *              - the claim is filed under one of the two, as its subject or
 *                its object;
 *              - the rename happened: not planned, proposed or denied
 *                (拟更名为, 将改名为, 建议将…更名为, 尚未更名为).
 *            Before 2026-11-13 the old name was "the longest live name
 *            before the marker"; on finance that merged 发展, 公司, 国际 and
 *            手机 into companies and 大族激光, 赛力斯 and 东芝 into what a
 *            subsidiary or a brand of theirs was renamed to.
 *            An alias list alone is weaker evidence — an extraction can file
 *            创业板 under A股 — so it only files merge suggestions, the
 *            likeliest first and a bounded number a run.
 *   namesake one person name whose documents fall into separate contexts at
 *            the same time — disjoint co-mentioned people and teams, each
 *            with an organization or project of its own — is two people. The
 *            smaller context's documents are re-applied from their sidecars
 *            (no model call) with the name resolved to a new entity
 *            "陈伟（平台组）"; entity_namesakes keeps the rule that resolution
 *            follows from then on (namesakeChoice).
 */

export interface EntityContextStats {
  merged: number;
  suggested: number;
  split: number;
  replayed: number;
}

/* ---------------------------------- rename ---------------------------------- */

const RENAME_MARKER = /更名为|改名为|更名成|改名成|易名为|renamed (?:to|as)|rebranded (?:to|as)|now (?:called|known as)/i;
const FORMERLY = /([^\s，,。；;（(]{1,40})\s*[（(]\s*(?:原名|原项目名|原|旧称|曾用名|formerly(?: known as)?|previously)[:：\s]*([^）)，,]{1,40})[）)]/i;
const FORMERLY_EN = /([A-Z][\w.&-]*(?: [A-Z][\w.&-]*){0,3}),? formerly (?:known as )?([A-Z][\w.&-]*(?: [A-Z][\w.&-]*){0,3})/;
/** "原名Facebook的上市公司…更名为", "（原项目名Atlas，自本周起改名为Orion）": the old name said outright, ahead of the marker. */
const FORMERLY_AHEAD = String.raw`(?:原名|原项目名|曾用名|旧称)(?:为|是|叫)?[:\s]*([^,;:()。\s的]{1,40})`;
const FORMERLY_AHEAD_HERE = new RegExp(`${FORMERLY_AHEAD}(?:的[^的]{1,8})?$`);
const FORMERLY_AHEAD_END = new RegExp(`${FORMERLY_AHEAD}$`);
const RENAME_SQL = '(更名|改名|易名|原名|原项目名|renamed|rebranded|formerly|now known as|now called)';

const HAN = /[㐀-鿿]/;
/** The noun a name may carry that is no part of it ("Atlas项目", "the Atlas project"). */
const KIND_SUFFIX = /(?:项目|系统|平台|公司)$|\s+(?:project|system|platform|company)$/i;

const DATE = String.raw`(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{2,4}\s*年(?:\s*\d{1,2}\s*月)?(?:\s*\d{1,2}\s*[日号])?|\d{1,2}\s*月(?:\s*\d{1,2}\s*[日号])?|第?\s*\d+\s*周|本周|上周|本月|上月|今年|去年|近日|近期|最近|日前|此前|目前|如今|当日|当天|昨日|今日)`;
const WHEN = String.raw`(?:于|在|自|从|截至)?\s*${DATE}(?:所在周|当周|底|末|初|中旬|上旬|下旬|中)?(?:起|开始|以来)?`;
const WHEN_EN = String.raw`(?<![\w])(?:in|on|since|from)\s+(?:[A-Z][a-z]+\s+)?(?:\d{1,2}\s+)?\d{4}`;
/** What may stand between the renamed thing's name and the marker and leaves the rename a fact. */
const SETTLED = String.raw`已经|已|现已|现|后来|随后|之后|其后|后|正式|曾|刚刚|刚|最终|终于|被|宣布|(?<![\w])(?:was|were|is|are|has|have|had|been|officially|formally|recently|later|subsequently|then|also|now)`;
/** The same place, saying it has not happened: planned, expected, denied. */
const UNSETTLED = String.raw`拟|计划|准备|打算|将会|将要|即将|将|有望|或将|可能|尚未|并未|未|没有|不会|不再|并非|是否|(?<![\w])(?:will|would|may|might|could|not|never|to be|be|being)`;
const SETTLED_END = new RegExp(`\\s*(?:${WHEN}|${WHEN_EN}|${SETTLED})$`, 'i');
const UNSETTLED_END = new RegExp(`\\s*(?:${UNSETTLED})$`, 'i');
const ONLY_FILLERS = new RegExp(`^(?:\\s*(?:${WHEN}|${WHEN_EN}|${SETTLED}|${UNSETTLED}))+\\s*$`, 'i');
/** Said ahead of the name, the rename is someone's intention, proposal or a rumour. */
const UNSETTLED_LEAD = /建议|提议|誓言|扬言|呼吁|考虑|打算|计划|准备|有望|或将|即将|将把|拟将|如果|假如|倘若|据传|传闻|是否|(?<![\w])(?:will|would|plans?|planned|proposes?|proposed|considering|may|might|if|whether)(?![\w])/i;
/** After one of these a name may begin: who says so, whose it is, 将/把 and 由 before the thing renamed. */
const NAME_LEAD = /称|表示|指出|透露|提到|宣布|公布|确认|说|的|将|把|由/g;
/** A word that may be part of a Latin name: capitalized, or with a digit, an underscore or an inner dot. */
const NAME_WORD = /[A-Z\d_㐀-鿿]|\w\.\w/;
/** A phrase that points at something named elsewhere. */
const POINTS_ELSEWHERE = /^(?:该|其|此|某|这|那|一家|一个|一款|一只|相关|上述|旗下|后者|前者|(?:its|their|this|that|these|those|which)\s)/i;
const WRAPPING = /^[\s“”"'‘’「」『』《》〈〉【】]+|[\s“”"'‘’「」『』《》〈〉【】]+$/g;

/**
 * Names no entity should carry and a rename never means, beyond the stop
 * list's (公司, 集团, 平台, 项目…): the words a sentence uses for the thing it
 * has just named.
 */
const GENERIC_NAMES = new Set([
  '上市公司', '子公司', '母公司', '分公司', '本公司', '该公司', '新公司', '控股公司', '上市', '控股', '标的', '标的公司', '品牌', '商标', '指数', '基金',
  '数据库', '股票池', '板块', '名称', '简称', '证券简称', '名字', '账号', '公众号', '课堂', '战法', '指标', '版本', '手机', '发展', '国际', '公告',
  'company', 'subsidiary', 'brand', 'product', 'service', 'database', 'project', 'platform', 'system', 'name', 'app',
  'ltd', 'inc', 'corp', 'llc', 'limited', 'holdings', 'group',
]);

/** A phrase as a name may be written, and without the noun that says what kind of thing it is. */
function spellings(phrase: string): string[] {
  const name = phrase.replace(WRAPPING, '').replace(/^(?:the|an|a)\s+/i, '');
  if (!name || name.length > 40 || POINTS_ELSEWHERE.test(name) || ONLY_FILLERS.test(name) || keyOf(name).length < 2) return [];
  const bare = name.replace(KIND_SUFFIX, '').trim();
  return bare !== name && keyOf(bare).length >= 2 ? [name, bare] : [name];
}

/** The names a phrase may end with, the longest first, each with what is said ahead of it. */
function nameReadings(phrase: string): { name: string; lead: string }[] {
  const starts = new Set([0]);
  for (const m of phrase.matchAll(NAME_LEAD)) starts.add(m.index + m[0].length);
  // a Latin name is the run of name-like words the phrase ends with ("the report says Atlas")
  const words = [...phrase.matchAll(/\S+/g)];
  let run = words.length;
  while (run > 0 && NAME_WORD.test(words[run - 1][0])) run--;
  if (run < words.length) starts.add(words[run].index);
  return [...starts].sort((a, b) => a - b).map((s) => ({ name: phrase.slice(s), lead: phrase.slice(0, s) }));
}

/** The new name as written after the marker: quoted, a run of Latin words, or a CJK run up to what follows it in the same breath. */
function newNames(after: string): string[] {
  let rest = after.replace(/^\s+/, '');
  if (/^[“"「『《‘']/.test(rest)) {
    const close = rest.slice(1).search(/[”"」』》’']/);
    if (close > 0) return spellings(rest.slice(1, 1 + close));
    rest = rest.slice(1);
  }
  const run = /^[^,;:()。!?“”"「」『』《》\n]{1,80}/.exec(rest)?.[0] ?? '';
  const [first, ...more] = run.trim().split(/\s+/);
  if (!first) return [];
  const out: string[] = [];
  if (!HAN.test(first)) {
    // "Meta Platforms", "Dyno Nobel并转向…": the capitalized words that follow belong to the name
    let name = first;
    for (const w of more) {
      if (!/^[A-Z\d]/.test(w)) break;
      const latin = /^[^㐀-鿿]+/.exec(w)![0];
      name += ` ${latin}`;
      if (latin.length < w.length) break;
    }
    out.push(name);
  } else {
    out.push(first);
    // "更名为大麦娱乐后，…", "更名为中航成飞的事项…", "更名为Skyclaw并…"
    const cuts = [...first.matchAll(/后|的|并/g)].map((m) => m.index).filter((i) => i >= 2).sort((a, b) => b - a);
    for (const i of cuts) out.push(first.slice(0, i));
  }
  return [...new Set(out.flatMap(spellings))];
}

export interface RenameReading {
  /** The old name a "formerly" form gives; null in the "renamed to" form, where `old` holds what the clause names. */
  from: string | null;
  to: string;
  marker: number;
  /** How the old name may be spelled, the likeliest first; empty when the statement names none where the renamed thing stands. */
  old: string[];
  /** How the new name may be spelled, the likeliest first. */
  renamed: string[];
  /** The statement says the rename is planned, proposed or did not happen: `old` leaves the name out. */
  planned: boolean;
}

/** The rename one statement states, as written; null when it states none. */
export function renameIn(statement: string): RenameReading | null {
  const text = statement.normalize('NFKC');
  let m = FORMERLY.exec(text) ?? FORMERLY_EN.exec(text);
  if (m) {
    const from = m[2].trim();
    const to = m[1].trim();
    return { from, to, marker: m.index, old: spellings(from), renamed: [...new Set(nameReadings(to).flatMap((r) => spellings(r.name)))], planned: false };
  }
  m = RENAME_MARKER.exec(text);
  if (!m) return null;
  const renamed = newNames(text.slice(m.index + m[0].length));
  if (renamed.length === 0) return null;
  const to = renamed[0].replace(KIND_SUFFIX, '').trim();
  const before = text.slice(0, m.index);
  const sentence = before.slice(Math.max(before.lastIndexOf('。'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n'), before.search(/\.\s(?!.*\.\s)/)) + 1);
  let planned = false;
  let old: string[] = [];
  // the marker's own clause, and the name it opens with: what stands between a name and the marker
  // comes off its end one piece at a time, and a reading is tried before each ("天后" is a name
  // before it is 天 and 后)
  const clauseStart = Math.max(...[',', ';', ':', '(', ')'].map((c) => sentence.lastIndexOf(c))) + 1;
  const ahead = sentence.slice(0, clauseStart);
  let head = sentence.slice(clauseStart).trim();
  for (;;) {
    // the old name said outright: in this clause ("原名Facebook的上市公司于…更名为"), or, when
    // this clause names nothing, at the end of the one before ("原项目名Atlas，自本周起改名为")
    const said = head ? FORMERLY_AHEAD_HERE.exec(head) : FORMERLY_AHEAD_END.exec(ahead.replace(/[,;:(\s]+$/, ''));
    if (said) {
      old = [];
      if (UNSETTLED_LEAD.test(ahead + head)) planned = true;
      else old.push(...spellings(said[1]));
      break;
    }
    if (!head) break;
    for (const r of nameReadings(head)) {
      if (UNSETTLED_LEAD.test(ahead + r.lead)) planned = true;
      else old.push(...spellings(r.name));
    }
    if (UNSETTLED_END.test(head)) {
      planned = true;
      break;
    }
    const filler = SETTLED_END.exec(head);
    if (!filler || filler[0].length === 0) break;
    head = head.slice(0, filler.index).trim();
  }
  return { from: null, to, marker: m.index, old: [...new Set(old)], renamed, planned };
}

/** A claim whose statement may state a rename, with the entities it is filed under (their survivors, if merged). */
export interface RenameClaim {
  id: string;
  statement: string;
  subject: string | null;
  object: string | null;
  path: string | null;
}

export interface Named {
  id: string;
  name: string;
  type: string;
}

export interface RenameMerge {
  from: Named;
  to: Named;
  reason: string;
}

export async function renameClaims(q: Queryable): Promise<RenameClaim[]> {
  return q.query<RenameClaim>(
    `SELECT c.id, c.statement, coalesce(se.canonical_id, se.id) AS subject, coalesce(oe.canonical_id, oe.id) AS object, s.key AS path
     FROM claims c
     LEFT JOIN scopes s ON s.id = c.primary_scope_id
     LEFT JOIN entities se ON se.id = c.subject_id AND se.tx_to IS NULL
     LEFT JOIN entities oe ON oe.id = c.object_id AND oe.tx_to IS NULL
     WHERE c.tx_to IS NULL AND c.canonical_id IS NULL AND c.status = 'fact' AND c.statement ~* $1
     ORDER BY c.id`,
    [RENAME_SQL],
  );
}

/**
 * The live, unmerged entities of a specific type whose own name each
 * spelling is: exactly, else with a corporate form taken off either side
 * (隆基股份 names 隆基). Aliases are not looked at.
 */
async function ownNamed(q: Queryable, names: string[]): Promise<(spelling: string) => Named[]> {
  const keys = new Set(names.flatMap((n) => Object.values(nameKey(n))));
  const rows = keys.size === 0 ? [] : await q.query<Named>(
    `SELECT DISTINCT e.id, e.name, e.type
     FROM entity_alias_keys k JOIN entities e ON e.id = k.entity_id
     WHERE k.alias_key = ANY($1::text[]) AND e.tx_to IS NULL AND e.canonical_id IS NULL AND e.type NOT IN ('concept', 'other')
       AND (e.wiki_path IS NOT NULL OR EXISTS (
         SELECT 1 FROM evidence ev WHERE ev.kind = 'entity' AND ev.target_id = e.id AND ev.tx_to IS NULL AND ev.extractor <> 'tier0.wikilink'))
     ORDER BY e.id`,
    [[...keys]],
  );
  const keyed = rows.map((e) => ({ e, k: nameKey(e.name) }));
  return (spelling) => {
    const want = nameKey(spelling);
    const exact = keyed.filter((x) => x.k.key === want.key);
    if (exact.length > 0) return exact.map((x) => x.e);
    return keyed.filter((x) => x.k.key === want.bare || x.k.bare === want.key).map((x) => x.e);
  };
}

/** The stop lists a rename's names are held against: `stop` with the corpus-frequent terms, `linkStop` the generic words alone (tier0Known). */
export interface RenameStops {
  stop: ReadonlySet<string>;
  linkStop: ReadonlySet<string>;
}

/**
 * The merge one claim's statement supports under the rename rule, or null
 * with nothing decided. Reads only (a dry run calls it as refine does).
 */
export async function renameMergeFor(q: Queryable, claim: RenameClaim, stops: RenameStops): Promise<RenameMerge | null> {
  const rename = renameIn(claim.statement);
  if (!rename || rename.old.length === 0 || rename.renamed.length === 0) return null;
  const named = await ownNamed(q, [...rename.old, ...rename.renamed]);
  const generic = (e: Named, stop: ReadonlySet<string>) => {
    const key = nameKey(e.name).key;
    return GENERIC_NAMES.has(key) || weakLinkKey(key, { isName: true, stop });
  };
  // the longest spelling that names anything is the name: a shorter one inside it is another thing
  const first = (list: string[]) => list.map(named).find((found) => found.length > 0) ?? [];
  const olds = first(rename.old).filter((e) => !generic(e, stops.stop));
  const news = first(rename.renamed).filter((e) => !generic(e, stops.linkStop));
  const pairs = olds.flatMap((from) => news.filter((to) => to.id !== from.id && to.type === from.type).map((to) => ({ from, to })));
  if (pairs.length !== 1) return null;
  const [{ from, to }] = pairs;
  const filedUnder = [claim.subject, claim.object];
  if (!filedUnder.includes(from.id) && !filedUnder.includes(to.id)) return null;
  return { from, to, reason: `更名：「${claim.statement}」${claim.path ? `（${claim.path}）` : ''}` };
}

/** A person said no to merging these two: they undid such a merge, or rejected the suggestion themselves. */
async function refusedByPerson(store: Store, a: string, b: string): Promise<boolean> {
  const [undone] = await store.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM scopes WHERE kind = 'merge' AND key = ANY($1::text[]) AND status = 'disposed'`,
    [[a, b]],
  );
  if (undone.n > 0) return true;
  const [s] = await store.query<{ status: string; llm: unknown }>(`SELECT status, payload->'llm' AS llm FROM suggestions WHERE id = $1`, [mergeSuggestionId(a, b)]);
  return Boolean(s && s.status === 'rejected' && (s.llm === null || s.llm === undefined));
}

async function namesakePair(store: Store, a: string, b: string): Promise<boolean> {
  const [r] = await store.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM entity_namesakes WHERE (id = $1 AND base_id = $2) OR (id = $2 AND base_id = $1)`,
    [a, b],
  );
  return r.n > 0;
}

async function mergeRenames(store: Store, stats: EntityContextStats, progress: (msg: string) => void): Promise<void> {
  const claims = await renameClaims(store);
  if (claims.length === 0) return;
  const stops = await tier0Known(store);
  for (const c of claims) {
    // one claim at a time: a merge changes which entities the next statement's names find
    const merge = await renameMergeFor(store, c, stops);
    if (!merge) continue;
    const { from, to, reason } = merge;
    if ((await refusedByPerson(store, from.id, to.id)) || (await namesakePair(store, from.id, to.id))) continue;
    try {
      const res = await applyMerge(store, { entityId: from.id, canonicalId: to.id, reason, actor: 'entity-context' });
      if (res.outcome === 'merged') {
        stats.merged++;
        progress(`entities: merged ${from.name} into ${to.name} — ${reason}`);
      }
    } catch (err) {
      progress(`entities: rename merge ${from.name} → ${to.name} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** Alias suggestions filed in one run: with the duplicate audit's 50 a night, what a person can look through. */
export const ALIAS_SUGGESTIONS_PER_RUN = 50;

/**
 * An entity whose alias list names another live entity of the same specific
 * type: filed as a merge suggestion with the alias as its reason, never merged
 * on that alone. A weak alias (two Latin letters, a short number, a stop
 * word) proposes nothing, as in the duplicate audit. Of the rest the
 * likeliest and the most used come first — each lists the other's name, then
 * the pair whose less-mentioned side is mentioned most — and a run files
 * ALIAS_SUGGESTIONS_PER_RUN at most, beside the audit's own cap: the first
 * run at finance size filed 5,873 at once (2026-11-13), more than anyone reads.
 */
async function suggestAliasMerges(store: Store, stats: EntityContextStats): Promise<void> {
  const rows = await store.query<{ a: string; a_name: string; a_type: string; a_mentions: number; b: string; b_name: string; b_mentions: number; alias: string; mutual: boolean }>(
    // the aliases first, then the entities they name: joined the other way round, the planner
    // paired every entity with every other of its type (20k organizations: 4.5 minutes)
    `WITH al AS MATERIALIZED (
       SELECT ea.id, ea.name, ea.type, ea.mention_count, lower(a.alias) AS alias
       FROM entities ea CROSS JOIN LATERAL jsonb_array_elements_text(ea.aliases) AS a(alias)
       WHERE ea.tx_to IS NULL AND ea.canonical_id IS NULL AND ea.type NOT IN ('concept', 'other') AND length(a.alias) >= 2
     )
     SELECT al.id AS a, al.name AS a_name, al.type AS a_type, al.mention_count AS a_mentions,
            eb.id AS b, eb.name AS b_name, eb.mention_count AS b_mentions, al.alias,
            EXISTS (SELECT 1 FROM jsonb_array_elements_text(eb.aliases) AS x(alias) WHERE lower(x.alias) = lower(al.name)) AS mutual
     FROM al JOIN entities eb ON lower(eb.name) = al.alias
     WHERE eb.id <> al.id AND eb.tx_to IS NULL AND eb.canonical_id IS NULL AND eb.type = al.type`,
  );
  if (rows.length === 0) return;
  // the generic words alone: a name frequent in this corpus is its hub, and a hub has duplicates too
  const { linkStop } = await tier0Known(store);
  const pairs = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (weakLinkKey(keyOf(r.alias), { isName: true, stop: linkStop })) continue;
    const id = mergeSuggestionId(r.a, r.b);
    // listed from both sides, one pair: the side with more mentions keeps the name
    const prev = pairs.get(id);
    if (!prev || r.a_mentions > prev.a_mentions) pairs.set(id, r);
  }
  const filed = new Set(
    (await store.query<{ id: string }>(`SELECT id FROM suggestions WHERE id = ANY($1::text[]) AND status <> 'stale'`, [[...pairs.keys()]])).map((s) => s.id),
  );
  const ranked = [...pairs.entries()]
    .filter(([id]) => !filed.has(id))
    .sort(([x, p], [y, r]) => Number(r.mutual) - Number(p.mutual) || Math.min(r.a_mentions, r.b_mentions) - Math.min(p.a_mentions, p.b_mentions) || (x < y ? -1 : 1));
  for (const [id, r] of ranked) {
    if (stats.suggested >= ALIAS_SUGGESTIONS_PER_RUN) break;
    if (await namesakePair(store, r.a, r.b)) continue;
    const reason = `"${r.a_name}" 的别名列表含有 "${r.b_name}"（同为 ${r.a_type}）`;
    await store.query(
      `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload)
       VALUES ($1, 'merge', $2, $3, $4::jsonb, 'pending', $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, evidence = EXCLUDED.evidence, payload = EXCLUDED.payload, status = 'pending'`,
      [
        id, `合并重复实体: ${r.b_name} → ${r.a_name}`,
        `${reason}。接受后 "${r.b_name}" 会指向 "${r.a_name}"（可撤销：knode-os entities unmerge ${r.b}）。`,
        JSON.stringify([`${r.b_name} ↔ ${r.a_name}`, reason]),
        JSON.stringify({ entityId: r.b, canonicalId: r.a, score: 0.97, reason, llm: null }),
      ],
    );
    await writeDeps(store, { kind: 'suggestion', id }, [{ kind: 'entity', id: r.a, required: true }, { kind: 'entity', id: r.b, required: true }]);
    stats.suggested++;
  }
}

/* --------------------------------- namesakes --------------------------------- */

/** Entity types that tell one person's context from another's. */
const CONTEXT_TYPES = ['person', 'organization', 'project', 'product', 'component'];
/** Types that may anchor a context: the team, company or project a person belongs to. */
const ANCHOR_TYPES = new Set(['organization', 'project']);
/** Documents a person name needs before its contexts are compared. */
const MIN_DOCS = 6;
/** The most documents of one name compared (a celebrity in a news corpus is one person in many contexts). */
const MAX_DOCS = 600;

export interface NamesakeDoc {
  id: string;
  path: string;
  date: string | null;
  /** Entity ids co-mentioned with the name in this document (context types only). */
  context: Set<string>;
}

export interface NamesakeCluster {
  docs: NamesakeDoc[];
  /** Anchors: an organization or project in most of this cluster's documents and almost none of the other's. */
  anchors: string[];
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / Math.max(1, a.size + b.size - shared);
}

/**
 * The documents of one name split into contexts that are two people, or null.
 * Documents join when their co-mentions mostly agree (Jaccard ≥ 0.3), and a
 * split needs all of: two clusters holding ≥ 90% of the documents, each ≥ 3
 * documents and ≥ 15%; contexts that barely meet (Jaccard of their unions <
 * 0.25); an anchor of each side (≥ 60% of its documents, ≤ 5% of the other's);
 * and both active at the same time (their date ranges overlap by ≥ 30% of
 * the shorter) — a person who moved teams has one context before and another
 * after, which is no namesake. Exported for tests.
 */
export function namesakeClusters(docs: NamesakeDoc[], typeOf: (id: string) => string | undefined): [NamesakeCluster, NamesakeCluster] | null {
  if (docs.length < MIN_DOCS) return null;
  const parent = docs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      if (find(i) !== find(j) && jaccard(docs[i].context, docs[j].context) >= 0.3) parent[find(i)] = find(j);
    }
  }
  const groups = [...groupBy(docs.map((d, i) => ({ d, i })), (x) => String(find(x.i))).values()].map((g) => g.map((x) => x.d)).sort((a, b) => b.length - a.length);
  if (groups.length < 2) return null;
  const [a, b] = groups;
  if (a.length + b.length < 0.9 * docs.length) return null;
  if (b.length < 3 || b.length < 0.15 * docs.length) return null;
  const union = (g: NamesakeDoc[]) => new Set(g.flatMap((d) => [...d.context]));
  if (jaccard(union(a), union(b)) >= 0.25) return null;
  const share = (g: NamesakeDoc[], id: string) => g.filter((d) => d.context.has(id)).length / g.length;
  const anchorsOf = (own: NamesakeDoc[], other: NamesakeDoc[]) =>
    [...union(own)]
      .filter((id) => ANCHOR_TYPES.has(typeOf(id) ?? '') && share(own, id) >= 0.6 && share(other, id) <= 0.05)
      .sort((x, y) => share(own, y) - share(own, x) || x.localeCompare(y));
  const anchorsA = anchorsOf(a, b);
  const anchorsB = anchorsOf(b, a);
  if (anchorsA.length === 0 || anchorsB.length === 0) return null;
  const range = (g: NamesakeDoc[]) => {
    const dates = g.map((d) => d.date).filter((x): x is string => Boolean(x)).sort();
    return dates.length ? [Date.parse(dates[0]), Date.parse(dates[dates.length - 1])] as const : null;
  };
  const ra = range(a);
  const rb = range(b);
  if (!ra || !rb) return null;
  const overlap = Math.min(ra[1], rb[1]) - Math.max(ra[0], rb[0]);
  const shorter = Math.max(1, Math.min(ra[1] - ra[0], rb[1] - rb[0]));
  if (overlap < 0.3 * shorter) return null;
  return [{ docs: a, anchors: anchorsA }, { docs: b, anchors: anchorsB }];
}

/** Re-apply documents' tier-1 extractions from their sidecars; a document without a whole one is left alone (no model call is ever queued). */
async function replayDocuments(store: Store, config: KnodeConfig, docs: { id: string; path: string }[], progress: (msg: string) => void): Promise<number> {
  const { enqueueTier1, planQueuedDocument, dequeueDocument, queuedDocuments } = await import('./tier1.js');
  let replayed = 0;
  for (const d of docs) {
    const t1 = readSidecarPart(store.dataDir, d.path, 'tier1');
    if (!t1 || t1.status !== 'done') continue;
    const [queuedBefore] = await store.query<{ n: number }>(`SELECT count(*)::int AS n FROM extraction_queue WHERE document_id = $1`, [d.id]);
    await enqueueTier1(store, d.id);
    const [row] = (await queuedDocuments(store)).filter((r) => r.document_id === d.id);
    if (!row) continue;
    const planned = await planQueuedDocument(store, config, row, { onProgress: progress });
    if (planned.kind === 'replayed') replayed++;
    // not replayable after all: back as it was, so no model call is spent on a decision of ours
    else if (planned.kind === 'plan' && queuedBefore.n === 0) await dequeueDocument(store, d.id);
  }
  return replayed;
}

async function splitNamesakes(store: Store, config: KnodeConfig | undefined, stats: EntityContextStats, progress: (msg: string) => void): Promise<void> {
  const people = await store.query<{ id: string; name: string; docs: number }>(
    `SELECT e.id, e.name, count(DISTINCT m.document_id)::int AS docs
     FROM entities e JOIN entity_mentions m ON m.entity_id = e.id
     WHERE e.tx_to IS NULL AND e.canonical_id IS NULL AND e.type = 'person'
       AND NOT EXISTS (SELECT 1 FROM entities x WHERE x.canonical_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM entity_namesakes n WHERE n.base_id = e.id OR n.id = e.id)
     GROUP BY e.id, e.name HAVING count(DISTINCT m.document_id) BETWEEN $1 AND $2`,
    [MIN_DOCS, MAX_DOCS],
  );
  if (people.length === 0) return;
  const pause = breather();
  for (const p of people) {
    await pause();
    const rows = await store.query<{ document_id: string; path: string; doc_date: string | Date | null; other: string | null; other_type: string | null }>(
      // one row per document and co-mentioned entity: a mention is a row per chunk, and read as
      // they are a name's documents came back up to 208,361 rows (finance, 2026-11-13: 20 million rows
      // for 1,619 names, 34,513 at most once distinct)
      `WITH d AS (SELECT DISTINCT document_id FROM entity_mentions WHERE entity_id = $1)
       SELECT DISTINCT d.document_id, doc.path, doc.doc_date, o.id AS other, o.type AS other_type
       FROM d JOIN documents doc ON doc.id = d.document_id
       LEFT JOIN entity_mentions m ON m.document_id = d.document_id AND m.entity_id <> $1
       LEFT JOIN entities o ON o.id = m.entity_id AND o.tx_to IS NULL AND o.type = ANY($2::text[])`,
      [p.id, CONTEXT_TYPES],
    );
    const types = new Map<string, string>();
    const docs = [...groupBy(rows, (r) => r.document_id).values()].map((g) => {
      const context = new Set<string>();
      for (const r of g) if (r.other && r.other_type) {
        context.add(r.other);
        types.set(r.other, r.other_type);
      }
      return { id: g[0].document_id, path: g[0].path, date: toIso(g[0].doc_date), context };
    });
    const split = namesakeClusters(docs, (id) => types.get(id));
    if (!split) continue;
    const [base, other] = split;
    const anchorNames = async (ids: string[]) => (await store.query<{ id: string; name: string }>(`SELECT id, name FROM entities WHERE id = ANY($1::text[])`, [ids]))
      .sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id)).map((e) => e.name);
    const otherAnchors = await anchorNames(other.anchors);
    const baseAnchors = await anchorNames(base.anchors);
    const label = otherAnchors[0];
    const variantName = `${p.name}（${label}）`;
    const variantId = slugify(variantName);
    const reason = `同名不同人：${base.docs.length} 篇文档与 ${baseAnchors.join('、')} 同现，${other.docs.length} 篇与 ${otherAnchors.join('、')} 同现，同一时期内两组共现实体几乎不重合`;
    await store.query(
      `INSERT INTO entity_namesakes (id, base_id, name, label, anchors, base_anchors, documents, reason)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)
       ON CONFLICT (id) DO UPDATE SET anchors = EXCLUDED.anchors, base_anchors = EXCLUDED.base_anchors, documents = EXCLUDED.documents, reason = EXCLUDED.reason`,
      [variantId, p.id, p.name, label, JSON.stringify(otherAnchors), JSON.stringify(baseAnchors), JSON.stringify(other.docs.map((d) => d.path).sort()), reason],
    );
    stats.split++;
    progress(`entities: ${p.name} split — ${reason}`);
    if (config) stats.replayed += await replayDocuments(store, config, other.docs, progress);
    // the two never come up as duplicates again: recorded as a decided pair
    const [variant] = await store.query<{ id: string }>(`SELECT id FROM entities WHERE id = $1 AND tx_to IS NULL`, [variantId]);
    if (variant) {
      const id = mergeSuggestionId(p.id, variantId);
      await store.query(
        `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload)
         VALUES ($1, 'merge', $2, $3, $4::jsonb, 'rejected', $5::jsonb)
         ON CONFLICT (id) DO UPDATE SET status = 'rejected', body = EXCLUDED.body, payload = EXCLUDED.payload`,
        [id, `合并重复实体: ${variantName} → ${p.name}`, reason, JSON.stringify([reason]), JSON.stringify({ entityId: variantId, canonicalId: p.id, reason, namesake: true, llm: { same: false, confidence: 1, reason, model: 'rule' } })],
      );
    }
  }
}

export type { NamesakeRule } from './identity.js';

/** The namesake rules for these names: name (lower case) → its variants. */
export async function namesakeRules(q: Queryable, names: string[]): Promise<Map<string, NamesakeRule[]>> {
  const lower = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))];
  if (lower.length === 0) return new Map();
  const rows = await q.query<NamesakeRule>(
    `SELECT id, base_id, name, label, anchors, base_anchors FROM entity_namesakes WHERE lower(name) = ANY($1::text[])`,
    [lower],
  );
  return groupBy(rows, (r) => r.name.toLowerCase());
}

/**
 * Which of a split name's people a document means: the variant whose anchors
 * the document's own entities name most, if it names more of them than of the
 * base person's; else null (the base person keeps the name).
 */
export function namesakeChoice(rules: NamesakeRule[], documentEntities: ExtractedEntity[]): NamesakeRule | null {
  const names = new Set(documentEntities.flatMap((e) => [e.name, ...(e.aliases ?? [])]).map((n) => n.trim().toLowerCase()));
  const score = (anchors: string[]) => anchors.filter((a) => names.has(a.toLowerCase())).length;
  const base = rules.length ? score(rules[0].base_anchors) : 0;
  let best: { rule: NamesakeRule; s: number } | null = null;
  for (const r of rules) {
    const s = score(r.anchors);
    if (s > 0 && s > base && (!best || s > best.s)) best = { rule: r, s };
  }
  return best?.rule ?? null;
}

/** Refine's entity step: rename merges, alias suggestions, namesake splits. */
export async function resolveEntityContext(store: Store, opts: { config?: KnodeConfig; onProgress?: (msg: string) => void } = {}): Promise<EntityContextStats> {
  const progress = opts.onProgress ?? (() => {});
  const stats: EntityContextStats = { merged: 0, suggested: 0, split: 0, replayed: 0 };
  await mergeRenames(store, stats, progress);
  await suggestAliasMerges(store, stats);
  await splitNamesakes(store, opts.config, stats, progress);
  return stats;
}
