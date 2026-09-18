import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { sync } from '../src/ingest/sync.js';
import { queueJob } from '../src/research/jobs.js';
import { claudeAgentsJson, codexAgentLayer, cursorModel, effortFor, sessionArgs } from '../src/research/launch.js';
import { outlineFrom } from '../src/research/pipeline.js';
import {
  activeProfile, claimSourceIssues, ensureDefaultProfiles, loadProfile, loadProfiles, normalizeProfile, normalizePromptPath, profileBrief,
  requiredSections, rolePrompt, saveProfile, webAllowed,
} from '../src/research/profile.js';
import { runResearchJob } from '../src/research/runner.js';
import { templateFor } from '../src/research/templates.js';
import { createApp } from '../src/server/app.js';
import { MCP_TOKEN_FILE } from '../src/server/mcp-http.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

/**
 * Research profiles: the harness-independent description of how a job runs
 * (effort, search, verification, sub-agent roles with their own prompts),
 * the per-CLI adapters that translate it into flags, the pipeline driven by
 * the roles, and the API the Settings page edits it through.
 */

const helpers = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers');
const fakeClaude = path.join(helpers, 'fake-claude.sh');
const mcpStub = { url: 'http://127.0.0.1:1/mcp', token: 'tok', headers: { 'x-knode-user': 'admin' } };
const baseSession = {
  agent: { kind: 'cli' as const, provider: 'claude-cli' as const, cliPath: '', model: '' }, maxTurns: 10, timeoutMs: 1000, cwd: '/tmp/run', prompt: 'hi', mcp: mcpStub,
  readDirs: ['/data/raw/docs'], jobId: 'j1', outputPath: 'wiki/entities/x.md', worksetId: 'ws1', tools: 'read' as const, label: 'research-1',
};

