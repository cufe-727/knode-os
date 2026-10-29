/* knode-os web UI — Markdown to HTML that is safe to put in the page */
'use strict';

/**
 * Every Markdown view in the UI — files, dream suggestions, chat — renders
 * text that a person, an imported folder or an agent wrote, so what comes out
 * carries formatting and nothing else:
 *
 *   - raw HTML is never parsed: `<script>`, `<img onerror=…>`, `<iframe>` show
 *     up as the text they were written as; the one exception is an empty
 *     `<a id="…"></a>` on a line of its own, an anchor exporters leave for
 *     links to land on, which becomes an invisible marker;
 *   - a link keeps its target only when it is relative or http(s) / mailto
 *     (an image also data:image/…), so a `javascript:` link becomes its label;
 *   - `[[wikilinks]]` and workspace paths in code spans (`raw/…`, `wiki/…`)
 *     become in-app links the file view resolves.
 *
 * A page's own parts are read too: the YAML frontmatter folds into a
 * metadata panel with a one-line summary, and GFM footnotes (`[^1]` with a
 * `[^1]: …` note) become numbered markers and a list of notes, each way
 * linked to the other. Nothing here sets an `id`: the markers carry `data-`
 * attributes, so a page cannot shadow a global of the app's own.
 *
 * The page's Content-Security-Policy (src/server/csp.ts) is the second line:
 * an inline script or handler would not run even if one slipped through.
 *
 * A plain script (no build step): app.js calls `knodeMarkdown.render`, and the
 * tests load this file the same way, next to marked.
 */
