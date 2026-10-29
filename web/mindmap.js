/* knode-os web UI — a mind map drawn from its outline */
'use strict';

/**
 * A document whose frontmatter says `type: MindMap` (docs/design/19-mind-maps.md)
 * is an outline: the root as its H1, every other node a bullet under its
 * parent. web/markdown.js hands the body to `render`, which draws it as the
 * tree it is — the root on the left, each branch to the right of its parent,
 * joined by bracket lines, the way mind-map tools draw it.
 *
 * Reading mirrors src/mindmap/outline.ts, which the server chunks and links
 * by: line-based, one item one node, its text kept as written (`1. 市场…` is
 * a label, not a nested ordered list), a trailing parenthetical shown as the
 * node's note.
 *
 * The drawing is HTML, not SVG: nested lists laid out by flexbox with the
 * connectors drawn in web/mindmap.css. Labels size themselves, the browser's
 * find reaches them, and the file view's entity marking (app.js
 * markMentions) turns the names the graph knows into links as it does in
 * prose. The same list reads as an indented outline when the figure says
 * so, which is what Obsidian and the Mac app show.
 *
 * Every label is escaped; the markup has no style, handler or id (the page's
 * Content-Security-Policy). `hydrate` adds the controls: folding a branch,
 * outline / map, and fitting a wide map to the pane (CSSOM, which the policy
 * allows). A map never hydrated still reads in full.
 *
 * A plain script (no build step), loaded before markdown.js.
 */
