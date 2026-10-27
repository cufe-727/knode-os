import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, saveConfig } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { originOf } from '../src/fs/sidecar.js';
import { captureUrl, CAPTURE_MANIFEST, fetchReadable, normalizeUrl, readManifest, registerPath, waitForCaptureIndexing } from '../src/research/capture.js';
import { guardedFetch, isFakeIp, isPrivateAddress, proxyFor } from '../src/research/fetch.js';
import { readSection } from '../src/research/read.js';
import { readSourceTextCapped } from '../src/ingest/source.js';
import { textPdf } from './helpers/pdf.js';

/**
 * Web capture (src/research/capture.ts): knode fetches what an agent asked
 * for, keeps the original under raw/docs/research/<study>/, files it in the
 * manifest and the study's register, and the ordinary pipeline converts and
 * indexes it. The guard keeps agent-chosen URLs off private addresses.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-capture-'));
const dataDir = path.join(tmp, 'data');
let ctx: AppContext;
let server: http.Server;
let base = '';
let hits = 0;

const ARTICLE = `<!doctype html><html lang="en"><head><title>Anthropic files for an IPO</title>
<meta property="article:published_time" content="2026-06-01T12:00:00Z"><meta name="author" content="A. Reporter"></head>
<body><nav>Home | Markets | Tech</nav><article><h1>Anthropic files for an IPO</h1>
<p>Anthropic confidentially submitted a draft registration statement on Form S-1 to the SEC, the company said on Monday. ${'The filing marks a step towards a listing that could value the company among the largest technology debuts. '.repeat(4)}</p>
<h2>Revenue</h2><p>Annualized revenue reached $47 billion in May, according to people familiar with the matter. ${'Analysts expect the prospectus to detail gross margin and compute costs. '.repeat(3)}</p>
<table><thead><tr><th>Year</th><th>Revenue</th></tr></thead><tbody><tr><td>2024</td><td>$ 0.9</td></tr><tr><td>2025</td><td>$ 4.5</td></tr></tbody></table>
<h2>Risks</h2><p>${'Competition from other frontier labs and the cost of compute are the main risks named by analysts. '.repeat(3)}</p>
</article><footer>© News Co</footer><script>track()</script></body></html>`;

beforeAll(async () => {
  initDataDir(dataDir);
  const config = defaultConfig();
  config.research.web.allowPrivateHosts = true; // the test server is on loopback
  config.research.web.proxy = 'none';
  saveConfig(dataDir, config);
  ctx = await createContext(dataDir);
  server = http.createServer((req, res) => {
    hits++;
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/article') {
      const body = zlib.gzipSync(Buffer.from(ARTICLE));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
      res.end(body);
    } else if (url.pathname === '/moved') {
      res.writeHead(301, { location: '/article?utm_source=x' });
      res.end();
    } else if (url.pathname === '/mirror') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ARTICLE);
    } else if (url.pathname === '/s-1.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(textPdf('Registration Statement on Form S-1. Total revenue 4.5 billion.'));
    } else if (url.pathname === '/data.csv') {
      res.writeHead(200, { 'content-type': 'text/csv' });
      res.end('year,revenue\n2024,0.9\n2025,4.5\n');
    } else if (url.pathname === '/app') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>App</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    } else if (url.pathname === '/blob') {
      res.writeHead(200, { 'content-type': 'application/zip' });
      res.end(Buffer.from([0x50, 0x4b, 3, 4, 0, 0]));
    } else if (url.pathname === '/forbidden') {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('no robots');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 60_000);

afterAll(async () => {
  await waitForCaptureIndexing(dataDir);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await ctx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const study = { id: 'r_study00001', slug: 'anthropic-ipo', title: 'Anthropic IPO' };

describe('the fetch guard', () => {
  it('refuses private, loopback, link-local and reserved addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '224.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '151.101.1.69']) expect(isPrivateAddress(ip), ip).toBe(false);
    // a proxy's fake-IP answer: reserved, but the proxy resolves the name itself
    expect(isPrivateAddress('198.18.1.9')).toBe(true);
    expect(isFakeIp('198.18.1.9')).toBe(true);
    expect(isFakeIp('198.20.0.1')).toBe(false);
    expect(isFakeIp('fdfe:dcba:9876::10b')).toBe(true);
    expect(isFakeIp('fd00::1')).toBe(false);
  });

  it('lets a name through that resolves only to fake-IP addresses, never such a literal', async () => {
    const strict = { ...ctx.config.research.web, allowPrivateHosts: false, proxy: 'none' };
    await expect(guardedFetch('http://198.18.0.5/x', strict, { timeoutMs: 500 })).rejects.toThrow(/private or reserved/);
  });

  it('will not fetch a loopback URL unless private hosts are allowed', async () => {
    const strict = { ...ctx.config.research.web, allowPrivateHosts: false };
    await expect(guardedFetch(`${base}/article`, strict)).rejects.toThrow(/private or reserved|local name/);
    await expect(guardedFetch('http://localhost:1/x', strict)).rejects.toThrow(/local name/);
    await expect(guardedFetch('file:///etc/passwd', strict)).rejects.toThrow(/only http and https/);
    // configuration a person wrote (a search provider's URL) may be local
    const ok = await guardedFetch(`${base}/data.csv`, strict, { trusted: true });
    expect(ok.status).toBe(200);
  });

  it('reads proxies the way curl does', () => {
    const env = { HTTPS_PROXY: 'http://u:p@127.0.0.1:7897', NO_PROXY: 'localhost,.internal.example' };
    expect(proxyFor(new URL('https://www.sec.gov/x'), '', env)?.url.port).toBe('7897');
    expect(proxyFor(new URL('https://www.sec.gov/x'), '', env)?.auth).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect(proxyFor(new URL('https://wiki.internal.example/x'), '', env)).toBeNull();
    expect(proxyFor(new URL('https://www.sec.gov/x'), 'none', env)).toBeNull();
    expect(proxyFor(new URL('http://example.com/'), '', env)).toBeNull(); // no HTTP_PROXY
    expect(proxyFor(new URL('http://example.com/'), 'http://proxy:3128', env)?.url.host).toBe('proxy:3128');
  });

  it('normalizes URLs it files captures under', () => {
    expect(normalizeUrl('https://WWW.Example.com:443/a/?utm_source=x&b=2&a=1#frag')).toBe('https://www.example.com/a/?a=1&b=2');
    expect(normalizeUrl('https://example.com/path/')).toBe('https://example.com/path');
  });
});

describe('captureUrl', () => {
  it('keeps a web page as its original, files it, and the pipeline converts and indexes it', async () => {
    const r = await captureUrl(ctx, { url: `${base}/article`, study, why: 'the filing news', actor: 'agent/codex-cli', index: 'wait' });
    expect(r.kind).toBe('html');
    expect(r.reused).toBe(false);
    expect(r.path).toMatch(/^raw\/docs\/research\/anthropic-ipo\/web\/2026-06-01-127-0-0-1-anthropic-files-for-an-ipo\.html$/);
    expect(r.title).toBe('Anthropic files for an IPO');
    expect(r.published).toMatch(/^2026-06-01/);
    expect(r.outline.map((h) => h.text)).toEqual(expect.arrayContaining(['Revenue', 'Risks']));
    const raw = fs.readFileSync(path.join(dataDir, r.path), 'utf8');
    expect(raw.startsWith('<!-- knode-capture: ')).toBe(true);
    expect(raw).toContain('<article>');
    // on record as the agent's: it lands quarantined like the rest of its work
    expect(originOf(dataDir, r.path)?.actor).toBe('agent/codex-cli');
    const [scope] = await ctx.store.query<{ trust: string }>(`SELECT trust FROM scopes WHERE key = $1 AND status = 'active'`, [r.path]);
    expect(scope?.trust).toBe('quarantined');
    // the converted Markdown is what search and knode_read see
    const text = readSourceTextCapped(dataDir, r.path, 4 * 1024 * 1024)!.content;
    expect(text).toContain('url: ');
    expect(text).toContain('Annualized revenue reached $47 billion');
    expect(text).not.toContain('track()');
    expect(readSection(text, { section: 'Revenue' })).toContain('$47 billion');
    const [doc] = await ctx.store.query<{ doc_date: string | Date | null }>(`SELECT doc_date FROM documents WHERE path = $1`, [r.path]);
    expect(String(doc?.doc_date ?? '')).toMatch(/2026-06-01|Jun 01 2026/);
    // manifest and register
    const manifest = readManifest(dataDir);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].studies.map((s) => s.id)).toEqual([study.id]);
    const register = fs.readFileSync(path.join(dataDir, registerPath(study.slug)), 'utf8');
    expect(register).toContain('Anthropic files for an IPO');
    expect(register).toContain(`\`${r.path}\``);
    expect(register).toContain('the filing news');
    expect(fs.existsSync(path.join(dataDir, CAPTURE_MANIFEST))).toBe(true);
  });

  it('captures a URL once: a redirect to it, a tracking parameter, a second study reuse the file', async () => {
    const before = hits;
    const again = await captureUrl(ctx, { url: `${base}/article?utm_campaign=y`, study, actor: 'agent/codex-cli' });
    expect(again.reused).toBe(true);
    expect(hits).toBe(before); // not fetched again
    const other = await captureUrl(ctx, { url: `${base}/moved`, study: { id: 'r_other00001', slug: 'other-study' }, why: 'also needed here', actor: 'agent/claude-cli', index: 'wait' });
    expect(other.reused).toBe(true);
    expect(other.path).toBe(again.path);
    expect(fs.readFileSync(path.join(dataDir, registerPath('other-study')), 'utf8')).toContain(again.path);
    // the same bytes under another URL are one file too
    const mirror = await captureUrl(ctx, { url: `${base}/mirror`, study, actor: 'agent/codex-cli' });
    expect(mirror.reused).toBe(true);
    expect(mirror.path).toBe(again.path);
  });

  it('keeps a PDF whole, dated by its metadata when it has some, and a CSV as data', async () => {
    const pdf = await captureUrl(ctx, { url: `${base}/s-1.pdf`, study, title: 'Form S-1', actor: 'agent/codex-cli', index: 'wait' });
    expect(pdf.kind).toBe('pdf');
    expect(pdf.path).toMatch(/^raw\/docs\/research\/anthropic-ipo\/files\/.+\.pdf$/);
    expect(readSourceTextCapped(dataDir, pdf.path, 4 * 1024 * 1024)?.content).toContain('Registration Statement on Form S-1');
    const csv = await captureUrl(ctx, { url: `${base}/data.csv`, study, actor: 'agent/codex-cli' });
    expect(csv.kind).toBe('data');
    expect(csv.path).toMatch(/\/files\/.+\.csv$/);
    expect(fs.readFileSync(path.join(dataDir, csv.path), 'utf8')).toContain('2025,4.5');
  });

  it('refuses what is not worth keeping, and says what to do instead', async () => {
    await expect(captureUrl(ctx, { url: `${base}/app`, study, actor: 'agent/codex-cli' })).rejects.toThrow(/almost no text|content/);
    await expect(captureUrl(ctx, { url: `${base}/blob`, study, actor: 'agent/codex-cli' })).rejects.toThrow(/keeps HTML, PDF/);
    await expect(captureUrl(ctx, { url: `${base}/forbidden`, study, actor: 'agent/codex-cli' })).rejects.toThrow(/answered 403.*User-Agent/);
  });

  it('refuses anything but an http(s) URL, even for an excerpt it never fetches', async () => {
    await expect(captureUrl(ctx, { url: 'javascript:alert(1)', study, actor: 'agent/x', content: 'x'.repeat(100) })).rejects.toThrow(/not an http\(s\) URL/);
  });

  it('keeps an agent\'s excerpt of a page knode could not fetch, labelled as such', async () => {
    const r = await captureUrl(ctx, { url: `${base}/forbidden`, study, actor: 'agent/codex-cli', content: '# Notes from the page\n\nThe page says revenue grew tenfold in 2025, driven by API usage and Claude Code.' });
    expect(r.kind).toBe('excerpt');
    const text = fs.readFileSync(path.join(dataDir, r.path), 'utf8');
    expect(text).toContain('source_type: "excerpt"');
    expect(text).toContain('Transcribed by agent/codex-cli');
  });

  it('stops a study at its capture budget', async () => {
    await expect(captureUrl(ctx, { url: `${base}/data.csv?v=2`, study: { id: 'r_budget0001', slug: 'budget' }, actor: 'agent/x', maxCaptures: 0 })).resolves.toBeTruthy();
    await expect(captureUrl(ctx, { url: `${base}/article?v=3`, study: { id: 'r_budget0001', slug: 'budget' }, actor: 'agent/x', maxCaptures: 1, content: 'x'.repeat(200) })).rejects.toThrow(/already holds 1 captures/);
  });

  it('reads a page without keeping it', async () => {
    const r = await fetchReadable(ctx, `${base}/article`, { limit: 1000 });
    expect(r.title).toBe('Anthropic files for an IPO');
    expect(r.text.length).toBeLessThanOrEqual(1000);
    expect(r.nextOffset).toBe(1000);
  });
});

describe('readSection', () => {
  const doc = ['# Prospectus', '', 'intro', '', '## Summary', 'summary text', '', '## Risk Factors', 'risk one', '### Competition', 'labs compete', '## MD&A', 'margins'].join('\n');
  it('returns a heading\'s section, an outline, or a range of lines', () => {
    expect(readSection(doc, { section: 'risk factors' })).toContain('labs compete');
    expect(readSection(doc, { section: 'risk factors' })).not.toContain('margins');
    expect(readSection(doc, { outline: true })).toContain('## Risk Factors');
    expect(readSection(doc, { offset: 5, limit: 2 })).toContain('summary text');
    expect(() => readSection(doc, { section: 'nope' })).toThrow(/no heading matches/);
  });
});
