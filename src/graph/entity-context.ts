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
import { ANCHOR_TYPES as ANCHOR_TYPE_LIST, Code, codeOf, Codes, codesDiffer, codesOf, namesakeName, NamesakeRule } from './identity.js';
import { keyOf, nameKey, typesCompatible } from './normalize.js';
import { namesApartByCode } from './resolve.js';
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
 *            follows from then on (identity.ts, namesakeFor). With
 *            review.identity "context" a document with no date of its own is
 *            dated by the dates its claims state (their median), and the two
 *            contexts are compared by what each is about.
 *   coded    (only with review.identity "context") one entity of an instance
 *            type whose documents carry two or more codes of one kind
 *            (T1-C1, D2T1-C1 … D10T1-C1), each code's documents under a roof of its
 *            own, is as many things: every such code gets an entity
 *            "name（roof · code）" and its documents are re-applied to it, those that
 *            name the thing without a code going by the roof they name. This
 *            is the only split of anything but a person. Disjoint contexts
 *            alone do not part a thing: a technology, a product or a sector
 *            is used under many roofs and stays one (on finance 1,848 names
 *            have two or more owners), so the namesake rule stays with
 *            people, who are in one team at a time. A code is an identifier
 *            the sources themselves give the thing — and even then only
 *            where the roofs differ, because an extraction also lists kinds
 *            as aliases (芯片: H100, H200).
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

/**
 * Types a renamed thing may carry under its two names: the same, or a project
 * and a product — an extraction types "箕宿系统" a product and the "心宿方案" it
 * became a project (1 of 25 stated renames on the 10× benchmark stayed two
 * entities for that alone).
 */
export function renameTypes(a: string, b: string): boolean {
  if (a === b) return true;
  const pair = new Set([a, b]);
  return pair.has('project') && pair.has('product');
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
  const pairs = olds.flatMap((from) => news.filter((to) => to.id !== from.id && renameTypes(from.type, to.type)).map((to) => ({ from, to })));
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
export const CONTEXT_TYPES = ['person', 'organization', 'project', 'product', 'component'];
/** Types that may anchor a context: the team, company or project a person belongs to. */
const ANCHOR_TYPES = new Set(ANCHOR_TYPE_LIST);
/** Documents a person name needs before its contexts are compared. */
export const MIN_DOCS = 6;
/** The most documents of one name compared (a celebrity in a news corpus is one person in many contexts). */
export const MAX_DOCS = 600;

export interface NamesakeDoc {
  id: string;
  path: string;
  date: string | null;
  /** The language the document is written in, when known. */
  language?: string | null;
  /** Entity ids co-mentioned with the name in this document (context types only). */
  context: Set<string>;
}

export interface NamesakeCluster {
  docs: NamesakeDoc[];
  /** Anchors: an organization or project in most of this cluster's documents and almost none of the other's. */
  anchors: string[];
}

/** An organization before a project: the first anchor names the parted entity, and a team says whose it is better than one of the team's projects. */
function roofFirst(typeOf: (id: string) => string | undefined, x: string, y: string): number {
  return Number(typeOf(y) === 'organization') - Number(typeOf(x) === 'organization');
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / Math.max(1, a.size + b.size - shared);
}

/** The share of a cluster's documents an entity must be in to count as its context: one report that names a customer is not what the cluster is about. */
const CHARACTERISTIC_SHARE = 0.2;
/** One cluster's documents mostly before a date and the other's mostly after it: one person who moved. */
const SEQUENTIAL_SHARE = 0.7;
/** The share of each cluster's documents that must carry a date before the dates say anything about the cluster. */
const DATED_SHARE = 0.5;

/**
 * How far two sets of dates are one after the other: the largest share s such
 * that s of one set lies on or before some date and s of the other after it.
 * 1 for a clean hand-over, about 0.5 for two that run side by side all along.
 */
export function sequentialShare(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let best = 0;
  for (const cut of new Set([...a, ...b])) {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      best = Math.max(best, Math.min(x.filter((d) => d <= cut).length / x.length, y.filter((d) => d > cut).length / y.length));
    }
  }
  return best;
}

/**
 * The documents of one name split into contexts that are two people, or null.
 * Documents join when their co-mentions mostly agree (Jaccard ≥ 0.3), and a
 * split needs all of: two clusters holding ≥ 90% of the documents, each ≥ 3
 * documents and ≥ 15%; contexts that barely meet (Jaccard < 0.25 of
 * everything each cluster names — or, with `characteristic`, of what each is
 * about: the entities in CHARACTERISTIC_SHARE of its documents or more, since
 * two teams both name the security team or a customer now and then); an
 * anchor of each side (≥ 60% of its documents, ≤ 5% of the other's); both
 * clusters mostly in one language (a Chinese and an English account of one
 * person name the same organizations as different entities until those are
 * merged); and both active at the same time — a person who moved teams has
 * one context before and another after, which is no namesake. For that, at
 * least DATED_SHARE of each cluster's documents carry a date (three dated
 * reports say nothing of thirty undated ones), the date ranges overlap by
 * ≥ 30% of the shorter, and the documents are not one cluster's first and
 * then the other's (sequentialShare < SEQUENTIAL_SHARE). The range alone is
 * fooled by a look back: on the 10× benchmark 13 people who changed teams
 * were named months later in their old team's incident reviews, and split
 * (2026-11-15). Exported for tests.
 */
