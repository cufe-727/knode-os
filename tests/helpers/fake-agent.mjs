// A stand-in for a coding-agent CLI. Launched like `claude -p …` with the
// prompt on stdin, it reads .mcp.json from the run workspace, connects to the
// knode MCP endpoint and behaves according to the phase named in the prompt's
// first line (team pipeline) or, without one, writes the page in one go.
//
//   FAKE_AGENT_MODE   good (default) | bad (missing sections) | contradict | drop-human
//                     | bad-guide (init: the guide misses a section) | no-guide (init: only the overview is written)
//                     | slow (sleeps 3 s first — cancel tests)
//                     | limit (fails at once with claude's usage-limit result, as a spent 5-hour limit does)
//   FAKE_AGENT_LIMIT_MATCH  with limit: only a prompt this pattern matches hits the limit (one collector of several)
//                     | teach (chat: writes a note through knode_write + knode_sync)
//   FAKE_AGENT_REVIEW critique → the first review of a run fails once, forcing a revise round
//   FAKE_AGENT_SLEEP_MS  how long `slow` sleeps (default 3000)
//   FAKE_CAPTURE_URL  a study's collector (phase collect) captures <url>?part=<n> through knode_capture
//   FAKE_STUDY_CHART  bad → a study page carries a chart block the validator must refuse
//
// Started as `opencode run …` (fake-opencode.sh), it speaks OpenCode instead: the MCP
// endpoint comes from the generated config in OPENCODE_CONFIG_CONTENT ({env:…} filled
// in as OpenCode would), and what it prints are `opencode run --format json` events.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const prompt = fs.readFileSync(0, 'utf8');
const phase = /<!--\s*knode-phase:\s*(\w+)\s*-->/.exec(prompt)?.[1] ?? null;
const opencode = process.argv[2] === 'run';
const substitute = (text) => text.replace(/\{env:([^}]+)\}/g, (_, name) => process.env[name] ?? '');
const opencodeConfig = opencode ? JSON.parse(substitute(process.env.OPENCODE_CONFIG_CONTENT ?? '{}')) : null;
const server = opencode
  ? opencodeConfig.mcp['knode-os']
  : JSON.parse(fs.readFileSync(path.join(process.cwd(), '.mcp.json'), 'utf8')).mcpServers['knode-os'];
