import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { createApp } from '../src/server/app.js';
import { API_CSP, UI_CSP } from '../src/server/csp.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';

/**
 * The web UI renders Markdown that people, imported folders and agents wrote.
 * web/markdown.js has to turn it into formatting only — no raw HTML, no
 * script-bearing link — and the page has to run under a policy that would
 * keep anything that slipped through inert.
 */

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

/** Load marked and web/markdown.js the way the page does: plain scripts sharing one global. */
function loadRenderer(): { render: (md: string) => string; safeUrl: (url: string, opts?: { image?: boolean }) => string | null } {
  const require = createRequire(import.meta.url);
  const markedUmd = path.join(path.dirname(require.resolve('marked')), 'marked.umd.js');
  const page = vm.createContext({});
  vm.runInContext(fs.readFileSync(markedUmd, 'utf8'), page);
  vm.runInContext(fs.readFileSync(path.join(webDir, 'markdown.js'), 'utf8'), page);
  return (page as { knodeMarkdown: ReturnType<typeof loadRenderer> }).knodeMarkdown;
}

describe('Markdown rendering (web/markdown.js)', () => {
  const md = loadRenderer();
  /** Elements and attributes the output may contain at all. */
  const tags = (html: string) => [...html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)].map((m) => ({ tag: m[1].toLowerCase(), attrs: m[2] }));

  it('shows raw HTML as the text it was written as, wherever it appears', () => {
    const payloads = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<pre><img/src=x onerror=alert(1)></pre>',
      'inline <kbd><img/src=x onerror=alert(1)></kbd> too',
      '<div>\n<iframe src="javascript:alert(1)"></iframe>\n</div>',
      '<a href="x" onclick="alert(1)">x</a>',
      '<svg><script>alert(1)</script></svg>',
      '<style>body{display:none}</style>',
      '| a |\n|---|\n| <img src=x onerror=alert(1)> |',
    ];
    for (const payload of payloads) {
      const html = md.render(payload);
      for (const { tag, attrs } of tags(html)) {
        expect(['p', 'table', 'thead', 'tbody', 'tr', 'th', 'td']).toContain(tag);
        expect(attrs).not.toMatch(/\bon[a-z]+\s*=/i);
      }
      expect(html).not.toMatch(/<(script|img|iframe|svg|style|a)\b/i);
    }
    expect(md.render('<script>alert(1)</script>')).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('keeps a link only when its target cannot run code', () => {
    const blocked = [
      '[x](javascript:alert(1))',
      '[x](JaVaScRiPt:alert(1))',
      '[x](<java\tscript:alert(1)>)',
      '[x](  javascript:alert(1))',
      '[x](vbscript:msgbox(1))',
      '[x](data:text/html,<script>alert(1)</script>)',
      '[x][r]\n\n[r]: javascript:alert(1)',
      '![x](javascript:alert(1))',
      '![x](data:image/svg+xml;base64,PHN2Zz4=)',
    ];
    // what is left is the label, as text
    for (const payload of blocked) expect(md.render(payload)).toBe('<p>x</p>\n');
    expect(md.render('<javascript:alert(1)>')).toBe('<p>javascript:alert(1)</p>\n');
    // an entity cannot smuggle a scheme in: the href is escaped, so the browser reads the entity as text
    for (const payload of ['[x](&#106;avascript:alert(1))', '[x](javascript&colon;alert(1))']) {
      const href = /href="([^"]*)"/.exec(md.render(payload))?.[1] ?? '';
      expect(href.startsWith('&amp;') || href.includes('&amp;colon;')).toBe(true);
    }
    expect(md.safeUrl('java\nscript:alert(1)')).toBeNull();
    expect(md.safeUrl('\u0001javascript:alert(1)')).toBeNull();
    expect(md.safeUrl('data:image/png;base64,AAAA', { image: true })).toBe('data:image/png;base64,AAAA');
  });

  it('still renders documents: links, images, code, tables, task lists and wikilinks', () => {
    const html = md.render([
      '# Title',
      '',
      '[rel](notes/x.md) [frag](#h) [mail](mailto:a@b.c) [web](https://example.com/?a=1&b=2 "it\'s") www.example.com',
      '',
      '![chart](https://example.com/c.png) ![inline](data:image/png;base64,AAAA)',
      '',
      '```html\n<b>code</b>\n```',
      '',
      '| a | b |\n|---|:-:|\n| `<i>` | y |',
      '',
      '- [x] done',
      '',
      '[[folder/note|the note]] and [[a"b]]',
    ].join('\n'));
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<a href="notes/x.md">rel</a>');
    expect(html).toContain('<a href="#h">frag</a>');
    expect(html).toContain('<a href="mailto:a@b.c">mail</a>');
    expect(html).toContain('<a href="https://example.com/?a=1&amp;b=2" title="it&#39;s">web</a>');
    expect(html).toContain('<a href="http://www.example.com">www.example.com</a>');
    expect(html).toContain('<img src="https://example.com/c.png" alt="chart">');
    expect(html).toContain('<img src="data:image/png;base64,AAAA" alt="inline">');
    expect(html).toContain('<pre><code class="language-html">&lt;b&gt;code&lt;/b&gt;');
    expect(html).toContain('<th align="center">b</th>');
    expect(html).toContain('<code>&lt;i&gt;</code>');
    expect(html).toContain('<input checked="" disabled="" type="checkbox">');
    expect(html).toContain('<a class="wikilink" href="#" data-wikilink="folder/note">the note</a>');
    expect(html).toContain('data-wikilink="a&quot;b"');
  });

  it('is what every Markdown view in the UI renders through', () => {
    const app = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');
    expect(app).not.toMatch(/marked\.(parse|use)\b/);
    expect(app).toMatch(/window\.knodeMarkdown\.render\(/);
  });
});