export function namesakeClusters(
  docs: NamesakeDoc[],
  typeOf: (id: string) => string | undefined,
  opts: { characteristic?: boolean } = {},
): [NamesakeCluster, NamesakeCluster] | null {
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
  const share = (g: NamesakeDoc[], id: string) => g.filter((d) => d.context.has(id)).length / g.length;
  const about = (g: NamesakeDoc[]) => new Set([...union(g)].filter((id) => share(g, id) >= CHARACTERISTIC_SHARE));
  if (jaccard(opts.characteristic ? about(a) : union(a), opts.characteristic ? about(b) : union(b)) >= 0.25) return null;
  const language = (g: NamesakeDoc[]) => {
    const counts = new Map<string, number>();
    for (const d of g) if (d.language) counts.set(d.language, (counts.get(d.language) ?? 0) + 1);
    return [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0];
  };
  const [la, lb] = [language(a), language(b)];
  if (la && lb && la !== lb) return null;
  const anchorsOf = (own: NamesakeDoc[], other: NamesakeDoc[]) =>
    [...union(own)]
      .filter((id) => ANCHOR_TYPES.has(typeOf(id) ?? '') && share(own, id) >= 0.6 && share(other, id) <= 0.05)
      .sort((x, y) => roofFirst(typeOf, x, y) || share(own, y) - share(own, x) || x.localeCompare(y));
  const anchorsA = anchorsOf(a, b);
  const anchorsB = anchorsOf(b, a);
  if (anchorsA.length === 0 || anchorsB.length === 0) return null;
  const dates = (g: NamesakeDoc[]) => g.map((d) => d.date).filter((x): x is string => Boolean(x)).sort();
  const da = dates(a);
  const db = dates(b);
  if (da.length === 0 || db.length === 0 || da.length < DATED_SHARE * a.length || db.length < DATED_SHARE * b.length) return null;
  const ra = [Date.parse(da[0]), Date.parse(da[da.length - 1])] as const;
  const rb = [Date.parse(db[0]), Date.parse(db[db.length - 1])] as const;
  const overlap = Math.min(ra[1], rb[1]) - Math.max(ra[0], rb[0]);
  const shorter = Math.max(1, Math.min(ra[1] - ra[0], rb[1] - rb[0]));
  if (overlap < 0.3 * shorter) return null;
  if (sequentialShare(da, db) >= SEQUENTIAL_SHARE) return null;
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

/** The scopes a document's own evidence is written under: the document, and its tier-1 extraction. Scopes are indexed by (kind, key). */
const DOCUMENT_SCOPES = ['doc', 'tier1'];

/** The middle one of some dates (ISO strings); null for none. */
export function medianDate(dates: readonly string[]): string | null {
  const sorted = dates.filter(Boolean).sort();
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
}

/** An entity's documents with the context-type entities each co-mentions, and the type of each of those. */
/**
 * Entities the duplicate audit has proposed to merge and nobody has decided
 * on yet: id → one id for the pair (or the chain of pairs). Two such
 * spellings of one organization (三星 / Samsung Electronics) are one roof for
 * the splits below — a wrong split is worse than a missed one, so a pair that
 * may be one thing is not what parts a name. A pair a person or the judge
 * rejected is two things; one that was merged is one already. Where the
 * audit has not looked at a pair yet, nothing says it is one: that is the
 * limit of this, and why refine runs the splits after the audit. (On the 10×
 * run's index the pending pairs are the 58 the judge called the same below
 * its merge threshold — renamed projects mostly — and none pairs two teams.)
 */
async function pendingSame(store: Store): Promise<Map<string, string>> {
  const pairs = await store.query<{ a: string | null; b: string | null }>(
    `SELECT payload->>'entityId' AS a, payload->>'canonicalId' AS b FROM suggestions
     WHERE kind = 'merge' AND status = 'pending' AND coalesce(payload->'llm'->>'same', 'true') <> 'false'`,
  );
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x);
    if (p === undefined || p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  for (const { a, b } of pairs) {
    if (!a || !b) continue;
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const out = new Map<string, string>();
  for (const id of parent.keys()) out.set(id, find(id));
  return out;
}

async function contextDocs(
  store: Store,
  entityId: string,
  /**
   * `claimDates`: date a document that has no date of its own by the dates its claims state.
   * `same`: co-mentions that may be one entity (pendingSame) count as one.
   */
  opts: { claimDates?: boolean; same?: Map<string, string> } = {},
): Promise<{ docs: NamesakeDoc[]; types: Map<string, string> }> {
  const rows = await store.query<{ document_id: string; path: string; doc_date: string | Date | null; language: string | null; other: string | null; other_type: string | null }>(
    // one row per document and co-mentioned entity: a mention is a row per chunk, and read as
    // they are a name's documents came back up to 208,361 rows (finance, 2026-11-13: 20 million rows
    // for 1,619 names, 34,513 at most once distinct)
    `WITH d AS (SELECT DISTINCT document_id FROM entity_mentions WHERE entity_id = $1)
     SELECT DISTINCT d.document_id, doc.path, doc.doc_date, doc.language, o.id AS other, o.type AS other_type
     FROM d JOIN documents doc ON doc.id = d.document_id
     LEFT JOIN entity_mentions m ON m.document_id = d.document_id AND m.entity_id <> $1
     LEFT JOIN entities x ON x.id = m.entity_id AND x.tx_to IS NULL
     -- a co-mention merged into another entity counts as that entity: 三星 and Samsung Electronics are one roof
     LEFT JOIN entities o ON o.id = coalesce(x.canonical_id, x.id) AND o.id <> $1 AND o.tx_to IS NULL AND o.type = ANY($2::text[])`,
    [entityId, CONTEXT_TYPES],
  );
  const types = new Map<string, string>();
  const docs = [...groupBy(rows, (r) => r.document_id).values()].map((g) => {
    const context = new Set<string>();
    for (const r of g) if (r.other && r.other_type) {
      const other = opts.same?.get(r.other) ?? r.other;
      if (other === entityId) continue;
      context.add(other);
      if (!types.has(other) || other === r.other) types.set(other, r.other_type);
    }
    return { id: g[0].document_id, path: g[0].path, date: toIso(g[0].doc_date), language: g[0].language || null, context };
  }).sort((x, y) => x.path.localeCompare(y.path)); // a fixed order: the clusters below must not depend on how the rows came back
  // a document with no date of its own: the middle of the dates its claims state (a weekly report
  // states its week in every figure; a plan or a look back is the odd one out)
  const undated = opts.claimDates ? docs.filter((d) => !d.date) : [];
  if (undated.length > 0) {
    const stated = await store.query<{ document_id: string; at: string | Date }>(
      // a claim is tied to a document by the evidence of that document's scope (its path is the scope's key)
      `SELECT d.id AS document_id, coalesce(c.event_at, c.valid_from) AS at
       FROM documents d JOIN scopes s ON s.kind = ANY($2::text[]) AND s.key = d.path
       JOIN evidence ev ON ev.scope_id = s.id AND ev.kind = 'claim' AND ev.tx_to IS NULL
       JOIN claims c ON c.id = ev.target_id AND c.tx_to IS NULL
       WHERE d.id = ANY($1::text[]) AND c.date_source = 'stated' AND coalesce(c.event_at, c.valid_from) IS NOT NULL`,
      [undated.map((d) => d.id), DOCUMENT_SCOPES],
    );
    const byDoc = groupBy(stated, (r) => r.document_id);
    for (const d of undated) d.date = medianDate((byDoc.get(d.id) ?? []).map((r) => toIso(r.at)).filter((x): x is string => Boolean(x)));
  }
  return { docs, types };
}

/** The entities named `ids`, in that order. */
async function namesOf(store: Store, ids: string[]): Promise<string[]> {
  return (await store.query<{ id: string; name: string }>(`SELECT id, name FROM entities WHERE id = ANY($1::text[])`, [ids]))
    .sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id)).map((e) => e.name);
}

