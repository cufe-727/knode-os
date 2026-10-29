/**
 * Mind maps (docs/design/19-mind-maps.md). A mind map — a picture of labelled
 * nodes joined into a tree, or an outline a person wrote — has one form in the
 * knowledge base: Markdown whose frontmatter says `type: MindMap`, with the
 * root as its H1 and every other node a bullet nested under its parent:
 *
 *   ---
 *   type: MindMap
 *   title: 华为产业链
 *   ---
 *   # 华为
 *
 *   - 华为智驾
 *     - 整车
 *       - **赛力斯（核心）**
 *         - 问界
 *
 * The image converter writes it from a picture, a transcript beside the
 * picture holds a reviewed one (src/ingest/convert.ts), and everything that
 * reads a mind map — chunking, the tier-0 graph (src/mindmap/graph.ts), the
 * web view (web/mindmap.js, which mirrors this reader) — reads it here.
 *
 * Reading is line-based, not CommonMark: each item is one node and its text is
 * kept as written, numbering included (`1. 市场整体情绪极弱` is a label, not a
 * nested ordered list). A heading below the H1 is a node too — `## A` a child
 * of the root, `### B` of the last `##` — so the outline an XMind or markmap
 * export writes reads the same.
 */

export const MINDMAP_TYPE = 'MindMap';

export interface MindMapNode {
  /** Where the node sits: '' for the root, then '1', '1.2', … by position among siblings, from 1. */
  id: string;
  depth: number;
  /** The label as written, its Markdown emphasis and escapes removed. */
  text: string;
  /** The label without leading numbering or a trailing note: what an entity would be called. */
  name: string;
  /** A trailing parenthetical: 钢研高纳（高温合金平台类企业） → 高温合金平台类企业. */
  note: string | null;
  /** Drawn in bold: the label, or a run in it, was wrapped in ** or __. */
  strong: boolean;
  children: MindMapNode[];
}

export interface MindMap {
  root: MindMapNode;
  /** Nodes, the root included. */
  size: number;
  /** The deepest level below the root. */
  depth: number;
}

/** `type: MindMap` — spelled any way a person might (mindmap, mind-map, Mind Map). */
export function isMindMapFrontmatter(fm: Record<string, unknown> | null | undefined): boolean {
  const type = fm?.type;
  return typeof type === 'string' && type.replace(/[\s_-]+/g, '').toLowerCase() === 'mindmap';
}

/* ─────────────────────────────── labels ─────────────────────────────── */

/** 1. / a. / 一、 / 2) before a label: its place in a list, not part of its name. */
const NUMBERING = /^(?:\d{1,3}|[A-Za-z]|[一二三四五六七八九十]{1,3})[.、．)）]\s*/u;
/** A note closing the label: the last parenthetical, full-width or not; an unclosed （ runs to the end. */
const TRAILING_NOTE = /^(.+?)\s*[（(]([^（()）]+)[）)]?\s*$/u;

function cleanLabel(raw: string): { text: string; strong: boolean } {
  let s = raw.trim();
  const strong = /\*\*[^*]+\*\*|__[^_]+__/.test(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
  // [[target|label]] and [label](url) read as their labels
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, label?: string) => label ?? target);
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Markdown escapes: \. \* \# … stand for the character itself
  s = s.replace(/\\([!-/:-@[-`{-~])/g, '$1');
  return { text: s.replace(/\s+/g, ' ').trim(), strong };
}

/** The name a label gives and the note it carries: `海光信息（CPU龙头）` → 海光信息 + CPU龙头. */
export function labelParts(text: string): { name: string; note: string | null } {
  const unnumbered = text.replace(NUMBERING, '').trim() || text.trim();
  const m = TRAILING_NOTE.exec(unnumbered);
  if (!m || !m[1].trim()) return { name: unnumbered, note: null };
  return { name: m[1].trim(), note: m[2].trim() || null };
}

function makeNode(raw: string, depth: number): MindMapNode {
  const { text, strong } = cleanLabel(raw);
  const { name, note } = labelParts(text);
  return { id: '', depth, text, name, note, strong, children: [] };
}

/* ─────────────────────────────── reading ─────────────────────────────── */

const BULLET = /^([ \t]*)(?:[-*+]|(\d{1,3}[.)]))[ \t]+(.*)$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE = /^[ \t]*(```|~~~)/;

function columns(indent: string): number {
  let n = 0;
  for (const ch of indent) n += ch === '\t' ? 4 - (n % 4) : 1;
  return n;
}

/**
 * The tree an outline holds, or null when it holds no tree (no node below a
 * root). Without an H1 a lone top-level item is the root; several are
 * children of a root named `title`.
 */
export function parseMindMap(body: string, opts: { title?: string } = {}): MindMap | null {
  const root = makeNode(opts.title ?? '', 0);
  let rootNamed = false;
  // headings open sections: headings[d] is the node a heading at depth d opened
  let headings: MindMapNode[] = [root];
  let base = root;
  let items: { indent: number; node: MindMapNode }[] = [];
  let inFence = false;

  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line.trim()) continue;
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (level === 1 && !rootNamed) {
        Object.assign(root, makeNode(heading[2], 0), { children: root.children });
        rootNamed = true;
        headings = [root];
        base = root;
      } else {
        const depth = Math.max(1, Math.min(level - 1, headings.length));
        const parent = headings[depth - 1];
        const node = makeNode(heading[2], depth);
        parent.children.push(node);
        headings = [...headings.slice(0, depth), node];
        base = node;
      }
      items = [];
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      const indent = columns(bullet[1]);
      while (items.length && items[items.length - 1].indent >= indent) items.pop();
      const parent = items.length ? items[items.length - 1].node : base;
      // an ordered item keeps its number: it is part of what the map says
      const node = makeNode(bullet[2] ? `${bullet[2]} ${bullet[3]}` : bullet[3], parent.depth + 1);
      parent.children.push(node);
      items.push({ indent, node });
      continue;
    }
    // an indented line under an item continues its label; prose elsewhere is not part of the tree
    if (items.length && /^[ \t]/.test(line)) {
      const last = items[items.length - 1].node;
      Object.assign(last, makeNode(`${last.text} ${line.trim()}`, last.depth), { children: last.children, strong: last.strong });
    }
  }

  let top = root;
  if (!rootNamed && !opts.title && root.children.length === 1) top = root.children[0];
  if (!top.text && !top.children.length) return null;
  const size = number(top, '', 0);
  if (size < 2) return null;
  return { root: top, size, depth: maxDepth(top, 0) };
}

