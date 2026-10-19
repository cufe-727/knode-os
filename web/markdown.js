/* knode-os web UI — Markdown to HTML that is safe to put in the page */
'use strict';

/**
 * Every Markdown view in the UI — files, dream suggestions, chat — renders
 * text that a person, an imported folder or an agent wrote, so what comes out
 * carries formatting and nothing else:
 *
 *   - raw HTML is never parsed: `<script>`, `<img onerror=…>`, `<iframe>` show
 *     up as the text they were written as;
 *   - a link keeps its target only when it is relative or http(s) / mailto
 *     (an image also data:image/…), so a `javascript:` link becomes its label;
 *   - `[[wikilinks]]` become in-app links the file view resolves.
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
      },
      extensions: [wikilink],
    });
    return { render: (text) => md.parse(String(text ?? ''), { async: false }) };
  }

  const shared = global.marked ? createMarkdown(global.marked) : null;
  global.knodeMarkdown = {
    createMarkdown,
    safeUrl,
    escapeHtml,
    render: (text) => (shared ?? createMarkdown(global.marked)).render(text),
  };
})(globalThis);