/** One split refine has decided on: the rule, the documents that go with the parted entity, and why. */
interface Parting {
  rule: NamesakeRule;
  docs: { id: string; path: string }[];
  reason: string;
  /** What the progress line calls the entity that is parted. */
  of: string;
}

/**
 * Carry out the splits one phase decided on: every rule first, then every
 * document of every parted entity re-applied once, in path order. The
 * decisions were all read from the graph as the phase found it, so neither
 * the order entities were read in nor the order these are applied in changes
 * what comes out; what one split makes visible (a team's setting now an
 * entity of its own, in the documents of another name) is for the next pass.
 */
async function applyPartings(
  store: Store,
  config: KnodeConfig | undefined,
  partings: Parting[],
  stats: EntityContextStats,
  progress: (msg: string) => void,
  relink: string[],
): Promise<void> {
  for (const p of partings) {
    await store.query(
      `INSERT INTO entity_namesakes (id, base_id, name, label, anchors, base_anchors, documents, reason)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)
       ON CONFLICT (id) DO UPDATE SET anchors = EXCLUDED.anchors, base_anchors = EXCLUDED.base_anchors, documents = EXCLUDED.documents, reason = EXCLUDED.reason`,
      [p.rule.id, p.rule.base_id, p.rule.name, p.rule.label, JSON.stringify(p.rule.anchors), JSON.stringify(p.rule.base_anchors), JSON.stringify(p.docs.map((d) => d.path).sort()), p.reason],
    );
    if (p.rule.id === p.rule.base_id) continue; // what the entity itself keeps: on record, nothing moves
    stats.split++;
    progress(`entities: ${p.of} split — ${p.reason}`);
  }
  if (!config) return;
  const docs = new Map<string, { id: string; path: string }>();
  for (const p of partings) if (p.rule.id !== p.rule.base_id) for (const d of p.docs) docs.set(d.path, d);
  const ordered = [...docs.values()].sort((x, y) => x.path.localeCompare(y.path));
  // the documents' own links to the name (tier 0: the name found in the text) follow the split too: once, when every split of this run is made
  relink.push(...ordered.map((d) => d.path));
  stats.replayed += await replayDocuments(store, config, ordered, progress);
}