/** Give every node its id and depth (a promoted root starts the count again). */
function number(node: MindMapNode, id: string, depth: number): number {
  node.id = id;
  node.depth = depth;
  let n = 1;
  node.children.forEach((child, i) => {
    n += number(child, id ? `${id}.${i + 1}` : String(i + 1), depth + 1);
  });
  return n;
}

function maxDepth(node: MindMapNode, depth: number): number {
  return node.children.reduce((d, c) => Math.max(d, maxDepth(c, depth + 1)), depth);
}

/** Every node, parents before children, with the labels of the nodes above it. */
export function* walkMindMap(map: MindMap): Generator<{ node: MindMapNode; trail: MindMapNode[] }> {
  const stack: { node: MindMapNode; trail: MindMapNode[] }[] = [{ node: map.root, trail: [] }];
  while (stack.length) {
    const item = stack.pop()!;
    yield item;
    const trail = [...item.trail, item.node];
    for (let i = item.node.children.length - 1; i >= 0; i--) stack.push({ node: item.node.children[i], trail });
  }
}

/* ─────────────────────────────── writing ─────────────────────────────── */

/**
 * A label as Markdown that reads back as itself: a leading `1.` or `-` would
 * start a nested list and `#` a heading, and the inline markers would format.
 */
export function escapeLabel(text: string): string {
  return text
    .replace(/[\\`*_[\]]/g, (c) => `\\${c}`)
    .replace(/^(\d{1,3})([.)])/, '$1\\$2')
    .replace(/^([#>+-])/, '\\$1');
}

function itemLine(node: MindMapNode, indent: number): string {
  const label = escapeLabel(node.text);
  return `${'  '.repeat(indent)}- ${node.strong ? `**${label}**` : label}`;
}

function branchLines(node: MindMapNode, indent: number, out: string[], plain = false): string[] {
  out.push(plain ? `${'  '.repeat(indent)}- ${node.text}` : itemLine(node, indent));
  for (const child of node.children) branchLines(child, indent + 1, out, plain);
  return out;
}

/** The canonical outline: `# root`, a blank line, then the branches, two spaces a level. */
export function serializeMindMap(map: MindMap): string {
  const head = escapeLabel(map.root.text);
  const lines = [`# ${map.root.strong ? `**${head}**` : head}`, ''];
  for (const child of map.root.children) branchLines(child, 0, lines);
  return `${lines.join('\n')}\n`;
}

/* ─────────────────────────────── chunks ─────────────────────────────── */

/** Breadcrumb separator in chunks and relation descriptions. */
export const TRAIL_SEPARATOR = ' › ';

/**
 * The map cut for search. A branch read alone loses what it hangs under —
 * `永贵电器（液冷充电枪）` says nothing about 华为 — so every piece starts with
 * the path that leads to it (`华为 › 华为智驾 › 液冷超充`) and then holds whole
 * branches as an outline, packed up to `chunkSize` characters. A branch larger
 * than that on its own is cut the same way one level down. Labels go in as
 * plain text: emphasis is presentation, and escapes would only be noise to a
 * search or a model.
 */
export function mindMapChunks(map: MindMap, chunkSize: number): string[] {
  const out: string[] = [];
  const length = (lines: string[]) => lines.reduce((n, l) => n + l.length + 1, 0);
  const cut = (parent: MindMapNode, trail: string[]) => {
    const head = trail.join(TRAIL_SEPARATOR);
    let batch: string[] = [];
    const flush = () => {
      if (batch.length) out.push([head, ...batch].join('\n'));
      batch = [];
    };
    for (const child of parent.children) {
      const lines = branchLines(child, 0, [], true);
      const size = length(lines);
      if (head.length + 1 + size > chunkSize && child.children.length) {
        flush();
        cut(child, [...trail, child.text]);
        continue;
      }
      if (batch.length && head.length + 1 + length(batch) + size > chunkSize) flush();
      batch.push(...lines);
    }
    flush();
  };
  cut(map.root, [map.root.text]);
  return out;
}
