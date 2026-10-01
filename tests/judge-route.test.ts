import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, defaultRoutedLlmConfig, KnodeConfig, LlmConnection, loadConfig, resolveRoutedLlmConfig, routeTargets } from '../src/config.js';
import { AppContext, createContext, summaryLlmClient } from '../src/context.js';
import { ensureDefaultAgents } from '../src/research/agents.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { startFakeOpenAi, type FakeOpenAi } from './helpers/fake-openai.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-judge-route-'));

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const row = (patch: Partial<LlmConnection> & Pick<LlmConnection, 'id' | 'label'>): LlmConnection => ({
  provider: 'openai',
  baseUrl: '',
  apiKey: 'sk-test',
  // pinned, so a call goes straight to /chat/completions instead of probing /responses
  protocol: 'chat',
  model: '',
  cliPath: '',
  effort: 'default',
  cliTimeoutMs: 30_000,
  ...patch,
});

// Nothing listens on port 9, so a job still running on the default fails
// instead of passing by accident.
const fallback = row({ id: 'connection-1', label: 'default', baseUrl: 'http://127.0.0.1:9/v1', model: 'default-model' });
const other = row({ id: 'connection-2', label: 'other', baseUrl: 'https://other.example/v1', model: 'other-model' });

function workspace(name: string, config: Record<string, unknown>): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'knode.config.json'), JSON.stringify({ ...defaultConfig(), ...config }));
  ensureDefaultAgents(dir);
  return dir;
}

const onDisk = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'knode.config.json'), 'utf8')) as KnodeConfig & { extraction: Record<string, unknown> };

/**
 * knode_ask, Dream and the two reviews take `ctx.llm`. They ran on the
 * default LLM, then on the Summarize stage; since Summarize keeps only
 * document summaries they are the Judge stage, with a route of their own
 * (docs/design/09).
 */
describe('the Judge stage', () => {
  it('starts a config written before it as a copy of the Summarize route, and drops the concept route', () => {
    const { judgeLlm: _judge, ...extraction } = defaultConfig().extraction;
    const { id: _id, ...mirror } = fallback;
    const dir = workspace('from-summary', {
      llm: mirror,
      connections: [fallback, other],
      llmUse: 'connection-1',
      extraction: {
        ...extraction,
        summaryLlm: { ...defaultRoutedLlmConfig(), use: 'connection-2', effort: 'high' },
        conceptLlm: { ...defaultRoutedLlmConfig(), use: 'connection-2' },
        tier2Model: 'legacy-concept',
      },
    });

    const loaded = loadConfig(dir);
    // knode_ask, Dream and the reviews keep running exactly where they ran
    expect(loaded.extraction.judgeLlm).toMatchObject({ use: 'connection-2', effort: 'high' });
    expect(loaded.extraction.summaryLlm.use).toBe('connection-2');
    expect(loaded.extraction).not.toHaveProperty('conceptLlm');
    expect(loaded.extraction).not.toHaveProperty('tier2Model');

    const written = onDisk(dir);
    expect(written.extraction.judgeLlm).toMatchObject({ use: 'connection-2', effort: 'high' });
    expect(written.extraction).not.toHaveProperty('conceptLlm');
    expect(written.extraction).not.toHaveProperty('tier2Model');

    // once written down it is a route like any other: moving Summarize moves nothing else
    written.extraction.summaryLlm = { ...defaultRoutedLlmConfig(), use: 'connection-1' };
    fs.writeFileSync(path.join(dir, 'knode.config.json'), JSON.stringify(written));
    const again = loadConfig(dir);
    expect(again.extraction.summaryLlm.use).toBe('connection-1');
    expect(again.extraction.judgeLlm.use).toBe('connection-2');
  });

  it('pins a config from before either route existed to the default it ran on', () => {
    const { summaryLlm: _summary, judgeLlm: _judge, ...extraction } = defaultConfig().extraction;
    const { id: _id, ...mirror } = other;
    const dir = workspace('from-before', { llm: mirror, connections: [fallback, other], llmUse: 'connection-2', extraction });

    const loaded = loadConfig(dir);
    expect(loaded.extraction.summaryLlm.use).toBe('connection-2');
    expect(loaded.extraction.judgeLlm.use).toBe('connection-2');
    // exactly what ran before: the default's endpoint and model
    expect(resolveRoutedLlmConfig(loaded.llm, loaded.extraction.judgeLlm, routeTargets(loaded))).toMatchObject({
      provider: 'openai',
      baseUrl: 'https://other.example/v1',
      model: 'other-model',
    });
    expect(onDisk(dir).extraction.judgeLlm).toMatchObject({ use: 'connection-2' });
  });

  it('is what ctx.llm runs on — not the default, and not Summarize', async () => {
    const base = defaultConfig();
    const { id: _id, ...mirror } = fallback;
    const dir = workspace('own-route', {
      llm: mirror,
      connections: [fallback, other],
      llmUse: 'connection-1',
      extraction: {
        ...base.extraction,
        summaryLlm: { ...defaultRoutedLlmConfig(), use: 'connection-1' },
        judgeLlm: { ...defaultRoutedLlmConfig(), use: 'connection-2' },
      },
    });
    const ctx = await createContext(dir);
    try {
      expect(ctx.config.llm.model).toBe('default-model');
      expect(ctx.llm.label).toBe('other-model');
      expect(summaryLlmClient(ctx.config).label).toBe('default-model');
    } finally {
      await ctx.store.close();
    }
  });
});

