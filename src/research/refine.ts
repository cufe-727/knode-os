import { AppContext } from '../context.js';
import { resolve } from '../compiler/resolve.js';
import { isCliProvider, LlmConfig, llmTargets } from '../config.js';
import { LlmClient } from '../llm/client.js';
import { agentForSpec, ResearchAgent } from './agent.js';
import { extractJson } from './pipeline.js';
import { ResearchSource } from './sources.js';
import { loadPhasePrompt, researchSlug } from './templates.js';

/**
 * Refinement: a topic as a person typed it → a research brief a study can
 * run. One model call, no tools: the model sees the topic, what the knowledge
 * base already holds about it, which sources the study may use, and — on a
 * second round — the previous brief, the person's feedback and their answers
 * to its clarifying questions. What comes back is normalized here so that
 * whatever the model wrote, the study gets ids, slugs, headings and limits it
 * can rely on; the person then edits the brief before starting.
 */

export interface StudyQuestion {
  id: string;
  text: string;
  why: string;
  /** Page id that answers it. */
  page: string;
  queries: string[];
}

export interface StudyPage {
  id: string;
  title: string;
  slug: string;
  purpose: string;
  /** "## …" headings, without the sources heading (added by language). */
  sections: string[];
  questions: string[];
  charts: string[];
  entities: string[];
}

export interface StudyClarification {
  question: string;
  options: string[];
  answer?: string;
}

export interface StudyBrief {
  title: string;
  slug: string;
  /** Output language: 'en', 'zh', or another BCP 47 tag. */
  language: string;
  objective: string;
  restatement: string;
  scope: { include: string[]; exclude: string[]; timeframe: string; asOf: string };
  assumptions: string[];
  clarifications: StudyClarification[];
  questions: StudyQuestion[];
  pages: StudyPage[];
  entities: string[];
  seedUrls: { url: string; why: string }[];
  searchQueries: string[];
  report: { title: string; sections: string[] };
}

export interface RefineInput {
  topic: string;
  /** The brief so far (a second round refines it). */
  brief?: StudyBrief | null;
  /** What the person wants changed. */
  feedback?: string;
  /** Answers to the brief's clarifications, by question text. */
  answers?: Record<string, string>;
  /** The sources the study may use. */
  sources: ResearchSource[];
  web: boolean;
  /** The study's own agent, used one-shot when no refiner model is configured. */
  agent?: ResearchAgent | null;
  maxPages: number;
  language?: string;
}

export interface RefineResult {
  brief: StudyBrief;
  /** Who refined it: a model label, or 'template' when no model was reachable. */
  refiner: string;
  error: string | null;
  ms: number;
}

const SOURCES_HEADING: Record<string, string> = { en: '## Sources', zh: '## 来源' };

/** The sources heading a page in this language ends with (the validator requires it). */
export function sourcesHeading(language: string): string {
  return SOURCES_HEADING[language.slice(0, 2).toLowerCase()] ?? SOURCES_HEADING.en;
}

const REPORT_SECTIONS: Record<string, string[]> = {
  en: ['## Executive summary', '## Key findings', '## Pages in this study', '## Open questions', '## Method and sources'],
  zh: ['## 摘要', '## 关键发现', '## 本研究的页面', '## 待解问题', '## 方法与来源'],
};

export function defaultReportSections(language: string): string[] {
  return REPORT_SECTIONS[language.slice(0, 2).toLowerCase()] ?? REPORT_SECTIONS.en;
}

const SOURCE_MARKER: Record<string, string> = { en: '(Source: raw/docs/…)', zh: '（来源：raw/docs/…）' };

/** How a page in this language cites a file inline (the research protocol and templates show the Chinese form). */
export function sourceMarker(language: string): string {
  return SOURCE_MARKER[language.slice(0, 2).toLowerCase()] ?? SOURCE_MARKER.en;
}

const NOTE_HEADINGS: Record<string, string[]> = {
  en: ['## Findings', '## Data', '## Views', '## Gaps'],
  zh: ['## 发现', '## 数据', '## 观点', '## 缺口'],
};

/** A collector's note headings in this language, in their fixed order: findings, data, views, gaps. */
export function noteHeadings(language: string): string[] {
  return NOTE_HEADINGS[language.slice(0, 2).toLowerCase()] ?? NOTE_HEADINGS.en;
}

