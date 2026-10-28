import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from '../compiler/intents.js';
import { CONCEPTS_DIR } from '../fs/layout.js';
import { writeAtomic } from '../fs/sidecar.js';
import { Queryable } from '../store/migrations.js';
import { keyOf } from './normalize.js';

/**
 * What tier-0 never mines as a concept (src/graph/concepts.ts). Three layers,
 * all compared by normalized key (NFKC, case, width and punctuation folded):
 *
 *   built-in    function words, hedges, time words, generic nouns — the
 *               vocabulary that is frequent in any corpus
 *   stoplist    `playbooks/concepts/stoplist.yaml`, a person's additions
 *               (`terms`) and exceptions (`allow`); seeded once, never rewritten
 *   frequent    `playbooks/concepts/frequent.yaml`, learned from the corpus:
 *               a candidate term found in more than FREQUENT_RATIO of the
 *               indexed documents says nothing about any one of them. Learned
 *               from the documents' own text (src/graph/concepts.ts
 *               learnFrequentTerms — `knode-os concepts learn`, and after a
 *               full sync pass when the list is missing, a week old or the
 *               corpus doubled), so it does not depend on which concept
 *               entities the graph happens to hold: a re-import that disposes
 *               them while it runs sees the same list throughout. Readable so
 *               a person can see why a term is missing, and promote one to
 *               `allow`.
 *
 * The built-in words and a person's `terms` also keep link surfaces and alias
 * lists clean: a generic alias is never matched (src/graph/concepts.ts
 * weakLinkKey) and is dropped from the entity row by the fold
 * (aliasStopKeys). The learned list shapes mining and alias surfaces, never a
 * name's — a name frequent in a corpus is often that corpus's hub entity, and
 * linking it is the point.
 */

export const CONCEPT_STOPLIST_FILE = `${CONCEPTS_DIR}/stoplist.yaml`;
export const CONCEPT_FREQUENT_FILE = `${CONCEPTS_DIR}/frequent.yaml`;

/** A term mined in more than this share of the indexed documents is too common to be a concept of any of them. */
export const FREQUENT_RATIO = 0.02;
/** Below this many indexed documents the share means nothing; the learned list stays empty. */
export const FREQUENT_MIN_CORPUS = 50;
/** A learned list older than this is learned again by the next full sync pass that applied documents. */
export const FREQUENT_RELEARN_MS = 7 * 24 * 60 * 60 * 1000;
/** The share never drops below this many documents, so a term in a handful of early documents is not learned as noise. */
export const FREQUENT_MIN_DOCS = 10;

export const EN_STOP = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were', 'has', 'have', 'had',
  'not', 'but', 'all', 'any', 'can', 'will', 'would', 'should', 'could', 'into', 'over', 'under',
  'about', 'after', 'before', 'between', 'they', 'them', 'their', 'there', 'here', 'when', 'what',
  'which', 'while', 'these', 'those', 'then', 'than', 'also', 'each', 'other', 'more', 'most',
  'some', 'such', 'only', 'very', 'just', 'been', 'being', 'does', 'doing', 'how', 'why', 'where',
  'note', 'notes', 'todo', 'https', 'http', 'www', 'com', 'org',
  // sentence starters and discourse words the Capitalized-phrase rule picks up
  'however', 'although', 'because', 'since', 'today', 'yesterday', 'tomorrow', 'first', 'second', 'third',
  'finally', 'meanwhile', 'overall', 'instead', 'perhaps', 'maybe', 'according', 'during', 'within', 'without',
  'among', 'another', 'every', 'many', 'much', 'often', 'still', 'already', 'again', 'even', 'like', 'well',
  'yes', 'thus', 'hence', 'therefore', 'indeed', 'actually', 'basically', 'obviously', 'clearly', 'simply',
  'people', 'things', 'something', 'anything', 'everything', 'nothing', 'someone', 'anyone', 'everyone',
  'update', 'updated', 'edit', 'source', 'image', 'see', 'via', 'read', 'link', 'links', 'click', 'figure',
  'table', 'chart', 'etc', 'new', 'old', 'big', 'small', 'good', 'bad', 'high', 'low', 'long', 'short',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