const outputPath = process.env.KNODE_OUTPUT_PATH ?? /输出路径[^`]*`([^`]+)`/.exec(prompt)?.[1];
const mode = process.env.FAKE_AGENT_MODE ?? 'good';
const target = /- 目标：(.+)/.exec(prompt)?.[1]?.trim() ?? 'unknown';
const workset = process.env.KNODE_WORKSET ?? /workset：`([^`]+)`/.exec(prompt)?.[1] ?? '';
const requiredSections = (/- 必需章节：(.+)/.exec(prompt)?.[1] ?? '').split(' / ').map((s) => s.trim()).filter((s) => s.startsWith('#'));
// an init brief names a companion output (the guide) and its required sections
const isInit = /- 类型：init/.test(prompt);
const companion = /- 附加输出[^\n]*?：`([^`]+)`；必需章节：(.+)/.exec(prompt);
const guidePath = companion?.[1] ?? null;
const guideSections = (companion?.[2] ?? '').split(' / ').map((s) => s.trim()).filter((s) => s.startsWith('#'));

const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
// claude's stream-json, put into OpenCode's events when started as opencode: a tool call
// is one `tool_use` once it finished, the result a `text` part and the step's `step_finish`
const pendingTools = new Map();
const opencodeEvent = (obj) => {
  const base = { timestamp: Date.now(), sessionID: 'ses_fake' };
  const block = obj.message?.content?.[0];
  if (obj.type === 'system') return write({ ...base, type: 'step_start', part: { type: 'step-start' } });
  if (obj.type === 'assistant' && block?.type === 'tool_use') return void pendingTools.set(block.id, block);
  if (obj.type === 'user' && block?.type === 'tool_result') {
    const call = pendingTools.get(block.tool_use_id);
    const state = block.is_error ? { status: 'error', input: call?.input ?? {}, error: 'tool failed' } : { status: 'completed', input: call?.input ?? {}, output: '', title: '' };
    return write({ ...base, type: 'tool_use', part: { type: 'tool', callID: block.tool_use_id, tool: String(call?.name ?? '').replace(/^mcp__knode-os__/, 'knode-os_'), state } });
  }
  if (obj.type === 'result') {
    if (obj.is_error) return write({ ...base, type: 'error', error: { name: 'APIError', data: { message: String(obj.result) } } });
    write({ ...base, type: 'text', part: { type: 'text', text: String(obj.result), time: { start: 1, end: 2 } } });
    const steps = Math.max(1, obj.num_turns ?? 1);
    for (let i = 0; i < steps; i++) write({ ...base, type: 'step_finish', part: { type: 'step-finish', reason: 'stop', cost: 0, tokens: { input: 1000, output: 40, reasoning: 10, cache: { read: 500, write: 0 } } } });
  }
};
const emit = (obj) => (opencode ? opencodeEvent(obj) : write(obj));
const finish = (text, turns) => emit({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: turns, total_cost_usd: 0.0123 });
emit({ type: 'system', subtype: 'init', cwd: process.cwd(), phase });
// what the harness launched us with, so tests can check the adapter flags and the prompt
try {
  fs.writeFileSync(path.join(process.cwd(), `argv-${phase ?? 'agent'}.json`), JSON.stringify(process.argv.slice(2)));
  fs.writeFileSync(path.join(process.cwd(), `prompt-${phase ?? 'agent'}.md`), prompt);
  if (opencode) {
    // the config as OpenCode received it (no secret in it), and whether the key arrived beside it
    fs.writeFileSync(path.join(process.cwd(), `opencode-config-${phase ?? 'agent'}.json`), process.env.OPENCODE_CONFIG_CONTENT ?? '');
    // the key only as its hash, so a test can look for the key itself in every file a run leaves
    const flags = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('OPENCODE_DISABLE_')));
    const key = process.env.KNODE_OPENCODE_API_KEY;
    fs.writeFileSync(path.join(process.cwd(), `opencode-env-${phase ?? 'agent'}.json`), JSON.stringify({ ...flags, keySha256: key ? crypto.createHash('sha256').update(key).digest('hex') : null }));
  }
} catch {
  // read-only workspace in some tests
}
if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_AGENT_SLEEP_MS ?? 3000)));
if (mode === 'limit' && (!process.env.FAKE_AGENT_LIMIT_MATCH || new RegExp(process.env.FAKE_AGENT_LIMIT_MATCH).test(prompt))) {
  emit({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your 5-hour limit · resets 1:30am (Asia/Shanghai)", num_turns: 1, total_cost_usd: 0 });
  process.exit(1);
}

if (phase === 'plan') {
  const sections = requiredSections.filter((s) => !/来源/.test(s)).slice(0, 2).map((title) => ({
    title, questions: [`${target} 的${title.replace(/^#+\s*/, '')}？`], queries: [target], entities: [target],
  }));
  const topics = isInit ? [{ kind: 'entity', target: '宁德时代', why: '提及最多、还没有研究页' }, { kind: 'concept', target: '动力电池', why: '一组文档共同的主题' }, { kind: 'bogus', target: 'x', why: '' }] : undefined;
  finish(JSON.stringify({ sections, ...(topics ? { topics } : {}), notes: '分两路调查' }), 2);
  process.exit(0);
}
if (phase === 'research') {
  const section = /阶段 2：调查「(.+?)」/.exec(prompt)?.[1] ?? 'section';
  if (isInit) {
    finish(`## 发现\n- 资料集中在 raw/docs（来源：raw/docs/trusted.md）\n\n## 值得单独成页的主题\n- {"kind":"entity","target":"宁德时代","why":"核心实体"}\n\n## 给指南的提示\n- 财务数字先查 knode_claims（subject=宁德时代）\n\n## 缺口\n- 只有 2025 年的资料\n`, 3);
  } else {
    finish(`## 发现\n- ${target}：${section} 的一条发现 · 2025 ·（来源：raw/docs/trusted.md）\n\n## 候选 claims\n- {"statement":"2025 年营业收入 4000 亿元","type":"revenue","status":"fact","eventDate":"2025","source":"raw/docs/trusted.md"}\n\n## 候选 relations\n- {"target":"特斯拉","type":"supplies_to","source":"raw/docs/trusted.md"}\n\n## 缺口\n- 无\n`, 3);
  }
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

// synthesize / revise / single-session / chat: talk to the index through MCP
const client = new Client({ name: 'fake-agent', version: '0' });
await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
let turns = 1;
// a tool call, announced the way claude's stream-json does (so activity parsers can be tested), then made for real
const tool = async (name, args) => {
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${turns}`, name: `mcp__knode-os__${name}`, input: args }] } });
  const res = await client.callTool({ name, arguments: args });
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${turns}`, is_error: Boolean(res.isError) }] } });
  turns++;
  return res;
};
const text = (res) => res.content?.[0]?.text ?? '';