describe('research profiles · files and normalization', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-profile-'));
  afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it('seeds the built-in profiles once and resolves the active one', () => {
    const created = ensureDefaultProfiles(dataDir);
    expect(created.sort()).toEqual(['default', 'native', 'quick', 'thorough'].map((n) => `playbooks/research/profiles/${n}.yaml`).sort());
    expect(ensureDefaultProfiles(dataDir)).toEqual([]);
    const profiles = loadProfiles(dataDir);
    expect([...profiles.keys()]).toEqual(['default', 'native', 'quick', 'thorough']);
    expect(profiles.get('default')!.roles.map((r) => r.id)).toEqual(['planner', 'researcher', 'synthesizer', 'critic', 'reviser']);
    expect(profiles.get('thorough')!.verification.minSourcesPerClaim).toBe(2);
    expect(profiles.get('thorough')!.roles.find((r) => r.id === 'researcher')!.parallel).toBe(5);
    const config = defaultConfig();
    expect(activeProfile(dataDir, config).name).toBe('default');
    config.research.profile = 'thorough';
    expect(activeProfile(dataDir, config).reasoning.effort).toBe('max');
    config.research.profile = 'missing';
    expect(activeProfile(dataDir, config).name).toBe('default');
  });

  it('normalizes roles: bad phases dropped, ids slugified, prompt paths kept inside playbooks/research', () => {
    const p = normalizeProfile({
      reasoning: { effort: 'xhigh' },
      search: { enabled: true, freshness: 'cached', max_rounds: 40 },
      verification: { min_sources_per_claim: 3, resolve_conflicts: 'prefer_recent' },
      roles: [
        { id: 'Web Scout', phase: 'research', prompt: '../../etc/passwd', tools: { web: 'on' }, parallel: 99 },
        { id: 'writer', phase: 'synthesize', prompt: 'roles/writer.md' },
        { id: 'nope', phase: 'bogus' },
        { id: 'writer', phase: 'revise' },
      ],
    }, 'custom', 'playbooks/research/profiles/custom.yaml');
    expect(p.reasoning.effort).toBe('xhigh');
    expect(p.search).toEqual({ web: 'on', freshness: 'cached', maxRounds: 20 });
    expect(p.verification.minSourcesPerClaim).toBe(3);
    expect(p.verification.resolveConflicts).toBe('prefer_recent');
    expect(p.roles.map((r) => r.id)).toEqual(['web-scout', 'writer', 'writer-2']);
    expect(p.roles[0].prompt).toBe('');
    expect(p.roles[0].parallel).toBe(16);
    expect(p.roles[0].tools.web).toBe('on');
    expect(p.roles[1].prompt).toBe('roles/writer.md');
    expect(p.roles[1].tools.write).toBe(true); // synthesize roles write by default
    expect(normalizePromptPath('/abs/x.md')).toBe('');
    expect(normalizePromptPath('phases/../../x.md')).toBe('');
    expect(normalizePromptPath('roles\\critic.md')).toBe('roles/critic.md');
  });

  it('round-trips a saved profile through YAML and fills role prompts with a phase marker', () => {
    const saved = saveProfile(dataDir, { name: 'lean', title: 'Lean', roles: [{ id: 'writer', phase: 'synthesize' } as never, { id: 'checker', phase: 'review', prompt: 'roles/checker.md' } as never] });
    expect(fs.existsSync(path.join(dataDir, 'playbooks/research/profiles/lean.yaml'))).toBe(true);
    const back = loadProfile(dataDir, 'lean')!;
    expect(back.title).toBe('Lean');
    expect(back.roles.map((r) => r.id)).toEqual(['writer', 'checker']);
    fs.mkdirSync(path.join(dataDir, 'playbooks/research/roles'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'playbooks/research/roles/checker.md'), '# 我的评审\n检查 {output}，workset {workset}\n');
    const prompt = rolePrompt(dataDir, back.roles[1], { output: 'wiki/entities/x.md', workset: 'ws-1' });
    expect(prompt.startsWith('<!-- knode-phase: review -->\n')).toBe(true);
    expect(prompt).toContain('检查 wiki/entities/x.md，workset ws-1');
    // a role without a file runs the built-in phase prompt, marker included
    expect(rolePrompt(dataDir, back.roles[0], { output: 'o', workset: 'w' })).toMatch(/^<!-- knode-phase: synthesize -->/);
    expect(saved.path).toBe('playbooks/research/profiles/lean.yaml');
  });

  it('gates web access by review.external first, then profile and role', () => {
    const profile = normalizeProfile({}, 'default', '');
    const role = { ...profile.roles[1] };
    expect(webAllowed({ gate: 'off', kind: 'verify', profile, role: { ...role, tools: { ...role.tools, web: 'on' } } })).toBe(false);
    expect(webAllowed({ gate: 'verify', kind: 'entity', profile })).toBe(false);
    expect(webAllowed({ gate: 'verify', kind: 'verify', profile })).toBe(true);
    expect(webAllowed({ gate: 'verify', kind: 'entity', profile: { ...profile, search: { ...profile.search, web: 'on' } } })).toBe(true);
    expect(webAllowed({ gate: 'verify', kind: 'entity', profile, role: { ...role, tools: { ...role.tools, web: 'on' } } })).toBe(true);
    expect(webAllowed({ gate: 'research', kind: 'entity', profile })).toBe(true);
    expect(webAllowed({ gate: 'research', kind: 'entity', profile, role: { ...role, tools: { ...role.tools, web: 'off' } } })).toBe(false);
    expect(webAllowed({ gate: 'research', kind: 'entity', profile: { ...profile, search: { ...profile.search, web: 'off' } } })).toBe(false);
  });

  it('checks the per-claim source bar and adds the evidence table section', () => {
    const claims = [
      { statement: 'A', status: 'fact', sources: ['raw/docs/a.md', 'raw/docs/b.md'] },
      { statement: 'B', status: 'fact', source: 'raw/docs/a.md' },
      { statement: 'C', status: 'suspected' },
    ];
    expect(claimSourceIssues(claims, 1)).toEqual({ errors: [], warnings: [] });
    const r = claimSourceIssues(claims, 2);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('claim "B"');
    expect(r.warnings).toHaveLength(1);
    const template = templateFor(dataDir, 'entity');
    const thorough = loadProfile(dataDir, 'thorough')!;
    expect(requiredSections(template, thorough)).toContain('## 证据表');
    expect(requiredSections(template, loadProfile(dataDir, 'default'))).not.toContain('## 证据表');
    const brief = profileBrief(thorough, { allowNetwork: true }).join('\n');
    expect(brief).toContain('至少 2 个来源');
    expect(brief).toContain('live');
    expect(brief).toContain('证据表');
  });

  it('builds an outline from required sections when there is no planner', () => {
    const sections = outlineFrom('', ['## 概要', '## 关键事实', '## 来源', '## 证据表'], '宁德时代', 8);
    expect(sections.map((s) => s.title)).toEqual(['## 概要', '## 关键事实']);
    expect(outlineFrom('', ['## 概要', '## 关键事实'], 'x', 1)).toHaveLength(1);
  });
});

