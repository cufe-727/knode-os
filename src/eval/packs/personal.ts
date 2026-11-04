import crypto from 'node:crypto';
import { seededKey } from '../pack.js';
import type { CorpusDoc, SourceRecord, Task, TaskType } from '../types.js';
import { finishDocpack } from './docpack.js';
import { fetchJson, fetchText, hfRows } from './fetch.js';
import { registerRecipe, RecipeContext } from './index.js';
import { PackWriter } from './writer.js';

/**
 * Pack recipes for the personal domain (docs/design/23 §2): one person's
 * mailbox, one user's chats with an assistant, and one diarist's year —
 * real (or realistic) personal records whose questions are about what that
 * person did, said and planned.
 *
 * - personal-email: Jeff Dasovich's Enron mailbox through EnronQA (Ryan et
 *   al., 2025), whose questions and gold answers were written per email; the
 *   author model adds multi-hop questions across threads and unanswerable ones.
 * - personal-chat: LongMemEval's oracle split (Wu et al., 2025): dated chat
 *   sessions with the evidence for each question, the questions typed by the
 *   memory ability they test — single-session recall, multi-session
 *   aggregation, temporal reasoning, knowledge updates (modelled as an update
 *   batch: the later session arrives after the build) and abstention.
 * - personal-chat-locomo: LoCoMo (Maharana et al., 2024): long two-person
 *   conversations over many dated sessions with their QA annotations.
 * - personal-diary: The Diary of Samuel Pepys for 1660 (Project Gutenberg,
 *   public domain), one document per week of entries, all gold drafted by the
 *   author model.
 */

type Doc = CorpusDoc & { text: string };

const hash = (...parts: string[]) => crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 10);

const slug = (s: string, n = 60) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, n) || 'x';

/** Items in a seeded round-robin over strata: every stratum is drawn once before any is drawn twice. */
function stratified<T>(items: T[], stratum: (t: T) => string, key: (t: T) => string, seed: string | number): T[] {
  const groups = new Map<string, T[]>();
  for (const t of items) (groups.get(stratum(t)) ?? groups.set(stratum(t), []).get(stratum(t))!).push(t);
  const lists = [...groups.entries()]
    .sort((a, b) => seededKey(seed, a[0]).localeCompare(seededKey(seed, b[0])))
    .map(([, list]) => list.sort((a, b) => seededKey(seed, key(a)).localeCompare(seededKey(seed, key(b)))));
  const out: T[] = [];
  for (let round = 0; out.length < items.length; round++) for (const l of lists) if (round < l.length) out.push(l[round]);
  return out;
}

/** A leading span of `text` (cut at a word boundary): an exact quote for evidence. */
function lead(text: string, max = 240): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).trim();
}

/* ------------------------------ personal-email ------------------------------ */

interface EnronRow {
  email: string;
  questions: unknown;
  gold_answers: unknown;
  path: string;
  user: string;
}

/** A list field that may arrive as a JSON array, a JSON string or a Python list literal (`['a', "b's"]`). */
export function pyList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string') return [];
  const s = v.trim();
  if (!s.startsWith('[')) return s ? [s] : [];
  try {
    const j = JSON.parse(s) as unknown;
    if (Array.isArray(j)) return j.map(String);
  } catch {
    /* a Python literal: read its quoted strings */
  }
  const out: string[] = [];
  for (const m of s.matchAll(/(['"])((?:\\.|(?!\1)[^\\])*)\1/gs)) {
    out.push(m[2].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(.)/g, '$1'));
  }
  return out;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const iso = (y: number, m: number, d: number) => (y >= 1997 && y <= 2002 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : undefined);

/**
 * The email's date, from its header lines: EnronQA's own header has none, so
 * the latest `Date:`/`Sent:` line or Notes-style timestamp (`04/18/2001 02:47 PM`)
 * of the message and the messages it quotes — the email is no older than them.
 */
export function emailDate(text: string): string | undefined {
  const found: string[] = [];
  for (const m of text.matchAll(/^\s*(?:Date|Sent):[^\n]*$/gim)) {
    const line = m[0];
    const named = line.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/) ?? null;
    const dayFirst = line.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})/) ?? null;
    const slash = line.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/) ?? null;
    const d = named && MONTHS.includes(named[1].slice(0, 3).toLowerCase()) ? iso(+named[3], MONTHS.indexOf(named[1].slice(0, 3).toLowerCase()) + 1, +named[2])
      : dayFirst && MONTHS.includes(dayFirst[2].slice(0, 3).toLowerCase()) ? iso(+dayFirst[3], MONTHS.indexOf(dayFirst[2].slice(0, 3).toLowerCase()) + 1, +dayFirst[1])
        : slash ? iso(+slash[3], +slash[1], +slash[2]) : undefined;
    if (d) found.push(d);
  }
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\s+\d{1,2}:\d{2}\s*(?:AM|PM)?/gi)) {
    const d = iso(+m[3], +m[1], +m[2]);
    if (d) found.push(d);
  }
  return found.sort().at(-1);
}