if (phase === 'collect') {
  // a study's collector: capture a page through knode, report findings that cite the captured path
  const studyId = /课题 id：`([^`]+)`/.exec(prompt)?.[1];
  const part = /# 收集资料：「(.+?)」/.exec(prompt)?.[1] ?? 'part';
  let captured = null;
  if (process.env.FAKE_CAPTURE_URL) {
    const res = await tool('knode_capture', { url: `${process.env.FAKE_CAPTURE_URL}?part=${encodeURIComponent(part)}`, study: studyId, why: `for ${part}` });
    try {
      captured = JSON.parse(text(res)).path;
    } catch {
      captured = null;
    }
  }
  await client.close();
  finish(`## 发现\n- ${part}：2025 年收入 45 亿美元 · 2026-03 ·（来源：${captured ?? 'raw/docs/trusted.md'}）\n\n## 数据\n- 收入 · USD bn · 2024=0.9, 2025=4.5 ·（来源：${captured ?? 'raw/docs/trusted.md'}）\n\n## 观点\n- 分析师看好 ·（来源：${captured ?? 'raw/docs/trusted.md'}）\n\n## 缺口\n- 无\n`, turns);
  process.exit(0);
}

// a study's page or its report: the sections its brief planned, citing what the study collected
const studyKind = /- 类型：(section|study)\b/.exec(prompt)?.[1] ?? null;
if (studyKind && phase !== 'revise') {
  const studyId = /study `(r_[0-9a-f]+)`/.exec(prompt)?.[1] ?? '';
  const collected = [...new Set([...prompt.matchAll(/`(raw\/docs\/research\/[^`]+)`/g)].map((m) => m[1]))].filter((p) => !p.endsWith('/'));
  const cites = collected.length ? collected.slice(0, 3) : ['raw/docs/trusted.md'];
  const chart = process.env.FAKE_STUDY_CHART === 'bad'
    ? '```chart\n{"type": "pie", "title": "", "x": ["2024"], "series": [{"name": "Revenue", "values": [1, 2]}]}\n```'
    : `\`\`\`chart\n${JSON.stringify({ type: 'bar', title: 'Revenue by year', unit: 'USD bn', x: ['2024', '2025'], series: [{ name: 'Revenue', values: [0.9, 4.5] }], source: cites[0] })}\n\`\`\``;
  const body = requiredSections.map((h, i) => (/sources|来源/i.test(h)
    ? `${h}\n\n${cites.map((c) => `- ${c}`).join('\n')}`
    : `${h}\n\n${target}: one finding for ${h.replace(/^#+\s*/, '')} (source: ${cites[0]}).${i === 0 ? `\n\n${chart}` : ''}`)).join('\n\n');
  const page = `---\ntype: ${studyKind === 'study' ? 'research-report' : 'research-page'}\ntitle: ${JSON.stringify(target)}\nstudy: ${studyId}\nsources: [${cites.map((c) => JSON.stringify(c)).join(', ')}]\n---\n# ${target}\n\n${body}\n`;
  const wrotePage = await tool('knode_write', { path: outputPath, content: page });
  await client.close();
  if (wrotePage.isError) {
    emit({ type: 'result', subtype: 'error', is_error: true, result: `knode_write failed: ${text(wrotePage)}`, num_turns: turns });
    process.exit(1);
  }
  finish(`wrote ${outputPath}`, turns);
  process.exit(0);
}

if (phase === 'chat') {
  const message = /## 本轮消息\n+([\s\S]*?)(?:\n## |$)/.exec(prompt)?.[1]?.trim() ?? prompt.slice(-200);
  const conversation = /chat\/(c_[0-9a-f]+)/.exec(prompt)?.[1] ?? /#\s*对话\s+(\S+)/.exec(prompt)?.[1] ?? 'unknown';
  const found = await tool('knode_search', { query: message.slice(0, 60), k: 3 });
  let hits = [];
  try {
    hits = JSON.parse(text(found)).map((r) => r.path);
  } catch {
    hits = [];
  }
  let reply = `关于「${message.slice(0, 40)}」：知识库里有 ${hits.length} 条相关段落${hits[0] ? `（来源：${hits[0]}）` : ''}。`;
  if (mode === 'teach') {
    const notePath = `raw/docs/notes/${new Date().toISOString().slice(0, 10)}-chat-${conversation}.md`;
    const content = `---\ntitle: 对话笔记\ndate: ${new Date().toISOString().slice(0, 10)}\nactor: agent/claude-cli\nsource: chat/${conversation}\nentities:\n  - { name: 宁德时代, type: organization }\nclaims:\n  - { subject: 宁德时代, type: revenue, statement: 2026 年营业收入 5000 亿元, eventDate: "2026" }\n---\n用户在对话中说：${message}\n`;
    await tool('knode_write', { path: notePath, content });
    await tool('knode_sync', { only: [notePath] });
    reply += `\n\n已记录到 ${notePath}（quarantined，需要采纳后才会覆盖已有事实）。\n<!-- knode:wrote ${notePath} -->`;
  }
  await client.close();
  finish(reply, turns);
  process.exit(0);
}

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

if (isInit) {
  // the overview page plus the guide at the data root
  const body = requiredSections.map((h) => `${h}\n\n${h === '## 来源' ? sources.map((s) => `- ${s}`).join('\n') : `${h.replace(/^#+\s*/, '')}：关于本知识库的一条判断${revised}（来源：${sources[0]}）。主题 [[宁德时代]]。`}`).join('\n\n');
  const overview = `---\ntype: overview\ntitle: 知识库总览\ndescription: 一个关于动力电池行业的知识库\nselfEntity: false\nsources: [${sources.map((s) => JSON.stringify(s)).join(', ')}]\n---\n# 知识库总览\n\n${body}\n`;
  const wroteOverview = await tool('knode_write', { path: outputPath, content: overview });
  if (wroteOverview.isError) {
    emit({ type: 'result', subtype: 'error', is_error: true, result: `knode_write failed: ${text(wroteOverview)}`, num_turns: turns });
    process.exit(1);
  }
  if (guidePath && mode !== 'no-guide') {
    const keep = guideSections.filter((h) => !(mode === 'bad-guide' && /如何查询/.test(h)));
    const guideBody = keep.map((h) => (/人工备注/.test(h) ? h : `${h}\n\n${h.replace(/^#+\s*/, '')}：这个知识库的具体做法${revised}——目录 raw/docs，核心实体 [[宁德时代]]，先 knode_resolve 再 knode_claims，谓词 supplies_to / subsidiary_of，写笔记到 raw/docs/notes/。`)).join('\n\n');
    const guide = `# 知识库指南\n\n${guideBody}\n`;
    const wroteGuide = await tool('knode_write', { path: guidePath, content: guide });
    if (wroteGuide.isError) {
      emit({ type: 'result', subtype: 'error', is_error: true, result: `knode_write ${guidePath} failed: ${text(wroteGuide)}`, num_turns: turns });
      process.exit(1);
    }
  }
  if (receipt) {
    await client.callTool({ name: 'knode_feedback', arguments: { receipt_id: receipt, used_ids: [], outcome: 'answered' } });
    turns++;
  }
  if (workset && phase !== 'revise') {
    await client.callTool({ name: 'knode_commit', arguments: { workset, content: `初始化了知识库，写了 ${outputPath} 和 ${guidePath ?? '(no guide)'}。`, title: 'init log' } });
    turns++;
  }
  await client.close();
  finish(`wrote ${outputPath} and ${guidePath ?? ''}`, turns);
  process.exit(0);
}

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
// an agent that claims a tier of its own (and someone else's name): the validator must not believe it
const selfTrust = mode === 'self-trusted' ? 'trust: trusted\nactor: user\n' : '';
const content = `---
${selfTrust}type: organization
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