(function (global) {
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** `type: MindMap` in a page's YAML, spelled any way a person might. */
  function isMindMapYaml(yaml) {
    const m = /^type:[ \t]*["']?([^"'\n#]+?)["']?[ \t]*(?:#.*)?$/m.exec(String(yaml ?? ''));
    return Boolean(m) && m[1].replace(/[\s_-]+/g, '').toLowerCase() === 'mindmap';
  }

  /* ------------------------------- reading ------------------------------- */

  const NUMBERING = /^(?:\d{1,3}|[A-Za-z]|[一二三四五六七八九十]{1,3})[.、．)）]\s*/u;
  const TRAILING_NOTE = /^(.+?)\s*([（(][^（()）]+[）)]?)\s*$/u;
  const BULLET = /^([ \t]*)(?:[-*+]|(\d{1,3}[.)]))[ \t]+(.*)$/;
  const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
  const FENCE = /^[ \t]*(```|~~~)/;

  function cleanLabel(raw) {
    let s = String(raw).trim();
    const strong = /\*\*[^*]+\*\*|__[^_]+__/.test(s);
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
    s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, label) => label ?? target);
    s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    s = s.replace(/\\([!-/:-@[-`{-~])/g, '$1');
    return { text: s.replace(/\s+/g, ' ').trim(), strong };
  }

  function makeNode(raw) {
    const { text, strong } = cleanLabel(raw);
    return { text, strong, children: [] };
  }

  function columns(indent) {
    let n = 0;
    for (const ch of indent) n += ch === '\t' ? 4 - (n % 4) : 1;
    return n;
  }

  /** The tree an outline holds: `{ root, size, depth }`, or null when no node hangs below a root. */
  function parse(body) {
    const root = makeNode('');
    let rootNamed = false;
    let headings = [root];
    let base = root;
    let items = [];
    let inFence = false;
    for (const line of String(body ?? '').replace(/\r\n?/g, '\n').split('\n')) {
      if (FENCE.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence || !line.trim()) continue;
      const heading = HEADING.exec(line);
      if (heading) {
        const level = heading[1].length;
        if (level === 1 && !rootNamed) {
          Object.assign(root, makeNode(heading[2]), { children: root.children });
          rootNamed = true;
          headings = [root];
          base = root;
        } else {
          const depth = Math.max(1, Math.min(level - 1, headings.length));
          const node = makeNode(heading[2]);
          headings[depth - 1].children.push(node);
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
        const node = makeNode(bullet[2] ? `${bullet[2]} ${bullet[3]}` : bullet[3]);
        parent.children.push(node);
        items.push({ indent, node });
        continue;
      }
      if (items.length && /^[ \t]/.test(line)) {
        const last = items[items.length - 1].node;
        last.text = cleanLabel(`${last.text} ${line.trim()}`).text;
      }
    }
    const top = !rootNamed && root.children.length === 1 ? root.children[0] : root;
    const count = (n) => n.children.reduce((s, c) => s + count(c), 1);
    const deepest = (n, d) => n.children.reduce((m, c) => Math.max(m, deepest(c, d + 1)), d);
    const size = count(top);
    if (size < 2) return null;
    return { root: top, size, depth: deepest(top, 0) };
  }

  /* ------------------------------- drawing ------------------------------- */

  /** A label as markup: its numbering and its note set apart from the name, every piece escaped. */
  function labelHtml(text) {
    const number = NUMBERING.exec(text)?.[0] ?? '';
    const rest = text.slice(number.length);
    const note = TRAILING_NOTE.exec(rest);
    const name = note && note[1].trim() ? note[1] : rest;
    return [
      number ? `<span class="kmm-num">${escapeHtml(number.trim())}</span> ` : '',
      `<span class="kmm-name">${escapeHtml(name)}</span>`,
      note && note[1].trim() ? `<span class="kmm-note">${escapeHtml(note[2])}</span>` : '',
    ].join('');
  }

  function count(node) {
    return node.children.reduce((s, c) => s + count(c), 1);
  }

  function itemHtml(node, depth) {
    const classes = ['kmm-item', `kmm-d${Math.min(depth, 3)}`];
    if (depth === 0) classes.push('kmm-root');
    if (node.strong) classes.push('kmm-strong');
    const fold = node.children.length && depth > 0
      ? `<button type="button" class="kmm-fold" data-kmm-fold aria-expanded="true" title="Fold this branch">${count(node) - 1}</button>`
      : '';
    const children = node.children.length
      ? `<ul class="kmm-children">${node.children.map((c) => itemHtml(c, depth + 1)).join('')}</ul>`
      : '';
    return `<li class="${classes.join(' ')}"><span class="kmm-node">${labelHtml(node.text)}</span>${fold}${children}</li>`;
  }

  /** The figure for an outline, or null when it holds no tree (markdown.js then renders it as text). */
  function render(body) {
    const map = parse(body);
    if (!map) return null;
    const bar = [
      `<span class="kmm-sum">Mind map · ${map.size} nodes · ${map.depth} levels</span>`,
      '<span class="kmm-tools">',
      '<button type="button" class="kmm-btn" data-kmm="fit" title="Fit the map to the pane">fit</button>',
      '<button type="button" class="kmm-btn" data-kmm="expand" title="Unfold every branch">unfold all</button>',
      '<button type="button" class="kmm-btn" data-kmm="outline" aria-pressed="false" title="Read it as an indented outline">outline</button>',
      '</span>',
    ].join('');
    return `<figure class="kmindmap"><div class="kmm-bar">${bar}</div><div class="kmm-scroll"><ul class="kmm-tree">${itemHtml(map.root, 0)}</ul></div></figure>`;
  }

  /* ------------------------------ controls ------------------------------ */

  function fit(figure, on) {
    const tree = figure.querySelector('.kmm-tree');
    const scroll = figure.querySelector('.kmm-scroll');
    if (!tree || !scroll) return;
    tree.style.removeProperty('zoom');
    if (!on) return;
    const scale = Math.min(1, (scroll.clientWidth - 4) / Math.max(1, tree.scrollWidth));
    if (scale < 1) tree.style.setProperty('zoom', String(Math.max(0.35, scale)));
  }

  function onClick(event) {
    const figure = event.currentTarget;
    const foldButton = event.target.closest('[data-kmm-fold]');
    if (foldButton && figure.contains(foldButton)) {
      const item = foldButton.closest('.kmm-item');
      const folded = item.classList.toggle('kmm-folded');
      foldButton.setAttribute('aria-expanded', String(!folded));
      foldButton.title = folded ? 'Unfold this branch' : 'Fold this branch';
      if (figure.classList.contains('kmm-fitted')) fit(figure, true);
      return;
    }
    const tool = event.target.closest('[data-kmm]');
    if (!tool || !figure.contains(tool)) return;
    const what = tool.dataset.kmm;
    if (what === 'expand') {
      figure.querySelectorAll('.kmm-folded').forEach((item) => item.classList.remove('kmm-folded'));
      figure.querySelectorAll('[data-kmm-fold]').forEach((b) => b.setAttribute('aria-expanded', 'true'));
      if (figure.classList.contains('kmm-fitted')) fit(figure, true);
    } else if (what === 'outline') {
      const on = figure.classList.toggle('kmm-as-outline');
      tool.setAttribute('aria-pressed', String(on));
      tool.textContent = on ? 'map' : 'outline';
      tool.title = on ? 'Draw it as a map again' : 'Read it as an indented outline';
      fit(figure, !on && figure.classList.contains('kmm-fitted'));
    } else if (what === 'fit') {
      const on = figure.classList.toggle('kmm-fitted');
      tool.setAttribute('aria-pressed', String(on));
      tool.textContent = on ? '100%' : 'fit';
      fit(figure, on && !figure.classList.contains('kmm-as-outline'));
    }
  }

  /** Wire every map under `root` once; safe to call again on the same view. */
  function hydrate(root) {
    const scope = root ?? global.document;
    if (!scope?.querySelectorAll) return;
    for (const figure of scope.querySelectorAll('.kmindmap')) {
      if (figure.dataset.kmmReady) continue;
      figure.dataset.kmmReady = '1';
      figure.addEventListener('click', onClick);
    }
  }

  global.knodeMindmap = { isMindMapYaml, parse, render, hydrate };
})(globalThis);