describe('the Judge stage over the API', () => {
  const root = path.join(tmp, 'api');
  const headers = {
    'content-type': 'application/json',
    'x-knode-user': 'tester',
    'x-knode-workspace-kind': 'personal',
    'x-knode-workspace-id': 'default',
    'x-knode-workspace-name': 'Default',
  };
  let rootCtx: AppContext;
  let registry: WorkspaceContextRegistry;
  let app: ReturnType<typeof createApp>;
  let fake: FakeOpenAi;
  let judge: LlmConnection;

  const json = async <T>(response: Response | Promise<Response>) => (await (await response).json()) as T;
  const save = (body: unknown) => json<{ config: KnodeConfig }>(app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify(body) }));
  const config = () => json<KnodeConfig>(app.request('/api/config', { headers }));
  // /api/stats reports `ctx.llm.label`, which is the stage's client
  const running = async () => (await json<{ llmModel: string | null }>(app.request('/api/stats', { headers }))).llmModel;
  const askOnce = () => json<{ answer: string }>(app.request('/api/ask', { method: 'POST', headers, body: JSON.stringify({ question: 'What runs here?' }) }));
  const putAgent = (name: string, agent: unknown) =>
    app.request(`/api/agents/${name}`, { method: 'PUT', headers, body: JSON.stringify({ agent }) });

  beforeAll(async () => {
    fake = await startFakeOpenAi({ answer: () => 'Answered on the Judge stage.' });
    judge = row({ id: 'judge', label: 'Judge', baseUrl: fake.url, model: 'fake-model' });
    rootCtx = await createContext(root);
    registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
    app = createApp(rootCtx, () => {}, registry);
    await app.request('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', 'x-knode-user': 'tester' }, body: JSON.stringify({ name: 'Default' }) });
  });

  afterAll(async () => {
    await registry.closeAll();
    await rootCtx.store.close();
    await fake.close();
  });

  it('writes a route that names nothing down as the default, and stays there when the default moves', async () => {
    const pinned = await save({ connections: [fallback, judge], llmUse: 'judge', extraction: { judgeLlm: { use: '' } } });
    expect(pinned.config.extraction.judgeLlm.use).toBe('judge');

    const moved = await save({ llmUse: 'connection-1' });
    expect(moved.config.llmUse).toBe('connection-1');
    expect(moved.config.extraction.judgeLlm.use).toBe('judge');

    // so knode_ask answers from the judge, not from the unreachable default
    expect(await running()).toBe('fake-model');
    const before = fake.calls.length;
    expect((await askOnce()).answer).toBe('Answered on the Judge stage.');
    expect(fake.calls.length).toBe(before + 1);
  });

  it('is tested and lists its models like every other stage, and the concept route is gone', async () => {
    const tested = await json<Record<string, { ok: boolean; model?: string }>>(
      app.request('/api/config/test', { method: 'POST', headers, body: JSON.stringify({}) }),
    );
    expect(tested.judgeLlm).toMatchObject({ ok: true, model: 'fake-model' });
    expect(tested).toHaveProperty('summaryLlm');
    expect(tested).not.toHaveProperty('conceptLlm');

    const listed = await app.request('/api/config/models', { method: 'POST', headers, body: JSON.stringify({ route: 'judgeLlm', config: {} }) });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { models: { id: string }[] }).models.map((m) => m.id)).toContain('fake-model');
    const gone = await app.request('/api/config/models', { method: 'POST', headers, body: JSON.stringify({ route: 'conceptLlm', config: {} }) });
    expect(gone.status).toBe(400);
  });

  it('saves the two review modes its form sets, and nothing it does not know', async () => {
    const saved = await save({ review: { llmJudge: 'auto', claims: 'off' } });
    expect(saved.config.review).toMatchObject({ llmJudge: 'auto', claims: 'off', autoMergeMinConfidence: 0.95 });
    const ignored = await save({ review: { llmJudge: 'always', claims: 'auto', autoMergeMinConfidence: 0.1 } });
    expect(ignored.config.review).toMatchObject({ llmJudge: 'auto', claims: 'off', autoMergeMinConfidence: 0.95 });
    await save({ review: { llmJudge: 'suggest', claims: 'suggest' } });
  });

  it('follows an agent it names when that agent changes, and lands on the default when it goes', async () => {
    expect((await putAgent('scribe', { title: 'Scribe', executor: 'codex-cli', model: 'gpt-a' })).status).toBe(200);
    expect((await save({ extraction: { judgeLlm: { use: 'scribe' } } })).config.extraction.judgeLlm.use).toBe('scribe');
    expect(await running()).toBe('codex-cli:gpt-a');

    // no config save in between: the agent file is all that changed
    await putAgent('scribe', { title: 'Scribe', executor: 'codex-cli', model: 'gpt-b' });
    expect(await running()).toBe('codex-cli:gpt-b');

    await app.request('/api/agents/scribe', { method: 'DELETE', headers });
    const current = await config();
    expect(current.extraction.judgeLlm.use).toBe('connection-1');
    expect(await running()).toBe('default-model');
  });
});
