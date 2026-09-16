import fs from 'node:fs';
import path from 'node:path';
import { AppContext } from '../context.js';
import { resolve } from '../compiler/resolve.js';
import { checkout } from '../compiler/workset.js';
import { safePath } from '../fs/files.js';
import { loadOntology, promptFragment } from '../graph/ontology.js';
import { parseFrontmatter } from '../markdown.js';
import { archivePage } from '../wiki/pages.js';
import { stripRegions } from '../wiki/regions.js';
import { ResearchJob } from './jobs.js';
import { loadResearchProtocol, renderOutputPath, ResearchTemplate } from './templates.js';
import { profileBrief, requiredSections, ResearchProfile } from './profile.js';

/**
 * The run workspace an agent CLI is launched in: `<data>/<runsDir>/<jobId>/`.
 *
 *   CLAUDE.md / AGENTS.md   the schema: protocol + template + the wiki's own purpose/schema notes
 *   brief.md                this job: target, output contract, a context seed from knode_resolve,
 *                           the existing page (for refresh / overwrite), previous rejection reasons
 *   .mcp.json               MCP endpoint for Claude Code (headers carry token + workspace)
 *   .cursor/mcp.json        the same for cursor-agent
 *   transcript.jsonl        stdout of the run (stream-json / NDJSON)
 *   result.json             what the runner concluded
 *
 * Nothing the agent writes here reaches the knowledge base: pages go through
 * `knode_write` over MCP, which enforces the writable roots.
 */

export interface McpEndpoint {
  url: string;
  token: string;
  /** Workspace routing headers (x-knode-user / x-knode-workspace-*). */
  headers: Record<string, string>;
}

export interface RunWorkspace {
  dir: string;
  briefPath: string;
  outputPath: string;
  /** The agent's actor string, e.g. agent/claude-cli. */
  actor: string;
  /** Value of the page's `research` frontmatter key. */
  research: Record<string, unknown>;
  worksetId: string;
  existingPage: string | null;
  humanParagraphs: string[];
}

export function runsRoot(dataDir: string, runsDir: string): string {
  return safePath(dataDir, runsDir || '.runs');
}

function isAgentAuthored(text: string): boolean {
  const actor = parseFrontmatter(text).frontmatter.actor;
  return typeof actor === 'string' && /^(agent|mcp|api)\b/i.test(actor);
}

/** Paragraphs a person wrote on an existing page (outside managed regions), long enough to be worth protecting. */
export function humanParagraphsOf(text: string): string[] {
  const { body } = parseFrontmatter(text);
  return stripRegions(body)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 40 && !p.startsWith('#'));
}

async function contextSeed(ctx: AppContext, query: string, worksetId: string): Promise<string> {
  try {
    const pack = await resolve(ctx, query, { record: false, actor: 'research' });
    const lines: string[] = [];
    if (pack.intent.entities.length) {
      lines.push('### 匹配到的实体', '');
      for (const e of pack.intent.entities.slice(0, 8)) lines.push(`- ${e.name} (${e.type}${e.aliases.length ? `; 别名: ${e.aliases.join(', ')}` : ''}${e.wikiPath ? `; 页面: ${e.wikiPath}` : ''}) — ${e.description || ''}`.trim());
      lines.push('');
    }
    if (pack.facts.length) {
      lines.push('### 已知事实（前 20 条）', '');
      for (const f of pack.facts.slice(0, 20)) {
        const when = f.eventDate ?? f.startDate;
        lines.push(`- ${when ? `${when} · ` : ''}${f.statement} [${f.status}${f.stale ? ', stale' : ''}]${f.path ? ` （来源：${f.path}）` : ''}`);
      }
      lines.push('');
    }
    if (pack.documents.length) {
      lines.push('### 相关文档', '');
      for (const d of pack.documents.slice(0, 12)) lines.push(`- ${d.path}${d.title ? ` — ${d.title}` : ''}`);
      lines.push('');
    }
    if (pack.unknowns.length) {
      lines.push('### 本地回答不了的缺口', '');
      for (const u of pack.unknowns.slice(0, 8)) lines.push(`- ${u.question}（默认假设：${u.defaultAssumption}；风险 ${u.risk}）`);
      lines.push('');
    }
    if (pack.availableNextQueries.length) {
      lines.push('### 值得先跑的查询', '');
      for (const n of pack.availableNextQueries.slice(0, 6)) lines.push(`- ${n.capability}: ${n.reason}`);
      lines.push('');
    }
    lines.push(`（以上由 knode_resolve 预先整理；receiptId ${pack.receiptId}；workset ${worksetId}）`);
    return lines.join('\n');
  } catch (err) {
    return `（knode_resolve 预整理失败：${err instanceof Error ? err.message : err}；请自行调用）`;
  }
}

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(target|query|output|actor|research|slug)\}/g, (m, key: string) => vars[key] ?? m);
}

