import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, saveConfig } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { readSidecarPart } from '../src/fs/sidecar.js';
import { openZip, ZipError } from '../src/fs/zip.js';
import { conversionCacheKey, convertDocumentToMarkdown, isConvertibleFile, maxConvertibleBytes } from '../src/ingest/convert.js';
import { entryHref, splitBookPath } from '../src/ingest/converters/epub.js';
import { runIngest } from '../src/ingest/pipeline.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';
import { epub, PIXEL_PNG, zip } from './helpers/epub.js';

/**
 * EPUB books (src/ingest/converters/epub.ts over src/fs/zip.ts): the chapters
 * in reading order as one Markdown text, titled and leveled by the table of
 * contents, notes as footnotes, pictures by their path inside the book — and
 * those pictures served from inside it (src/server/originals.ts).
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-epub-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const write = (name: string, bytes: Buffer) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, bytes);
  return file;
};

const body = (markdown: string) => markdown.replace(/^---\n[\s\S]*?\n---\n/, '').trim();

describe('zip reader', () => {
  it('reads stored and deflated entries, by name or by the same name in another case', () => {
    const file = write('a.zip', zip([
      { name: 'mimetype', data: 'application/epub+zip', store: true },
      { name: 'OEBPS/Text/Ch1.xhtml', data: '<p>hello</p>'.repeat(100) },
      { name: '图片/封面.png', data: PIXEL_PNG },
    ]));
    const archive = openZip(file);
    try {
      expect(archive.recovered).toBe(false);
      expect([...archive.entries.keys()]).toEqual(['mimetype', 'OEBPS/Text/Ch1.xhtml', '图片/封面.png']);
      expect(archive.read('mimetype').toString()).toBe('application/epub+zip');
      expect(archive.read('oebps/text/ch1.xhtml').toString()).toBe('<p>hello</p>'.repeat(100));
      expect(archive.read('图片/封面.png').equals(PIXEL_PNG)).toBe(true);
      expect(() => archive.read('missing.txt')).toThrow(ZipError);
    } finally {
      archive.close();
    }
  });

  it('reads an archive whose directory was cut off from its local headers, and says so', () => {
    const whole = zip([{ name: 'a.txt', data: 'first' }, { name: 'b.txt', data: 'second' }], { directory: false });
    const archive = openZip(write('cut.zip', whole));
    try {
      expect(archive.recovered).toBe(true);
      expect(archive.read('b.txt').toString()).toBe('second');
    } finally {
      archive.close();
    }
  });

  it('refuses what is no zip, and stops inflating at the cap', () => {
    expect(() => openZip(write('not.zip', Buffer.from('%PDF-1.4 not a zip')))).toThrow(/not a zip/);
    const bomb = zip([{ name: 'zeros', data: Buffer.alloc(2 * 1024 * 1024) }]);
    const archive = openZip(write('bomb.zip', bomb));
    try {
      expect(() => archive.read('zeros', 1024)).toThrow(/larger than 1024 bytes/);
    } finally {
      archive.close();
    }
  });
});

describe('EPUB conversion', () => {
  const EPUB3 = epub({
    metadata: `<dc:title>The Quiet Engine</dc:title>
<dc:creator id="a1">Ada Writer</dc:creator><meta refines="#a1" property="role" scheme="marc:relators">aut</meta>
<dc:creator id="t1">Tom Translator</dc:creator><meta refines="#t1" property="role" scheme="marc:relators">trl</meta>
<dc:language>en-US</dc:language><dc:publisher>Small Press</dc:publisher><dc:date>2019-04-30T00:00:00+00:00</dc:date>
<dc:identifier>urn:isbn:978-0-306-40615-7</dc:identifier><dc:subject>Engineering</dc:subject><dc:subject>Essays</dc:subject>
<dc:description>&lt;p&gt;A book about engines.&lt;/p&gt;&lt;p&gt;And quiet.&lt;/p&gt;</dc:description>`,
    nav: `<ol>
<li><a href="toc.xhtml">Contents</a></li>
<li><a href="part1.xhtml">Part One: Steam</a><ol>
  <li><a href="Text/ch1.xhtml">The First Boiler</a></li>
  <li><a href="Text/ch2.xhtml">Pressure</a><ol><li><a href="Text/ch2.xhtml#valves">Valves</a></li></ol></li>
</ol></li></ol>`,
    chapters: [
      { file: 'cover.xhtml', body: '<div><svg xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="images/cover%20art.png"/></svg></div>' },
      {
        file: 'toc.xhtml',
        body: '<h1>Contents</h1><p><a href="part1.xhtml">Part One</a></p><p><a href="Text/ch1.xhtml">The First Boiler</a></p><p><a href="Text/ch2.xhtml">Pressure</a></p><p><a href="Text/ch2.xhtml#valves">Valves</a></p><p><a href="Text/ch3.xhtml">Notes</a></p>',
      },
      { file: 'part1.xhtml', body: '<p class="part-title">Part One: Steam</p>' },
      {
        file: 'Text/ch1.xhtml',
        body: `<section><p>Every engine starts cold.<a epub:type="noteref" href="#fn1"><sup>1</sup></a> See <a href="ch2.xhtml#valves">the valves</a> and <a href="https://example.com/steam">a museum</a>.</p>
<h2>Fire</h2><p>Coal burns.</p>
<figure><img src="../images/fig%20(1).png" alt="image"/><figcaption>The boiler, 1890.</figcaption></figure>
<span epub:type="pagebreak" id="p2" title="2">2</span>
<aside epub:type="footnote" id="fn1"><p><a href="#ref1">1</a> Engines were often warm in summer.</p></aside>
<nav epub:type="landmarks"><a href="ch2.xhtml">skip</a></nav>
<p style="visibility: hidden"><a href="#fn1"> </a></p></section>`,
      },
      {
        file: 'Text/ch2.xhtml',
        body: `<h1>2</h1><h1>Pressure</h1><p>Steam pushes.</p><a id="valves"></a><p>A valve lets it out.</p>
<aside><p class="sidebar">Sidebar: a safety valve saved the town.</p></aside>`,
      },
    ],
    extra: [
      { file: 'images/cover art.png', data: PIXEL_PNG, mediaType: 'image/png', properties: 'cover-image' },
      { file: 'images/fig (1).png', data: PIXEL_PNG, mediaType: 'image/png' },
    ],
  });

  it('reads what the book says it is into the frontmatter', async () => {
    const result = await convertDocumentToMarkdown(write('engine.epub', EPUB3), 'raw/docs/books/engine.epub');
    expect(result.kind).toBe('epub');
    const fm = /^---\n([\s\S]*?)\n---/.exec(result.markdown)![1];
    expect(fm).toContain('title: "The Quiet Engine"');
    expect(fm).toContain('source_type: "epub"');
    expect(fm).toContain('author: "Ada Writer"');
    expect(fm).not.toContain('Tom Translator');
    expect(fm).toContain('lang: "en"');
    expect(fm).toContain('published: "2019-04-30"');
    expect(fm).toContain('publisher: "Small Press"');
    expect(fm).toContain('isbn: "9780306406157"');
    expect(fm).toContain('subject: "Engineering, Essays"');
    expect(fm).toContain('description: "A book about engines. And quiet."');
  });

  it('writes the chapters in reading order, titled and leveled by the table of contents', async () => {
    const md = body((await convertDocumentToMarkdown(write('engine2.epub', EPUB3), 'raw/docs/books/engine.epub')).markdown);
    const headings = md.split('\n').filter((l) => /^#{1,6} /.test(l));
    // the part page's title line becomes its heading; the chapter without one gets its entry's;
    // "2" / "Pressure" are one heading; the anchor mid-chapter gets its entry as a heading at its depth
    expect(headings).toEqual(['# Part One: Steam', '## The First Boiler', '### Fire', '## 2. Pressure', '### Valves']);
    // the printed table of contents is left out, the cover kept, and chapters come in spine order
    expect(md).not.toContain('Contents');
    expect(md.indexOf('![](OEBPS/images/cover%20art.png)')).toBe(0);
    expect(md.indexOf('Every engine')).toBeLessThan(md.indexOf('Steam pushes'));
    // nothing in a book is chrome: an aside, a "sidebar", stays
    expect(md).toContain('Sidebar: a safety valve saved the town.');
  });

  it('turns a note the chapter points at into a footnote, links into the book into words, pictures into paths inside it', async () => {
    const md = body((await convertDocumentToMarkdown(write('engine3.epub', EPUB3), 'raw/docs/books/engine.epub')).markdown);
    expect(md).toContain('Every engine starts cold.[^4.1] See the valves and [a museum](https://example.com/steam).');
    expect(md).toContain('[^4.1]: Engines were often warm in summer.');
    expect(md.match(/\[\^4\.1\]/g)).toHaveLength(2); // one marker, one note: the hidden run of links marks nothing
    // a picture keeps its path in the book (from the book's root), escaped; "image" says nothing and is dropped as alt text
    expect(md).toContain('![](OEBPS/images/fig%20%281%29.png)');
    expect(md).toContain('*The boiler, 1890.*');
    // printed page numbers and landmarks are not the text
    expect(md).not.toMatch(/^2$/m);
    expect(md).not.toContain('skip');
  });

  it('reads an EPUB 2 book: NCX contents, a calibre footnote with its back-link, a cover kept outside the reading order', async () => {
    const book = epub({
      metadata: '<dc:title>老书</dc:title><dc:creator opf:role="aut">作者</dc:creator><dc:language>Chinese</dc:language><dc:date>0101-01-01T00:00:00+00:00</dc:date>',
      ncx: `<navPoint id="n1" playOrder="1"><navLabel><text>第一章 起源</text></navLabel><content src="text/part0001.html"/></navPoint>
<navPoint id="n2" playOrder="2"><navLabel><text>第二章 远方</text></navLabel><content src="text/part0002.html#ch2"/></navPoint>`,
      chapters: [
        { file: 'text/part0001.html', body: '<p class="c1"><b>第</b><b>一</b><b>章</b> 起源</p><p>很久以前<a id="r1" href="part0001.html#n1"><sup>[1]</sup></a>。</p><p id="n1"><a href="part0001.html#r1">[1]</a> 一个注释。</p>' },
        { file: 'text/part0002.html', body: '<p>上一章的结尾。</p><div id="ch2"><p>远方的故事。</p></div>' },
      ],
      extra: [{ file: 'images/cover.jpg', data: PIXEL_PNG, mediaType: 'image/jpeg' }],
      coverId: 'x0',
    });
    const result = await convertDocumentToMarkdown(write('old.epub', book), 'raw/docs/old.epub');
    const fm = /^---\n([\s\S]*?)\n---/.exec(result.markdown)![1];
    expect(fm).toContain('lang: "zh"');
    expect(fm).not.toContain('published'); // calibre's "unknown" date
    const md = body(result.markdown);
    expect(md).toMatch(/^!\[老书\]\(OEBPS\/images\/cover\.jpg\)/);
    expect(md).toContain('# 第一章 起源');
    expect(md).toContain('很久以前[^1.1]。');
    expect(md).toContain('[^1.1]: 一个注释。');
    expect(md).toMatch(/上一章的结尾。\n\n# 第二章 远方\n\n远方的故事。/);
  });

  it('reads a book whose zip was cut off before its directory, and says so', async () => {
    const book = epub({ chapters: [{ file: 'a.xhtml', body: '<h1>One</h1><p>Recovered text.</p>' }], directory: false });
    const result = await convertDocumentToMarkdown(write('cut.epub', book), 'raw/docs/cut.epub');
    expect(body(result.markdown)).toContain('Recovered text.');
    expect(result.warnings.join(' ')).toMatch(/zip directory is missing or damaged/);
  });

  it('refuses a DRM-protected book by name, and reads one whose fonts alone are obfuscated', async () => {
    const drm = epub({ chapters: [{ file: 'a.xhtml', body: '<p>secret</p>' }], encrypted: ['OEBPS/a.xhtml'] });
    await expect(convertDocumentToMarkdown(write('drm.epub', drm), 'raw/docs/drm.epub')).rejects.toThrow(/DRM-protected/);
    const fonts = epub({ chapters: [{ file: 'a.xhtml', body: '<p>open text</p>' }], encrypted: ['OEBPS/fonts/a.ttf'] });
    expect((await convertDocumentToMarkdown(write('fonts.epub', fonts), 'raw/docs/fonts.epub')).markdown).toContain('open text');
    await expect(convertDocumentToMarkdown(write('broken.epub', Buffer.from('nope')), 'raw/docs/broken.epub')).rejects.toThrow(/not a readable EPUB/);
  });

  it('is a convertible type of its own: a larger cap than other originals, no vision model in its key', () => {
    expect(isConvertibleFile('raw/docs/x.EPUB')).toBe(true);
    expect(maxConvertibleBytes('raw/docs/x.epub')).toBeGreaterThan(maxConvertibleBytes('raw/docs/x.pdf'));
    const key = conversionCacheKey({ vision: { enabled: true, label: 'some-vision', complete: async () => '' } }, 'raw/docs/x.epub');
    expect(key.startsWith('epub@1|no-vision|')).toBe(true);
  });

  it('names a path through a book, and escapes an entry as a link target', () => {
    expect(splitBookPath('raw/docs/a b.epub/OEBPS/i/x.png')).toEqual({ book: 'raw/docs/a b.epub', entry: 'OEBPS/i/x.png' });
    expect(splitBookPath('raw/docs/a.epub/../../x.png')).toBeNull();
    expect(splitBookPath('raw/docs/a.pdf')).toBeNull();
    expect(entryHref('OEBPS/图 (1).png')).toBe('OEBPS/%E5%9B%BE%20%281%29.png');
  });
});

describe('a book in a workspace', () => {
  const root = path.join(tmp, 'served');
  const workspaceDir = path.join(root, 'users', 'admin', 'workspaces', 'default');
  const headers = { 'x-knode-user': 'admin', 'x-knode-workspace-kind': 'personal', 'x-knode-workspace-id': 'default', 'x-knode-workspace-name': 'Default' };
  const book = epub({
    metadata: '<dc:title>Field Notes</dc:title>',
    nav: '<ol><li><a href="ch1.xhtml">Birds</a></li></ol>',
    chapters: [{ file: 'ch1.xhtml', body: '<p>The heron waits at the water.</p><p><img src="img/heron.png" alt="A heron"/></p>' }],
    extra: [{ file: 'img/heron.png', data: PIXEL_PNG, mediaType: 'image/png' }],
  });
  let rootCtx: AppContext;
  let registry: WorkspaceContextRegistry;
  let app: ReturnType<typeof createApp>;
  const original = (rel: string) => app.request(`/api/file/original?path=${encodeURIComponent(rel)}`, { headers });

  beforeAll(async () => {
    rootCtx = await createContext(root);
    registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
    app = createApp(rootCtx, () => {}, registry);
    await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
    fs.mkdirSync(path.join(workspaceDir, 'raw/docs/books'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'raw/docs/books/field notes.epub'), book);
  });

  afterAll(async () => {
    await registry.closeAll();
    await rootCtx.store.close();
  });

  it('sends the book as a download and a picture from inside it as itself', async () => {
    const res = await original('raw/docs/books/field notes.epub');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/epub+zip');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(Buffer.from(await res.arrayBuffer()).equals(book)).toBe(true);

    const picture = await original('raw/docs/books/field notes.epub/OEBPS/img/heron.png');
    expect(picture.status).toBe(200);
    expect(picture.headers.get('content-type')).toBe('image/png');
    expect(picture.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await picture.arrayBuffer()).equals(PIXEL_PNG)).toBe(true);
  });

  it('hands out pictures only: never a chapter, nothing missing, nothing out of the book', async () => {
    expect((await original('raw/docs/books/field notes.epub/OEBPS/ch1.xhtml')).status).toBe(404);
    expect((await original('raw/docs/books/field notes.epub/OEBPS/img/none.png')).status).toBe(404);
    expect((await original('raw/docs/books/none.epub/OEBPS/img/heron.png')).status).toBe(404);
    expect((await original('raw/docs/books/field notes.epub/../../../knode.config.json')).status).not.toBe(200);
  });

  it('is converted and indexed by a sync, its text searchable', async () => {
    const dataDir = path.join(tmp, 'ingest-workspace');
    initDataDir(dataDir);
    saveConfig(dataDir, defaultConfig());
    fs.writeFileSync(path.join(dataDir, 'raw/docs/field notes.epub'), book);
    const ctx = await createContext(dataDir);
    try {
      const stats = await runIngest(ctx.store, ctx.config, ctx.embedder, ctx.llm, { llmGraph: false });
      expect(stats.errors).toBe(0);
      const [doc] = await ctx.store.query<{ status: string }>(`SELECT status FROM documents WHERE path = 'raw/docs/field notes.epub'`);
      expect(doc?.status).toBe('indexed');
      const [chunk] = await ctx.store.query<{ content: string }>(
        `SELECT c.content FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = 'raw/docs/field notes.epub' LIMIT 1`,
      );
      expect(chunk.content).toContain('The heron waits at the water.');
      expect(readSidecarPart(dataDir, 'raw/docs/field notes.epub', 'meta')?.conversion?.kind).toBe('epub');
    } finally {
      await ctx.store.close();
    }
  }, 30_000);
});