async function buildEmail(dir: string, ctx: RecipeContext) {
  const n = ctx.limit ?? 120;
  const questions = Number(ctx.options.questions ?? 50);
  const seed = ctx.seed ?? 0;
  const writer = new PackWriter(dir, {
    id: 'personal-email',
    version: 1,
    title: "Jeff Dasovich's Enron mailbox (EnronQA)",
    domain: 'personal',
    languages: ['en'],
    description: `About ${n} emails from Jeff Dasovich's Enron mailbox (2000–2001, California energy crisis regulatory affairs), drawn across its folders, with EnronQA's per-email questions and gold answers; multi-hop questions across threads and unanswerable ones drafted by the author model.`,
    builder: { recipe: 'personal-email', options: { emails: n, questions } },
  });
  // the filter endpoint fails now and then: pages already fetched are cached, so a retry only asks for the rest
  let fetched: { rows: EnronRow[]; record: SourceRecord } | undefined;
  for (let attempt = 1; !fetched; attempt++) {
    try {
      fetched = await hfRows<EnronRow>('MichaelR207/enron_qa_0922', { where: `"user"='dasovich-j'`, limit: 400, license: 'unspecified on the dataset card (EnronQA, arXiv:2505.00263); emails from the public FERC Enron corpus' });
    } catch (err) {
      if (attempt >= 6) throw err;
      ctx.log(`EnronQA rows: ${err instanceof Error ? err.message.slice(0, 120) : String(err)} — retrying`);
      await new Promise((r) => setTimeout(r, 20_000 * attempt));
    }
  }
  writer.addSource(fetched.record);

  const seen = new Set<string>();
  const rows = fetched.rows.filter((r) => {
    const body = r.email.split(/={10,}/)[1]?.trim() ?? r.email;
    const k = hash(body);
    return pyList(r.questions).length > 0 && !seen.has(k) && (seen.add(k), true);
  });
  const chosen = stratified(rows, (r) => r.path.split('/')[1] ?? '', (r) => r.path, seed).slice(0, n);
  const docs: Doc[] = chosen.map((r) => {
    const date = emailDate(r.email);
    return {
      path: `${r.path.replace(/\.$/, '')}.md`,
      title: r.email.match(/^Subject: (.*)$/m)?.[1]?.trim().replace(/^nan$/, '') || undefined,
      author: r.email.match(/^Sender: (.*)$/m)?.[1]?.trim() || undefined,
      ...(date ? { date } : {}),
      lang: 'en', source: 'enron', kind: 'email',
      text: r.email,
    };
  });

  // one published question per email, from emails drawn across folders
  const tasks: Task[] = [];
  for (const [i, r] of chosen.entries()) {
    if (tasks.length >= questions) break;
    const qs = pyList(r.questions);
    const as = pyList(r.gold_answers);
    const k = parseInt(seededKey(seed, r.path).slice(0, 4), 16) % qs.length;
    if (!qs[k] || !as[k]) continue;
    tasks.push({
      id: `email-${hash(r.path, qs[k])}`, suite: 'usage', type: 'single-hop', lang: 'en', question: qs[k], answer: as[k],
      scoring: 'judge', evidence: [{ doc: docs[i].path }], primary: true, meta: { source: 'enronqa', folder: r.path.split('/')[1] },
    });
  }
  return finishDocpack({ writer, docs, lang: 'en', tasks, plan: { multi: 8, unanswerable: 4 }, perDoc: 4 }, ctx);
}

/* ------------------------------ personal-chat ------------------------------ */

interface LmeTurn {
  role: string;
  content: string;
  has_answer?: boolean;
}