describe('the page policy', () => {
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');

  it('needs nothing the policy forbids: no inline script, style or handler', () => {
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      expect(m[1]).toMatch(/\bsrc="\/[^"]+"/);
      expect(m[2].trim()).toBe('');
    }
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    // the renderer loads after marked and before the app that calls it
    const order = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['/vendor/marked.js', '/markdown.js', '/vendor/d3.js', '/graph.js', '/app.js']);
    const app = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');
    expect(app).not.toMatch(/\sstyle="|\son(click|error|load|change|input)="/);
  });

  it('runs only this server\'s scripts', () => {
    const directives = new Map(UI_CSP.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('style-src')).toEqual(["'self'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(UI_CSP).not.toMatch(/unsafe-(inline|eval)/);
  });

  describe('served with sign-in off', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-web-security-'));
    let rootCtx: AppContext;
    let registry: WorkspaceContextRegistry;
    let app: ReturnType<typeof createApp>;

    beforeAll(async () => {
      rootCtx = await createContext(path.join(tmp, 'data'));
      registry = new WorkspaceContextRegistry(rootCtx.dataDir, { templateConfig: rootCtx.config });
      app = createApp(rootCtx, () => {}, registry);
    });

    afterAll(async () => {
      await registry.closeAll();
      await rootCtx.store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('sends the page, the renderer and the app with the policy and the other hardening headers', async () => {
      const page = await app.request('/');
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toMatch(/text\/html/);
      expect(page.headers.get('content-security-policy')).toBe(UI_CSP);
      expect(page.headers.get('x-content-type-options')).toBe('nosniff');
      expect(page.headers.get('x-frame-options')).toBe('DENY');
      // an unknown path is the app too
      expect((await app.request('/files/some/deep/link')).headers.get('content-security-policy')).toBe(UI_CSP);

      const script = await app.request('/markdown.js');
      expect(script.status).toBe(200);
      expect(script.headers.get('content-type')).toBe('text/javascript');
      expect(await script.text()).toContain('knodeMarkdown');
      expect(script.headers.get('content-security-policy')).toBe(API_CSP);
    });
  });
});