/** A collector's note with its fixed headings in this language, whichever language it headed them in. */
export function localizeNoteHeadings(text: string, language: string): string {
  const wanted = noteHeadings(language);
  return text.replace(/^##[ \t].*$/gm, (line) => {
    const heading = line.replace(/\s+/g, ' ').trim();
    for (const headings of Object.values(NOTE_HEADINGS)) {
      const i = headings.indexOf(heading);
      if (i >= 0) return wanted[i];
    }
    return line;
  });
}

/** 'zh' when the text is mostly CJK, else 'en'. */
export function detectLanguage(text: string): string {
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return cjk > 0 && cjk * 3 >= latin ? 'zh' : 'en';
}

function str(v: unknown, max = 2000): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function strs(v: unknown, max: number, each = 300): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  return [...new Set(list.map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x).trim().slice(0, each) : '')).filter(Boolean))].slice(0, max);
}

function heading(v: string): string {
  const t = v.replace(/^#+\s*/, '').trim();
  return t ? `## ${t}` : '';
}

const SOURCES_LIKE = /^(sources?|references?|bibliography|来源|参考资料|参考文献|资料来源)$/i;

/**
 * Whatever the model wrote, made into a brief the study can run: ids, unique
 * slugs, `## ` headings without a sources section (each page gets the one for
 * its language), every question on a page, limits applied, the person's
 * answers kept.
 */
export function normalizeBrief(raw: Record<string, unknown>, input: { topic: string; maxPages: number; language?: string; answers?: Record<string, string> }): StudyBrief {
  const language = (str(raw.language, 12) || input.language || detectLanguage(input.topic)).toLowerCase();
  const title = str(raw.title, 160) || input.topic.trim().split('\n')[0].slice(0, 120) || 'Untitled study';
  const today = new Date().toISOString().slice(0, 10);
  const scopeRaw = (raw.scope ?? {}) as Record<string, unknown>;

  const pagesRaw = Array.isArray(raw.pages) ? raw.pages : [];
  const pages: StudyPage[] = [];
  const slugs = new Set<string>();
  const idMap = new Map<string, string>();
  for (const p of pagesRaw) {
    if (!p || typeof p !== 'object' || pages.length >= Math.max(1, input.maxPages)) continue;
    const o = p as Record<string, unknown>;
    const pageTitle = str(o.title, 160);
    if (!pageTitle) continue;
    const id = `p${pages.length + 1}`;
    if (typeof o.id === 'string' && o.id.trim()) idMap.set(o.id.trim(), id);
    let slug = researchSlug(str(o.slug, 80) || pageTitle) || id;
    if (/^entity-[0-9a-f]{8}$/.test(slug)) slug = id;
    for (let n = 2; slugs.has(slug); n++) slug = `${slug.replace(/-\d+$/, '')}-${n}`;
    slugs.add(slug);
    const sections = [...new Set(strs(o.sections, 10, 120).map(heading).filter((h) => h && !SOURCES_LIKE.test(h.replace(/^##\s*/, ''))))].slice(0, 8);
    pages.push({
      id, title: pageTitle, slug, purpose: str(o.purpose, 600),
      sections: sections.length ? sections : language.startsWith('zh') ? ['## 概要', '## 发现', '## 分析', '## 缺口'] : ['## Overview', '## Findings', '## Analysis', '## Gaps'],
      questions: [], charts: strs(o.charts, 4, 200), entities: strs(o.entities, 12, 120),
    });
  }
  if (pages.length === 0) {
    pages.push({
      id: 'p1', title, slug: researchSlug(title) || 'findings', purpose: str(raw.objective, 600) || input.topic.slice(0, 600),
      sections: language.startsWith('zh') ? ['## 背景', '## 发现', '## 评估', '## 缺口'] : ['## Background', '## Findings', '## Assessment', '## Gaps'],
      questions: [], charts: [], entities: [],
    });
  }

  const questions: StudyQuestion[] = [];
  for (const q of Array.isArray(raw.questions) ? raw.questions : []) {
    if (!q || typeof q !== 'object' || questions.length >= 40) continue;
    const o = q as Record<string, unknown>;
    const text = str(o.text, 400);
    if (!text) continue;
    const wanted = str(o.page, 20);
    const page = idMap.get(wanted) ?? (pages.some((p) => p.id === wanted) ? wanted : pages[questions.length % pages.length].id);
    const id = `q${questions.length + 1}`;
    questions.push({ id, text, why: str(o.why, 400), page, queries: strs(o.queries, 5, 120) });
  }
  // each page lists its questions; a page the plan left without any gets one from its purpose
  for (const p of pages) {
    p.questions = questions.filter((q) => q.page === p.id).map((q) => q.id);
    if (p.questions.length === 0) {
      const id = `q${questions.length + 1}`;
      questions.push({ id, text: p.purpose || p.title, why: '', page: p.id, queries: [] });
      p.questions.push(id);
    }
  }

  const answers = input.answers ?? {};
  const clarifications: StudyClarification[] = [];
  for (const c of Array.isArray(raw.clarifications) ? raw.clarifications : []) {
    if (!c || typeof c !== 'object' || clarifications.length >= 5) continue;
    const o = c as Record<string, unknown>;
    const question = str(o.question, 300);
    if (!question) continue;
    const answer = answers[question] ?? str(o.answer, 300);
    clarifications.push({ question, options: strs(o.options, 5, 160), ...(answer ? { answer } : {}) });
  }

  const report = (raw.report ?? {}) as Record<string, unknown>;
  const reportSections = [...new Set(strs(report.sections, 10, 120).map(heading).filter((h) => h && !SOURCES_LIKE.test(h.replace(/^##\s*/, ''))))];
  const seedUrls: { url: string; why: string }[] = [];
  for (const u of Array.isArray(raw.seedUrls) ? raw.seedUrls : []) {
    const o = (typeof u === 'string' ? { url: u } : u) as Record<string, unknown>;
    const url = str(o?.url, 1000);
    if (/^https?:\/\/[^\s]+$/i.test(url) && !seedUrls.some((s) => s.url === url) && seedUrls.length < 10) seedUrls.push({ url, why: str(o?.why, 300) });
  }
  return {
    title,
    slug: researchSlug(str(raw.slug, 80) || title) || 'study',
    language,
    objective: str(raw.objective, 2000) || input.topic.trim().slice(0, 2000),
    restatement: str(raw.restatement, 3000),
    scope: {
      include: strs(scopeRaw.include, 12), exclude: strs(scopeRaw.exclude, 12),
      timeframe: str(scopeRaw.timeframe, 200), asOf: str(scopeRaw.asOf, 40) || today,
    },
    assumptions: strs(raw.assumptions, 10, 400),
    clarifications,
    questions,
    pages,
    entities: strs(raw.entities, 30, 120),
    seedUrls,
    searchQueries: strs(raw.searchQueries, 20, 200),
    report: { title: str(report.title, 160) || title, sections: reportSections.length ? reportSections.slice(0, 8) : defaultReportSections(language) },
  };
}

/** A brief with no model behind it: the topic as one page, for the person to fill in. */
export function templateBrief(topic: string, maxPages: number, language?: string): StudyBrief {
  const lang = language || detectLanguage(topic);
  const zh = lang.startsWith('zh');
  return normalizeBrief({
    clarifications: [{ question: zh ? '没有可用的规划模型，这是一份模版简报：开始前请补充问题与页面。' : 'No refiner model was reachable, so this brief is a template: add questions and pages before starting.', options: [] }],
  }, { topic, maxPages, language: lang });
}

/** What the knowledge base already knows about the topic, for the refiner (a resolve without a receipt). */
async function knowledgeContext(ctx: AppContext, topic: string): Promise<string> {
  try {
    const pack = await resolve(ctx, topic.slice(0, 2000), { record: false, actor: 'research' });
    const lines: string[] = [];
    if (pack.intent.entities.length) {
      lines.push('知识库里匹配到的实体：');
      for (const e of pack.intent.entities.slice(0, 10)) lines.push(`- ${e.name}（${e.type}${e.aliases.length ? `；别名 ${e.aliases.slice(0, 4).join('、')}` : ''}）${e.description ? `：${e.description.slice(0, 160)}` : ''}`);
    }
    if (pack.documents.length) {
      lines.push('相关文档：');
      for (const d of pack.documents.slice(0, 10)) lines.push(`- ${d.path}${d.title ? ` — ${d.title}` : ''}`);
    }
    if (pack.facts.length) lines.push(`已知事实 ${pack.facts.length} 条，例如：${pack.facts.slice(0, 5).map((f) => f.statement.slice(0, 80)).join('；')}`);
    return lines.length ? lines.join('\n') : '知识库里还没有这个主题的资料：几乎所有内容都要从外部来源收集。';
  } catch (err) {
    return `（知识库预查失败：${err instanceof Error ? err.message : err}）`;
  }
}

/**
 * The model that refines: `research.study.refiner` when set; else the
 * default LLM when it is a model endpoint; else the study's own agent, once,
 * as a one-shot completion (a CLI runs one non-interactive turn).
 */
export function refinerClient(ctx: AppContext, agent: ResearchAgent | null | undefined): LlmClient | null {
  const spec = ctx.config.research.study?.refiner?.trim();
  const fromAgent = (a: ResearchAgent | null): LlmClient | null => {
    if (!a) return null;
    const base: LlmConfig = { ...ctx.config.llm, provider: a.provider === 'deep-agents' ? 'openai' : a.provider, model: a.model, cliPath: a.kind === 'cli' ? a.cliPath : '', effort: 'medium', speed: 'default', cliTimeoutMs: Math.max(ctx.config.llm.cliTimeoutMs ?? 0, 600_000) };
    if (a.kind === 'builtin') Object.assign(base, { baseUrl: a.baseUrl, apiKey: a.apiKey, protocol: a.protocol });
    // OpenCode runs on its own connection, not on whatever the default is
    else if (a.endpoint) Object.assign(base, a.endpoint);
    const client = new LlmClient(base);
    return client.enabled ? client : null;
  };
  if (spec) {
    const connection = llmTargets(ctx.config).find((c) => c.id === spec);
    if (connection && !isCliProvider(connection.provider)) {
      const client = new LlmClient(connection);
      if (client.enabled) return client;
    }
    const named = fromAgent(agentForSpec(ctx.config, spec, '', ctx.dataDir));
    if (named) return named;
  }
  if (ctx.llm.enabled && !isCliProvider(ctx.llm.provider)) return ctx.llm;
  return fromAgent(agent ?? null) ?? (ctx.llm.enabled ? ctx.llm : null);
}

function sourcesContext(sources: ResearchSource[], web: boolean): string {
  const lines = [`本研究可用的来源：知识库（默认）${web ? '、网络搜索' : '（不联网）'}`];
  for (const s of sources) lines.push(`- ${s.title}（${s.kind}${s.kind === 'site' && s.domains.length ? `：${s.domains.join('、')}` : ''}）${s.description ? `：${s.description}` : ''}`);
  return lines.join('\n');
}

export async function refineBrief(ctx: AppContext, input: RefineInput): Promise<RefineResult> {
  const t0 = Date.now();
  const language = input.language || input.brief?.language || detectLanguage(input.topic);
  const client = refinerClient(ctx, input.agent);
  if (!client) {
    return { brief: input.brief ?? templateBrief(input.topic, input.maxPages, language), refiner: 'template', error: 'no refiner model: configure an LLM (Settings → Providers & Agents) or research.study.refiner', ms: Date.now() - t0 };
  }
  const answers = Object.entries(input.answers ?? {}).filter(([, a]) => a?.trim());
  const context = [
    '## 用户的研究请求', '', input.topic.trim(), '',
    '## 知识库现状', '', await knowledgeContext(ctx, input.topic), '',
    '## 来源', '', sourcesContext(input.sources, input.web), '',
    ...(input.brief ? ['## 上一版简报', '', '```json', JSON.stringify(input.brief, null, 2), '```', ''] : []),
    ...(answers.length ? ['## 用户对澄清问题的回答', '', ...answers.map(([q, a]) => `- ${q} → ${a}`), ''] : []),
    ...(input.feedback?.trim() ? ['## 用户的修改意见', '', input.feedback.trim(), ''] : []),
  ].join('\n');
  const prompt = loadPhasePrompt(ctx.dataDir, 'refine', {
    today: new Date().toISOString().slice(0, 10),
    language: language.startsWith('zh') ? 'zh（中文）' : language === 'en' ? 'en（English）' : language,
    maxPages: String(input.maxPages),
    context,
  });
  try {
    const reply = await client.complete([{ role: 'user', content: prompt }], { json: true, maxTokens: 8_000 });
    const parsed = extractJson<Record<string, unknown>>(reply);
    if (!parsed) throw new Error(`the refiner answered no JSON: ${reply.slice(0, 200)}`);
    // the model echoes "zh（中文）" back sometimes; keep the tag
    if (typeof parsed.language === 'string') parsed.language = parsed.language.replace(/[（(].*$/, '').trim();
    const brief = normalizeBrief(parsed, { topic: input.topic, maxPages: input.maxPages, language, answers: input.answers });
    // a brief already started on keeps its folder name
    if (input.brief?.slug) brief.slug = input.brief.slug;
    return { brief, refiner: client.label, error: null, ms: Date.now() - t0 };
  } catch (err) {
    return { brief: input.brief ?? templateBrief(input.topic, input.maxPages, language), refiner: client.label, error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 };
  }
}
