import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, defaultRoutedLlmConfig, KnodeConfig, LlmConnection, loadConfig, resolveRoutedLlmConfig, routeTargets } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { ensureDefaultAgents } from '../src/research/agents.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { startFakeOpenAi, type FakeOpenAi } from './helpers/fake-openai.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-summary-route-'));

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

/**
 * Document summaries, Dream, the nightly reviews and knode_ask ran on the
 * default LLM, as the jobs that never picked a model of their own. They are
 * the Summarize stage now, with a route like every other stage.
 */
describe('the Summarize stage', () => {
  it('pins a config written before it had a route to the default it ran on, and writes that down', () => {
    const { summaryLlm: _summary, ...extraction } = defaultConfig().extraction;
    const { id: _id, ...mirror } = other;
    const dir = workspace('from-before', { llm: mirror, connections: [fallback, other], llmUse: 'connection-2', extraction });

    const loaded = loadConfig(dir);
    expect(loaded.extraction.summaryLlm.use).toBe('connection-2');
    // exactly what ran before: the default's endpoint and model
    expect(resolveRoutedLlmConfig(loaded.llm, loaded.extraction.summaryLlm, routeTargets(loaded))).toMatchObject({
      provider: 'openai',
      baseUrl: 'https://other.example/v1',
      model: 'other-model',
    });
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'knode.config.json'), 'utf8')) as KnodeConfig;
    expect(written.extraction.summaryLlm.use).toBe('connection-2');
  });

  it('is what ctx.llm runs on, not the default', async () => {
    const base = defaultConfig();
    const { id: _id, ...mirror } = fallback;
    const dir = workspace('own-route', {
      llm: mirror,
      connections: [fallback, other],
      llmUse: 'connection-1',
      extraction: { ...base.extraction, summaryLlm: { ...defaultRoutedLlmConfig(), use: 'connection-2' } },
    });
    const ctx = await createContext(dir);
    try {
      expect(ctx.config.llm.model).toBe('default-model');
      expect(ctx.llm.label).toBe('other-model');
    } finally {
      await ctx.store.close();
    }
  });
});

describe('the Summarize stage over the API', () => {
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
  let summarizer: LlmConnection;

  const json = async <T>(response: Response | Promise<Response>) => (await (await response).json()) as T;
  const save = (body: unknown) => json<{ config: KnodeConfig }>(app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify(body) }));
  const config = () => json<KnodeConfig>(app.request('/api/config', { headers }));
  // /api/stats reports `ctx.llm.label`, which is the stage's client
  const running = async () => (await json<{ llmModel: string | null }>(app.request('/api/stats', { headers }))).llmModel;
  const askOnce = () => json<{ answer: string }>(app.request('/api/ask', { method: 'POST', headers, body: JSON.stringify({ question: 'What runs here?' }) }));
  const putAgent = (name: string, agent: unknown) =>
    app.request(`/api/agents/${name}`, { method: 'PUT', headers, body: JSON.stringify({ agent }) });

  beforeAll(async () => {
    fake = await startFakeOpenAi({ answer: () => 'Answered on the Summarize stage.' });
    summarizer = row({ id: 'summarizer', label: 'Summarizer', baseUrl: fake.url, model: 'fake-model' });
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
    const pinned = await save({ connections: [fallback, summarizer], llmUse: 'summarizer', extraction: { summaryLlm: { use: '' } } });
    expect(pinned.config.extraction.summaryLlm.use).toBe('summarizer');

    const moved = await save({ llmUse: 'connection-1' });
    expect(moved.config.llmUse).toBe('connection-1');
    expect(moved.config.extraction.summaryLlm.use).toBe('summarizer');

    // so knode_ask answers from the summarizer, not from the unreachable default
    expect(await running()).toBe('fake-model');
    const before = fake.calls.length;
    expect((await askOnce()).answer).toBe('Answered on the Summarize stage.');
    expect(fake.calls.length).toBe(before + 1);
  });

  it('is tested and lists its models like every other stage', async () => {
    const tested = await json<Record<string, { ok: boolean; model?: string }>>(
      app.request('/api/config/test', { method: 'POST', headers, body: JSON.stringify({}) }),
    );
    expect(tested.summaryLlm).toMatchObject({ ok: true, model: 'fake-model' });

    const listed = await app.request('/api/config/models', { method: 'POST', headers, body: JSON.stringify({ route: 'summaryLlm', config: {} }) });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { models: { id: string }[] }).models.map((m) => m.id)).toContain('fake-model');
  });

  it('follows an agent it names when that agent changes, and lands on the default when it goes', async () => {
    expect((await putAgent('scribe', { title: 'Scribe', executor: 'codex-cli', model: 'gpt-a' })).status).toBe(200);
    expect((await save({ extraction: { summaryLlm: { use: 'scribe' } } })).config.extraction.summaryLlm.use).toBe('scribe');
    expect(await running()).toBe('codex-cli:gpt-a');

    // no config save in between: the agent file is all that changed
    await putAgent('scribe', { title: 'Scribe', executor: 'codex-cli', model: 'gpt-b' });
    expect(await running()).toBe('codex-cli:gpt-b');

    await app.request('/api/agents/scribe', { method: 'DELETE', headers });
    const current = await config();
    expect(current.extraction.summaryLlm.use).toBe('connection-1');
    expect(await running()).toBe('default-model');
  });
});
