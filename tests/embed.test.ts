import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/auth/service.js';
import { AppContext, createContext } from '../src/context.js';
import { markdownMeta } from '../src/markdown.js';
import { createApp } from '../src/server/app.js';
import { API_CSP, embedCsp, isEmbedPath, UI_CSP } from '../src/server/csp.js';
import { embedOrigins, normalizeEmbedOrigin, parseEmbedOrigins } from '../src/server/embed.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { deepLink, embedUrl, mount } from '../web/embed/sdk.js';

/**
 * The embeddable reader (src/server/embed.ts, web/embed/): the one page
 * another app may frame — by the exact origins `server.embed.allowedOrigins`
 * lists, every other page still refusing every frame — its files, the SDK
 * those origins may import, the helpers the page and the full UI's deep
 * links run on, and the folder listing's frontmatter.
 */

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-embed-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ALLOWED = ['https://rookie-trade.lemoncheese.cc', 'http://127.0.0.1:12300', 'http://localhost:12310'];
const directives = (policy: string) => new Map(policy.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));

describe('server.embed.allowedOrigins', () => {
  it('takes exact origins, normalized as a browser serializes them, each once', () => {
    expect(parseEmbedOrigins(undefined)).toEqual([]);
    expect(parseEmbedOrigins([])).toEqual([]);
    expect(parseEmbedOrigins([
      'https://rookie-trade.lemoncheese.cc',
      ' HTTPS://Rookie-Trade.LemonCheese.cc/ ',
      'http://127.0.0.1:12300',
      'http://localhost:12310',
      'https://example.com:443',
      'http://[::1]:8080',
      'https://bücher.example',
    ])).toEqual(['https://rookie-trade.lemoncheese.cc', 'http://127.0.0.1:12300', 'http://localhost:12310', 'https://example.com', 'http://[::1]:8080', 'https://xn--bcher-kva.example']);
  });

  it('refuses anything else, naming every bad entry', () => {
    const bad = [
      '', '  ', 'rookie-trade.lemoncheese.cc', "'self'", '*', 'https://*.lemoncheese.cc', 'null', 'file:///tmp', 'ftp://example.com',
      'https://example.com/path', 'https://example.com/?q=1', 'https://example.com/#x', 'https://user:pw@example.com',
      'https://a;b.example', 'https://a,b.example', 'https://a b.example', 'javascript:alert(1)', 42, null, {},
    ];
    for (const entry of bad) expect(() => normalizeEmbedOrigin(entry), String(entry)).toThrow();
    expect(() => parseEmbedOrigins('https://example.com')).toThrow(/must be a list/);
    expect(() => parseEmbedOrigins(['https://ok.example', 'https://x.example/app', '*'])).toThrow(/"https:\/\/x\.example\/app".*;.*wildcards/);
  });

  it('is read from the server config, absent meaning none', () => {
    expect(embedOrigins({ port: 1, host: '127.0.0.1', mcp: { enabled: false, path: '/mcp' } })).toEqual([]);
    expect(embedOrigins({ port: 1, host: '127.0.0.1', mcp: { enabled: false, path: '/mcp' }, embed: { allowedOrigins: ALLOWED } })).toEqual(ALLOWED);
  });
});

