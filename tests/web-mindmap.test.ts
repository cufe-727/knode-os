import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseMindMap, walkMindMap } from '../src/mindmap/outline.js';

/**
 * Mind maps in the page (web/mindmap.js): a `type: MindMap` document drawn
 * as its tree by web/markdown.js, every label escaped, no inline style,
 * handler or id, and read the way the server reads it
 * (src/mindmap/outline.ts). Loaded the way the page loads them: plain
 * scripts sharing one global, next to marked.
 */

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

interface WebNode { text: string; strong: boolean; children: WebNode[] }
interface Mindmap {
  isMindMapYaml: (yaml: string) => boolean;
  parse: (body: string) => { root: WebNode; size: number; depth: number } | null;
  render: (body: string) => string | null;
}

function load(withMindmap = true): { mindmap: Mindmap; md: { render: (text: string) => string } } {
  const require = createRequire(import.meta.url);
  const markedUmd = path.join(path.dirname(require.resolve('marked')), 'marked.umd.js');
  const page = vm.createContext({});
  vm.runInContext(fs.readFileSync(markedUmd, 'utf8'), page);
  if (withMindmap) vm.runInContext(fs.readFileSync(path.join(webDir, 'mindmap.js'), 'utf8'), page);
  vm.runInContext(fs.readFileSync(path.join(webDir, 'markdown.js'), 'utf8'), page);
  const g = page as { knodeMindmap: Mindmap; knodeMarkdown: { render: (text: string) => string } };
  return { mindmap: g.knodeMindmap, md: g.knodeMarkdown };
}

const { mindmap, md } = load();

const OUTLINE = `# 上市公司军工产业链

- 上游
  - 合金
    - 钢研高纳（高温合金平台类企业）
  - 碳纤维
    - **光威复材**
      - 20（创）
- 情绪
  - 1. 市场整体情绪极弱
    - a. 下跌家数是近期最多
- <img src=x onerror=alert(1)>
`;

describe('mind maps in the page', () => {
  it('reads an outline the way the server does', () => {
    const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));
    const strip = (n: WebNode): unknown => ({ text: n.text, strong: n.strong, children: n.children.map(strip) });
    const server = parseMindMap(OUTLINE)!;
    const fromServer = (n: typeof server.root): unknown => ({ text: n.text, strong: n.strong, children: n.children.map(fromServer) });
    const web = plain(mindmap.parse(OUTLINE))!;
    expect(strip(web.root)).toEqual(fromServer(server.root));
    expect(web.size).toBe(server.size);
    expect(web.depth).toBe(server.depth);
    expect(web.size).toBe([...walkMindMap(server)].length);
  });

  it('draws a type: MindMap page as its tree, under the metadata panel', () => {
    const html = md.render(`---\ntype: MindMap\ntitle: 军工\n---\n${OUTLINE}`);
    expect(html.startsWith('<details class="md-meta"')).toBe(true);
    expect(html).toContain('<figure class="kmindmap">');
    expect(html).toContain('Mind map · 11 nodes · 4 levels');
    expect(html).toContain('<li class="kmm-item kmm-d0 kmm-root"><span class="kmm-node"><span class="kmm-name">上市公司军工产业链</span></span>');
    // the name and its note apart; numbering apart; bold as a class
    expect(html).toContain('<span class="kmm-name">钢研高纳</span><span class="kmm-note">（高温合金平台类企业）</span>');
    expect(html).toContain('<span class="kmm-num">1.</span> <span class="kmm-name">市场整体情绪极弱</span>');
    expect(html).toContain('<li class="kmm-item kmm-d3 kmm-strong"><span class="kmm-node"><span class="kmm-name">光威复材</span></span><button type="button" class="kmm-fold" data-kmm-fold aria-expanded="true" title="Fold this branch">1</button>');
  });

  it('escapes every label and carries no style, handler or id', () => {
    const html = mindmap.render(OUTLINE)!;
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toMatch(/<img/);
    // attributes only: the escaped label above is text, whatever it spells
    expect(html).not.toMatch(/<[^>]*\s(?:style|on[a-z]+|id)=/i);
  });

  it('leaves other pages, and a map that holds no tree, to the Markdown renderer', () => {
    expect(md.render('---\ntype: Document\n---\n# T\n\n- a\n  - b\n')).not.toContain('kmindmap');
    const notATree = md.render('---\ntype: MindMap\n---\n# Only a title\n\nprose');
    expect(notATree).not.toContain('kmindmap');
    expect(notATree).toContain('<h1>Only a title</h1>');
    // without web/mindmap.js the outline still reads as a list
    expect(load(false).md.render(`---\ntype: MindMap\n---\n${OUTLINE}`)).toContain('<li>上游<ul>');
  });

  it('recognises the type however it is spelled', () => {
    for (const yaml of ['type: MindMap', 'type: "mindmap"', "type: 'mind-map'", 'title: x\ntype: Mind Map # drawn']) expect(mindmap.isMindMapYaml(yaml)).toBe(true);
    expect(mindmap.isMindMapYaml('type: Document')).toBe(false);
    expect(mindmap.isMindMapYaml('subtype: MindMap')).toBe(false);
  });
});
