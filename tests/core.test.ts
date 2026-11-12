import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { defaultConfig, loadConfig, resolveRoutedLlmConfig, resolveSecret, saveConfig } from '../src/config.js';
import { initDataDir } from '../src/fs/datadir.js';
import { safePath, walkFiles } from '../src/fs/files.js';
import { chunkText } from '../src/ingest/chunker.js';
import { estimateTokens } from '../src/llm/tokens.js';
import { createEmbeddingProvider, LocalHashEmbeddingProvider } from '../src/ingest/embeddings.js';
import { slugify } from '../src/graph/store.js';
import { extractWikilinks } from '../src/graph/wire.js';
import { codexExecArgs, completeViaCli, renderCliPrompt } from '../src/llm/cli.js';
import { LlmClient } from '../src/llm/client.js';
import { keywordTerms, queryTerms, termCount, websearchText } from '../src/search/search.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('config', () => {
  it('merges saved config over defaults', () => {
    const dir = path.join(tmp, 'cfg');
    fs.mkdirSync(dir, { recursive: true });
    const cfg = defaultConfig();
    cfg.server.port = 1234;
    saveConfig(dir, cfg);
    const loaded = loadConfig(dir);
    expect(loaded.server.port).toBe(1234);
    expect(loaded.embedding.dimensions).toBe(384);
    expect(loaded.retrieval.sag.maxHops).toBe(2);
  });

  it('resolves env: secrets', () => {
    process.env.KNODE_TEST_KEY = 'abc';
    expect(resolveSecret('env:KNODE_TEST_KEY')).toBe('abc');
    expect(resolveSecret('plain')).toBe('plain');
  });

  it('routes extraction jobs to an independent CLI provider', () => {
    const cfg = defaultConfig();
    const routed = resolveRoutedLlmConfig(cfg.llm, {
      ...cfg.extraction.entityLlm,
      provider: 'cursor-cli',
      model: 'composer-1.5',
    });
    expect(routed.provider).toBe('cursor-cli');
    expect(routed.model).toBe('composer-1.5');
    expect(routed.baseUrl).toBe(cfg.llm.baseUrl);
  });
});

describe('datadir', () => {
  it('creates the raw/wiki layout idempotently', () => {
    const dir = path.join(tmp, 'data');
    const first = initDataDir(dir);
    expect(first.created).toContain('raw/docs/');
    expect(first.created).toContain('wiki/index.md');
    expect(first.created).toContain('playbooks/packs/default.md');
    expect(first.created).toContain('playbooks/intents/entity-overview.yaml');
    expect(first.created).toContain('playbooks/capabilities/');
    const second = initDataDir(dir);
    expect(second.created).toHaveLength(0);
  });
});

describe('safePath', () => {
  it('rejects traversal', () => {
    expect(() => safePath(tmp, '../etc/passwd')).toThrow(/escapes/);
    expect(() => safePath(tmp, 'a/../../b')).toThrow(/escapes/);
    expect(safePath(tmp, 'wiki/index.md')).toBe(path.join(tmp, 'wiki/index.md'));
  });
});

