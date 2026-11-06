import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LlmConfig } from '../src/config.js';
import { LlmClient } from '../src/llm/client.js';
import { resetProtocolCache } from '../src/llm/protocol.js';

/**
 * A two-wire endpoint whose `/responses` route can be taken away, which is the
 * whole point of the negotiation: "OpenAI-compatible" says nothing about which
 * routes exist, so the client has to find out and then remember.
 */
interface Fake {
  url: string;
  close: () => Promise<void>;
  /** Every request, in order, as `<METHOD> <path>` plus its body. */
  hits: { path: string; body: Record<string, unknown> }[];
  responsesRoute: boolean;
  /** Answer a temperature the way a reasoning model does. */
  refuseTemperature: boolean;
  /** Answer json_object mode the way Anthropic's OpenAI-compatible endpoint does. */
  refuseResponseFormat: boolean;
}

const TEMPERATURE_REFUSED = { error: { message: "Unsupported parameter: 'temperature' is not supported with this model.", type: 'invalid_request_error', param: 'temperature' } };
const RESPONSE_FORMAT_REFUSED = { error: { code: 'invalid_request_error', message: "response_format.type: Input should be 'json_schema'", type: 'invalid_request_error', param: null } };

async function startFake(opts: { responses?: boolean } = {}): Promise<Fake> {
  const state: Fake = { url: '', close: async () => {}, hits: [], responsesRoute: opts.responses ?? true, refuseTemperature: false, refuseResponseFormat: false };
  const app = new Hono();

  app.post('/v1/responses', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    state.hits.push({ path: '/responses', body });
    // the route is gone: what a plain Chat-Completions endpoint answers
    if (!state.responsesRoute) return c.json({ error: { message: 'Not found' } }, 404);
    if (state.refuseTemperature && 'temperature' in body) return c.json(TEMPERATURE_REFUSED, 400);
    // the probe sends a model and no input; a real endpoint validates and complains
    if (!body.input) return c.json({ error: { message: 'missing input' } }, 400);
    return c.json({
      object: 'response',
      status: 'completed',
      output: [
        // the thinking must not be mistaken for the answer
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'thinking out loud' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'from responses' }] },
      ],
    });
  });

  app.post('/v1/chat/completions', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    state.hits.push({ path: '/chat/completions', body });
    if (state.refuseTemperature && 'temperature' in body) return c.json(TEMPERATURE_REFUSED, 400);
    if (state.refuseResponseFormat && 'response_format' in body) return c.json(RESPONSE_FORMAT_REFUSED, 400);
    return c.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'from chat' }, finish_reason: 'stop' }] });
  });

  let server: Server;
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info.port)) as Server;
  });
  state.url = `http://127.0.0.1:${port}/v1`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

function clientFor(fake: Fake, overrides: Partial<LlmConfig> = {}): LlmClient {
  return new LlmClient({
    provider: 'openai',
    baseUrl: fake.url,
    apiKey: 'test-key',
    model: 'fake-model',
    cliPath: '',
    cliTimeoutMs: 1000,
    ...overrides,
  });
}

const paths = (fake: Fake) => fake.hits.map((h) => h.path);