export const CJK_STOP = new Set([
  // pronouns, connectives, aspect
  '我们', '你们', '他们', '她们', '它们', '咱们', '这个', '那个', '这些', '那些', '这样', '那样', '这里', '那里', '这种', '那种',
  '因为', '所以', '但是', '如果', '虽然', '而且', '或者', '以及', '通过', '对于', '关于', '可以', '需要', '使用', '进行',
  '一个', '一些', '一下', '一点', '一直', '一定', '一样', '一起', '没有', '就是', '也是', '都是', '不是', '还是', '已经',
  '现在', '时候', '什么', '怎么', '为了', '其中', '之后', '之前', '以上', '以下', '如下', '例如', '比如', '包括', '主要',
  '同时', '然后', '还有', '只是', '不过', '其实', '当然', '真的', '非常', '比较', '特别', '应该', '可能', '大概', '或许',
  '估计', '也许', '必须', '肯定', '确实', '基本', '完全', '几乎', '总是', '经常', '有时', '仍然', '依然', '继续', '开始',
  '最后', '最终', '然而', '不仅', '甚至', '只有', '只要', '无论', '即使', '尽管', '除了', '另外', '此外', '而是', '不但',
  // time words
  '今天', '明天', '昨天', '今年', '去年', '明年', '前年', '最近', '目前', '当前', '以前', '以后', '当时', '未来', '现在',
  '本周', '上周', '下周', '本月', '上月', '下月', '早上', '上午', '中午', '下午', '晚上', '周末', '每天', '每年', '每月',
  // generic nouns and verbs that carry no topic
  '问题', '东西', '事情', '情况', '方面', '方式', '方法', '原因', '结果', '内容', '相关', '信息', '感觉', '觉得', '认为',
  '知道', '看到', '看看', '看了', '发现', '表示', '说明', '显示', '出现', '存在', '产生', '影响', '作用', '部分', '整体', '所有',
  '值得', '结束', '变化', '增加', '减少', '提高', '降低', '上升', '下降', '保持', '成为', '带来', '进入', '达到', '超过', '接近',
  '以来', '之间', '左右', '以内', '不要', '一遍', '一篇', '文章', '本身', '反而', '关注', '跟踪', '回调', '区间', '阶段', '水平',
  '很多', '大家', '别人', '自己', '朋友', '时间', '地方', '工作', '生活', '世界', '社会', '人们', '人类', '国家',
  '全球', '全国', '国内', '国外', '海外', '公司', '企业', '集团', '机构', '组织', '部门', '单位', '个人', '用户',
  '老大', '老板', '老师', '大哥', '大佬', '兄弟', '同学', '群主', '楼主', '作者', '本人', '笔者', '小编',
  // question and hedge phrases the segmenter returns as one word
  '是不是', '为什么', '会不会', '有没有', '要不要', '能不能', '好不好', '对不对', '怎么样', '怎么办', '不知道', '也没有',
  '大部分', '大多数', '一方面', '另一方面', '什么样', '有时候', '看起来', '刚刚', '较早', '最新', '曾经', '从来', '永远',
  '一般', '通常', '往往', '大约', '多少', '几个', '这次', '那次', '上次', '下次', '每次', '当年', '本来', '原来', '后来',
  '于是', '因此', '不然', '否则', '要是', '除非', '哪怕', '即便', '既然', '不管', '任何', '全部', '整个', '各种', '每个',
  '这么', '那么', '如此', '好像', '似乎', '看来', '听说', '据说', '可见', '显然', '自然', '果然', '反正', '毕竟', '到底',
  '究竟', '根本', '简直', '居然', '竟然', '突然', '马上', '立刻', '对方', '双方', '彼此', '互相', '自身', '人家', '哪些',
  // generic nouns that make no node worth having, in any corpus
  '价格', '价值', '收益', '资产', '利润', '数据', '技术', '系统', '平台', '模式', '概念', '逻辑', '股票', '金融', '服务',
  '现金', '业务', '行业', '产品', '项目', '模型', '指标', '因素', '条件', '目标', '标准', '机会', '风险', '趋势', '周期',
  // exporter and platform boilerplate
  '附件', '网页链接', '网页', '帖子', '转发', '评论', '回复', '点赞', '收藏', '分享', '原文', '链接', '图片', '视频', '阅读',
  '全文', '查看', '来源', '粉丝', '私信',
]);

/** Single characters that break a run of unknown characters: function words and particles, never part of a name. */
export const CJK_FUNCTION_CHARS = new Set([...'的了在是和与及或把被让给对从到为以之也都就还很太更最不没有又再才这那些个条件种样什么怎吗呢吧啊哦嗯呀而且但则即如若虽因由于向往比跟同像等着过来去说看做要会能可将已所其此每各该些者们您你我他她它']);

export interface ConceptStoplist {
  terms: string[];
  allow: string[];
}

export interface FrequentTerm {
  term: string;
  docs: number;
}

export interface FrequentTerms {
  /** Indexed documents the shares were computed over. */
  docs: number;
  /** A term in at least this many documents is listed. */
  threshold: number;
  at: string;
  terms: FrequentTerm[];
}

/** The stop list seeded as `playbooks/concepts/stoplist.yaml`; Settings resets an edited copy to it. */
export const STOPLIST_TEMPLATE = `# Tier-0 concept stop list (src/graph/concepts.ts).
#
# Tier-0 mines a few topical terms per document without a model. Generic words
# make useless graph nodes: add them under \`terms\`. knode-os also learns which
# terms occur in more than 2% of the indexed documents and keeps them in
# frequent.yaml next to this file (regenerated; do not edit). A term you want
# mined although it is frequent goes under \`allow\`.
#
# Matching ignores case, width and punctuation; a stop term is also never used
# as a surface for linking a document to a known entity.
terms:
  - 公司
  - 附件
  - 市场
  - 今天
  - 可能
  - 目前
allow: []
`;

