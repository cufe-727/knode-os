import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createEmbeddingProvider } from '../src/ingest/embeddings.js';
import { droppedConnection, fetchRetrying, NETWORK_RETRY } from '../src/llm/network.js';
import { OpenAiCompatibleBackend } from '../src/llm/providers/openai.js';
import { Meter } from '../src/eval/meter.js';
import { buildFixturePack } from '../src/eval/packs/fixture.js';
import { runEval, withEarlierAttempt } from '../src/eval/run.js';
import { buildFingerprint } from '../src/eval/systems/knode.js';
import { RunStore } from '../src/eval/runstore.js';
import { KEEP_ALIVE_MS, startShim, type ChatBackend, type ChatRequest } from '../src/eval/shim.js';
import { emptyUsage } from '../src/eval/types.js';
import { ScriptedBackend, scriptedJudge } from './helpers/eval-scripted.js';
import { runWorkspaceDir } from '../src/eval/root.js';

/*
 * A knode build that survives a failed request (docs/design/33): the 10× build stopped with
 * "fetch failed" (ECONNRESET on the evaluation's loopback endpoint) after five hours. Dropped
 * connections are tried again where the request is made, and a resumed run continues a build
 * an outage stopped from what it had already indexed, embedded and extracted.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-resume-'));
const saved = { ...NETWORK_RETRY };
beforeAll(() => Object.assign(NETWORK_RETRY, { attempts: 4, baseMs: 2, maxMs: 10 }));
afterAll(() => {
  Object.assign(NETWORK_RETRY, saved);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** An endpoint that drops the connections `drop` says to (by request number and body), and answers the rest. */
async function droppingEndpoint(drop: (n: number, body: string) => boolean, answer: (url: string, body: Record<string, unknown>) => unknown) {
  let n = 0;
  const seen = { requests: 0, dropped: 0 };
  const server = http.createServer((req, res) => {
    const i = ++n;
    seen.requests++;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (drop(i, raw)) {
        seen.dropped++;
        req.socket.destroy();
        return;
      }
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer(req.url ?? '', body)));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A deterministic 384-dimension vector of a text: an embedding endpoint with no model. */
function vectorOf(text: string): number[] {
  const h = crypto.createHash('sha256').update(text).digest();
  const v = Array.from({ length: 384 }, (_, i) => (h[i % 32] - 128) / 128 + (i % 7) / 50);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}
const embeddingsReply = (body: Record<string, unknown>) => {
  const input = Array.isArray(body.input) ? (body.input as string[]) : [String(body.input)];
  return { object: 'list', data: input.map((t, index) => ({ object: 'embedding', index, embedding: vectorOf(t) })), usage: { prompt_tokens: 1, total_tokens: 1 } };
};

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closing.splice(0)) await c();
});