describe('chunker', () => {
  it('splits markdown into chunks under the size limit', async () => {
    const text = Array.from({ length: 40 }, (_, i) => `## Section ${i}\n\n${'word '.repeat(60)}`).join('\n\n');
    const chunks = await chunkText('doc.md', text, { chunkSize: 500, chunkOverlap: 50 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(600);
  });

  it('estimates CJK tokens more densely than ASCII', () => {
    expect(estimateTokens('中文中文中文')).toBeGreaterThan(estimateTokens('aaaaaa'));
  });
});

describe('queryTerms', () => {
  it('splits CJK questions into salient bigrams, dropping question words', () => {
    const terms = queryTerms('印度扩建战略石油储备的影响是什么？');
    expect(terms.length).toBeGreaterThan(2);
    expect(terms).toContain('印度');
    expect(terms.some((t) => t.includes('石油') || t.includes('储备'))).toBe(true);
    expect(terms).not.toContain('什么');
  });

  it('keeps latin tokens and short CJK runs whole', () => {
    const terms = queryTerms('LME 铜价 squeeze');
    expect(terms).toContain('LME');
    expect(terms).toContain('铜价');
    expect(terms).toContain('squeeze');
  });

  it('drops English function words and the punctuation a sentence leaves on a word', () => {
    expect(queryTerms('Who is the director of the film that won in 2019?')).toEqual(['director', 'film', 'won', '2019']);
    expect(queryTerms('What happened at the end.')).toEqual(['happened', 'end']);
    // a name written in capitals is not the word it spells
    expect(queryTerms('Is the US in the WHO?')).toEqual(['US', 'WHO']);
    expect(queryTerms('$NVDA a.b-c_d r_6f406e239a')).toEqual(['$NVDA', 'a.b-c_d', 'r_6f406e239a']);
    // an excluded word is not looked for; a hyphen inside a word is part of it
    expect(queryTerms('storage -flash 2026-10-28')).toEqual(['storage', '2026-10-28']);
  });
});

describe('keywordTerms', () => {
  it('keeps every word and CJK bigram, lowercased, without stopwords', () => {
    expect(keywordTerms('LME 铜价 squeeze')).toEqual(['lme', 'squeeze', '铜价']);
    expect(keywordTerms('印度的战略石油储备是什么')).toEqual(['印度', '度的', '的战', '战略', '略石', '石油', '油储', '储备', '备是', '是什']);
    expect(keywordTerms('who is it')).toEqual([]);
  });
});

describe('termCount', () => {
  it('counts a CJK term wherever it stands', () => {
    expect(termCount('储能业务与储能电池', '储能')).toBe(2);
  });

  it('counts a Latin term at the start of a word, and a short one or a number only as a whole word', () => {
    expect(termCount('the limit, its limits, unlimited', 'limit')).toBe(2);
    expect(termCount('ai aims at ai.', 'ai')).toBe(2);
    expect(termCount('in 2026 and 20261', '2026')).toBe(1);
    // CJK beside it is no letter
    expect(termCount('海力士的hbm4在量产', 'hbm4')).toBe(1);
    expect(termCount('编号rx6f406e239a', 'r_6f406e239a')).toBe(0);
  });
});

describe('websearchText', () => {
  it('keeps a hyphen that starts or joins a word, and drops rules and dangling hyphens', () => {
    expect(websearchText('copper -futures e-mail')).toBe('copper -futures e-mail');
    expect(websearchText(`第十六回\n${'-'.repeat(62)}\n話說`)).toBe('第十六回\n \n話說');
    expect(websearchText('| a |\n|---|---|\n| b |')).toBe('| a |\n| | |\n| b |');
    expect(websearchText('x - y -， z-')).toBe('x   y  ， z ');
  });
});

describe('local embedding', () => {
  it('is deterministic, normalized, and ranks related text higher', async () => {
    const e = new LocalHashEmbeddingProvider(256);
    const [a1, a2, b] = await e.embed(['postgres vector database', 'postgres vector index', 'cooking pasta recipes']);
    const [a1b] = await e.embed(['postgres vector database']);
    expect(a1).toEqual(a1b);
    const norm = Math.sqrt(a1.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
    expect(cos(a1, a2)).toBeGreaterThan(cos(a1, b));
  });
});

describe('ark multimodal embedding', () => {
  const cfg = {
    provider: 'ark-multimodal' as const,
    baseUrl: 'https://ark-cn-beijing.example/api/v3/',
    apiKey: 'test-key',
    model: 'ep-test',
    dimensions: 4,
    batchSize: 3,
    sendDimensions: false,
  };

  /** Ark answers with a single fused vector per call, under `data.embedding`. */
  function mockArk(onCall: (body: Record<string, any>, url: string) => number[]) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
      const body = JSON.parse(init.body as string);
      const embedding = onCall(body, String(url));
      return new Response(JSON.stringify({ data: { embedding }, usage: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  }

  it('posts one text part per request and keeps input order despite concurrency', async () => {
    const seen: string[] = [];
    const fetchSpy = mockArk((body, url) => {
      expect(url).toBe('https://ark-cn-beijing.example/api/v3/embeddings/multimodal');
      expect(body.model).toBe('ep-test');
      expect(body.dimensions).toBeUndefined();
      // One item per call: the parts of one `input` are fused into one vector.
      expect(body.input).toHaveLength(1);
      expect(body.input[0].type).toBe('text');
      const text = body.input[0].text as string;
      seen.push(text);
      return [Number(text), 0, 0, 0];
    });
    try {
      const provider = createEmbeddingProvider(cfg);
      const vectors = await provider.embed(['0', '1', '2', '3', '4']);
      expect(fetchSpy).toHaveBeenCalledTimes(5);
      expect(seen.sort()).toEqual(['0', '1', '2', '3', '4']);
      expect(vectors.map((v) => v[0])).toEqual([0, 1, 2, 3, 4]);
      expect(provider.dimensions).toBe(4);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('sends the dimensions parameter only when configured', async () => {
    const fetchSpy = mockArk((body) => {
      expect(body.dimensions).toBe(4);
      return [1, 0, 0, 0];
    });
    try {
      await createEmbeddingProvider({ ...cfg, sendDimensions: true }).embed(['x']);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('fails loudly when the response is not in Ark multimodal shape', async () => {
    // An OpenAI-shaped `data: [{embedding}]` body must not silently yield junk.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    try {
      await expect(createEmbeddingProvider(cfg).embed(['x'])).rejects.toThrow(/data\.embedding/);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('graph extraction', () => {
  it('extracts wikilinks including aliases and headings', () => {
    const links = extractWikilinks('see [[PGlite]] and [[Electric SQL|electric]] plus [[Page#Section]] and [[PGlite]] again');
    expect(links).toEqual(['PGlite', 'Electric SQL', 'Page']);
  });

  it('slugifies names including CJK', () => {
    expect(slugify('Electric SQL')).toBe('electric-sql');
    expect(slugify('知识图谱')).toBe('知识图谱');
    expect(slugify('  PGlite!! ')).toBe('pglite');
  });
});

describe('llm cli providers', () => {
  const llmCfg = (overrides: object) => ({
    provider: 'openai' as const, baseUrl: '', apiKey: '', model: '', cliPath: '', cliTimeoutMs: 30_000, ...overrides,
  });
  const writeStub = (name: string, script: string) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, `#!/bin/bash\n${script}`, { mode: 0o755 });
    return p;
  };

  it('flattens messages into a one-shot prompt with a JSON directive', () => {
    const prompt = renderCliPrompt([
      { role: 'system', content: 'extract entities' },
      { role: 'user', content: 'Document: x' },
    ], true);
    expect(prompt).toContain('extract entities');
    expect(prompt).toContain('Document: x');
    expect(prompt).toMatch(/single JSON object only/);
  });

  it('codex-cli: reads the final message from --output-last-message', async () => {
    // stub emulating `codex exec ... --output-last-message <file> -`
    const stub = writeStub('codex-stub.sh', `
out=""; prev=""
for a in "$@"; do [ "$prev" = "--output-last-message" ] && out="$a"; prev="$a"; done
cat > /dev/null  # consume the stdin prompt
echo -n '{"entities":[{"name":"PGlite","type":"technology"}]}' > "$out"
`);
    const cfg = llmCfg({ provider: 'codex-cli', cliPath: stub });
    const client = new LlmClient(cfg);
    expect(client.enabled).toBe(true);
    expect(client.label).toBe('codex-cli');
    const res = await client.completeJson<{ entities: { name: string }[] }>([{ role: 'user', content: 'x' }]);
    expect(res.entities[0].name).toBe('PGlite');
  });

  it('codex-cli: turns plugins, apps and analytics off for a one-shot call', () => {
    // with plugins on, every start downloads ChatGPT's whole plugin catalog (~15 MB); apps, the apps listing (~1 MB)
    const args = codexExecArgs({ outFile: '/tmp/out.txt', cwd: '/tmp', images: ['/tmp/page.png'] }).join(' ');
    expect(args).toContain('--ignore-user-config --ephemeral -c features.plugins=false -c features.apps=false -c analytics.enabled=false');
    expect(args).not.toContain('model_catalog_json'); // no copy given (tests/codex-catalog.test.ts)
    expect(args).not.toContain('--disable'); // fails the call on a Codex that lacks the feature
    expect(args).toMatch(/--image \/tmp\/page\.png -$/);
  });

  it('claude-cli: unwraps the --output-format json result field', async () => {
    const stub = writeStub('claude-stub.sh', `
cat > /dev/null
echo '{"type":"result","is_error":false,"result":"pong"}'
`);
    const out = await completeViaCli(llmCfg({ provider: 'claude-cli', cliPath: stub }), [{ role: 'user', content: 'ping' }]);
    expect(out).toBe('pong');
  });

  it('claude-cli: grants Read access and identifies attached images', async () => {
    const image = path.join(tmp, 'claude-image.png');
    fs.writeFileSync(image, 'fixture');
    const stub = writeStub('claude-image-stub.sh', `
args="$*"
prompt="$(cat)"
[[ "$args" == *"--tools Read"* ]] || exit 7
[[ "$args" == *"--add-dir ${tmp}"* ]] || exit 8
[[ "$prompt" == *"${image}"* ]] || exit 9
echo '{"type":"result","is_error":false,"result":"# Image text"}'
`);
    const out = await completeViaCli(
      llmCfg({ provider: 'claude-cli', cliPath: stub }),
      [{ role: 'user', content: 'transcribe' }],
      { images: [image] },
    );
    expect(out).toBe('# Image text');
  });

  it('claude-cli: surfaces is_error results as errors', async () => {
    const stub = writeStub('claude-err-stub.sh', `
cat > /dev/null
echo '{"type":"result","is_error":true,"result":"Failed to authenticate"}'
exit 1
`);
    await expect(completeViaCli(llmCfg({ provider: 'claude-cli', cliPath: stub }), [{ role: 'user', content: 'ping' }]))
      .rejects.toThrow(/Failed to authenticate/);
  });

  it('cursor-cli: unwraps the headless JSON result', async () => {
    const stub = writeStub('cursor-stub.sh', `
echo '{"type":"result","subtype":"success","is_error":false,"result":"pong"}'
`);
    const out = await completeViaCli(llmCfg({ provider: 'cursor-cli', cliPath: stub }), [{ role: 'user', content: 'ping' }]);
    expect(out).toBe('pong');
  });

  it('passes the configured reasoning effort to each CLI in its own syntax', async () => {
    const claude = writeStub('claude-effort-stub.sh', `
cat > /dev/null
echo '{"type":"result","is_error":false,"result":"'"$*"'"}'
`);
    const args = await completeViaCli(llmCfg({ provider: 'claude-cli', cliPath: claude, effort: 'high' }), [{ role: 'user', content: 'x' }]);
    expect(args).toContain('--effort high');
    // 'default' means "leave the CLI's own setting alone", so nothing is sent
    const plain = await completeViaCli(llmCfg({ provider: 'claude-cli', cliPath: claude, effort: 'default' }), [{ role: 'user', content: 'x' }]);
    expect(plain).not.toContain('--effort');

    const codex = writeStub('codex-effort-stub.sh', `
out=""; prev=""
for a in "$@"; do [ "$prev" = "--output-last-message" ] && out="$a"; prev="$a"; done
cat > /dev/null
echo -n "$*" > "$out"
`);
    expect(await completeViaCli(llmCfg({ provider: 'codex-cli', cliPath: codex, effort: 'max' }), [{ role: 'user', content: 'x' }]))
      .toContain('model_reasoning_effort="max"');

    // cursor has no flag: the level rides in the model name, and only as far as high
    const cursor = writeStub('cursor-effort-stub.sh', `
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"'"$*"'"}]}}'
`);
    expect(await completeViaCli(llmCfg({ provider: 'cursor-cli', cliPath: cursor, model: 'gpt-5', effort: 'max' }), [{ role: 'user', content: 'x' }]))
      .toContain('--model gpt-5[effort=high]');
  });

  it('reports a missing CLI executable clearly', async () => {
    await expect(completeViaCli(llmCfg({ provider: 'codex-cli', cliPath: path.join(tmp, 'nope-cli') }), [{ role: 'user', content: 'x' }]))
      .rejects.toThrow(/not found/);
  });

  it('kills a hung CLI after cliTimeoutMs', async () => {
    const stub = writeStub('hang-stub.sh', 'sleep 30');
    await expect(completeViaCli(llmCfg({ provider: 'claude-cli', cliPath: stub, cliTimeoutMs: 1000 }), [{ role: 'user', content: 'x' }]))
      .rejects.toThrow(/timed out/);
  }, 10_000);
});

describe('walkFiles', () => {
  it('lists files recursively with posix paths', () => {
    const dir = path.join(tmp, 'walk');
    fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a/b/c.md'), 'x');
    const files = walkFiles(tmp, 'walk');
    expect(files).toEqual(['walk/a/b/c.md']);
  });
});