/**
 * The two never come up as duplicates again: every parted entity that is
 * live and its base are recorded as a decided pair — those refine parted and
 * those write-time resolution did (resolve.ts, partByCode).
 */
async function decidePartedPairs(store: Store): Promise<void> {
  const rules = await store.query<{ id: string; base_id: string; name: string; label: string; reason: string; variant: string; base_name: string }>(
    `SELECT n.id, n.base_id, n.name, n.label, n.reason, v.name AS variant, b.name AS base_name
     FROM entity_namesakes n JOIN entities v ON v.id = n.id AND v.tx_to IS NULL JOIN entities b ON b.id = n.base_id AND b.tx_to IS NULL
     WHERE n.id <> n.base_id`,
  );
  if (rules.length === 0) return;
  const decided = new Set(
    (await store.query<{ id: string }>(`SELECT id FROM suggestions WHERE id = ANY($1::text[]) AND payload->>'namesake' = 'true'`, [rules.map((r) => mergeSuggestionId(r.base_id, r.id))])).map((r) => r.id),
  );
  for (const r of rules) {
    const id = mergeSuggestionId(r.base_id, r.id);
    if (decided.has(id)) continue;
    await store.query(
      `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload)
       VALUES ($1, 'merge', $2, $3, $4::jsonb, 'rejected', $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET status = 'rejected', body = EXCLUDED.body, payload = EXCLUDED.payload`,
      [id, `合并重复实体: ${r.variant} → ${r.base_name}`, r.reason, JSON.stringify([r.reason]), JSON.stringify({ entityId: r.id, canonicalId: r.base_id, reason: r.reason, namesake: true, llm: { same: false, confidence: 1, reason: r.reason, model: 'rule' } })],
    );
  }
}

async function splitNamesakes(store: Store, config: KnodeConfig | undefined, stats: EntityContextStats, progress: (msg: string) => void, relink: string[], same: Map<string, string>): Promise<void> {
  // what a workspace turns on with review.identity "context": documents dated by their claims, contexts compared by what they are about
  const wider = config?.review?.identity === 'context';
  const people = await store.query<{ id: string; name: string; docs: number }>(
    `SELECT e.id, e.name, count(DISTINCT m.document_id)::int AS docs
     FROM entities e JOIN entity_mentions m ON m.entity_id = e.id
     WHERE e.tx_to IS NULL AND e.canonical_id IS NULL AND e.type = 'person'
       AND NOT EXISTS (SELECT 1 FROM entities x WHERE x.canonical_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM entity_namesakes n WHERE n.base_id = e.id OR n.id = e.id)
     GROUP BY e.id, e.name HAVING count(DISTINCT m.document_id) BETWEEN $1 AND $2
     ORDER BY e.id`,
    [MIN_DOCS, MAX_DOCS],
  );
  if (people.length === 0) return;
  const pause = breather();
  const partings: Parting[] = [];
  for (const p of people) {
    await pause();
    const { docs, types } = await contextDocs(store, p.id, { claimDates: wider, same });
    const split = namesakeClusters(docs, (id) => types.get(id), { characteristic: wider });
    if (!split) continue;
    const [base, other] = split;
    const otherAnchors = await namesOf(store, other.anchors);
    const baseAnchors = await namesOf(store, base.anchors);
    const rule: NamesakeRule = { id: '', base_id: p.id, name: p.name, label: otherAnchors[0], anchors: otherAnchors, base_anchors: baseAnchors };
    rule.id = slugify(namesakeName(rule));
    const reason = `同名不同人：${base.docs.length} 篇文档与 ${baseAnchors.join('、')} 同现，${other.docs.length} 篇与 ${otherAnchors.join('、')} 同现，同一时期内两组共现实体几乎不重合`;
    partings.push({ rule, docs: other.docs, reason, of: p.name });
  }
  await applyPartings(store, config, partings, stats, progress, relink);
}