describe('research profiles · CLI adapters', () => {
  it('maps effort per CLI', () => {
    expect(effortFor('claude-cli', 'max')).toBe('max');
    expect(effortFor('codex-cli', 'max')).toBe('xhigh');
    expect(effortFor('cursor-cli', 'xhigh')).toBe('high');
    expect(effortFor('claude-cli', 'default')).toBeNull();
    expect(cursorModel('gpt-5', 'high')).toBe('gpt-5[effort=high]');
    expect(cursorModel('claude-opus-4-8[context=1m,fast=false]', 'max')).toBe('claude-opus-4-8[context=1m,fast=false,effort=high]');
    expect(cursorModel('claude-opus-4-8[effort=low]', 'medium')).toBe('claude-opus-4-8[effort=medium]');
    expect(cursorModel('', 'high')).toBe('');
  });

  it('claude: effort flag, web tools, file tools and native sub-agents', () => {
    const agents = [{ id: 'researcher', title: '研究员', description: '取证', prompt: 'P', write: false, files: true, web: true, model: 'sonnet', effort: 'high' as const }];
    const { args } = sessionArgs({ ...baseSession, effort: 'max', allowNetwork: true, agents });
    expect(args).toContain('--effort');
    expect(args[args.indexOf('--effort') + 1]).toBe('max');
    expect(args).toContain('WebSearch');
    expect(args).toContain('Agent');
    const json = JSON.parse(args[args.indexOf('--agents') + 1]);
    expect(json.researcher.tools).toEqual(expect.arrayContaining(['mcp__knode-os__knode_search', 'Read', 'WebSearch']));
    expect(json.researcher.model).toBe('sonnet');
    expect(json.researcher.tools).not.toContain('mcp__knode-os__*');
    expect(claudeAgentsJson(agents)).toContain('"description":"取证"');
    const noFiles = sessionArgs({ ...baseSession, files: false }).args;
    const disallowedAt = noFiles.indexOf('--disallowedTools');
    expect(noFiles.slice(disallowedAt)).toContain('Read');
    expect(noFiles.slice(noFiles.indexOf('--allowedTools'), disallowedAt)).not.toContain('Read');
    expect(noFiles).not.toContain('--effort');
    expect(noFiles).not.toContain('--agents');
  });

  it('codex: live/cached/disabled web_search, reasoning effort and agent layers', () => {
    const live = sessionArgs({ ...baseSession, agent: { ...baseSession.agent, provider: 'codex-cli' as const }, effort: 'max', allowNetwork: true, webFreshness: 'live' }).args;
    expect(live).toContain('web_search="live"');
    expect(live).toContain('model_reasoning_effort="xhigh"');
    expect(live).not.toContain('tools.web_search=true');
    const cached = sessionArgs({ ...baseSession, agent: { ...baseSession.agent, provider: 'codex-cli' as const }, allowNetwork: true, webFreshness: 'cached' }).args;
    expect(cached).toContain('web_search="cached"');
    const off = sessionArgs({ ...baseSession, agent: { ...baseSession.agent, provider: 'codex-cli' as const } }).args;
    expect(off).toContain('web_search="disabled"');
    expect(off.some((a) => a.startsWith('model_reasoning_effort'))).toBe(false);
    const agents = [{ id: 'critic', title: '评审', description: '评审页面', prompt: "检查 '''页面'''", write: false, files: true, web: false, model: '', effort: 'high' as const }];
    const native = sessionArgs({ ...baseSession, agent: { ...baseSession.agent, provider: 'codex-cli' as const }, agents, effort: 'high' }).args;
    expect(native).toContain('agents.enabled=true');
    expect(native).toContain('agents.critic.description="评审页面"');
    expect(native.some((a) => a.startsWith('agents.critic.config_file=') && a.includes('agents/critic.toml'))).toBe(true);
    expect(native).toContain('agents.default_subagent_reasoning_effort="high"');
    const layer = codexAgentLayer(agents[0], 'live');
    expect(layer).toContain('model_reasoning_effort = "high"');
    expect(layer).toContain('web_search = "disabled"');
    expect(layer).toContain("developer_instructions = '''");
    expect(layer).not.toContain("'''页面'''");
  });

  it('cursor: effort rides in the model name; no effort without a model', () => {
    const withModel = sessionArgs({ ...baseSession, agent: { ...baseSession.agent, provider: 'cursor-cli' as const, model: 'gpt-5' }, effort: 'high' }).args;
    expect(withModel[withModel.indexOf('--model') + 1]).toBe('gpt-5[effort=high]');
    const noModel = sessionArgs({ ...baseSession, agent: { ...baseSession.agent, provider: 'cursor-cli' as const }, effort: 'high' }).args;
    expect(noModel).not.toContain('--model');
  });
});