describe('the policy split', () => {
  it('lets the listed origins frame the reader, under the UI\'s policy otherwise', () => {
    const policy = embedCsp(ALLOWED);
    const embed = directives(policy);
    const ui = directives(UI_CSP);
    expect(embed.get('frame-ancestors')).toEqual(["'self'", ...ALLOWED]);
    for (const [name, values] of ui) if (name !== 'frame-ancestors') expect(embed.get(name), name).toEqual(values);
    expect([...embed.keys()].sort()).toEqual([...ui.keys()].sort());
    expect(policy).not.toMatch(/unsafe-(inline|eval)/);
    expect(directives(embedCsp()).get('frame-ancestors')).toEqual(["'self'"]);
    // every other page keeps refusing every frame
    expect(ui.get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('knows which paths are the reader\'s', () => {
    for (const p of ['/embed', '/embed/v1', '/embed/sdk.js']) expect(isEmbedPath(p), p).toBe(true);
    for (const p of ['/', '/embedded', '/api/embed', '/app.js']) expect(isEmbedPath(p), p).toBe(false);
  });
});

/** The served page's directives, and its origins as written into the page. */
async function readPage(res: Response): Promise<{ origins: unknown; html: string }> {
  const html = await res.text();
  const meta = /<meta name="knode-embed-origins" content="([^"]*)">/.exec(html)?.[1] ?? 'null';
  return { html, origins: JSON.parse(meta.replace(/&quot;/g, '"').replace(/&amp;/g, '&')) };
}

describe('served with sign-in off', () => {
  let rootCtx: AppContext;
  let registry: WorkspaceContextRegistry;
  let app: ReturnType<typeof createApp>;
  const headers = { 'x-knode-user': 'admin', 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': 'default', 'x-knode-workspace-name': 'Default' };

  beforeAll(async () => {
    rootCtx = await createContext(path.join(tmp, 'open'));
    rootCtx.config.server.embed = { allowedOrigins: [...ALLOWED, 'HTTP://LOCALHOST:12310/'] };
    registry = new WorkspaceContextRegistry(rootCtx.dataDir, { templateConfig: rootCtx.config });
    app = createApp(rootCtx, () => {}, registry);
    await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  });

  afterAll(async () => {
    await registry.closeAll();
    await rootCtx.store.close();
  });

  it('sends the reader with its own policy and no X-Frame-Options, the listed origins written in', async () => {
    for (const p of ['/embed/v1', '/embed/v1/', '/embed/v1?view=doc&path=wiki/index.md&origin=http://localhost:12310']) {
      const res = await app.request(p);
      expect(res.status, p).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/html/);
      expect(res.headers.get('content-security-policy')).toBe(embedCsp(ALLOWED));
      expect(res.headers.get('x-frame-options')).toBeNull();
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      const { html, origins } = await readPage(res);
      expect(origins).toEqual(ALLOWED);
      expect(html).toContain('<script src="/embed/embed.js"></script>');
    }
  });

  it('keeps every other page unframeable', async () => {
    for (const p of ['/', '/files/some/deep/link']) {
      const res = await app.request(p);
      expect(res.headers.get('content-security-policy'), p).toBe(UI_CSP);
      expect(res.headers.get('x-frame-options'), p).toBe('DENY');
    }
    // nothing else under /embed: never the app's page, nor a file the reader does not use
    for (const p of ['/embed', '/embed/v2', '/embed/index.html', '/embed/v1/more', '/embed/../app.js', '/embed/sdk.js.map']) {
      const res = await app.request(p);
      if (p === '/embed/../app.js') {
        // the URL parser resolves it to /app.js, a plain asset
        expect(res.headers.get('content-security-policy')).toBe(API_CSP);
        continue;
      }
      expect(res.status, p).toBe(404);
      expect(await res.text(), p).not.toContain('<html');
    }
  });

  it('serves the page\'s own files', async () => {
    const js = await app.request('/embed/embed.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript');
    expect(await js.text()).toContain('knodeEmbed');
    const css = await app.request('/embed/embed.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toBe('text/css');
    const deeplink = await app.request('/deeplink.js');
    expect(deeplink.status).toBe(200);
    expect(await deeplink.text()).toContain('knodeDeepLink');
  });

  it('serves the SDK with CORS for a listed origin only', async () => {
    const allowed = await app.request('/embed/sdk.js', { headers: { origin: 'http://localhost:12310' } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:12310');
    expect(allowed.headers.get('vary')).toMatch(/Origin/);
    expect(allowed.headers.get('access-control-allow-credentials')).toBeNull();
    expect(await allowed.text()).toContain('export function mount');
    for (const origin of ['https://evil.example', 'http://localhost:12311', 'null']) {
      const res = await app.request('/embed/sdk.js', { headers: { origin } });
      expect(res.status, origin).toBe(200);
      expect(res.headers.get('access-control-allow-origin'), origin).toBeNull();
    }
    expect((await app.request('/embed/sdk.js')).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('will not start on an allowed origin that is not one', async () => {
    const ctx = { ...rootCtx, config: { ...rootCtx.config, server: { ...rootCtx.config.server, embed: { allowedOrigins: ['https://rookie-trade.lemoncheese.cc/app'] } } } };
    expect(() => createApp(ctx as AppContext, () => {}, registry)).toThrow(/server\.embed\.allowedOrigins/);
  });

  it('lists a folder\'s Markdown files by their frontmatter when asked', async () => {
    const dir = path.join(rootCtx.dataDir, 'users', 'admin', 'workspaces', 'default', 'raw', 'docs', 'cards');
    fs.mkdirSync(path.join(dir, 'experiments'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'trend.md'), [
      '---', 'type: Strategy', 'title: "Leveraged trend (长牛杠杆增强)"', 'description: Hold QQQ and SPY.', 'date: 2026-10-27',
      'tags: [quant-trading, etf]', 'stage: strategy-lab', 'verdict: promising', '---', '', '# Leveraged trend', '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'README.md'), '# Quant trading\n\nCards.\n');
    fs.writeFileSync(path.join(dir, 'unclosed.md'), '---\ntitle: never closed\n');
    fs.writeFileSync(path.join(dir, 'data.csv'), 'a,b\n1,2\n');
    type Node = { name: string; kind: string; meta?: Record<string, unknown>; children?: Node[] };
    const list = async (query: string): Promise<Node> => (await app.request(`/api/tree?path=raw/docs/cards${query}`, { headers })).json();
    const tree = await list('&depth=1&meta=1');
    const byName = Object.fromEntries((tree.children ?? []).map((c) => [c.name, c]));
    expect(tree.children?.[0]).toMatchObject({ name: 'experiments', kind: 'dir' });
    expect(byName['trend.md'].meta).toEqual({
      title: 'Leveraged trend (长牛杠杆增强)', description: 'Hold QQQ and SPY.', date: '2026-10-27', type: 'Strategy', stage: 'strategy-lab', verdict: 'promising', tags: ['quant-trading', 'etf'],
    });
    expect(byName['README.md'].meta).toEqual({ title: 'Quant trading' });
    expect(byName['unclosed.md'].meta).toBeUndefined();
    expect(byName['data.csv'].meta).toBeUndefined();
    expect(byName['experiments'].meta).toBeUndefined();
    // only when asked, and only for one level
    expect((await list('&depth=1')).children?.find((c) => c.name === 'trend.md')?.meta).toBeUndefined();
    expect((await list('&meta=1')).children?.find((c) => c.name === 'trend.md')?.meta).toBeUndefined();
  });
});

describe('served with sign-in on', () => {
  let rootCtx: AppContext;
  let registry: WorkspaceContextRegistry;
  let app: ReturnType<typeof createApp>;
  const remote = (p: string, headers: Record<string, string> = {}) => app.request(`http://knode.example.com${p}`, {
    headers: { 'cf-connecting-ip': '203.0.113.7', 'cf-visitor': JSON.stringify({ scheme: 'https' }), ...headers },
  });

  beforeAll(async () => {
    const root = path.join(tmp, 'signed');
    rootCtx = await createContext(root);
    rootCtx.config.server.embed = { allowedOrigins: ALLOWED };
    registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
    app = createApp(rootCtx, () => {}, registry, { auth: new AuthService(root, { cookieName: 'knode_session_test' }) });
  });

  afterAll(async () => {
    await registry.closeAll();
    await rootCtx.store.close();
  });

  it('serves the reader to anyone — it signs in nothing — framed only by the listed origins', async () => {
    const res = await remote('/embed/v1?view=doc&path=wiki/index.md');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(embedCsp(ALLOWED));
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect((await readPage(res)).origins).toEqual(ALLOWED);
    const js = await remote('/embed/embed.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('x-frame-options')).toBeNull();
    // the app and the API are as they were
    const page = await remote('/');
    expect(page.headers.get('content-security-policy')).toBe(UI_CSP);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    const state = await remote('/api/auth/state');
    expect(state.headers.get('content-security-policy')).toBe(API_CSP);
    expect(state.headers.get('x-frame-options')).toBe('DENY');
    // what the page reads still needs a session
    expect((await remote('/api/file?path=wiki/index.md', { 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': 'default' })).status).toBe(401);
  });

  it('serves the SDK across origins to a listed one', async () => {
    const res = await remote('/embed/sdk.js', { origin: 'https://rookie-trade.lemoncheese.cc' });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://rookie-trade.lemoncheese.cc');
    expect((await remote('/embed/sdk.js', { origin: 'https://lemoncheese.cc' })).headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('the reader page', () => {
  const html = fs.readFileSync(path.join(webDir, 'embed', 'index.html'), 'utf8');

  it('needs nothing the policy forbids, and loads the UI\'s renderers before its own script', () => {
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      expect(m[1]).toMatch(/\bsrc="\/[^"]+"/);
      expect(m[2].trim()).toBe('');
    }
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect([...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])).toEqual(['/vendor/marked.js', '/chart.js', '/mindmap.js', '/markdown.js', '/deeplink.js', '/embed/embed.js']);
    // the placeholder the server fills, ahead of the script that reads it
    expect(html.indexOf('<meta name="knode-embed-origins" content="[]" />')).toBeGreaterThan(0);
    expect(html.indexOf('knode-embed-origins')).toBeLessThan(html.indexOf('/embed/embed.js'));
    for (const file of ['embed/embed.js', 'embed/sdk.js', 'deeplink.js']) {
      const js = fs.readFileSync(path.join(webDir, file), 'utf8');
      expect(js, file).not.toMatch(/\sstyle="|\son(click|error|load|change|input)="|setAttribute\(\s*['"]style/);
    }
    // markup from text goes in only through the Markdown renderer
    const embed = fs.readFileSync(path.join(webDir, 'embed', 'embed.js'), 'utf8');
    expect([...embed.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim())).toEqual(['global.knodeMarkdown.render(file.content)']);
  });
});

interface EmbedHelpers {
  joinPath: (dir: string, rel: string) => string | null;
  readFrontmatter: (text: string) => Record<string, unknown> | null;
  sanitizeTokens: (tokens: unknown, supports?: (property: string, value: string) => boolean) => Record<string, string>;
  hostOrigin: (param: unknown, allowed: string[], self: string, ancestor: string | null) => string | null;
  readTarget: (input: Record<string, unknown>) => { view: string; path: string; q: string; scope: string; fragment: string | null; invalid?: string };
  errorCode: (status: number, reason?: string) => string;
}
interface DeepLink {
  read: (search: string, hash: string) => { path: string; kind: string | null; ws: string | null; fragment: string | null } | null;
  href: (base: string, link: { path?: string; kind?: string | null; ws?: string | null; fragment?: string | null }) => string;
  pick: <T extends { id: string; kind: string }>(link: { kind: string | null; ws: string | null } | null, workspaces: T[]) => T | null;
}

/** deeplink.js and the reader's script, loaded the way the page loads them, without a document. */
function loadScripts(): { embed: EmbedHelpers; deeplink: DeepLink } {
  const page = vm.createContext({ URL, URLSearchParams });
  vm.runInContext(fs.readFileSync(path.join(webDir, 'deeplink.js'), 'utf8'), page);
  vm.runInContext(fs.readFileSync(path.join(webDir, 'embed', 'embed.js'), 'utf8'), page);
  const g = page as unknown as { knodeEmbed: EmbedHelpers; knodeDeepLink: DeepLink };
  return { embed: g.knodeEmbed, deeplink: g.knodeDeepLink };
}

describe('the reader\'s helpers (web/embed/embed.js)', () => {
  const { embed } = loadScripts();

  it('talks only to a listed origin that is exactly an origin, and that is the frame\'s parent', () => {
    const self = 'https://knode-os.lemoncheese.cc';
    expect(embed.hostOrigin('https://rookie-trade.lemoncheese.cc', ALLOWED, self, null)).toBe('https://rookie-trade.lemoncheese.cc');
    expect(embed.hostOrigin('http://localhost:12310/', ALLOWED, self, 'http://localhost:12310')).toBe('http://localhost:12310');
    expect(embed.hostOrigin(self, ALLOWED, self, self)).toBe(self);
    for (const param of [null, '', 'https://evil.example', 'https://rookie-trade.lemoncheese.cc/page', 'null', '*', 'not a url']) {
      expect(embed.hostOrigin(param, ALLOWED, self, null), String(param)).toBeNull();
    }
    // a listed origin named by a page on another listed origin: not this frame's host
    expect(embed.hostOrigin('http://localhost:12310', ALLOWED, self, 'http://127.0.0.1:12300')).toBeNull();
  });

  it('turns the host\'s tokens into the page\'s variables, keeping only values that cannot load or break out', () => {
    const all = () => true;
    expect(embed.sanitizeTokens({
      background: '#0b0d12', foreground: 'oklch(0.98 0 0)', muted: '222.2 84% 4.9%', mutedForeground: 'rgb(120 120 130)',
      border: 'hsl(0 0% 20%)', primary: '#4f8cff', radius: '0.5rem', fontSans: 'Inter, sans-serif', fontMono: '"JetBrains Mono", monospace', fontHeading: 'Inter',
    }, all)).toEqual({
      '--bg': '#0b0d12', '--fg': 'oklch(0.98 0 0)', '--bg2': 'hsl(222.2 84% 4.9%)', '--bg3': 'hsl(222.2 84% 4.9%)', '--muted': 'rgb(120 120 130)',
      '--border': 'hsl(0 0% 20%)', '--border-strong': 'hsl(0 0% 20%)', '--accent': '#4f8cff', '--radius': '0.5rem',
      '--font-sans': 'Inter, sans-serif', '--mono': '"JetBrains Mono", monospace', '--font-heading': 'Inter',
    });
    expect(embed.sanitizeTokens({
      background: 'url(https://evil.example/x.png)', foreground: 'var(--foreground)', muted: 'red; background: url(x)', border: '}body{display:none',
      primary: 'x'.repeat(201), radius: 7, fontSans: '<b>', unknown: '#fff',
    }, all)).toEqual({});
    // a value the browser would not take for its property is dropped too
    expect(embed.sanitizeTokens({ background: 'not-a-colour', radius: '4px' }, (property, value) => property !== 'color' || value.startsWith('#'))).toEqual({ '--radius': '4px' });
    expect(embed.sanitizeTokens(null)).toEqual({});
  });

  it('reads the frontmatter fields a title area shows', () => {
    expect(embed.readFrontmatter([
      '---', 'type: Strategy', 'title: "Leveraged trend: QQQ + S&P 500"', "stage: 'strategy-lab'", 'date: 2026-10-27',
      'tags: [quant-trading, "a, b", etf]', 'generated: { by: "claude", at: "2026-10-27" }', 'sources:', '  - one', '  - "two"',
      'generated_by:', '  by: process', 'description: >', '  Always hold QQQ', '  and SPY.', 'verdict: promising', '---', '# Body',
    ].join('\n'))).toEqual({
      type: 'Strategy', title: 'Leveraged trend: QQQ + S&P 500', stage: 'strategy-lab', date: '2026-10-27',
      tags: ['quant-trading', 'a, b', 'etf'], sources: ['one', 'two'], generated_by: [], description: 'Always hold QQQ and SPY.', verdict: 'promising',
    });
    expect(embed.readFrontmatter('# No frontmatter\n')).toBeNull();
  });

  it('reads a target from an address or a host message, and resolves paths inside the workspace only', () => {
    expect(embed.readTarget({ view: 'doc', path: '/raw/docs//x.md', fragment: 'e-88703d61' })).toEqual({ view: 'doc', path: 'raw/docs/x.md', q: '', scope: '', fragment: 'e-88703d61' });
    expect(embed.readTarget({ q: 'momentum', scope: 'raw/docs/quant-trading/' })).toMatchObject({ view: 'search', q: 'momentum', scope: 'raw/docs/quant-trading' });
    expect(embed.readTarget({ view: 'folder', path: '' })).toMatchObject({ view: 'folder', path: '' });
    expect(embed.readTarget({ view: 'doc' }).invalid).toMatch(/path=/);
    expect(embed.readTarget({ view: 'doc', path: '../../etc/passwd' }).invalid).toMatch(/outside the workspace/);
    expect(embed.readTarget({ view: 'graph', path: 'wiki/index.md' }).view).toBe('doc');
    expect(embed.joinPath('raw/docs/quant-trading/strategies', '../experiments/2026-10-19-leveraged-trend/report.md')).toBe('raw/docs/quant-trading/experiments/2026-10-19-leveraged-trend/report.md');
    expect(embed.joinPath('raw/docs/q', 'outputs/')).toBe('raw/docs/q/outputs');
    expect(embed.joinPath('raw/docs/q', '%E5%9B%BE.png')).toBe('raw/docs/q/图.png');
    expect(embed.joinPath('raw', '../../x')).toBeNull();
  });

  it('tells the host what went wrong, and a session that ended from a failure', () => {
    expect(embed.errorCode(401, 'auth')).toBe('auth');
    expect(embed.errorCode(404)).toBe('not-found');
    expect(embed.errorCode(400)).toBe('not-found');
    expect(embed.errorCode(401)).toBe('not-found');
    expect(embed.errorCode(403, 'forbidden')).toBe('forbidden');
    expect(embed.errorCode(403, 'private')).toBe('forbidden');
    expect(embed.errorCode(403, 'https')).toBe('unavailable');
    expect(embed.errorCode(500)).toBe('unavailable');
    expect(embed.errorCode(503)).toBe('unavailable');
  });
});

describe('deep links (web/deeplink.js)', () => {
  const { deeplink } = loadScripts();

  it('reads /?open=… with its workspace and fragment', () => {
    expect(deeplink.read('?open=raw/docs/quant-trading/strategies/us-leveraged-trend.md&kind=personal&ws=finance', '#e-88703d61'))
      .toEqual({ path: 'raw/docs/quant-trading/strategies/us-leveraged-trend.md', kind: 'personal', ws: 'finance', fragment: 'e-88703d61' });
    expect(deeplink.read('?open=%2Fraw%2Fdocs%2F&ws=finance', '#%E4%B8%80%E3%80%81%E6%83%85%E7%BB%AA')).toEqual({ path: 'raw/docs', kind: 'personal', ws: 'finance', fragment: '一、情绪' });
    expect(deeplink.read('?open=wiki/index.md&kind=team', '')).toEqual({ path: 'wiki/index.md', kind: null, ws: null, fragment: null });
    expect(deeplink.read('?open=', '')).toEqual({ path: '', kind: null, ws: null, fragment: null });
    expect(deeplink.read('', '#x')).toBeNull();
    expect(deeplink.read('?open=../../etc/passwd', '')).toBeNull();
  });

  it('writes them back the same way', () => {
    const link = { path: 'raw/docs/a b.md', kind: 'team', ws: 'Knode Labs', fragment: 'e-1f2e' };
    const href = deeplink.href('https://knode-os.lemoncheese.cc/', link);
    expect(href).toBe('https://knode-os.lemoncheese.cc/?open=raw%2Fdocs%2Fa+b.md&kind=team&ws=Knode+Labs#e-1f2e');
    const url = new URL(href);
    expect(deeplink.read(url.search, url.hash)).toEqual(link);
    expect(deeplink.href('', { path: 'wiki/index.md' })).toBe('/?open=wiki%2Findex.md');
  });

  it('finds the workspace a link names: a personal one by id, a Team by id, name, code or slug', () => {
    const workspaces = [
      { id: 'default', name: 'Default', kind: 'personal' },
      { id: 'finance', name: 'Finance', kind: 'personal' },
      { id: 'team-knode-labs', name: 'Knode Labs', kind: 'team', code: 'KNODE-LABS' },
      { id: 'team-finance', name: 'Finance', kind: 'team', slug: 'finance' },
    ];
    expect(deeplink.pick({ kind: 'personal', ws: 'finance' }, workspaces)?.id).toBe('finance');
    expect(deeplink.pick({ kind: 'personal', ws: 'Finance' }, workspaces)?.id).toBe('finance');
    expect(deeplink.pick({ kind: 'team', ws: 'finance' }, workspaces)?.id).toBe('team-finance');
    for (const ws of ['Knode Labs', 'knode-labs', 'team-knode-labs', 'KNODE-LABS']) expect(deeplink.pick({ kind: 'team', ws }, workspaces)?.id, ws).toBe('team-knode-labs');
    expect(deeplink.pick({ kind: 'personal', ws: 'Knode Labs' }, workspaces)).toBeNull();
    expect(deeplink.pick({ kind: 'personal', ws: 'research' }, workspaces)).toBeNull();
    expect(deeplink.pick({ kind: null, ws: null }, workspaces)).toBeNull();
  });
});

describe('frontmatter for a listing (src/markdown.ts)', () => {
  it('reads a head, and leaves a list or a map out of the text fields', () => {
    expect(markdownMeta('---\ntitle: T\ndate: 2026-10-27\ntags: one\nverdict: [a, b]\n---\nbody')).toEqual({ title: 'T', date: '2026-10-27', tags: ['one'] });
    expect(markdownMeta('---\ntitle: [\n---\n# Heading')).toEqual({ title: 'Heading' });
    expect(markdownMeta('plain text')).toBeNull();
  });
});

describe('the SDK (web/embed/sdk.js)', () => {
  const BASE = 'https://knode-os.lemoncheese.cc';

  it('builds the reader\'s address and the full UI\'s', () => {
    expect(embedUrl({ baseUrl: `${BASE}/some/path`, view: 'doc', path: 'raw/docs/x.md', workspace: { kind: 'personal', id: 'finance' }, theme: 'dark', origin: 'http://localhost:12310', fragment: 'e-1' }))
      .toBe(`${BASE}/embed/v1?view=doc&path=raw%2Fdocs%2Fx.md&kind=personal&ws=finance&theme=dark&origin=http%3A%2F%2Flocalhost%3A12310#e-1`);
    expect(embedUrl({ baseUrl: BASE, view: 'search', q: 'momentum', scope: 'raw/docs', path: 'ignored.md' })).toBe(`${BASE}/embed/v1?view=search&q=momentum&scope=raw%2Fdocs`);
    expect(() => embedUrl({ baseUrl: BASE, view: 'graph' })).toThrow(/view/);
    expect(() => embedUrl({ baseUrl: 'knode-os.lemoncheese.cc' })).toThrow(/baseUrl/);
    expect(deepLink({ baseUrl: BASE, path: 'raw/docs/x.md', workspace: { kind: 'team', id: 'finance' }, fragment: 'e-1' })).toBe(`${BASE}/?open=raw%2Fdocs%2Fx.md&kind=team&ws=finance#e-1`);
  });

  /** Just enough of a page for mount(): elements that record what is done to them, a window that dispatches messages. */
  function fakePage() {
    const listeners = new Set<(event: unknown) => void>();
    const posted: { msg: Record<string, unknown>; target: string }[] = [];
    const element = (tag: string) => ({
      tag, style: {} as Record<string, string>, children: [] as unknown[], removed: false,
      contentWindow: tag === 'iframe' ? { postMessage: (msg: Record<string, unknown>, target: string) => posted.push({ msg, target }) } : undefined,
      append(...nodes: unknown[]) { this.children.push(...nodes); },
      appendChild(node: unknown) { this.children.push(node); return node; },
      setAttribute() {},
      remove() { this.removed = true; },
    });
    const win = {
      location: { origin: 'http://localhost:12310' },
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      addEventListener: (_: string, fn: (event: unknown) => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: (event: unknown) => void) => listeners.delete(fn),
    };
    const doc = { defaultView: win, createElement: element, createTextNode: (text: string) => ({ text }) };
    const container = { ...element('div'), ownerDocument: doc };
    const dispatch = (event: unknown) => { for (const fn of [...listeners]) fn(event); };
    return { container, posted, listeners, dispatch };
  }

  it('mounts the frame, sends the host\'s look and queued moves once it is ready, and sizes it to the content', () => {
    vi.useFakeTimers();
    try {
      const page = fakePage();
      const events: unknown[] = [];
      const embed = mount(page.container, {
        baseUrl: BASE, view: 'doc', path: 'raw/docs/x.md', workspace: { kind: 'personal', id: 'finance' }, theme: 'light', tokens: { background: '#fff' },
        minHeight: 300, maxHeight: 900,
        onReady: (p: unknown) => events.push(['ready', p]), onNavigate: (p: unknown) => events.push(['navigate', p]),
        onAuth: (p: unknown) => events.push(['auth', p]), onError: (p: unknown) => events.push(['error', p]),
      });
      const iframe = embed.iframe;
      expect(iframe.src).toBe(`${BASE}/embed/v1?view=doc&path=raw%2Fdocs%2Fx.md&kind=personal&ws=finance&theme=light&origin=http%3A%2F%2Flocalhost%3A12310`);
      expect(iframe.style.height).toBe('300px');
      embed.navigate({ view: 'folder', path: 'raw/docs' });
      expect(() => embed.navigate({ view: 'graph' })).toThrow(/view/);
      expect(page.posted).toEqual([]);

      const from = (data: unknown, overrides: Record<string, unknown> = {}) => page.dispatch({ source: iframe.contentWindow, origin: BASE, data, ...overrides });
      // not from the frame, not from its origin, not the protocol: nothing happens
      from({ source: 'knode-embed', version: 1, type: 'ready' }, { origin: 'https://evil.example' });
      from({ source: 'knode-embed', version: 1, type: 'ready' }, { source: {} });
      from({ source: 'knode-embed', version: 2, type: 'ready' });
      from('ready');
      expect(embed.ready).toBe(false);

      from({ source: 'knode-embed', version: 1, type: 'ready', view: 'doc', path: 'raw/docs/x.md' });
      expect(embed.ready).toBe(true);
      expect(page.posted).toEqual([
        { msg: { source: 'knode-host', version: 1, type: 'theme', theme: 'light', tokens: { background: '#fff' } }, target: BASE },
        { msg: { source: 'knode-host', version: 1, type: 'navigate', view: 'folder', path: 'raw/docs' }, target: BASE },
      ]);
      from({ source: 'knode-embed', version: 1, type: 'resize', height: 1234.2 });
      expect(iframe.style.height).toBe('900px');
      from({ source: 'knode-embed', version: 1, type: 'resize', height: 120 });
      expect(iframe.style.height).toBe('300px');
      from({ source: 'knode-embed', version: 1, type: 'resize', height: 480.5 });
      expect(iframe.style.height).toBe('481px');
      from({ source: 'knode-embed', version: 1, type: 'auth', state: 'signed-in' });
      from({ source: 'knode-embed', version: 1, type: 'navigate', view: 'doc', path: 'raw/docs/y.md', title: 'Y' });
      embed.setTheme('dark');
      expect(page.posted.at(-1)?.msg).toEqual({ source: 'knode-host', version: 1, type: 'theme', theme: 'dark' });
      expect(events).toEqual([
        ['ready', { view: 'doc', path: 'raw/docs/x.md' }],
        ['auth', { state: 'signed-in' }],
        ['navigate', { view: 'doc', path: 'raw/docs/y.md', title: 'Y' }],
      ]);
      vi.advanceTimersByTime(10_000);
      expect(events).toHaveLength(3);

      embed.destroy();
      expect(page.listeners.size).toBe(0);
      expect(iframe.removed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives way to a link into knode-os when the frame never says it is ready', () => {
    vi.useFakeTimers();
    try {
      const page = fakePage();
      const errors: unknown[] = [];
      const embed = mount(page.container, { baseUrl: BASE, view: 'doc', path: 'raw/docs/x.md', workspace: { kind: 'personal', id: 'finance' }, fragment: 'e-1', onError: (e: unknown) => errors.push(e) });
      vi.advanceTimersByTime(7_999);
      expect(errors).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(errors).toEqual([expect.objectContaining({ code: 'unavailable' })]);
      expect(embed.iframe.style.display).toBe('none');
      const fallback = page.container.children.at(-1) as { className: string; children: { href?: string }[] };
      expect(fallback.className).toBe('knode-embed-fallback');
      expect(fallback.children.find((c) => c.href)?.href).toBe(`${BASE}/?open=raw%2Fdocs%2Fx.md&kind=personal&ws=finance#e-1`);
      // a frame that was only slow still takes over
      page.dispatch({ source: embed.iframe.contentWindow, origin: BASE, data: { source: 'knode-embed', version: 1, type: 'ready', view: 'doc', path: 'raw/docs/x.md' } });
      expect(embed.iframe.style.display).toBe('block');
      embed.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