describe('a dropped connection is tried again where the request is made', () => {
  it('reads what a dropped request fails with, and nothing else', async () => {
    const ep = await droppingEndpoint(() => true, () => ({}));
    closing.push(ep.close);
    const err = await fetch(`${ep.url}/x`, { method: 'POST', body: '{}' }).catch((e: unknown) => e);
    expect(droppedConnection(err)).toBe(true);
    expect(droppedConnection(new Error('chat request failed (400): bad'))).toBe(false);
    const aborted = await fetch(`${ep.url}/x`, { signal: AbortSignal.abort() }).catch((e: unknown) => e);
    expect(droppedConnection(aborted)).toBe(false);
    // refused: nothing listens there any more
    await ep.close();
    closing.pop();
    expect(droppedConnection(await fetch(`${ep.url}/x`).catch((e: unknown) => e))).toBe(true);
  });

  it('embeds and completes through an endpoint that drops connections, and gives up after the last try', async () => {
    const ep = await droppingEndpoint((n) => n % 3 !== 0, (url, body) => (url.endsWith('/embeddings')
      ? embeddingsReply(body)
      : { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    closing.push(ep.close);
    const retried: number[] = [];
    // two of every three connections dropped: each request gets through on its third try
    const embedder = createEmbeddingProvider({ provider: 'openai', baseUrl: `${ep.url}/v1`, apiKey: '', model: 'm', dimensions: 384, batchSize: 8, sendDimensions: false });
    expect((await embedder.embed(['甲', '乙']))[0]).toHaveLength(384);
    const chat = new OpenAiCompatibleBackend({ provider: 'openai', baseUrl: `${ep.url}/v1`, apiKey: '', model: 'm', protocol: 'chat', cliPath: '', cliTimeoutMs: 1000 } as never);
    expect(await chat.complete([{ role: 'user', content: 'hi' }])).toBe('ok');
    expect(ep.seen.dropped).toBe(4);
    const r = await fetchRetrying(`${ep.url}/v1/x`, { method: 'POST', body: '{}' }, (_e, attempt) => retried.push(attempt));
    expect(r.ok).toBe(true);
    expect(retried).toEqual([1, 2]);

    const down = await droppingEndpoint(() => true, () => ({}));
    closing.push(down.close);
    await expect(fetchRetrying(`${down.url}/v1/x`, { method: 'POST', body: '{}' }, () => {})).rejects.toThrow(/fetch failed/);
    expect(down.seen.requests).toBe(NETWORK_RETRY.attempts);
  });

  it('the shim keeps idle connections past the clients\' idle timeout, and answers a repeated request with the one call', async () => {
    let calls = 0;
    const slow: ChatBackend = {
      label: 'slow',
      async complete(_req: ChatRequest) {
        calls++;
        await new Promise((r) => setTimeout(r, 80));
        return { text: 'answer', usage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, reasoningTokens: 0 }, model: 'slow' };
      },
    };
    const shim = await startShim({ backend: slow, meter: new Meter(), keepAliveMs: 1_000 });
    closing.push(shim.close);
    const ask = () => fetch(`${shim.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'codex@extract', messages: [{ role: 'user', content: 'same' }] }) });
    // the client that lost its connection asks again while the first call is still out
    const [a, b] = await Promise.all([ask(), new Promise((r) => setTimeout(r, 20)).then(ask)]);
    expect(a.headers.get('keep-alive')).toBe(`timeout=${KEEP_ALIVE_MS / 1000}`);
    const texts = await Promise.all([a.json(), b.json()]) as { choices: { message: { content: string } }[] }[];
    expect(texts.map((t) => t.choices[0].message.content)).toEqual(['answer', 'answer']);
    expect(calls).toBe(1);
  });
});

describe('a resumed run continues a knode build an outage stopped', () => {
  it('survives dropped connections, and after an outage resumes from what it had indexed, embedded and extracted', async () => {
    const packDir = path.join(tmp, 'pack');
    buildFixturePack(packDir);
    // the embedding endpoint behind the run's shim drops every fourth connection throughout; in the first run it goes
    // down for good once the document passes embed their first entity (every connection, past every retry). knode
    // absorbs a failed embedding inside a document pass, so that build fails where it next needs the endpoint
    let outage = false;
    let down = false;
    const failing = (body: string) => (down ||= body.includes(' (person): '));
    const ep = await droppingEndpoint((n, body) => (outage && failing(body)) || n % 4 === 0, (_u, body) => embeddingsReply(body));
    closing.push(ep.close);
    const embedder = () => createEmbeddingProvider({ provider: 'openai', baseUrl: `${ep.url}/v1`, apiKey: '', model: 'fake-384', dimensions: 384, batchSize: 4, sendDimensions: false });
    const runDir = path.join(tmp, 'run');
    const progressOf = () => JSON.parse(fs.readFileSync(path.join(runWorkspaceDir(runDir, 'fixture-life'), '.knode', 'eval-build.json'), 'utf8')) as { attempts: number; done: string[] };
    const run = (backend: ScriptedBackend) => runEval({
      packs: [packDir], systems: ['knode-ask'], runDir, quota: false, suites: ['usage'], types: ['single-hop'], judgeAudit: 0,
      overrides: { chat: backend, judge: scriptedJudge(), embedder: embedder() },
    });

    outage = true;
    await run(new ScriptedBackend());
    const failed = new RunStore(runDir).allBuilds().find((b) => b.system === 'knode')!;
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/embedding request failed \(429\).*fetch failed/);
    const stopped = progressOf();
    expect(stopped.attempts).toBe(1);
    expect(stopped.done).toEqual(expect.arrayContaining(['synced', 'extracted']));

    // the endpoint is back (still dropping one connection in four): the run is resumed
    outage = false;
    await run(new ScriptedBackend());
    const store = new RunStore(runDir);
    const built = store.allBuilds().find((b) => b.system === 'knode')!;
    expect(built.ok).toBe(true);
    const notes = built.notes as Record<string, unknown> & { resumed: { attempt: number; phasesDone: string[]; before: Record<string, number>; earlier: { error: string; ms: number } } };
    expect(notes.resumed.attempt).toBe(2);
    expect(notes.resumed.phasesDone).toEqual(stopped.done);
    expect(notes.resumed.earlier.error).toBe(failed.error);
    // what the first attempt indexed, embedded and extracted stayed: nothing indexed again, no extraction call made again
    // (the final sync indexes the generated pages: the counts after it are higher)
    expect(notes.resumed.before.documents).toBeGreaterThan(0);
    expect(notes.resumed.before.chunks).toBeGreaterThan(0);
    expect(notes.resumed.before.entities).toBeGreaterThan(0);
    expect(notes.resumed.before.queued).toBe(0);
    // indexed again: only what the failed sync never reached (the generated pages), not the corpus the first attempt indexed
    expect(notes.indexed).toBeGreaterThan(0);
    expect(notes.indexed).toBeLessThan(notes.resumed.before.documents / 2);
    expect(notes.processed).toBe(0);
    expect(notes.calls).toBe(0);
    expect(progressOf()).toMatchObject({ attempts: 2, done: ['synced', 'extracted', 'wiki', 'refined'] });
    // the record counts both attempts
    expect(built.ms).toBeGreaterThan(failed.ms);
    expect(built.usage.calls).toBeGreaterThanOrEqual(failed.usage.calls);
    expect(built.stages.extract?.calls).toBe(failed.stages.extract?.calls);
    expect(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8')).toContain('"build resumed"');
    expect(store.allAnswers().filter((a) => a.system === 'knode-ask' && !a.error).length).toBeGreaterThan(0);
    expect(ep.seen.dropped).toBeGreaterThan(NETWORK_RETRY.attempts);

    // a run whose build is done reuses it
    await run(new ScriptedBackend());
    expect(new RunStore(runDir).allBuilds().find((b) => b.system === 'knode')!.at).toBe(built.at);
  }, 120_000);

  it('continues only the same build: another corpus or other models start over', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'fp-'));
    fs.writeFileSync(path.join(dir, 'a.md'), 'one');
    const env = { pack: { manifest: { id: 'p', version: '1' } }, staged: { dir, docs: [{ path: 'a.md' }] }, models: { model: 'm', buildEffort: 'low', answerEffort: 'medium' } } as never;
    const fp = buildFingerprint(env);
    expect(buildFingerprint(env)).toBe(fp);
    expect(buildFingerprint({ ...(env as object), models: { model: 'other', buildEffort: 'low', answerEffort: 'medium' } } as never)).not.toBe(fp);
    fs.writeFileSync(path.join(dir, 'a.md'), 'one, edited');
    expect(buildFingerprint(env)).not.toBe(fp);
  });

  it('counts an earlier failed attempt with the resumed one', () => {
    const usage = (n: number) => ({ ...emptyUsage(), calls: n, weightedTokens: 10 * n, embeddingTokens: n });
    const earlier = { key: 'k', pack: 'p', system: 'knode', ok: false, error: 'fetch failed', ms: 1000, usage: usage(3), stages: { extract: usage(3) }, bytes: 0, at: 'then' };
    const rec = { key: 'k', pack: 'p', system: 'knode', ok: true, ms: 500, usage: usage(2), stages: { extract: usage(1), wiki: usage(1) }, bytes: 9, notes: { resumed: { attempt: 2 } }, at: 'now' };
    const out = withEarlierAttempt(rec, earlier);
    expect(out).toMatchObject({ ok: true, ms: 1500, usage: { calls: 5, weightedTokens: 50 }, stages: { extract: { calls: 4 }, wiki: { calls: 1 } } });
    expect(out.notes!.resumed).toEqual({ attempt: 2, earlier: { at: 'then', error: 'fetch failed', ms: 1000, weightedTokens: 30, embeddingTokens: 3 } });
    // stopped with no record (a cancelled or killed run): said so, and nothing to add
    expect(withEarlierAttempt(rec, null)).toMatchObject({ ms: 500, notes: { resumed: { attempt: 2, earlier: null } } });
  });
});