/* ----------------------------------- coded ----------------------------------- */

/**
 * The entity types a code may part: a thing that is one instance — a setting,
 * a part of a system — and what extraction could not type. A product, a
 * technology, a sector, a concept is a category: several makers' kinds of it
 * (DRAM: DDR4, DDR5) are one entity however the makers divide, and the only
 * evidence for the split, the 10× benchmark's settings, is of these types.
 */
export const CODED_TYPES: readonly string[] = ['component', 'other'];
/** Documents a code needs before it may part a name. */
const CODE_MIN_DOCS = 2;
/** The share of an entity's documents the codes' roofs must account for before they part it. */
const CODE_COVERAGE = 0.8;

export interface CodedDoc extends NamesakeDoc {
  /** The codes the entity's mention in this document carries (identity.ts, codesOf). */
  codes: Codes;
}

export interface CodedPart {
  code: Code;
  docs: CodedDoc[];
  /** Organizations or projects in most of this code's documents and almost none of the other codes'. */
  anchors: string[];
}

export interface CodedSplit {
  /** The codes that are things of their own, the one with the most documents first. */
  parts: CodedPart[];
  /** What stays with the entity: documents of no part. */
  rest: CodedDoc[];
  restAnchors: string[];
}

/**
 * One entity's documents parted by the codes its mentions carry, or null.
 *
 * A code is written once or twice — where the thing is introduced — and the
 * other documents name the thing without it. So the documents that carry a
 * code are the seed of a group, and a document without one joins the group
 * it is most like: its co-mentions agree with a document of that group
 * (Jaccard ≥ 0.3) and with no other group's as well. That repeats while
 * groups grow. A split then needs all of:
 *
 *   - two or more codes that differ as identifiers of one kind do
 *     (identity.ts, codesDiffer), each of its group at least CODE_MIN_DOCS
 *     documents;
 *   - an anchor of each group: an organization or project in ≥ 60% of its
 *     documents, ≤ 5% of the other groups', and in no document that carries
 *     another of the codes — a roof has one such thing, and its code names
 *     it. Kinds listed as aliases (H100 and H200 under 芯片), one code
 *     written short and long, and a maker whose notes carry DDR4 here and
 *     DDR5 there share their context and find none;
 *   - the roofs account for the entity: CODE_COVERAGE of its documents are
 *     in a group, or stay under a roof of their own that no group's
 *     documents name. Two codes seen twice each in a hub of hundreds of
 *     documents (DRAM: DDR4, DDR5) find organizations of their own by
 *     chance, but most of the hub's documents are like neither (finance,
 *     2026-11-15: without this test 10 names would have parted).
 *
 * A document that carries two codes that differ, or is as much like one
 * group as another (a monthly report over several teams), stays. No test of
 * dates: a code is not a person, who may change teams. Exported for tests.
 */
