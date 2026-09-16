// A stand-in for a coding-agent CLI. Launched like `claude -p …` with the
// prompt on stdin, it reads .mcp.json from the run workspace, connects to the
// knode MCP endpoint and behaves according to the phase named in the prompt's
// first line (team pipeline) or, without one, writes the page in one go.
//
//   FAKE_AGENT_MODE   good (default) | bad (missing sections) | contradict | drop-human
//   FAKE_AGENT_REVIEW critique → the first review of a run fails once, forcing a revise round
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const prompt = fs.readFileSync(0, 'utf8');
const phase = /<!--\s*knode-phase:\s*(\w+)\s*-->/.exec(prompt)?.[1] ?? null;
const mcpConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.mcp.json'), 'utf8'));
const server = mcpConfig.mcpServers['knode-os'];
const outputPath = process.env.KNODE_OUTPUT_PATH ?? /输出路径[^`]*`([^`]+)`/.exec(prompt)?.[1];
const mode = process.env.FAKE_AGENT_MODE ?? 'good';
const target = /- 目标：(.+)/.exec(prompt)?.[1]?.trim() ?? 'unknown';
const workset = process.env.KNODE_WORKSET ?? /workset：`([^`]+)`/.exec(prompt)?.[1] ?? '';
const requiredSections = (/- 必需章节：(.+)/.exec(prompt)?.[1] ?? '').split(' / ').map((s) => s.trim()).filter((s) => s.startsWith('#'));

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const finish = (text, turns) => emit({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: turns, total_cost_usd: 0.0123 });
emit({ type: 'system', subtype: 'init', cwd: process.cwd(), phase });
// what the harness launched us with, so tests can check the adapter flags
try {
  fs.writeFileSync(path.join(process.cwd(), `argv-${phase ?? 'agent'}.json`), JSON.stringify(process.argv.slice(2)));
} catch {
  // read-only workspace in some tests
}

if (phase === 'plan') {
  const sections = requiredSections.filter((s) => !/来源/.test(s)).slice(0, 2).map((title) => ({
    title, questions: [`${target} 的${title.replace(/^#+\s*/, '')}？`], queries: [target], entities: [target],
  }));
  finish(JSON.stringify({ sections, notes: '分两路调查' }), 2);
  process.exit(0);
}
if (phase === 'research') {
  const section = /阶段 2：调查「(.+?)」/.exec(prompt)?.[1] ?? 'section';
  finish(`## 发现\n- ${target}：${section} 的一条发现 · 2025 ·（来源：raw/docs/trusted.md）\n\n## 候选 claims\n- {"statement":"2025 年营业收入 4000 亿元","type":"revenue","status":"fact","eventDate":"2025","source":"raw/docs/trusted.md"}\n\n## 候选 relations\n- {"target":"特斯拉","type":"supplies_to","source":"raw/docs/trusted.md"}\n\n## 缺口\n- 无\n`, 3);
  process.exit(0);
}
if (phase === 'review') {
  const marker = path.join(process.cwd(), '.fake-review-done');
  if (process.env.FAKE_AGENT_REVIEW === 'critique' && !fs.existsSync(marker)) {
    fs.writeFileSync(marker, '1');
    finish(JSON.stringify({ pass: false, issues: [{ where: '## 概要', problem: '结论缺少来源', fix: '补上来源路径并标注（已修订）' }], summary: '需要修订一次' }), 2);
  } else {
    finish(JSON.stringify({ pass: true, issues: [], summary: '通过' }), 2);
  }
  process.exit(0);
}

// synthesize / revise / single-session: write the page through MCP
const client = new Client({ name: 'fake-agent', version: '0' });
await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
let turns = 1;
let receipt = null;
if (phase !== 'revise') {
  const resolved = await client.callTool({ name: 'knode_resolve', arguments: { query: target, workset: workset || undefined } });
  turns++;
  try {
    receipt = JSON.parse(resolved.content?.[0]?.text ?? '{}').receiptId ?? null;
  } catch {
    receipt = null;
  }
}
const search = await client.callTool({ name: 'knode_search', arguments: { query: target, k: 3 } });
turns++;
const sources = (() => {
  try {
    return [...new Set(JSON.parse(search.content?.[0]?.text ?? '[]').map((r) => r.path))].slice(0, 3);
  } catch {
    return [];
  }
})();
if (sources.length === 0) sources.push('raw/docs/trusted.md');

const revised = phase === 'revise' ? '（已修订）' : '';
const claimStatement = mode === 'contradict' ? '2025 年营业收入 9999 亿元' : '2025 年营业收入 4000 亿元';
const sections = mode === 'bad'
  ? `## 概要\n\n${target} 是一家公司。\n`
  : [
    '## 概要', '', `${target} 是全球领先的动力电池制造商${revised}（来源：${sources[0]}）。`, '',
    '## 关键事实', '', `- ${claimStatement}（来源：${sources[0]}）`, '',
    '## 关系', '', '- 向 [[特斯拉]] 供货（supplies_to）', '',
    '## 时间线', '', '- 2011-12-16 · 公司成立', '',
    '## 争议与缺口', '', '- 暂无', '',
    '## 来源', '', ...sources.map((s) => `- ${s}`), '',
  ].join('\n');
const human = mode === 'drop-human' ? '' : (/(?<=```markdown\n)[\s\S]*?(?=\n```)/.exec(prompt)?.[0] ?? '')
  .split(/\n\s*\n/).filter((p) => p.trim().startsWith('人工备注')).join('\n\n');
const content = `---
type: organization
title: ${target}
aliases: [CATL, "300750"]
description: 动力电池制造商
relations:
  supplies_to: ["[[特斯拉]]"]
claims:
  - { statement: "${claimStatement}", type: revenue, status: fact, eventDate: "2025" }
sources: [${sources.map((s) => JSON.stringify(s)).join(', ')}]
---
# ${target}

${sections}${human ? `\n${human}\n` : ''}`;

const wrote = await client.callTool({ name: 'knode_write', arguments: { path: outputPath, content } });
turns++;
if (wrote.isError) {
  emit({ type: 'result', subtype: 'error', is_error: true, result: `knode_write failed: ${wrote.content?.[0]?.text}`, num_turns: turns });
  process.exit(1);
}
if (receipt) {
  await client.callTool({ name: 'knode_feedback', arguments: { receipt_id: receipt, used_ids: [], outcome: 'answered' } });
  turns++;
}
if (workset && phase !== 'revise') {
  await client.callTool({ name: 'knode_commit', arguments: { workset, content: `研究了 ${target}，写了 ${outputPath}。`, title: `research log ${target}` } });
  turns++;
}
await client.close();
finish(`wrote ${outputPath}`, turns);