interface LmeQuestion {
  question_id: string;
  question_type: string;
  question: string;
  answer: string | number;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: LmeTurn[][];
  answer_session_ids: string[];
}

/** `2023/04/10 (Mon) 17:50` → `2023-04-10`. */
const lmeDay = (s: string) => s.slice(0, 10).replace(/\//g, '-');

const LME_QUOTA: Record<string, number> = { 'single-session-user': 8, 'multi-session': 9, 'temporal-reasoning': 9, 'knowledge-update': 8, abstention: 6 };

async function buildChat(dir: string, ctx: RecipeContext) {
  const limit = ctx.limit ?? 120;
  const want = Number(ctx.options.questions ?? 40);
  const seed = ctx.seed ?? 0;
  const writer = new PackWriter(dir, {
    id: 'personal-chat',
    version: 1,
    title: 'LongMemEval: one user’s dated chats with an assistant',
    domain: 'personal',
    languages: ['en'],
    description: `Dated user–assistant chat sessions from LongMemEval's oracle split (the evidence sessions of about ${want} questions, drawn across single-session recall, multi-session aggregation, temporal reasoning, knowledge updates and abstention), with the benchmark's own questions and gold answers. For knowledge-update questions the later session arrives as update batch 01.`,
    builder: { recipe: 'personal-chat', options: { questions: want } },
  });
  const { json, record } = await fetchJson<LmeQuestion[]>('https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json', { license: 'MIT', maxBytes: 50 * 1024 * 1024 });
  writer.addSource({ ...record, note: 'LongMemEval (Wu et al., ICLR 2025), cleaned oracle split: evidence sessions only' });

  const kind = (q: LmeQuestion) => (q.question_id.endsWith('_abs') ? 'abstention' : q.question_type);
  const quota = (k: string) => Math.round((LME_QUOTA[k] ?? 0) * want / 40);
  const pool = stratified(json.filter((q) => quota(kind(q)) > 0), kind, (q) => q.question_id, seed);

  // a session id can carry different contents under different questions: key sessions by content
  const corpus = new Map<string, Doc>();
  const updates = new Map<string, Doc>();
  const taken = new Map<string, number>();
  const tasks: Task[] = [];
  const sessionDoc = (q: LmeQuestion, i: number): [string, Doc] => {
    const sid = q.haystack_session_ids[i];
    const when = q.haystack_dates[i];
    const turns = q.haystack_sessions[i];
    const text = `# Chat session · ${when}\n\n${turns.map((t) => `**${t.role === 'user' ? 'User' : 'Assistant'}:** ${t.content.trim()}`).join('\n\n')}\n`;
    const key = hash(sid, when, text);
    return [key, { path: `sessions/${lmeDay(when)}-${sid}-${key.slice(0, 4)}.md`, title: `Chat session ${when}`, date: lmeDay(when), lang: 'en', source: 'longmemeval', kind: 'chat', text }];
  };
  const quoteOf = (q: LmeQuestion, i: number) => {
    const turn = q.haystack_sessions[i].find((t) => t.has_answer && t.content.trim());
    return turn ? lead(turn.content) : undefined;
  };

  for (const q of pool) {
    const k = kind(q);
    if (tasks.length >= want || corpus.size + updates.size >= limit) break;
    if ((taken.get(k) ?? 0) >= quota(k)) continue;
    const sessions = q.haystack_session_ids.map((_, i) => sessionDoc(q, i));
    // knowledge update: the latest session is the update the system must absorb
    const latest = k === 'knowledge-update' && sessions.length > 1
      ? q.haystack_dates.map((d, i) => [d, i] as const).sort((a, b) => a[0].localeCompare(b[0])).at(-1)![1] : -1;
    const toCorpus = sessions.filter((_, i) => i !== latest);
    if (toCorpus.some(([key]) => updates.has(key)) || (latest >= 0 && corpus.has(sessions[latest][0]))) continue;
    const fresh = sessions.filter(([key]) => !corpus.has(key) && !updates.has(key)).length;
    if (corpus.size + updates.size + fresh > limit) continue;
    for (const [key, d] of toCorpus) corpus.set(key, d);
    if (latest >= 0) updates.set(sessions[latest][0], sessions[latest][1]);
    taken.set(k, (taken.get(k) ?? 0) + 1);

    const evidence = k === 'abstention' ? [] : sessions.map(([, d], i) => ({ doc: d.path, ...(quoteOf(q, i) ? { quote: quoteOf(q, i) } : {}) }));
    const answer = String(q.answer);
    const type: TaskType = k === 'abstention' ? 'unanswerable' : k === 'multi-session' ? 'multi-hop' : k === 'temporal-reasoning' ? 'temporal' : k === 'knowledge-update' ? (latest >= 0 ? 'update' : 'temporal') : 'single-hop';
    tasks.push({
      id: `lme-${q.question_id}`, suite: type === 'update' ? 'update' : 'usage', type, lang: 'en', question: q.question,
      ...(k === 'abstention' ? {} : { answer }),
      scoring: k === 'abstention' ? 'abstain' : /^\d+(\.\d+)?$/.test(answer.trim()) ? 'exact' : 'judge',
      // update tasks cite the later session, which only the batch adds; quotes there are not checked against the corpus
      evidence: type === 'update' ? evidence.map((e) => ({ doc: e.doc })) : evidence,
      asOf: lmeDay(q.question_date),
      ...(type === 'update' ? { afterUpdate: '01' } : {}),
      primary: type !== 'update' && k !== 'abstention' ? true : undefined,
      meta: { source: 'longmemeval', questionType: q.question_type, ...(k === 'abstention' ? { goldAnswer: answer } : {}) },
    });
  }
  for (const d of updates.values()) writer.addUpdate('01', d.path, d.text);
  ctx.log(`LongMemEval: ${tasks.length} questions (${[...taken].map(([k, v]) => `${k} ${v}`).join(', ')}), ${corpus.size} sessions, ${updates.size} in the update batch`);
  return finishDocpack({ writer, docs: [...corpus.values()], lang: 'en', tasks }, ctx);
}

/* --------------------------- personal-chat-locomo --------------------------- */

interface LocomoSample {
  sample_id: string;
  conversation: Record<string, unknown>;
  qa: { question: string; answer?: string | number; adversarial_answer?: string; evidence?: string[]; category: number }[];
}

interface LocomoTurn {
  speaker: string;
  dia_id: string;
  text: string;
  blip_caption?: string;
}

/** LoCoMo's QA categories (from the paper's code): 1 multi-hop, 2 temporal, 3 open-domain inference, 4 single-hop, 5 adversarial. */
const LOCOMO_TYPES: Record<number, TaskType> = { 1: 'multi-hop', 2: 'temporal', 3: 'single-hop', 4: 'single-hop', 5: 'unanswerable' };

/** `1:56 pm on 8 May, 2023` → `2023-05-08`. */
function locomoDay(s: string): string | undefined {
  const m = s.match(/(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/);
  if (!m) return undefined;
  const mon = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
  return mon ? `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}` : undefined;
}

async function buildLocomo(dir: string, ctx: RecipeContext) {
  const limit = ctx.limit ?? 100;
  const want = Number(ctx.options.questions ?? 50);
  const seed = ctx.seed ?? 0;
  const writer = new PackWriter(dir, {
    id: 'personal-chat-locomo',
    version: 1,
    title: 'LoCoMo: long two-person conversations over many sessions',
    domain: 'personal',
    languages: ['en'],
    description: `Dated chat sessions between pairs of people from LoCoMo (one document per session), with the dataset's QA annotations — about ${want} questions across single-hop, multi-hop, temporal and adversarial (unanswerable) categories, each grounded in the dialogue turns it cites.`,
    builder: { recipe: 'personal-chat-locomo', options: { questions: want } },
  });
  const { json, record } = await fetchJson<LocomoSample[]>('https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json', { license: 'CC BY-NC 4.0', maxBytes: 20 * 1024 * 1024 });
  writer.addSource({ ...record, note: 'LoCoMo (Maharana et al., ACL 2024), locomo10.json' });

  // whole conversations in seeded order, until the document budget is spent
  const docs: Doc[] = [];
  const turnDoc = new Map<string, { doc: string; text: string }>();
  const samples = [...json].sort((a, b) => seededKey(seed, a.sample_id).localeCompare(seededKey(seed, b.sample_id)));
  const used: LocomoSample[] = [];
  for (const s of samples) {
    const c = s.conversation;
    const keys = Object.keys(c).filter((k) => /^session_\d+$/.test(k) && Array.isArray(c[k])).sort((a, b) => +a.split('_')[1] - +b.split('_')[1]);
    if (docs.length + keys.length > limit && docs.length) break;
    const room = limit - docs.length;
    for (const k of keys.slice(0, room)) {
      const when = String(c[`${k}_date_time`] ?? '');
      const day = locomoDay(when);
      const turns = c[k] as LocomoTurn[];
      const p = `${s.sample_id}/${day ?? 'undated'}-${k.replace('_', '-')}.md`;
      const lines = turns.map((t) => `**${t.speaker}:** ${t.text.trim()}${t.blip_caption ? ` [shares a photo: ${t.blip_caption}]` : ''}`);
      const text = `# ${c.speaker_a} and ${c.speaker_b} · ${when}\n\n${lines.join('\n\n')}\n`;
      docs.push({ path: p, title: `${c.speaker_a} and ${c.speaker_b}, ${when}`, ...(day ? { date: day } : {}), lang: 'en', source: 'locomo', kind: 'chat', text });
      turns.forEach((t, i) => turnDoc.set(`${s.sample_id}:${t.dia_id}`, { doc: p, text: lines[i] }));
    }
    used.push(s);
    if (docs.length >= limit) break;
  }

  const candidates = used.flatMap((s) => s.qa.map((qa, i) => ({ s, qa, i })))
    .filter(({ s, qa }) => {
      const ev = (qa.evidence ?? []).map((e) => turnDoc.get(`${s.sample_id}:${e.trim()}`));
      return qa.category === 5 ? Boolean(qa.adversarial_answer) : qa.answer !== undefined && ev.length > 0 && ev.every(Boolean);
    });
  const picked = stratified(candidates, ({ qa }) => String(qa.category), ({ s, i }) => `${s.sample_id}:${i}`, seed).slice(0, want);
  const tasks: Task[] = picked.map(({ s, qa, i }) => {
    const type = LOCOMO_TYPES[qa.category] ?? 'single-hop';
    const evidence = type === 'unanswerable' ? [] : (qa.evidence ?? []).map((e) => {
      const t = turnDoc.get(`${s.sample_id}:${e.trim()}`)!;
      return { doc: t.doc, quote: lead(t.text.replace(/^\*\*[^*]+:\*\* /, ''), 200) };
    });
    const dedup = [...new Map(evidence.map((e) => [`${e.doc}|${e.quote}`, e])).values()];
    return {
      id: `locomo-${s.sample_id}-${i}`, suite: 'usage', type, lang: 'en', question: qa.question,
      ...(type === 'unanswerable' ? {} : { answer: String(qa.answer) }),
      scoring: type === 'unanswerable' ? 'abstain' : 'judge', evidence: dedup,
      primary: type !== 'unanswerable' ? true : undefined,
      meta: { source: 'locomo', category: qa.category, ...(qa.adversarial_answer ? { adversarialAnswer: qa.adversarial_answer } : {}) },
    };
  });
  ctx.log(`LoCoMo: ${used.length} conversations, ${docs.length} sessions, ${tasks.length} questions`);
  return finishDocpack({ writer, docs, lang: 'en', tasks }, ctx);
}

/* ------------------------------ personal-diary ------------------------------ */

const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

/**
 * Pepys's 1660 entries, a document per week of each month (days 1–7, 8–14,
 * 15–21, 22–end): the editors' footnotes (indented blocks and `--[…]--`
 * asides) are dropped, so what remains is the diarist's own text.
 */
export function pepysWeeks(raw: string, year: number): { start: string; end: string; month: string; text: string }[] {
  const start = raw.search(/\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\n/i);
  const end = raw.search(/\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG EBOOK/i);
  const body = raw.slice(start >= 0 ? raw.indexOf('\n', start) + 1 : 0, end > 0 ? end : undefined).replace(/\r\n/g, '\n');
  const heads = [...body.matchAll(new RegExp(`^(${MONTH_NAMES.join('|')}) \\d{4}(?:-\\d{4})?\\s*$`, 'gm'))];
  const out: { start: string; end: string; month: string; text: string }[] = [];
  heads.forEach((h, hi) => {
    const mon = MONTH_NAMES.indexOf(h[1]) + 1;
    const section = body.slice(h.index! + h[0].length, heads[hi + 1]?.index ?? body.length);
    // a footnote block between blank lines often splits a sentence: rejoin it unless the sentence had ended
    const clean = section
      .replace(/(\S)\n\n(?: {4,}\S[^\n]*\n|\n(?= {4,}\S))+\n/g, (_, prev: string) => `${prev}${/[.?!)\]]/.test(prev) ? '\n\n' : '\n'}`)
      .split('\n').filter((l) => !/^ {4,}\S/.test(l)).join('\n')
      .replace(/--\[[^\]]*\]--?/g, ' ')
      .replace(/ +([,.;:])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    // day entries open a line with their day ("2nd.", "Jan. 1st (Lord's day).", "2d."), in increasing order
    const marks: { day: number; at: number }[] = [];
    for (const m of clean.matchAll(/^(?:[A-Z][a-z]+\.? )?(\d{1,2})(?:st|nd|rd|th|d)(?:[.,]|\s*\()/gm)) {
      const day = +m[1];
      const last = marks.at(-1)?.day ?? 0;
      if (day > last && day <= Math.min(31, last + 7)) marks.push({ day, at: m.index! });
    }
    const weeks: [number, number][] = [[1, 7], [8, 14], [15, 21], [22, 31]];
    for (const [a, b] of weeks) {
      const inWeek = marks.filter((m) => m.day >= a && m.day <= b);
      if (!inWeek.length) continue;
      const from = a === 1 ? 0 : inWeek[0].at;
      const next = marks.find((m) => m.day > b);
      const text = clean.slice(from, next?.at ?? clean.length).trim();
      const lastDay = inWeek.at(-1)!.day;
      const ymd = (d: number) => `${year}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      out.push({ start: ymd(inWeek[0].day), end: ymd(lastDay), month: h[1][0] + h[1].slice(1).toLowerCase(), text });
    }
  });
  return out;
}

async function buildDiary(dir: string, ctx: RecipeContext) {
  const writer = new PackWriter(dir, {
    id: 'personal-diary',
    version: 1,
    title: 'The Diary of Samuel Pepys, 1660',
    domain: 'personal',
    languages: ['en'],
    description: 'Samuel Pepys\'s diary for 1660 (Braybrooke/Wheatley edition, Project Gutenberg #4125), one document per week of entries with the editors\' footnotes removed: the Restoration year seen day by day — his work for Lord Sandwich and the Navy Office, his household, money and recurring companions. All gold is drafted by the author model.',
    builder: { recipe: 'personal-diary', options: {} },
  });
  const { text, record } = await fetchText('https://www.gutenberg.org/cache/epub/4125/pg4125.txt', { license: 'Public domain in the USA (Project Gutenberg License)' });
  writer.addSource({ ...record, note: 'Diary of Samuel Pepys — Complete 1660 N.S., Project Gutenberg eBook #4125' });
  const weeks = pepysWeeks(text, 1660).slice(0, ctx.limit ?? Infinity);
  const docs: Doc[] = weeks.map((w) => {
    const d1 = +w.start.slice(8);
    const d2 = +w.end.slice(8);
    const span = d1 === d2 ? `${d1}` : `${d1}–${d2}`;
    return {
      path: `diary/${w.start}.md`, title: `Diary, ${span} ${w.month} 1660`, date: w.start, author: 'Samuel Pepys', lang: 'en', source: 'gutenberg:4125', kind: 'diary',
      text: `# The Diary of Samuel Pepys — ${span} ${w.month} 1660\n\n${w.text}\n`,
    };
  });
  return finishDocpack({ writer, docs, lang: 'en', plan: { single: 20, multi: 10, temporal: 8, unanswerable: 5, global: 4 }, perDoc: 6 }, ctx);
}

/* -------------------------------- register -------------------------------- */

export function registerPersonalRecipes(): void {
  registerRecipe({ id: 'personal-email', title: "Jeff Dasovich's Enron mailbox, EnronQA questions + drafted multi-hop", domain: 'personal', network: true, needsAuthor: true, build: buildEmail });
  registerRecipe({ id: 'personal-chat', title: 'LongMemEval oracle chats: recall, aggregation, time, updates, abstention', domain: 'personal', network: true, needsAuthor: false, build: buildChat });
  registerRecipe({ id: 'personal-chat-locomo', title: 'LoCoMo long conversations with their QA annotations', domain: 'personal', network: true, needsAuthor: false, build: buildLocomo });
  registerRecipe({ id: 'personal-diary', title: 'The Diary of Samuel Pepys, 1660, a document per week', domain: 'personal', network: true, needsAuthor: true, build: buildDiary });
}
