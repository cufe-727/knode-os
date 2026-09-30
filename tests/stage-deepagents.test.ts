import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LlmConfig } from '../src/config.js';
import { JSON_DIRECTIVE } from '../src/llm/cli.js';
import { LlmClient } from '../src/llm/client.js';
import { startFakeOpenAi, type FakeOpenAi } from './helpers/fake-openai.js';

/**
 * A pipeline stage on a deepagents agent, end to end: the real deepagents loop
 * against a fake OpenAI-compatible endpoint that plays only the model. What a
 * stage names resolves to `loop: 'deepagents'` in `routeTargets`; this is what
 * that makes `LlmClient` do.
 */
describe('a pipeline stage through the deepagents loop', () => {
  let llm: FakeOpenAi;

  beforeAll(async () => {
    llm = await startFakeOpenAi({ answer: () => JSON.stringify({ entities: [{ name: '宁德时代', type: 'company' }] }) });
  });

  afterAll(async () => {
    await llm.close();
  });

  const cfg = (loop?: 'deepagents'): LlmConfig => ({
    provider: 'openai',
    baseUrl: llm.url,
    apiKey: 'sk-test',
    // pinned, so the loop and the direct call skip the /responses probe the fake cannot answer
    protocol: 'chat',
    model: 'fake-model',
    cliPath: '',
    cliTimeoutMs: 30_000,
    ...(loop ? { loop } : {}),
  });

  it('runs the loop on the stage prompt and hands back its final answer', async () => {
    const client = new LlmClient(cfg('deepagents'));
    expect(client.label).toBe('deepagents:fake-model');
    const before = llm.calls.length;

    const out = await client.completeJson<{ entities: { name: string }[] }>([
      { role: 'system', content: '你负责从文档里抽取实体。' },
      { role: 'user', content: '宁德时代 2025 年营收 4000 亿元。' },
    ]);
    expect(out.entities[0].name).toBe('宁德时代');

    const request = llm.calls[before];
    const offered = (request.tools ?? []).map((t) => t.function?.name);
    // deepagents' own sub-agents and a read-only view of its scratch files…
    expect(offered).toContain('task');
    expect(offered).toContain('read_file');
    expect(offered).not.toContain('write_file');
    // …and nothing of the knowledge base
    expect(offered.some((name) => name?.startsWith('mcp__'))).toBe(false);
    // the stage's own instructions ride in the loop's system prompt, and JSON is asked for in words
    expect(JSON.stringify(request.messages?.find((m) => m.role === 'system')?.content)).toContain('你负责从文档里抽取实体。');
    expect(JSON.stringify(request.messages?.filter((m) => m.role === 'user').at(-1)?.content)).toContain(JSON_DIRECTIVE);
  });

  it('calls the model directly when the route names a model', async () => {
    const client = new LlmClient(cfg());
    expect(client.label).toBe('fake-model');
    const before = llm.calls.length;
    await client.completeJson([{ role: 'user', content: '宁德时代' }]);
    expect(llm.calls.length - before).toBe(1);
    expect(llm.calls[before].tools ?? []).toEqual([]);
  });
});
