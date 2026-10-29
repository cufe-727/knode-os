import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultConfig, saveConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { readSidecarPart } from '../src/fs/sidecar.js';
import { loadOntology } from '../src/graph/ontology.js';
import { mindMapTranscription } from '../src/ingest/converters/image.js';
import { MINDMAP_MARK } from '../src/ingest/converters/shared.js';
import { originalOfTranscript, transcriptPathFor, transcriptToMarkdown } from '../src/ingest/convert.js';
import { prepareDocs } from '../src/ingest/prepare.js';
import { runIngest } from '../src/ingest/pipeline.js';
import { sync } from '../src/ingest/sync.js';
import { edgeFor, MINDMAP_PLAN_VERSION, NodeEntity, planMindMapGraph } from '../src/mindmap/graph.js';
import { escapeLabel, isMindMapFrontmatter, labelParts, mindMapChunks, parseMindMap, serializeMindMap, walkMindMap } from '../src/mindmap/outline.js';

/**
 * Mind maps (docs/design/19-mind-maps.md): one outline form, read the same
 * by chunking, the tier-0 graph and the web view; a picture converted into
 * it; a reviewed transcript beside the picture read in its place.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-mindmap-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const HUAWEI = `# 华为

- 华为智驾
  - 整车
    - **赛力斯（核心）**
      - 问界
    - 北汽蓝谷
      - 享界
  - 液冷超充
    - 永贵电器（液冷充电枪）
- 华为算力
  - 散热
    - 液冷管路
      - 川环科技
        - 实锤独供
`;

const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

describe('reading an outline', () => {
  it('reads the H1 as the root and each bullet as a node under its parent', () => {
    const map = parseMindMap(HUAWEI)!;
    expect(map.root.text).toBe('华为');
    expect(map.size).toBe(14);
    expect(map.depth).toBe(5);
    expect(map.root.children.map((c) => c.text)).toEqual(['华为智驾', '华为算力']);
    const seres = map.root.children[0].children[0].children[0];
    expect(seres).toMatchObject({ id: '1.1.1', depth: 3, text: '赛力斯（核心）', name: '赛力斯', note: '核心', strong: true });
    expect(seres.children[0].text).toBe('问界');
  });

  it('keeps numbering as part of a label, and splits off a trailing note', () => {
    const map = parseMindMap('# 情绪\n\n- 冰点期\n  - 特征\n    - 1. 市场整体情绪极弱\n      - a. 下跌家数是近期最多\n    - 2\\. 杀跌动能减弱\n')!;
    const traits = map.root.children[0].children[0];
    expect(traits.children.map((c) => c.text)).toEqual(['1. 市场整体情绪极弱', '2. 杀跌动能减弱']);
    expect(traits.children[0].name).toBe('市场整体情绪极弱');
    expect(traits.children[0].children[0].name).toBe('下跌家数是近期最多');
  });

  it('splits names from notes the way a map writes them', () => {
    expect(labelParts('钢研高纳（高温合金平台类企业）')).toEqual({ name: '钢研高纳', note: '高温合金平台类企业' });
    expect(labelParts('菲菱科思（30%份额，代工）')).toEqual({ name: '菲菱科思', note: '30%份额，代工' });
    // an unclosed note runs to the end
    expect(labelParts('神火股份（产能855万吨/年')).toEqual({ name: '神火股份', note: '产能855万吨/年' });
    expect(labelParts('A（B）C（D）')).toEqual({ name: 'A（B）C', note: 'D' });
    expect(labelParts('AI眼镜类SOC')).toEqual({ name: 'AI眼镜类SOC', note: null });
    expect(labelParts('（龙头）')).toEqual({ name: '（龙头）', note: null });
  });

  it('reads headings below the H1 as nodes, and promotes a lone top-level item to the root', () => {
    const fromHeadings = parseMindMap('# 根\n\n## 甲\n\n- 甲一\n- 甲二\n\n## 乙\n\n### 乙一\n\n- 乙一一\n')!;
    expect(fromHeadings.root.children.map((c) => c.text)).toEqual(['甲', '乙']);
    expect(fromHeadings.root.children[0].children.map((c) => c.text)).toEqual(['甲一', '甲二']);
    expect(fromHeadings.root.children[1].children[0].children[0].text).toBe('乙一一');

    const lone = parseMindMap('- deepseek\n\t- 算力\n\t\t- 芯片\n')!;
    expect(lone.root.text).toBe('deepseek');
    expect(lone.root.depth).toBe(0);
    expect(lone.root.children[0].children[0]).toMatchObject({ text: '芯片', depth: 2, id: '1.1' });
  });

  it('holds no tree without a node below the root', () => {
    expect(parseMindMap('# only a title\n\nsome prose')).toBeNull();
    expect(parseMindMap('')).toBeNull();
  });

  it('writes the canonical outline back so it reads as itself', () => {
    const map = parseMindMap('# 根 *1*\n\n- 1. 第一\n  - # 不是标题\n  - **[强调]**\n- a_b`c`\n')!;
    const text = serializeMindMap(map);
    expect(text).toContain('- 1\\. 第一');
    expect(text).toContain('  - \\# 不是标题');
    expect(text).toContain('  - **\\[强调\\]**');
    const again = parseMindMap(text)!;
    const labels = (m: typeof map) => [...walkMindMap(m)].map(({ node }) => [node.text, node.strong]);
    expect(labels(again)).toEqual(labels(map));
    expect(escapeLabel('- x')).toBe('\\- x');
  });

  it('recognises the type however it is spelled', () => {
    for (const type of ['MindMap', 'mindmap', 'mind-map', 'Mind Map']) expect(isMindMapFrontmatter({ type })).toBe(true);
    expect(isMindMapFrontmatter({ type: 'Document' })).toBe(false);
    expect(isMindMapFrontmatter({})).toBe(false);
  });
});

describe('cutting a map for search', () => {
  it('starts every piece with the path to it and keeps branches whole', () => {
    const map = parseMindMap(HUAWEI)!;
    expect(mindMapChunks(map, 2000)).toEqual([HUAWEI.replace('# 华为\n\n', '华为\n').replace('**赛力斯（核心）**', '赛力斯（核心）').trimEnd()]);

    // siblings are packed together while they fit
    expect(mindMapChunks(map, 60)[0]).toBe('华为 › 华为智驾\n- 整车\n  - 赛力斯（核心）\n    - 问界\n  - 北汽蓝谷\n    - 享界');
    // a branch too large for one piece is cut one level down, under its own path
    const pieces = mindMapChunks(map, 40);
    expect(pieces).toEqual([
      '华为 › 华为智驾 › 整车\n- 赛力斯（核心）\n  - 问界',
      '华为 › 华为智驾 › 整车\n- 北汽蓝谷\n  - 享界',
      '华为 › 华为智驾\n- 液冷超充\n  - 永贵电器（液冷充电枪）',
      '华为 › 华为算力 › 散热 › 液冷管路\n- 川环科技\n  - 实锤独供',
    ]);
    // nothing lost: every label is in some piece
    for (const { node } of walkMindMap(map)) expect(pieces.some((p) => p.includes(node.text))).toBe(true);
  });
});

describe('what a map tells the graph', () => {
  const ontology = loadOntology(fs.mkdtempSync(path.join(tmp, 'ont-')), ['core', 'organization', 'finance']);

  it('types an edge by what the two ends are', () => {
    expect(edgeFor('organization', 'theme', ontology)).toEqual({ type: 'belongs_to_sector', flip: false });
    expect(edgeFor('organization', 'commodity', ontology)).toEqual({ type: 'produces', flip: false });
    expect(edgeFor('product', 'organization', ontology)).toEqual({ type: 'produces', flip: true });
    expect(edgeFor('sector', 'theme', ontology)).toEqual({ type: 'part_of', flip: false });
    expect(edgeFor('organization', 'organization', ontology)).toEqual({ type: 'related_to', flip: false });
    // a workspace without the finance pack says part_of
    expect(edgeFor('organization', 'theme', loadOntology(fs.mkdtempSync(path.join(tmp, 'ont-')), ['core']))).toEqual({ type: 'part_of', flip: false });
  });

  it('joins each named node to the nearest named node above it, through the branches nobody names', () => {
    const known: Record<string, NodeEntity> = {
      赛力斯: { id: 'e-seres', name: '赛力斯', type: 'organization' },
      问界: { id: 'e-aito', name: '问界', type: 'product' },
      北汽蓝谷: { id: 'e-baic', name: '北汽蓝谷', type: 'organization' },
      永贵电器: { id: null, name: '永贵电器', type: 'organization' },
      川环科技: { id: null, name: '川环科技', type: 'organization' },
    };
    const subject: NodeEntity = { id: null, name: '华为产业链', type: 'theme' };
    const plan = planMindMapGraph(parseMindMap(HUAWEI)!, (name) => known[name] ?? null, { subject, ontology });
    expect(plan.entities.map((e) => e.entity.name).sort()).toEqual(['北汽蓝谷', '华为产业链', '川环科技', '永贵电器', '赛力斯', '问界'].sort());
    const edges = plan.edges.map((e) => [e.source.name, e.type, e.target.name]);
    expect(edges).toContainEqual(['赛力斯', 'belongs_to_sector', '华为产业链']);
    expect(edges).toContainEqual(['赛力斯', 'produces', '问界']);
    expect(edges).toContainEqual(['川环科技', 'belongs_to_sector', '华为产业链']);
    // 享界 and 实锤独供 name nothing; 整车 and 液冷超充 are branches, not entities
    expect(edges).toHaveLength(5);
    const yonggui = plan.edges.find((e) => e.source.name === '永贵电器')!;
    expect(yonggui.description).toBe('华为 › 华为智驾 › 液冷超充 › 永贵电器（液冷充电枪）');
  });

  it('joins two groupings only under the subject, and every company to the subject too', () => {
    const named: Record<string, NodeEntity> = {
      华为智驾: { id: 'e-adas', name: '华为智驾', type: 'technology' },
      整车: { id: 'e-auto', name: '整车', type: 'sector' },
      赛力斯: { id: 'e-seres', name: '赛力斯', type: 'organization' },
      永贵电器: { id: 'e-yonggui', name: '永贵电器', type: 'organization' },
    };
    const subject: NodeEntity = { id: null, name: '华为产业链', type: 'theme' };
    const edges = planMindMapGraph(parseMindMap(HUAWEI)!, (name) => named[name] ?? null, { subject, ontology }).edges
      .map((e) => [e.source.name, e.type, e.target.name]);
    expect(edges).toEqual([
      ['华为智驾', 'part_of', '华为产业链'],
      // 整车 —part_of→ 华为智驾 would be true of this map only
      ['赛力斯', 'belongs_to_sector', '整车'],
      ['赛力斯', 'belongs_to_sector', '华为产业链'],
      // under 液冷超充, which names nothing: nothing said about 华为智驾, only the subject
      ['永贵电器', 'belongs_to_sector', '华为产业链'],
    ]);
  });
});

describe('reading a picture of a mind map', () => {
  it('keeps a marked outline in the canonical form', () => {
    const reply = `\`\`\`markdown\n${MINDMAP_MARK}\n# 军工\n\n- 上游\n    - 合金\n        - **抚顺特钢（高温合金龙头）**\n\`\`\``;
    const read = mindMapTranscription(reply);
    expect(read.outline).toBe('# 军工\n\n- 上游\n  - 合金\n    - **抚顺特钢（高温合金龙头）**\n');
  });

  it('drops a mark over something that is no tree, and leaves other pictures alone', () => {
    expect(mindMapTranscription(`${MINDMAP_MARK}\n\nJust a sentence.`)).toMatchObject({ outline: null, body: 'Just a sentence.', warning: expect.stringContaining('no tree') });
    expect(mindMapTranscription('# Invoice\n\nTotal: $12')).toEqual({ outline: null, body: '# Invoice\n\nTotal: $12' });
  });

  it('converts a mind map picture into a MindMap document through the vision route', async () => {
    const dir = path.join(tmp, 'vision');
    initDataDir(dir);
    fs.writeFileSync(path.join(dir, 'raw/docs/chain.png'), PIXEL_PNG);
    let system = '';
    const prep = await prepareDocs(dir, {
      vision: {
        enabled: true,
        label: 'fake-vision',
        complete: async (messages) => {
          system = String(messages[0].content);
          return `${MINDMAP_MARK}\n# 华为\n\n- 华为智驾\n  - 整车\n`;
        },
      },
    });
    expect(prep.stats).toMatchObject({ prepared: 1, errors: 0 });
    expect(system).toContain(MINDMAP_MARK);
    const content = fs.readFileSync(path.join(dir, '.sidecar/raw/docs/chain.png/content.md'), 'utf8');
    expect(content).toContain('type: "MindMap"');
    expect(content).toContain('conversion: "image-mindmap"');
    expect(content).toContain('# 华为\n\n- 华为智驾\n  - 整车');
    expect(readSidecarPart(dir, 'raw/docs/chain.png', 'meta')?.conversion?.key).toMatch(/^v2\|fake-vision\|/);
  });
});

describe('a reviewed transcript beside its picture', () => {
  it('names the transcript after the converted Markdown, and only for convertible originals', () => {
    expect(transcriptPathFor('raw/docs/m/华为产业链.webp')).toBe('raw/docs/m/华为产业链.webp.md');
    expect(transcriptPathFor('raw/docs/m/note.md')).toBeNull();
    expect(originalOfTranscript('raw/docs/m/华为产业链.webp.md')).toBe('raw/docs/m/华为产业链.webp');
    expect(originalOfTranscript('raw/docs/m/note.md')).toBeNull();
  });

  it('adds where the text came from without touching what its author declared', () => {
    const md = transcriptToMarkdown('raw/docs/m/x.webp', 'raw/docs/m/x.webp.md', '---\ntype: MindMap\ntitle: X 图\ntranscribed_by: "human:ning"\n---\n# X\n\n- a\n').markdown;
    expect(md).toBe('---\nsource: "raw/docs/m/x.webp"\nsource_type: "webp"\nconversion: "transcript"\nconversion_model: "human:ning"\ntranscript: "raw/docs/m/x.webp.md"\ntype: MindMap\ntitle: X 图\ntranscribed_by: "human:ning"\n---\n\n# X\n\n- a\n');
  });

  it('is read instead of a model, is no document of its own, and links the map into the graph', async () => {
    const dir = path.join(tmp, 'transcript');
    initDataDir(dir);
    const config = defaultConfig();
    config.graph.ontologyPacks = ['core', 'organization', 'finance'];
    saveConfig(dir, config);
    fs.mkdirSync(path.join(dir, 'raw/docs/maps'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'raw/docs/maps/chain.png'), PIXEL_PNG);
    fs.writeFileSync(path.join(dir, 'raw/docs/maps/chain.png.md'), [
      '---',
      'type: MindMap',
      'title: 测试产业链',
      'subject: { name: 测试产业链, type: theme }',
      'entities:',
      '  - { name: 甲公司, type: organization }',
      '  - { name: 乙公司, type: organization }',
      '  - { name: 液冷, type: sector }',
      '  - { name: 星光一号, type: product }',
      'relations:',
      '  - { source: 测试产业链, target: 测试集团, type: related_to }',
      '---',
      '# 测试',
      '',
      '- 上游',
      '  - 液冷',
      '    - 甲公司（液冷龙头）',
      '      - 星光一号',
      '- 下游',
      '  - 乙公司（20cm）',
      '',
    ].join('\n'));

    // what the graph knew before the map: 丁公司 by its name, and a merge that left 上游 as an alias of 丙集团
    // and 下游, a word some extraction typed as a company
    // and 测试产业链, an alias some merge gave a company (as 华为产业链 is one of 华为's in finance)
    fs.writeFileSync(path.join(dir, 'raw/docs/seed.md'), '---\nentities:\n  - { name: 丁公司, type: organization }\n  - { name: 丙集团, type: organization, aliases: [上游] }\n  - { name: 下游, type: organization }\n  - { name: 测试集团, type: organization, aliases: [测试产业链] }\n---\n丁公司与丙集团。\n');
    const pictures = ['chain.png', 'chain.png.md'].map((f) => path.join(dir, 'raw/docs/maps', f));
    const held = pictures.map((p) => [p, fs.readFileSync(p)] as const);
    for (const p of pictures) fs.rmSync(p);

    const ctx = await createContext(dir);
    try {
      expect((await runIngest(ctx.store, ctx.config, ctx.embedder, ctx.llm, { llmGraph: false })).errors).toBe(0);
      for (const [p, bytes] of held) fs.writeFileSync(p, bytes);
      fs.writeFileSync(pictures[1], fs.readFileSync(pictures[1], 'utf8').replace('  - 乙公司（20cm）\n', '  - 乙公司（20cm）\n  - 丁公司（龙头）\n'));
      // no vision route is configured: a conversion would fail, the transcript needs none
      const stats = await runIngest(ctx.store, ctx.config, ctx.embedder, ctx.llm, { llmGraph: false });
      expect(stats.errors).toBe(0);
      const docs = await ctx.store.query<{ path: string }>(`SELECT path FROM documents WHERE path LIKE 'raw/docs/maps/%' AND status = 'indexed' ORDER BY path`);
      expect(docs.map((d) => d.path)).toEqual(['raw/docs/maps/chain.png']);
      expect(readSidecarPart(dir, 'raw/docs/maps/chain.png', 'meta')?.conversion).toMatchObject({ kind: 'transcript', key: expect.stringMatching(/^transcript\|/) });
      const [chunk] = await ctx.store.query<{ content: string }>(
        `SELECT c.content FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = 'raw/docs/maps/chain.png' ORDER BY c.seq LIMIT 1`,
      );
      expect(chunk.content.startsWith('测试\n- 上游\n  - 液冷\n    - 甲公司（液冷龙头）')).toBe(true);

      const edges = async () => (await ctx.store.query<{ s: string; type: string; t: string; description: string }>(
        `SELECT s.name AS s, r.type, t.name AS t, r.description FROM relations r
         JOIN entities s ON s.id = r.source_id JOIN entities t ON t.id = r.target_id
         WHERE r.tx_to IS NULL ORDER BY s.name, r.type, t.name`,
      )).map((r) => [r.s, r.type, r.t]);
      expect(await edges()).toEqual(expect.arrayContaining([
        ['乙公司', 'belongs_to_sector', '测试产业链'],
        ['液冷', 'part_of', '测试产业链'],
        ['甲公司', 'belongs_to_sector', '液冷'],
        ['甲公司', 'belongs_to_sector', '测试产业链'],
        ['甲公司', 'produces', '星光一号'],
        // known by its name, undeclared
        ['丁公司', 'belongs_to_sector', '测试产业链'],
      ]));
      // known only through an alias: the branch 上游 is no 丙集团; a two-character company name is not trusted either
      expect((await edges()).filter(([s, , t]) => ['丙集团', '下游'].includes(s) || ['丙集团', '下游'].includes(t))).toEqual([]);
      // the subject keeps its type wherever the document names it: the company with its name as an alias does not capture it
      expect(await edges()).toEqual(expect.arrayContaining([['测试产业链', 'related_to', '测试集团']]));
      expect((await edges()).filter(([, type, t]) => t === '测试集团' && type !== 'related_to')).toEqual([]);

      // a map applied by an older planner is read again once, though its text is the same
      const scopeOf = async () => (await ctx.store.query<{ id: string; meta: { mindmap?: number } }>(
        `SELECT id, meta FROM scopes WHERE kind = 'doc' AND key = 'raw/docs/maps/chain.png' AND status = 'active' AND parent_id IS NULL`,
      ))[0];
      const before = await scopeOf();
      expect(before.meta.mindmap).toBe(MINDMAP_PLAN_VERSION);
      await ctx.store.query(`UPDATE scopes SET meta = jsonb_set(meta, '{mindmap}', '1') WHERE id = $1`, [before.id]);
      const resync = () => sync({ dataDir: dir, config: ctx.config, store: ctx.store, embedder: ctx.embedder, llm: ctx.llm }, { only: ['raw/docs/maps/chain.png'], llmGraph: false, datasources: false });
      expect((await resync()).applied).toBe(1);
      expect((await scopeOf()).meta.mindmap).toBe(MINDMAP_PLAN_VERSION);
      expect((await resync()).applied).toBe(0);
      const [evidence] = await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM evidence WHERE extractor = 'tier0.mindmap' AND tx_to IS NULL`);
      expect(evidence.n).toBeGreaterThan(0);

      // an edit to the transcript alone re-reads its original
      fs.writeFileSync(path.join(dir, 'raw/docs/maps/chain.png.md'), fs.readFileSync(path.join(dir, 'raw/docs/maps/chain.png.md'), 'utf8').replace('  - 乙公司（20cm）', '  - 乙公司（20cm）\n  - 丙公司'));
      await sync({ dataDir: dir, config: ctx.config, store: ctx.store, embedder: ctx.embedder, llm: ctx.llm }, { only: ['raw/docs/maps/chain.png.md'], llmGraph: false, datasources: false });
      const after = await ctx.store.query<{ content: string }>(
        `SELECT c.content FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = 'raw/docs/maps/chain.png' AND d.status = 'indexed'`,
      );
      expect(after.map((c) => c.content).join('\n')).toContain('丙公司');
      expect(await edges()).toEqual(expect.arrayContaining([['乙公司', 'belongs_to_sector', '测试产业链']]));

      // a transcript that arrives before its picture is a document of its own, until the picture comes
      const solo = path.join(dir, 'raw/docs/maps/later.png.md');
      fs.writeFileSync(solo, '---\ntype: MindMap\n---\n# 后来\n\n- 一\n');
      const scoped = (only: string) => sync({ dataDir: dir, config: ctx.config, store: ctx.store, embedder: ctx.embedder, llm: ctx.llm }, { only: [only], llmGraph: false, datasources: false });
      await scoped('raw/docs/maps/later.png.md');
      const indexed = async () => (await ctx.store.query<{ path: string }>(`SELECT path FROM documents WHERE path LIKE 'raw/docs/maps/later%' AND status = 'indexed' ORDER BY path`)).map((d) => d.path);
      expect(await indexed()).toEqual(['raw/docs/maps/later.png.md']);
      fs.writeFileSync(path.join(dir, 'raw/docs/maps/later.png'), PIXEL_PNG);
      await scoped('raw/docs/maps/later.png');
      expect(await indexed()).toEqual(['raw/docs/maps/later.png']);
    } finally {
      await ctx.store.close();
    }
  }, 30_000);
});