export function codedClusters(docs: CodedDoc[], typeOf: (id: string) => string | undefined): CodedSplit | null {
  const byValue = new Map<string, { code: Code; docs: CodedDoc[] }>();
  for (const d of docs) for (const c of d.codes.values()) (byValue.get(c.value) ?? byValue.set(c.value, { code: c, docs: [] }).get(c.value)!).docs.push(d);
  // codes that differ from one another, directly or through a third: one kind of identifier
  const all = [...byValue.values()];
  const kind = all.map((_, i) => i);
  const find = (i: number): number => (kind[i] === i ? i : (kind[i] = find(kind[i])));
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (codesDiffer(all[i].code, all[j].code)) kind[find(i)] = find(j);
  const share = (g: CodedDoc[], id: string) => (g.length ? g.filter((d) => d.context.has(id)).length / g.length : 0);
  const ids = (g: CodedDoc[]) => new Set(g.flatMap((d) => [...d.context]));
  const anchorsOf = (own: CodedDoc[], other: CodedDoc[]) =>
    [...ids(own)]
      .filter((id) => ANCHOR_TYPES.has(typeOf(id) ?? '') && share(own, id) >= 0.6 && share(other, id) <= 0.05)
      .sort((x, y) => roofFirst(typeOf, x, y) || share(own, y) - share(own, x) || x.localeCompare(y));
  let best: CodedSplit | null = null;
  for (const members of groupBy(all.map((g, i) => ({ g, i })), (x) => String(find(x.i))).values()) {
    if (members.length < 2) continue;
    const values = new Set(members.map((x) => x.g.code.value));
    // the seeds: a document that carries one of these codes, and not two of them
    const carried = (d: CodedDoc) => [...d.codes.values()].filter((c) => values.has(c.value));
    const groups = members.map((x) => ({ code: x.g.code, docs: x.g.docs.filter((d) => carried(d).length === 1) })).filter((g) => g.docs.length > 0);
    if (groups.length < 2) continue;
    const seeded = new Set(docs.filter((d) => carried(d).length > 0));
    let open = docs.filter((d) => !seeded.has(d));
    // the documents that carry each code, before any other joined: where a roof must not show under two codes
    const seeds = new Map(groups.map((g) => [g, [...g.docs]]));
    for (let round = 0; round < 6 && open.length > 0; round++) {
      const joins: { d: CodedDoc; g: (typeof groups)[number] }[] = [];
      for (const d of open) {
        const like = groups.map((g) => ({ g, s: Math.max(...g.docs.map((o) => jaccard(d.context, o.context))) })).sort((a, b) => b.s - a.s);
        if (like[0].s >= 0.3 && like[0].s > like[1].s) joins.push({ d, g: like[0].g });
      }
      if (joins.length === 0) break;
      for (const j of joins) j.g.docs.push(j.d);
      const joined = new Set(joins.map((j) => j.d));
      open = open.filter((d) => !joined.has(d));
    }
    const parts: CodedPart[] = groups
      .filter((g) => g.docs.length >= CODE_MIN_DOCS)
      .map((g) => {
        const others = groups.filter((o) => o !== g);
        const underAnother = new Set(others.flatMap((o) => seeds.get(o)!).flatMap((d) => [...d.context]));
        return { code: g.code, docs: g.docs, anchors: anchorsOf(g.docs, others.flatMap((o) => o.docs)).filter((id) => !underAnother.has(id)) };
      })
      .filter((p) => p.anchors.length > 0);
    if (parts.length < 2) continue;
    const taken = new Set(parts.flatMap((p) => p.docs));
    const rest = docs.filter((d) => !taken.has(d));
    parts.sort((a, b) => b.docs.length - a.docs.length || a.code.value.localeCompare(b.code.value));
    const restAnchors = anchorsOf(rest, parts.flatMap((p) => p.docs));
    const accounted = docs.length - rest.filter((d) => !restAnchors.some((a) => d.context.has(a))).length;
    if (accounted < CODE_COVERAGE * docs.length) continue;
    const split: CodedSplit = { parts, rest, restAnchors };
    if (!best || split.parts.length > best.parts.length) best = split;
  }
  return best;
}