(function (global) {
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const LINK_SCHEMES = new Set(['http', 'https', 'mailto']);
  const IMAGE_DATA = /^data:image\/(?:png|gif|jpe?g|webp|avif|bmp)[;,]/i;

  /**
   * The URL a link or image may carry, or null when its scheme could run
   * code. Read the way a browser's URL parser reads it — tabs and newlines
   * anywhere and control characters at either end do not count — so
   * `java\tscript:` is the scheme it looks like to the browser.
   */
  function safeUrl(raw, opts = {}) {
    const url = String(raw ?? '').replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
    const scheme = /^([a-z][a-z\d+.-]*):/i.exec(url)?.[1].toLowerCase();
    if (scheme && !LINK_SCHEMES.has(scheme) && !(opts.image && IMAGE_DATA.test(url))) return null;
    try {
      // what marked itself does to a link target; a lone surrogate cannot be encoded
      return encodeURI(url).replace(/%25/g, '%');
    } catch {
      return null;
    }
  }

  /** The YAML block a Markdown file may open with: Obsidian's properties, a knode page's metadata. */
  const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

  /** A workspace file as a page names it: a path under raw/ or wiki/, maybe with an #anchor. */
  const WORKSPACE_PATH = /^(?:raw|wiki)\/[^\s`"'<>]+$/;

  /** `[[note]]`, `[[folder/note|label]]`, `[[note#heading]]` — Obsidian's wikilinks. */
  const wikilink = {
    name: 'wikilink',
    level: 'inline',
    start(src) {
      const at = src.search(/!?\[\[/);
      return at < 0 ? undefined : at;
    },
    tokenizer(src) {
      const match = /^(!)?\[\[([^\]\n]+)\]\]/.exec(src);
      if (!match) return undefined;
      const fields = match[2].split('|');
      const target = fields.shift().trim();
      if (!target) return undefined;
      const note = target.split('#', 1)[0].replace(/\\/g, '/').replace(/\.(md|markdown)$/i, '');
      const label = fields.join('|').trim() || note.split('/').pop() || target.replace(/^#/, '');
      return { type: 'wikilink', raw: match[0], target, label, embed: Boolean(match[1]) };
    },
    renderer(token) {
      return `<a class="wikilink" href="#" data-wikilink="${escapeHtml(token.target)}">${escapeHtml(token.label)}</a>`;
    },
  };

  /** `<a id="e-1f2e"></a>` alone on a line: where links into an export land. Anything else that looks like HTML stays text. */
  const anchor = {
    name: 'anchor',
    level: 'block',
    start(src) {
      const at = src.search(/^<a\s+(?:id|name)\s*=/im);
      return at < 0 ? undefined : at;
    },
    tokenizer(src) {
      const match = /^<a\s+(?:id|name)\s*=\s*"([\w.:-]+)"\s*>\s*<\/a>[ \t]*(?:\n+|$)/i.exec(src);
      return match ? { type: 'anchor', raw: match[0], name: match[1] } : undefined;
    },
    renderer(token) {
      return `<span class="md-anchor" data-anchor="${escapeHtml(token.name)}"></span>`;
    },
  };

  /**
   * The notes of the document being rendered: their numbers in the order the
   * text first cites them, the notes themselves, and where the list goes.
   * Set for one `render` call; rendering is synchronous, so one slot does.
   */
  let notes = null;

  /** Plain text of a note for a marker's tooltip: the Markdown's punctuation dropped. */
  const notePreview = (text) => text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

  /** `[^label]` in the text: a numbered marker that goes to its note. */
  const footnoteRef = {
    name: 'footnoteRef',
    level: 'inline',
    start(src) {
      const at = src.indexOf('[^');
      return at < 0 ? undefined : at;
    },
    tokenizer(src) {
      const match = /^\[\^([^\]\s]+)\]/.exec(src);
      return match ? { type: 'footnoteRef', raw: match[0], label: match[1] } : undefined;
    },
    renderer(token) {
      const note = notes?.byLabel.get(token.label);
      // a marker with no note stays the text it was written as, as GitHub shows it
      if (!note) return escapeHtml(token.raw);
      return `<sup class="fn-ref"><a href="#" data-fn="${escapeHtml(token.label)}" title="${escapeHtml(notePreview(note.text))}">[${note.n}]</a></sup>`;
    },
  };

  /** `[^label]: text`, indented lines continuing it: a note, gathered into the list of notes. */
  const footnoteDef = {
    name: 'footnoteDef',
    level: 'block',
    start(src) {
      const at = src.search(/^\[\^[^\]\s]+\]:/m);
      return at < 0 ? undefined : at;
    },
    tokenizer(src) {
      const match = /^\[\^([^\]\s]+)\]:[ \t]*([^\n]*(?:\n(?:[ \t]{2,}|\t)[^\n]*)*)(?:\n|$)/.exec(src);
      if (!match) return undefined;
      const text = match[2].replace(/\n[ \t]+/g, ' ').trim();
      const tokens = [];
      this.lexer.inline(text, tokens);
      return { type: 'footnoteDef', raw: match[0], label: match[1], text, tokens };
    },
    renderer(token) {
      // the list stands where the notes were written when they form one run (under a "Sources" heading, say), else at the end
      if (!notes || notes.atEnd || notes.placed || notes.first !== token) return '';
      notes.placed = true;
      return notesHtml(this.parser);
    },
  };

  /** The list of notes: the number a marker shows, the note with its links live, and a way back to the first marker. */
  function notesHtml(parser) {
    const items = notes.list.map((note) => {
      const back = note.cited
        ? `<a href="#" class="fn-back" data-fn-back="${escapeHtml(note.label)}" title="Back to the text">↩</a>`
        : '';
      return `<li class="fn" data-fn-def="${escapeHtml(note.label)}"><span class="fn-num">[${note.n}]</span><span class="fn-body">${parser.parseInline(note.token.tokens)}</span>${back}</li>`;
    });
    return `<section class="footnotes"><ol>${items.join('')}</ol></section>`;
  }

  /** Number the notes the way GitHub does — by the text's first citation — and decide where their list goes. */
  function collectNotes(md, tokens) {
    const defs = new Map();
    const cited = [];
    let written = 0;
    md.walkTokens(tokens, (token) => {
      if (token.type === 'footnoteDef') {
        written++;
        if (!defs.has(token.label)) defs.set(token.label, token);
      }
      if (token.type === 'footnoteRef' && !cited.includes(token.label)) cited.push(token.label);
    });
    if (defs.size === 0) return null;
    const list = [];
    for (const label of cited) if (defs.has(label)) list.push({ label, token: defs.get(label), cited: true });
    // a note nothing cites still shows, after the cited ones: it is part of what the author wrote
    for (const [label, token] of defs) if (!cited.includes(label)) list.push({ label, token, cited: false });
    list.forEach((note, i) => Object.assign(note, { n: i + 1, text: note.token.text }));

    // every note written at the top level, in one run: the list takes the run's place
    const at = tokens.map((t, i) => (t.type === 'footnoteDef' ? i : -1)).filter((i) => i >= 0);
    const inPlace = at.length === written && tokens.slice(at[0], at.at(-1) + 1).every((t) => t.type === 'footnoteDef' || t.type === 'space');
    return {
      list,
      byLabel: new Map(list.map((note) => [note.label, note])),
      first: inPlace ? tokens[at[0]] : null,
      atEnd: !inPlace,
      placed: false,
    };
  }

  /* ------------------------------ frontmatter ----------------------------- */

  /** Items of a YAML flow list, `[a, "b, c", [d]]`, counted at its top level. */
  function flowCount(value) {
    let depth = 0;
    let quote = null;
    let commas = 0;
    let content = false;
    for (const ch of value) {
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        content = true;
      } else if (ch === '[' || ch === '{') {
        if (depth > 0) content = true;
        depth++;
      } else if (ch === ']' || ch === '}') {
        depth--;
      } else if (ch === ',' && depth === 1) {
        commas++;
      } else if (depth > 0 && !/\s/.test(ch)) {
        content = true;
      }
    }
    return content ? commas + 1 : 0;
  }

  /**
   * What the metadata holds, in one line: the `type`, then how many entries
   * each list has (`sources 87`). Read line by line, not parsed: a summary
   * should never fail on YAML a person is halfway through writing.
   */
  function frontmatterSummary(yaml) {
    const fields = [];
    for (const line of String(yaml ?? '').split(/\r?\n/)) {
      const top = /^([^\s#:-][^:]*):(?:[ \t]+(.*))?$/.exec(line);
      if (top) fields.push({ key: top[1].trim(), value: (top[2] ?? '').trim(), block: [] });
      else if (fields.length && line.trim()) fields.at(-1).block.push(line);
    }
    const parts = [];
    for (const { key, value, block } of fields) {
      if (key === 'type' && value) {
        parts.unshift(value.replace(/^["']|["']$/g, ''));
        continue;
      }
      let n = 0;
      if (value.startsWith('[')) n = flowCount(value);
      else if (!value && block.length) {
        const items = block.filter((l) => /^\s*-(\s|$)/.test(l));
        if (items.length) {
          const indent = Math.min(...items.map((l) => l.search(/\S/)));
          n = items.filter((l) => l.search(/\S/) === indent).length;
        } else {
          // a map of lists, such as relations by predicate: count what it points at
          n = (block.join('\n').match(/\[\[[^\]\n]+\]\]/g) ?? []).length || block.filter((l) => /^\s+[^\s:#-][^:]*:/.test(l)).length;
        }
      }
      if (n > 0) parts.push(`${key} ${n}`);
    }
    return parts;
  }

  /** The YAML as written, with its wikilinks and workspace paths made links. */
  function frontmatterBody(yaml) {
    const out = [];
    let last = 0;
    for (const m of yaml.matchAll(/\[\[([^\]\n]+)\]\]|(?<![\w/.-])((?:raw|wiki)\/[^\s"'<>[\]{},|]+)/g)) {
      out.push(escapeHtml(yaml.slice(last, m.index)));
      if (m[1] !== undefined) {
        const target = m[1].split('|')[0].trim();
        out.push(`<a class="wikilink" href="#" data-wikilink="${escapeHtml(target)}">${escapeHtml(m[0])}</a>`);
      } else {
        out.push(`<a class="path-link" href="#" data-wikilink="${escapeHtml(m[2])}">${escapeHtml(m[2])}</a>`);
      }
      last = m.index + m[0].length;
    }
    out.push(escapeHtml(yaml.slice(last)));
    return out.join('');
  }

  /** Folded unless asked: a page's metadata can run to a hundred lines before its first sentence. */
  function frontmatterHtml(yaml, open) {
    const parts = frontmatterSummary(yaml);
    const lines = yaml.split(/\r?\n/).length;
    const summary = parts.length ? parts.map(escapeHtml).join(' · ') : `${lines} ${lines === 1 ? 'line' : 'lines'}`;
    return `<details class="md-meta"${open ? ' open' : ''}><summary><span class="md-meta-label">metadata</span><span class="md-meta-sum">${summary}</span></summary><pre class="md-meta-body">${frontmatterBody(yaml)}</pre></details>`;
  }

  /* ------------------------------- mentions ------------------------------- */

  const LATIN = /[A-Za-z0-9]/;

  /**
   * Finds, in a run of rendered text, the entity names a view was told about
   * (POST /api/entities/mentions): the longest name wins where several start
   * at one place, and a Latin name counts only as a whole word, the way the
   * service found them in the source.
   */
  function mentionMatcher(mentions) {
    const byFirst = new Map();
    for (const mention of mentions ?? []) {
      for (const surface of mention.surfaces ?? []) {
        if (!surface) continue;
        const list = byFirst.get(surface[0]) ?? byFirst.set(surface[0], []).get(surface[0]);
        list.push({ surface, mention });
      }
    }
    for (const list of byFirst.values()) list.sort((a, b) => b.surface.length - a.surface.length);
    return {
      empty: byFirst.size === 0,
      /** The text cut into `{ text }` and `{ text, mention }` pieces, in order. */
      split(text) {
        const out = [];
        let last = 0;
        let i = 0;
        while (i < text.length) {
          let hit = null;
          for (const c of byFirst.get(text[i]) ?? []) {
            const end = i + c.surface.length;
            if (!text.startsWith(c.surface, i)) continue;
            if (LATIN.test(c.surface[0]) && i > 0 && LATIN.test(text[i - 1])) continue;
            if (LATIN.test(c.surface.at(-1)) && end < text.length && LATIN.test(text[end])) continue;
            hit = c;
            break;
          }
          if (!hit) {
            i++;
            continue;
          }
          if (i > last) out.push({ text: text.slice(last, i) });
          out.push({ text: hit.surface, mention: hit.mention });
          i += hit.surface.length;
          last = i;
        }
        if (last < text.length) out.push({ text: text.slice(last) });
        return out;
      },
    };
  }

  /* ------------------------------- renderer ------------------------------- */

  /** A renderer on its own marked instance, so nothing else that loads marked changes what it lets through. */
  function createMarkdown(marked) {
    if (!marked?.Marked) {
      return { render: (text) => `<pre>${escapeHtml(text)}</pre>` };
    }
    const md = new marked.Marked({ gfm: true });
    md.use({
      tokenizer: {
        // no raw HTML, block or inline: undefined means "not HTML here", so it is read as text
        html() { return undefined; },
        tag() { return undefined; },
      },
      renderer: {
        link(token) {
          const label = this.parser.parseInline(token.tokens);
          const href = safeUrl(token.href);
          if (href === null) return label;
          const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
          return `<a href="${escapeHtml(href)}"${title}>${label}</a>`;
        },
        image(token) {
          const alt = escapeHtml(token.text);
          const src = safeUrl(token.href, { image: true });
          if (src === null) return alt;
          const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
          return `<img src="${escapeHtml(src)}" alt="${alt}"${title}>`;
        },
        codespan(token) {
          // a cited source, `raw/…/2021-06-20.md#e-a822`, opens where it points; a long path shows its last two parts
          if (!WORKSPACE_PATH.test(token.text)) return false;
          const parts = token.text.split('/');
          const label = parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : token.text;
          return `<a class="path-link" href="#" data-wikilink="${escapeHtml(token.text)}" title="${escapeHtml(token.text)}"><code>${escapeHtml(label)}</code></a>`;
        },
        code(token) {
          // a ```chart block is data web/chart.js draws, every string in it escaped; without chart.js it stays code
          const lang = String(token.lang ?? '').trim().toLowerCase().split(/\s+/, 1)[0];
          if (lang !== 'chart' || !global.knodeChart) return false;
          return global.knodeChart.render(token.text);
        },
      },
      extensions: [anchor, footnoteDef, wikilink, footnoteRef],
    });

    /** `opts.metadataOpen` unfolds the frontmatter panel. */
    function render(text, opts = {}) {
      const src = String(text ?? '');
      const fm = FRONTMATTER_RE.exec(src);
      // a `type: MindMap` page is an outline web/mindmap.js draws as its tree; one that holds no tree reads as text
      const map = fm && global.knodeMindmap?.isMindMapYaml(fm[1]) ? global.knodeMindmap.render(src.slice(fm[0].length)) : null;
      if (map) return frontmatterHtml(fm[1], Boolean(opts.metadataOpen)) + map;
      const tokens = md.lexer(fm ? src.slice(fm[0].length) : src);
      notes = collectNotes(md, tokens);
      try {
        let html = md.parser(tokens);
        if (notes && !notes.placed) html += notesHtml(new md.Parser(md.defaults));
        return (fm ? frontmatterHtml(fm[1], Boolean(opts.metadataOpen)) : '') + html;
      } finally {
        notes = null;
      }
    }
    return { render };
  }

  const shared = global.marked ? createMarkdown(global.marked) : null;
  global.knodeMarkdown = {
    createMarkdown,
    safeUrl,
    escapeHtml,
    frontmatterSummary,
    mentionMatcher,
    render: (text, opts) => (shared ?? createMarkdown(global.marked)).render(text, opts),
  };
})(globalThis);