export async function prepareRunWorkspace(
  ctx: AppContext,
  job: ResearchJob,
  template: ResearchTemplate,
  opts: { runsDir: string; provider: string; mcp: McpEndpoint; readDirs: string[]; dir?: string; allowNetwork?: boolean; profile?: ResearchProfile | null },
): Promise<RunWorkspace> {
  const dir = opts.dir ?? path.join(runsRoot(ctx.dataDir, opts.runsDir), job.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.cursor'), { recursive: true });

  const outputPath = renderOutputPath(template, job);
  const actor = `agent/${opts.provider}`;
  const worksetId = job.worksetId ?? (await checkout(ctx.store, { actor, note: `research ${job.id}: ${job.kind} ${job.target ?? job.query ?? ''}` })).id;
  const research = { job: job.id, kind: job.kind, template: template.name, at: new Date().toISOString(), agent: opts.provider, workset: worksetId };
  const subject = job.kind === 'question' ? job.query ?? job.target ?? '' : job.target ?? job.query ?? '';
  const vars = { target: job.target ?? subject, query: job.query ?? subject, output: outputPath, actor, research: JSON.stringify(research), slug: path.posix.basename(outputPath, '.md') };

  const abs = safePath(ctx.dataDir, outputPath);
  let existingPage = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  // a generated stub (a view) at the output path is archived first: the page the
  // agent writes is a Source, and a live pages row would classify it as a view
  const [view] = await ctx.store.query<{ path: string }>(`SELECT path FROM pages WHERE path = $1 AND tx_to IS NULL`, [outputPath]);
  if (view) {
    existingPage = existingPage ?? null;
    await archivePage(ctx, outputPath, 'research');
  } else if (existingPage) {
    // a source page (human or agent) the agent will overwrite through knode_write:
    // kept here so a rejected draft can be rolled back to it
    fs.writeFileSync(path.join(dir, 'existing.md'), existingPage);
  }
  // prose to protect: what a person wrote. A page an agent authored is rewritten wholesale on refresh.
  const humanParagraphs = existingPage && !isAgentAuthored(existingPage) ? humanParagraphsOf(existingPage) : [];
  const ontology = loadOntology(ctx.dataDir);
  const vocab = promptFragment(ontology);

  const notes: string[] = [];
  for (const f of ['purpose.md', 'schema.md']) {
    const p = path.join(ctx.dataDir, f);
    if (fs.existsSync(p)) notes.push(`## ${f}\n\n${fs.readFileSync(p, 'utf8').trim()}`);
  }
  const schema = [
    loadResearchProtocol(ctx.dataDir).trim(),
    '',
    `# 本任务的模版（${template.path}）`,
    '',
    fill(template.body, vars),
    '',
    notes.length ? `# 知识库自述\n\n${notes.join('\n\n')}` : '',
  ].filter(Boolean).join('\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), schema);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), schema);

  const previous = Array.isArray(job.payload.rejections) ? (job.payload.rejections as string[]) : [];
  const brief = [
    `# 研究任务 ${job.id}`,
    '',
    `- 类型：${job.kind}`,
    job.target ? `- 目标：${job.target}` : null,
    job.query ? `- 问题：${job.query}` : null,
    `- 输出路径（只写这里，用 knode_write）：\`${outputPath}\``,
    `- workset：\`${worksetId}\`（所有 knode_* 读取都带上它）`,
    `- frontmatter 必需键：${template.requires.frontmatter.join(', ') || '（无额外要求）'}`,
    `- 必需章节：${requiredSections(template, opts.profile).join(' / ') || '（无固定章节）'}`,
    `- frontmatter 固定值：\`actor: ${actor}\`；\`research: ${JSON.stringify(research)}\``,
    `- 只读资料目录：${opts.readDirs.join(', ')}`,
    `- 联网核实：${opts.allowNetwork ? '允许（WebSearch / WebFetch 可用；来源写 URL，单一外部来源的断言用 suspected）' : '不允许（只用知识库与只读资料）'}`,
    '',
    ...(opts.profile ? [...profileBrief(opts.profile, { allowNetwork: Boolean(opts.allowNetwork) }), ''] : []),
    '## 可用的关系谓词（frontmatter relations 的键）',
    '',
    vocab.relationTypes,
    '',
    `实体类型：${vocab.entityTypes}`,
    '',
    previous.length ? `## 上一次提交被退回，原因\n\n${previous.map((r) => `- ${r}`).join('\n')}\n` : '',
    existingPage ? `## 输出路径上已有页面（${humanParagraphs.length} 段人写内容必须原样保留）\n\n\`\`\`markdown\n${existingPage.trim()}\n\`\`\`\n` : '',
    '## 知识库预整理',
    '',
    await contextSeed(ctx, subject, worksetId),
    '',
    '开始吧：先 knode_resolve，然后按模版逐节取证，最后 knode_write → knode_feedback → knode_commit。',
  ].filter((l) => l !== null && l !== '').join('\n');
  const briefPath = path.join(dir, 'brief.md');
  fs.writeFileSync(briefPath, brief);

  const server = { type: 'http', url: opts.mcp.url, headers: { Authorization: `Bearer ${opts.mcp.token}`, ...opts.mcp.headers } };
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { 'knode-os': server } }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { 'knode-os': { url: opts.mcp.url, headers: server.headers } } }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'README.md'), `Run workspace for research job ${job.id}. brief.md is the prompt; CLAUDE.md / AGENTS.md the schema; transcript.jsonl the agent's output.\n`);

  return { dir, briefPath, outputPath, actor, research, worksetId, existingPage, humanParagraphs };
}

/** Keep only the newest `keep` run directories. */
export function pruneRuns(dataDir: string, runsDir: string, keep: number): number {
  const root = runsRoot(dataDir, runsDir);
  if (!fs.existsSync(root)) return 0;
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(root, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const e of entries.slice(Math.max(0, keep))) {
    fs.rmSync(path.join(root, e.name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}