/** The spelling most of these mentions use that is no code, or null. */
function commonName(spellings: string[]): string | null {
  const counts = new Map<string, number>();
  for (const s of spellings) if (s.trim() && !codeOf(s)) counts.set(s.trim(), (counts.get(s.trim()) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

async function splitCoded(store: Store, config: KnodeConfig | undefined, stats: EntityContextStats, progress: (msg: string) => void, relink: string[], same: Map<string, string>): Promise<void> {
  // every live entity of a type a code may part, one of whose spellings has a digit; the codes are read here
  const rows = await store.query<{ id: string; name: string; aliases: string[] | null }>(
    `SELECT e.id, e.name, e.aliases FROM entities e
     WHERE e.tx_to IS NULL AND e.canonical_id IS NULL AND e.type = ANY($1::text[]) AND (e.name ~ '[0-9]' OR e.aliases::text ~ '[0-9]')
       AND NOT EXISTS (SELECT 1 FROM entity_namesakes n WHERE n.id = e.id AND n.id <> n.base_id)
     ORDER BY e.id`,
    [[...CODED_TYPES]],
  );
  const candidates = rows.filter((e) => {
    const codes = [e.name, ...(e.aliases ?? [])].map((x) => (typeof x === 'string' ? codeOf(x) : null)).filter((c): c is Code => c !== null);
    return codes.some((a, i) => codes.slice(i + 1).some((b) => codesDiffer(a, b)));
  });
  if (candidates.length === 0) return;
  // how many documents each is in, counted no further than the limit: an entity in more than MAX_DOCS
  // is a hub, and its co-mentions (the join below) are never read
  const counted = await store.query<{ id: string; n: number }>(
    `SELECT c.id, (SELECT count(*) FROM (SELECT DISTINCT m.document_id FROM entity_mentions m WHERE m.entity_id = c.id LIMIT $2) x)::int AS n
     FROM unnest($1::text[]) AS c(id)`,
    [candidates.map((e) => e.id), MAX_DOCS + 1],
  );
  const documents = new Map(counted.map((r) => [r.id, r.n]));
  const pause = breather();
  const partings: Parting[] = [];
  for (const e of candidates) {
    const n = documents.get(e.id) ?? 0;
    if (n < 2 * CODE_MIN_DOCS || n > MAX_DOCS) continue;
    await pause();
    const { docs, types } = await contextDocs(store, e.id, { same });
    // what each document's extraction called it: the entity evidence of that document's scope
    const said = await store.query<{ path: string; attrs: { name?: string; aliases?: string[]; resolved_from?: string } | null }>(
      `SELECT s.key AS path, ev.attrs FROM evidence ev JOIN scopes s ON s.id = ev.scope_id
       WHERE ev.kind = 'entity' AND ev.target_id = $1 AND ev.tx_to IS NULL`,
      [e.id],
    );
    const spellings = new Map<string, string[]>();
    for (const r of said) {
      const list = spellings.get(r.path) ?? spellings.set(r.path, []).get(r.path)!;
      for (const x of [r.attrs?.name, r.attrs?.resolved_from, ...(r.attrs?.aliases ?? [])]) if (typeof x === 'string') list.push(x);
    }
    // the entity's own name is in every evidence row once mentions were resolved onto it: only what the mention itself wrote counts
    const own = (path: string) => (spellings.get(path) ?? []).filter((x) => x !== e.name || codeOf(e.name) === null);
    const coded: CodedDoc[] = docs.map((d) => ({ ...d, codes: codesOf(own(d.path)) })).sort((x, y) => x.path.localeCompare(y.path));
    const split = codedClusters(coded, (id) => types.get(id));
    if (!split) continue;
    const rules = await store.query<{ id: string; label: string; anchors: string[] }>(`SELECT id, label, anchors FROM entity_namesakes WHERE base_id = $1`, [e.id]);
    const existing = new Set(rules.map((r) => codeOf(r.label)?.value));
    const self = rules.find((r) => r.id === e.id);
    // With nothing left for the entity itself, the code with the most documents keeps it — and that is
    // put on record (a row for the entity itself), so that it keeps the entity whatever later documents
    // bring: an entity's id is what its claims, its page and a person's corrections are filed under.
    const kept = !self && split.rest.length === 0 && !existing.has(split.parts[0].code.value) ? split.parts[0] : null;
    const display = codeOf(e.name) ? commonName(said.flatMap((r) => [r.attrs?.name ?? '', r.attrs?.resolved_from ?? '', ...(r.attrs?.aliases ?? [])])) ?? e.name : e.name;
    const baseAnchors = self ? self.anchors : await namesOf(store, kept ? kept.anchors : split.restAnchors);
    const parts = split.parts.filter((p) => p !== kept && !existing.has(p.code.value));
    if (kept && parts.length > 0) {
      const reason = `同名不同物：${e.name} 的 ${docs.length} 篇文档带有 ${split.parts.length} 个不同编号；${kept.docs.length} 篇属于 ${kept.code.raw}（与 ${baseAnchors.join('、')} 同现），文档最多，保留本实体`;
      partings.push({ rule: { id: e.id, base_id: e.id, name: display, label: kept.code.raw, anchors: baseAnchors, base_anchors: baseAnchors }, docs: kept.docs, reason, of: e.name });
    }
    for (const part of parts) {
      const anchors = await namesOf(store, part.anchors);
      const rule: NamesakeRule = { id: '', base_id: e.id, name: display, label: part.code.raw, anchors, base_anchors: baseAnchors };
      rule.id = slugify(namesakeName(rule));
      const [taken] = await store.query<{ id: string }>(`SELECT id FROM entities WHERE id = $1 AND tx_to IS NULL`, [rule.id]);
      if (taken) continue;
      const carrying = part.docs.filter((d) => [...d.codes.values()].some((c) => c.value === part.code.value)).length;
      const reason = `同名不同物：${e.name} 的 ${docs.length} 篇文档带有 ${split.parts.length} 个不同编号；${carrying} 篇带 ${part.code.raw}${part.docs.length > carrying ? `、另 ${part.docs.length - carrying} 篇未带编号` : ''}，与 ${anchors.join('、')} 同现，其他编号的文档不与之同现`;
      partings.push({ rule, docs: part.docs, reason, of: e.name });
    }
  }
  await applyPartings(store, config, partings, stats, progress, relink);
}

/**
 * An entity whose name is nothing but a code ("T2-C2") into the one entity
 * that answers to that code: the entity a coded split labelled with it
 * ("对账批次间隔（第一事业部支付组 · T2-C2）"), else the one live entity that
 * carries the code among its spellings (the setting 对账批次间隔 with alias
 * T2-C2, with review.identity "name"). A report that names the thing by its
 * code alone resolves to that entity when it is applied after the report that
 * gives the code as an alias, and to an entity of its own when applied before:
 * refine, which sees both, makes the two orders end alike. Two carriers, a
 * carrier named by another code, or a type that does not fit: nothing. The
 * merge is reversible (`entities unmerge`); a merge a person undid is not
 * made again.
 */
async function mergeCodesIntoCarriers(store: Store, stats: EntityContextStats, progress: (msg: string) => void): Promise<void> {
  const rules = await store.query<{ id: string; label: string }>(
    `SELECT n.id, n.label FROM entity_namesakes n JOIN entities e ON e.id = n.id AND e.tx_to IS NULL AND e.canonical_id IS NULL ORDER BY n.id`,
  );
  const byLabel = new Map<string, string[]>();
  for (const r of rules) {
    const c = codeOf(r.label);
    if (c) (byLabel.get(c.value) ?? byLabel.set(c.value, []).get(c.value)!).push(r.id);
  }
  const named = await store.query<{ id: string; name: string; type: string }>(
    `SELECT id, name, type FROM entities WHERE tx_to IS NULL AND canonical_id IS NULL AND name ~ '[0-9]'
       AND NOT EXISTS (SELECT 1 FROM entity_namesakes n WHERE n.id = entities.id) ORDER BY id`,
  );
  for (const e of named) {
    const c = codeOf(e.name);
    if (!c) continue;
    let into: string | undefined;
    const labelled = byLabel.get(c.value);
    if (labelled) {
      if (labelled.length !== 1) continue;
      into = labelled[0];
    } else {
      const carriers = await store.query<{ id: string; name: string; type: string; aliases: string[] | null }>(
        `SELECT DISTINCT x.id, x.name, x.type, x.aliases FROM entity_alias_keys k JOIN entities x ON x.id = k.entity_id
         WHERE k.alias_key = $1 AND k.kind = 'exact' AND x.id <> $2 AND x.tx_to IS NULL AND x.canonical_id IS NULL ORDER BY x.id`,
        [nameKey(e.name).key, e.id],
      );
      // not a carrier named by a code, nor one that carries another identifier of the same series (a title every incident has)
      const fit = carriers.filter((x) => typesCompatible(e.type, x.type) && !codeOf(x.name) && !(x.aliases ?? []).some((a) => namesApartByCode(a, e.name)));
      if (carriers.length !== 1 || fit.length !== 1) continue;
      into = fit[0].id;
    }
    if (!into || into === e.id) continue;
    if (await refusedByPerson(store, e.id, into)) continue;
    const reason = labelled ? `编号即拆分标签：${e.name} 是拆分出的实体 ${into} 的编号` : `编号即别名：${e.name} 只有 ${into} 以它为别名`;
    try {
      const res = await applyMerge(store, { entityId: e.id, canonicalId: into, reason, actor: 'entity-context' });
      if (res.outcome === 'merged') {
        stats.merged++;
        progress(`entities: merged ${e.name} into ${into} — ${reason}`);
      }
    } catch (err) {
      progress(`entities: code merge ${e.name} → ${into} failed: ${err instanceof Error ? err.message : err}`);
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

/**
 * Refine's splits: people of one name, and (review.identity "context") an
 * entity parted by its codes. Run after the duplicate audit, so that two
 * spellings of one organization the audit has just proposed to merge are one
 * roof here.
 */
export async function splitEntities(store: Store, opts: { config?: KnodeConfig; onProgress?: (msg: string) => void } = {}): Promise<Pick<EntityContextStats, 'split' | 'replayed'>> {
  const progress = opts.onProgress ?? (() => {});
  const stats: EntityContextStats = { merged: 0, suggested: 0, split: 0, replayed: 0 };
  const relink: string[] = [];
  const same = await pendingSame(store);
  await splitNamesakes(store, opts.config, stats, progress, relink, same);
  // parting an entity by its codes is something a workspace turns on (review.identity "context")
  if (opts.config?.review?.identity === 'context') await splitCoded(store, opts.config, stats, progress, relink, same);
  // in either mode: a code-named entity and the one entity that answers to its code end as one, whatever came first
  await mergeCodesIntoCarriers(store, stats, progress);
  if (relink.length > 0) {
    const { relinkTier0 } = await import('./concepts.js');
    await relinkTier0(store, { only: [...new Set(relink)] });
  }
  await decidePartedPairs(store);
  return { split: stats.split, replayed: stats.replayed };
}

/**
 * Refine's entity step: rename merges, alias suggestions, and — unless
 * `splits` is false, as refine itself asks, to run them after the duplicate
 * audit — the namesake and coded splits.
 */
export async function resolveEntityContext(store: Store, opts: { config?: KnodeConfig; onProgress?: (msg: string) => void; splits?: boolean } = {}): Promise<EntityContextStats> {
  const progress = opts.onProgress ?? (() => {});
  const stats: EntityContextStats = { merged: 0, suggested: 0, split: 0, replayed: 0 };
  await mergeRenames(store, stats, progress);
  await suggestAliasMerges(store, stats);
  if (opts.splits !== false) {
    const done = await splitEntities(store, opts);
    stats.split = done.split;
    stats.replayed = done.replayed;
  }
  return stats;
}
