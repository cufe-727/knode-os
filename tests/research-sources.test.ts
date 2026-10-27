import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { codexExtraMcpArgs, extraToolNames, sessionArgs, sessionEnv } from '../src/research/launch.js';
import { callApiSource, deleteResearchSource, loadResearchSources, mcpServersFor, redactSource, saveResearchSource, sourceProblem, sourcesBrief } from '../src/research/sources.js';
import { readResponse, runDeepResearch } from '../src/research/deep-research.js';
import { webSearch, webSearchEnabled } from '../src/research/web.js';
import { writeAgentFiles } from '../src/research/workspace.js';

/**
 * Research sources (src/research/sources.ts): files a person configures; an
 * MCP source is attached to every session of a study that selects it, an API
 * source is called through its declared endpoints only. Also the stand-ins for
 * the web search providers and the deep-research wire.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-sources-'));
let server: http.Server;
let base = '';
const requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let polls = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const url = new URL(req.url ?? '/', 'http://x');
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (url.pathname === '/api/v1/companies/0001234/facts') return json(200, { data: { items: [{ year: 2025, revenue: 4.5 }] } });
      if (url.pathname === '/search') return json(200, { results: [{ title: 'Anthropic S-1', url: 'https://www.sec.gov/x', content: 'the filing', publishedDate: '2026-10-26' }] });
      if (url.pathname === '/v1/responses' && req.method === 'POST') return json(200, { id: 'resp_1', status: 'queued' });
      if (url.pathname === '/v1/responses/resp_1') {
        polls++;
        if (polls < 2) return json(200, { id: 'resp_1', status: 'in_progress' });
        return json(200, {
          id: 'resp_1', status: 'completed', model: 'o3-deep-research',
          output: [{ type: 'web_search_call' }, { type: 'message', content: [{ type: 'output_text', text: '# Report\n\nRevenue grew.', annotations: [{ type: 'url_citation', url: 'https://example.com/a', title: 'A' }, { type: 'url_citation', url: 'https://example.com/a', title: 'A' }] }] }],
        });
      }
      if (url.pathname === '/chat/v1/responses') return json(404, { error: 'no responses here' });
      if (url.pathname === '/chat/v1/chat/completions') return json(200, { id: 'c1', model: 'sonar-deep-research', choices: [{ message: { content: 'A report.' } }], citations: ['https://example.org/1'], search_results: [{ url: 'https://example.org/2', title: 'Two' }] });
      json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const web = () => ({ ...defaultConfig().research.web, proxy: 'none' });

describe('research sources', () => {
  it('are files: saved, listed, validated, redacted, deleted', () => {
    const config = defaultConfig();
    expect(() => saveResearchSource(tmp, { id: 'Bad Id', kind: 'site' })).toThrow(/invalid source id/);
    expect(() => saveResearchSource(tmp, { id: 'knode-os', kind: 'site', domains: ['x'] })).toThrow(/invalid source id/);
    expect(() => saveResearchSource(tmp, { id: 'empty-api', kind: 'api', url: 'https://x' })).toThrow(/at least one endpoint/);
    saveResearchSource(tmp, { id: 'sites', title: 'Primary filings', kind: 'site', domains: ['https://www.sec.gov/', 'anthropic.com'], urls: ['https://www.anthropic.com/news/s1-sec', 'javascript:alert(1)'] });
    saveResearchSource(tmp, { id: 'filings', kind: 'mcp', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer secret-1' }, tools: ['search_filings'] });
    saveResearchSource(tmp, { id: 'local-mcp', kind: 'mcp', command: 'npx', args: ['-y', 'some-mcp'], env: { API_KEY: 'env:SOME_KEY' }, enabled: false });
    saveResearchSource(tmp, { id: 'facts', kind: 'api', url: `${base}/api/v1`, headers: { 'X-Key': 'k-123' }, endpoints: [{ name: 'facts', path: 'companies/{cik}/facts', params: [{ name: 'cik', in: 'path', required: true }, { name: 'year' }], resultPath: 'data.items' }] });
    const all = loadResearchSources(tmp);
    expect(all.map((s) => s.id)).toEqual(['facts', 'filings', 'local-mcp', 'sites']);
    const sites = all.find((s) => s.id === 'sites')!;
    expect(sites.domains).toEqual(['www.sec.gov', 'anthropic.com']);
    expect(sites.urls).toEqual(['https://www.anthropic.com/news/s1-sec']);
    expect(redactSource(all.find((s) => s.id === 'filings')!).headers.Authorization).toBe('***');
    expect(redactSource(all.find((s) => s.id === 'local-mcp')!).env.API_KEY).toBe('env:SOME_KEY');
    // saving the redacted form back keeps the stored secret
    saveResearchSource(tmp, { ...redactSource(all.find((s) => s.id === 'filings')!), id: 'filings' } as unknown as Record<string, unknown> & { id: string });
    expect(loadResearchSources(tmp).find((s) => s.id === 'filings')!.headers.Authorization).toBe('Bearer secret-1');
    expect(sourceProblem({ ...sites, kind: 'datasource', datasource: 'nope' }, config)).toMatch(/no datasource "nope"/);
    expect(deleteResearchSource(tmp, 'sites')).toBe(true);
    expect(deleteResearchSource(tmp, 'sites')).toBe(false);
  });

  it('attach MCP servers to claude, codex and cursor without secrets in the argv', () => {
    process.env.SOME_KEY = 'from-env';
    const servers = mcpServersFor(loadResearchSources(tmp));
    expect(servers.map((s) => s.id)).toEqual(['filings', 'local-mcp']);
    expect(servers[1].env).toEqual({ API_KEY: 'from-env' });
    expect(extraToolNames(servers)).toEqual(['mcp__filings__search_filings', 'mcp__local-mcp__*']);
    const mcp = { url: 'http://127.0.0.1:9/mcp', token: 'tok', headers: {} };
    const common = { maxTurns: 10, timeoutMs: 1000, cwd: tmp, prompt: 'p', mcp, readDirs: [], jobId: 'r_1', outputPath: '', worksetId: 'w', tools: 'read' as const, label: 'collect-1', extraMcp: servers };
    const claude = sessionArgs({ ...common, agent: { kind: 'cli', provider: 'claude-cli', cliPath: '', model: '' } });
    const allowed = claude.args.slice(claude.args.indexOf('--allowedTools') + 1, claude.args.indexOf('--disallowedTools'));
    expect(allowed).toEqual(expect.arrayContaining(['mcp__knode-os__knode_capture', 'mcp__filings__search_filings', 'mcp__local-mcp__*']));
    expect(allowed).not.toContain('mcp__knode-os__knode_write');
    const codex = sessionArgs({ ...common, agent: { kind: 'cli', provider: 'codex-cli', cliPath: '', model: '' } });
    const joined = codex.args.join(' ');
    expect(joined).toContain('mcp_servers.filings.url="https://mcp.example.com/mcp"');
    expect(joined).toContain('mcp_servers.filings.enabled_tools=["search_filings"]');
    expect(joined).toContain('mcp_servers.local-mcp.command="npx"');
    expect(joined).toContain('mcp_servers.knode-os.tool_timeout_sec=300');
    expect(joined).not.toContain('secret-1');
    expect(joined).not.toContain('from-env');
    const env = sessionEnv({ mcp, jobId: 'r_1', outputPath: '', worksetId: 'w', extraMcp: servers });
    expect(Object.values(env)).toContain('Bearer secret-1');
    expect(env.API_KEY).toBe('from-env');
    expect(codexExtraMcpArgs(servers).args.join(' ')).toMatch(/env_http_headers=\{ "Authorization" = "KNODE_SRC_FILINGS_0_AUTHORIZATION" \}/);
    // claude and cursor read theirs from the run workspace
    const dir = path.join(tmp, 'run');
    fs.mkdirSync(dir, { recursive: true });
    writeAgentFiles(dir, { schema: 's', mcp, readme: 'r', extraMcp: servers });
    const claudeCfg = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
    expect(Object.keys(claudeCfg.mcpServers)).toEqual(['knode-os', 'filings', 'local-mcp']);
    expect(claudeCfg.mcpServers['local-mcp']).toMatchObject({ type: 'stdio', command: 'npx' });
    expect(fs.statSync(path.join(dir, '.mcp.json')).mode & 0o077).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.cursor', 'cli.json'), 'utf8')).permissions.allow).toEqual(['Mcp(knode-os:*)', 'Mcp(filings:*)', 'Mcp(local-mcp:*)']);
    delete process.env.SOME_KEY;
  });

  it('call an API source through its declared endpoints only', async () => {
    const config = defaultConfig();
    config.research.web.proxy = 'none';
    const facts = loadResearchSources(tmp).find((s) => s.id === 'facts')!;
    const r = await callApiSource(config, facts, 'facts', { cik: '0001234' });
    expect(r.status).toBe(200);
    expect(r.records).toEqual([{ year: 2025, revenue: 4.5 }]);
    expect(requests.at(-1)?.headers['x-key']).toBe('k-123');
    await expect(callApiSource(config, facts, 'other', {})).rejects.toThrow(/unknown endpoint/);
    await expect(callApiSource(config, facts, 'facts', { cik: '1', url: 'http://evil' })).rejects.toThrow(/does not take "url"/);
    await expect(callApiSource(config, facts, 'facts', {})).rejects.toThrow(/needs "cik"/);
    const brief = sourcesBrief(loadResearchSources(tmp), { web: true, webSearchTool: false }).join('\n');
    expect(brief).toContain('knode_api source=`facts`');
    expect(brief).toContain('mcp__filings__*');
  });
});

describe('web search and deep research', () => {
  it('searches through the configured provider, and not without one', async () => {
    const w = web();
    expect(webSearchEnabled(w)).toBe(false);
    await expect(webSearch(w, 'x')).rejects.toThrow(/no web search provider/);
    w.search = { provider: 'searxng', baseUrl: base, apiKey: '', maxResults: 5 };
    expect(webSearchEnabled(w)).toBe(true);
    const results = await webSearch(w, 'Anthropic S-1', { domains: ['sec.gov'] });
    expect(results).toEqual([{ title: 'Anthropic S-1', url: 'https://www.sec.gov/x', snippet: 'the filing', published: '2026-10-26', source: 'searxng' }]);
    expect(decodeURIComponent(requests.at(-1)!.url)).toContain('q=Anthropic+S-1+site:sec.gov'.replace(/\+/g, ' ').replace(/ /g, '+'));
  });

  it('runs a deep-research model in the background and reads its citations', async () => {
    const r = await runDeepResearch({ connection: { id: 'c', label: 'c', baseUrl: `${base}/v1`, apiKey: 'sk-test', protocol: 'auto' }, model: 'o3-deep-research', prompt: 'research', web: web(), timeoutMs: 60_000, jobId: 'r_dr', pollMs: 10 });
    expect(r.wire).toBe('responses');
    expect(r.text).toContain('Revenue grew');
    expect(r.citations).toEqual([{ url: 'https://example.com/a', title: 'A' }]);
    const started = JSON.parse(requests.find((q) => q.url === '/v1/responses')!.body);
    expect(started).toMatchObject({ model: 'o3-deep-research', background: true, tools: [{ type: 'web_search_preview' }] });
    expect(requests.find((q) => q.url === '/v1/responses')!.headers.authorization).toBe('Bearer sk-test');
    // an endpoint without /responses: chat completions, Perplexity-style citations
    const chat = await runDeepResearch({ connection: { id: 'p', label: 'p', baseUrl: `${base}/chat/v1`, apiKey: '', protocol: 'auto' }, model: 'sonar-deep-research', prompt: 'research', web: web(), timeoutMs: 60_000, jobId: 'r_dr2', pollMs: 10 });
    expect(chat.wire).toBe('chat');
    expect(chat.citations.map((c) => c.url)).toEqual(['https://example.org/2', 'https://example.org/1']);
    expect(readResponse({ output_text: 'plain' }).text).toBe('plain');
  });
});