/** Seed the editable stop list (idempotent; a file that exists is never touched). */
export function ensureDefaultConceptStoplist(dataDir: string): string[] {
  const file = path.join(dataDir, CONCEPT_STOPLIST_FILE);
  if (fs.existsSync(file)) return [];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, STOPLIST_TEMPLATE);
  return [CONCEPT_STOPLIST_FILE];
}

function strings(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => (typeof x === 'string' || typeof x === 'number' ? [String(x).trim()] : [])).filter(Boolean);
}

export function readConceptStoplist(dataDir: string): ConceptStoplist {
  const file = path.join(dataDir, CONCEPT_STOPLIST_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { terms: [], allow: [] };
  }
  const data = parseYaml(text);
  return { terms: strings(data.terms), allow: strings(data.allow) };
}

export function readFrequentTerms(dataDir: string): FrequentTerms | null {
  const file = path.join(dataDir, CONCEPT_FREQUENT_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const data = parseYaml(text);
  const terms: FrequentTerm[] = [];
  for (const raw of Array.isArray(data.terms) ? data.terms : []) {
    if (typeof raw === 'string' && raw.trim()) terms.push({ term: raw.trim(), docs: 0 });
    else if (raw && typeof raw === 'object' && typeof (raw as { term?: unknown }).term === 'string') {
      const o = raw as { term: string; docs?: unknown };
      terms.push({ term: o.term.trim(), docs: typeof o.docs === 'number' ? o.docs : 0 });
    }
  }
  return {
    docs: typeof data.docs === 'number' ? data.docs : 0,
    threshold: typeof data.threshold === 'number' ? data.threshold : 0,
    at: typeof data.at === 'string' ? data.at : '',
    terms,
  };
}

export function writeFrequentTerms(dataDir: string, result: FrequentTerms): void {
  const lines = [
    '# Learned by knode-os from document frequency: concept terms tier-0 mined in',
    `# more than ${Math.round(FREQUENT_RATIO * 100)}% of the indexed documents (here: at least ${result.threshold} of ${result.docs}).`,
    '# Regenerated while documents are applied — do not edit. Exceptions go under',
    '# `allow` in stoplist.yaml, additions under `terms`.',
    `docs: ${result.docs}`,
    `threshold: ${result.threshold}`,
    `at: ${JSON.stringify(result.at)}`,
    'terms:',
    ...result.terms.map((t) => `  - { term: ${JSON.stringify(t.term)}, docs: ${t.docs} }`),
  ];
  writeAtomic(path.join(dataDir, CONCEPT_FREQUENT_FILE), lines.join('\n') + '\n');
}

/** The document-frequency threshold for a corpus of `docs` indexed documents (null while the corpus is too small). */
export function frequentThreshold(docs: number, ratio = FREQUENT_RATIO, minCorpus = FREQUENT_MIN_CORPUS, minDocs = FREQUENT_MIN_DOCS): number | null {
  if (docs < minCorpus) return null;
  return Math.max(minDocs, Math.ceil(docs * ratio));
}

/** Indexed source documents the shares are computed over. */
export async function indexedDocumentCount(q: Queryable): Promise<number> {
  const [row] = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM documents WHERE status = 'indexed' AND root = 'docs'`);
  return row?.n ?? 0;
}

/** The merged stop set as normalized keys: built-in and editable terms plus the learned ones, minus the exceptions. */
export function stopKeySet(editable: ConceptStoplist, frequent: FrequentTerms | null): Set<string> {
  const out = new Set<string>();
  for (const t of EN_STOP) out.add(t);
  for (const t of CJK_STOP) out.add(keyOf(t));
  for (const t of editable.terms) {
    const k = keyOf(t);
    if (k) out.add(k);
  }
  for (const t of frequent?.terms ?? []) {
    const k = keyOf(t.term);
    if (k) out.add(k);
  }
  for (const t of editable.allow) out.delete(keyOf(t));
  return out;
}

function fileStamp(abs: string): string {
  try {
    const st = fs.statSync(abs);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'none';
  }
}

/** Modification stamps of the two list files, so a cache notices an edit or a new learning run. */
export function stoplistStamp(dataDir: string): string {
  return fileStamp(path.join(dataDir, CONCEPT_STOPLIST_FILE));
}

export function frequentStamp(dataDir: string): string {
  return fileStamp(path.join(dataDir, CONCEPT_FREQUENT_FILE));
}

const aliasStopCache = new Map<string, { stamp: string; keys: Set<string> }>();

/**
 * The words an alias may not be — the built-in lists and the workspace's
 * `terms`, by normalized key — for the fold (src/lineage/fold.ts): an
 * extractor's "other spellings" sometimes include 市场 or 公司, and an alias
 * that ordinary would resolve and link every document onto one entity. Read
 * once per data dir and again when stoplist.yaml changes.
 */
export function aliasStopKeys(dataDir: string): ReadonlySet<string> {
  const stamp = stoplistStamp(dataDir);
  const hit = aliasStopCache.get(dataDir);
  if (hit && hit.stamp === stamp) return hit.keys;
  const keys = stopKeySet(readConceptStoplist(dataDir), null);
  aliasStopCache.set(dataDir, { stamp, keys });
  return keys;
}