describe('research profiles · pipeline and API', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-profile-run-'));
  const root = path.join(tmp, 'data');
  const wsDir = path.join(root, 'users', 'admin', 'workspaces', 'default');
  const scope = { user: 'admin', kind: 'personal' as const, id: 'default', name: 'Default', slug: 'default', relativeDir: 'users/admin/workspaces/default' };
  const headers = { 'x-knode-user': 'admin', 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': 'default', 'x-knode-workspace-name': 'Default' };
  const json = { ...headers, 'content-type': 'application/json' };
  let rootCtx: AppContext;
  let registry: WorkspaceContextRegistry;
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  let httpServer: Server;
  let mcp: { url: string; token: string; headers: Record<string, string> };
  const agent = { kind: 'cli' as const, provider: 'claude-cli' as const, cliPath: fakeClaude, model: '' };

  beforeAll(async () => {
    rootCtx = await createContext(root);
    registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
    app = createApp(rootCtx, () => {}, registry);
    await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
    ctx = await registry.get(scope);
    ctx.config.research.pipeline = 'team';
    ctx.config.research.researchers = 2;
    ctx.config.research.reviewRounds = 1;
    const token = fs.readFileSync(path.join(root, MCP_TOKEN_FILE), 'utf8').trim();
    await new Promise<void>((resolve) => {
      httpServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        mcp = { url: `http://127.0.0.1:${info.port}/mcp`, token, headers };
        resolve();
      }) as Server;
    });
    const abs = path.join(wsDir, 'raw', 'docs', 'trusted.md');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `---
title: 宁德时代 2025 年报摘要
date: 2026-03-30
entities:
  - { name: 宁德时代, type: organization, aliases: ["CATL", "300750"] }
claims:
  - { subject: 宁德时代, type: revenue, statement: 2025 年营业收入 4000 亿元, eventDate: "2025" }
---
宁德时代 2025 年营业收入 4000 亿元。
`);
    await sync(ctx, { llmGraph: false });
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await registry.closeAll();
    await rootCtx.store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('runs the team pipeline from the profile roles: no planner, two researcher sessions, one critic, no reviser', async () => {
    const profile = normalizeProfile({
      pipeline: 'team',
      reasoning: { effort: 'high' },
      roles: [
        { id: 'scout', phase: 'research', parallel: 2, effort: 'low' },
        { id: 'writer', phase: 'synthesize' },
        { id: 'checker', phase: 'review' },
      ],
    }, 'lean', '');
    const { job } = await queueJob(ctx.store, { kind: 'entity', target: '宁德时代', requestedBy: 'test' });
    process.env.FAKE_AGENT_MODE = 'good';
    delete process.env.FAKE_AGENT_REVIEW;
    const done = await runResearchJob(ctx, job, { mcp, agent, profile, log: () => {} });
    expect(done.status).toBe('done');
    expect(done.payload.profile).toBe('lean');
    expect(done.payload.pipeline).toBe('team');
    const runDir = path.join(wsDir, '.runs', job.id);
    const plan = JSON.parse(fs.readFileSync(path.join(runDir, 'plan.json'), 'utf8'));
    expect(plan.planner).toBeNull();
    expect(plan.sections.map((s: { title: string }) => s.title)).toEqual(expect.arrayContaining(['## 概要', '## 关键事实', '## 时间线']));
    const phases = done.payload.phases as { name: string; label: string; role: string }[];
    expect(phases.some((p) => p.name === 'plan')).toBe(false);
    expect(phases.filter((p) => p.name === 'research').length).toBe(plan.sections.length);
    expect(phases.filter((p) => p.name === 'research').every((p) => p.role === 'scout')).toBe(true);
    expect(phases.map((p) => p.label)).toEqual(expect.arrayContaining(['synthesize', 'review-1']));
    expect(phases.some((p) => p.name === 'revise')).toBe(false);
    // adapter flags reached the CLI: the researcher's own effort, the writer inherits the profile's
    const scoutArgv = JSON.parse(fs.readFileSync(path.join(runDir, 'argv-research.json'), 'utf8')) as string[];
    expect(scoutArgv[scoutArgv.indexOf('--effort') + 1]).toBe('low');
    const writerArgv = JSON.parse(fs.readFileSync(path.join(runDir, 'argv-synthesize.json'), 'utf8')) as string[];
    expect(writerArgv[writerArgv.indexOf('--effort') + 1]).toBe('high');
    expect(writerArgv).toContain('mcp__knode-os__*');
    expect(fs.readFileSync(path.join(runDir, 'brief.md'), 'utf8')).toContain('研究规范（profile: lean）');
  }, 180_000);

  it('runs the native pipeline as one orchestrator session with the native roles as --agents', async () => {
    const profile = loadProfile(wsDir, 'native')!;
    const { job } = await queueJob(ctx.store, { kind: 'entity', target: '比亚迪', requestedBy: 'test' });
    const done = await runResearchJob(ctx, job, { mcp, agent, profile, log: () => {} });
    expect(done.status).toBe('done');
    expect(done.payload.pipeline).toBe('native');
    const phases = done.payload.phases as { name: string; label: string }[];
    expect(phases).toHaveLength(1);
    expect(phases[0].name).toBe('orchestrate');
    const runDir = path.join(wsDir, '.runs', job.id);
    const argv = JSON.parse(fs.readFileSync(path.join(runDir, 'argv-orchestrate.json'), 'utf8')) as string[];
    const agents = JSON.parse(argv[argv.indexOf('--agents') + 1]);
    expect(Object.keys(agents).sort()).toEqual(['critic', 'researcher']);
    expect(agents.researcher.prompt).toContain('knode-phase: research');
    expect(argv[argv.indexOf('--effort') + 1]).toBe('high');
    expect(argv).toContain('Agent');
    expect(fs.existsSync(path.join(wsDir, 'wiki', 'entities', '比亚迪.md'))).toBe(true);
  }, 120_000);

  it('serves profiles over the API: list, create with prompts, config patch, delete rules', async () => {
    const list = await (await app.request('/api/research/profiles', { headers })).json();
    expect(list.active).toBe('default');
    expect(list.profiles.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(['default', 'quick', 'thorough', 'native']));

    const put = await app.request('/api/research/profiles/custom', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({
        profile: { title: 'Custom', reasoning: { effort: 'xhigh' }, roles: [{ id: 'writer', phase: 'synthesize', tools: { write: true } }, { id: 'checker', phase: 'review', agent: 'codex-cli' }] },
        prompts: { checker: '# 我的评审提示\n检查 {output}' },
      }),
    });
    expect(put.status).toBe(200);
    const detail = await put.json();
    expect(detail.name).toBe('custom');
    expect(detail.builtin).toBe(false);
    expect(detail.roles[0].promptIsDefault).toBe(true);
    expect(detail.roles[1].promptPath).toBe('playbooks/research/roles/checker.md');
    expect(detail.roles[1].promptText).toContain('我的评审提示');
    expect(detail.roles[1].agent).toBe('codex-cli');
    expect(detail.phaseDefaults.review).toContain('knode-phase: review');
    expect(fs.existsSync(path.join(wsDir, 'playbooks/research/roles/checker.md'))).toBe(true);

    const bad = await app.request('/api/research/profiles/bad%20name', { method: 'PUT', headers: json, body: '{}' });
    expect(bad.status).toBe(400);

    const cfgPut = await app.request('/api/config', { method: 'PUT', headers: json, body: JSON.stringify({ research: { profile: 'custom', pipeline: 'native', maxTurns: 25, auto: { enabled: true, dailyJobs: 2 } } }) });
    expect(cfgPut.status).toBe(200);
    const cfg = await (await app.request('/api/config', { headers })).json();
    expect(cfg.research.profile).toBe('custom');
    expect(cfg.research.pipeline).toBe('native');
    expect(cfg.research.maxTurns).toBe(25);
    expect(cfg.research.auto).toEqual({ enabled: true, dailyJobs: 2 });
    expect((await (await app.request('/api/research/profiles', { headers })).json()).active).toBe('custom');

    expect((await app.request('/api/research/profiles/custom', { method: 'DELETE', headers })).status).toBe(400);
    await app.request('/api/config', { method: 'PUT', headers: json, body: JSON.stringify({ research: { profile: 'default', pipeline: 'team' } }) });
    expect((await app.request('/api/research/profiles/custom', { method: 'DELETE', headers })).status).toBe(200);
    expect((await app.request('/api/research/profiles/custom', { headers })).status).toBe(404);
    // deleting a built-in resets it
    const reset = await (await app.request('/api/research/profiles/quick', { method: 'DELETE', headers })).json();
    expect(reset.reset).toBe(true);
    expect((await app.request('/api/research/profiles/quick', { headers })).status).toBe(200);
  });
});