describe('llm protocol negotiation', () => {
  let fake: Fake;

  beforeEach(async () => {
    resetProtocolCache();
    fake = await startFake();
  });
  afterEach(async () => {
    await fake.close();
  });

  it('prefers the responses wire and reads past the reasoning item', async () => {
    const text = await clientFor(fake).complete([{ role: 'user', content: 'hi' }]);
    expect(text).toBe('from responses');
    expect(paths(fake)).toEqual(['/responses', '/responses']); // probe, then the call
  });

  it('falls back to chat completions when there is no responses route', async () => {
    fake.responsesRoute = false;
    const client = clientFor(fake);
    expect(await client.complete([{ role: 'user', content: 'hi' }])).toBe('from chat');
    expect(paths(fake)).toEqual(['/responses', '/chat/completions']);
  });

  it('probes an endpoint once, however many calls it serves', async () => {
    fake.responsesRoute = false;
    const client = clientFor(fake);
    await client.complete([{ role: 'user', content: 'one' }]);
    await client.complete([{ role: 'user', content: 'two' }]);
    expect(paths(fake)).toEqual(['/responses', '/chat/completions', '/chat/completions']);
  });

  it('shares one probe between calls made concurrently', async () => {
    const client = clientFor(fake);
    await Promise.all([1, 2, 3].map(() => client.complete([{ role: 'user', content: 'hi' }])));
    expect(paths(fake).filter((p) => p === '/responses')).toHaveLength(4); // one probe + three calls
  });

  it('pinning to chat skips the probe entirely', async () => {
    const text = await clientFor(fake, { protocol: 'chat' }).complete([{ role: 'user', content: 'hi' }]);
    expect(text).toBe('from chat');
    expect(paths(fake)).toEqual(['/chat/completions']);
  });

  it('pinning to responses reports a missing route instead of downgrading', async () => {
    fake.responsesRoute = false;
    await expect(clientFor(fake, { protocol: 'responses' }).complete([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/no \/responses route/);
    expect(paths(fake)).toEqual(['/responses']);
  });

  it('downgrades for good when a route that probed fine later disappears', async () => {
    const client = clientFor(fake);
    expect(await client.complete([{ role: 'user', content: 'one' }])).toBe('from responses');
    fake.responsesRoute = false;
    expect(await client.complete([{ role: 'user', content: 'two' }])).toBe('from chat');
    expect(await client.complete([{ role: 'user', content: 'three' }])).toBe('from chat');
    expect(paths(fake)).toEqual([
      '/responses', '/responses', // probe + first call
      '/responses', '/chat/completions', // the call that found it gone, then the fallback
      '/chat/completions', // remembered: no second wasted round-trip
    ]);
  });

  it('translates json mode and the token budget onto the responses wire', async () => {
    await clientFor(fake).complete([{ role: 'user', content: 'hi' }], { maxTokens: 300, json: true });
    const call = fake.hits.at(-1)!;
    expect(call.path).toBe('/responses');
    expect(call.body.text).toEqual({ format: { type: 'json_object' } });
    // max_output_tokens covers reasoning too, so the caller's budget is not the whole budget
    expect(call.body.max_output_tokens as number).toBeGreaterThan(300);
    expect(call.body.max_tokens).toBeUndefined();
  });

  it('keeps chat completions spelled the way it always was', async () => {
    fake.responsesRoute = false;
    await clientFor(fake).complete([{ role: 'user', content: 'hi' }], { maxTokens: 300, json: true });
    const call = fake.hits.at(-1)!;
    expect(call.path).toBe('/chat/completions');
    expect(call.body.max_tokens).toBe(300);
    expect(call.body.response_format).toEqual({ type: 'json_object' });
  });

  it('sends no temperature to a model that refuses one, and remembers that', async () => {
    fake.refuseTemperature = true;
    const client = clientFor(fake);
    expect(await client.complete([{ role: 'user', content: 'one' }])).toBe('from responses');
    expect(await client.complete([{ role: 'user', content: 'two' }])).toBe('from responses');
    expect(fake.hits.map((h) => [h.path, 'temperature' in h.body])).toEqual([
      ['/responses', false], // the probe
      ['/responses', true], // refused
      ['/responses', false], // sent again without it
      ['/responses', false], // remembered
    ]);
  });

  it('keeps the temperature where it is taken, and drops it on chat completions too when refused', async () => {
    await clientFor(fake, { protocol: 'chat' }).complete([{ role: 'user', content: 'hi' }]);
    expect(fake.hits.at(-1)!.body.temperature).toBe(0.2);
    fake.refuseTemperature = true;
    expect(await clientFor(fake, { protocol: 'chat', model: 'claude-sonnet-5-5' }).complete([{ role: 'user', content: 'hi' }])).toBe('from chat');
    expect(fake.hits.slice(-2).map((h) => 'temperature' in h.body)).toEqual([true, false]);
  });

  it('drops each refused parameter in turn: json mode on an endpoint that takes only a schema', async () => {
    fake.refuseTemperature = true;
    fake.refuseResponseFormat = true;
    const client = clientFor(fake, { protocol: 'chat', model: 'claude-sonnet-5-5' });
    expect(await client.complete([{ role: 'user', content: 'Reply in JSON.' }], { json: true })).toBe('from chat');
    await client.complete([{ role: 'user', content: 'Reply in JSON.' }], { json: true });
    expect(fake.hits.map((h) => ['temperature' in h.body, 'response_format' in h.body])).toEqual([
      [true, true],
      [false, true],
      [false, false],
      [false, false], // both remembered
    ]);
  });

  it("puts a call's reasoning effort on either wire, and none for the default", async () => {
    await clientFor(fake).complete([{ role: 'user', content: 'hi' }], { effort: 'low' });
    expect(fake.hits.at(-1)!.body.reasoning).toEqual({ effort: 'low' });
    const chat = clientFor(fake, { protocol: 'chat' });
    await chat.complete([{ role: 'user', content: 'hi' }], { effort: 'max' });
    expect(fake.hits.at(-1)!.body.reasoning_effort).toBe('xhigh');
    await chat.complete([{ role: 'user', content: 'hi' }], { effort: 'default' });
    expect(fake.hits.at(-1)!.body.reasoning_effort).toBeUndefined();
  });
});
