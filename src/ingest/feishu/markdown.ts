/**
 * Feishu documents as the Markdown knode-os keeps.
 *
 * lark-cli's `docs +fetch --doc-format markdown` returns Markdown with Lark's
 * own blocks left as tags: the title in `<title>`, pictures as
 * `![](https://<host>/file/<token>)` (or `<img token=…>`), attachments as
 * `<source name mime size token/>`, side-by-side columns as `<grid>` /
 * `<column>`, embedded bases and sheets as `<bitable>` / `<sheet>`, boards as
 * `<whiteboard>`. Here a document is read for what it references (so the
 * pictures and attachments can be downloaded next to it) and written back with
 * those references pointing at the local copies and every other tag reduced to
 * its text — never dropped silently: an embedded base or sheet stays as a link
 * back to Feishu.
 */

/** A document reference as a person pastes it. */
export interface FeishuRef {
  kind: 'docx' | 'wiki';
  token: string;
  /** The tenant host the link was on (my.feishu.cn, xxx.larksuite.com); null for a bare token. */
  host: string | null;
}

const TOKEN = /^[A-Za-z0-9]{16,64}$/;
const HOSTS = /(^|\.)(feishu\.cn|feishu\.net|larksuite\.com|larkoffice\.com|larksuite\.cn)$/i;

/** Kinds of Feishu links knode-os does not import (yet), with what they are, for the refusal. */
const UNSUPPORTED: Record<string, string> = {
  doc: 'an old-format Doc (open it in Feishu and upgrade it to the new Docs first)',
  docs: 'an old-format Doc (open it in Feishu and upgrade it to the new Docs first)',
  sheets: 'a Sheet',
  base: 'a Base',
  bitable: 'a Base',
  mindnotes: 'a Mindnote',
  slides: 'a Slides deck',
  file: 'an uploaded file (download it and import the file instead)',
  drive: 'a Drive folder',
  minutes: 'a Minutes recording',
};

/**
 * Read a Feishu document link — `https://<tenant>.feishu.cn/docx/<token>`,
 * `/wiki/<token>`, the Lark equivalents — or a bare docx token.
 */
export function parseFeishuRef(input: string): FeishuRef {
  const text = String(input ?? '').trim();
  if (!text) throw new Error('a Feishu document link is required');
  if (TOKEN.test(text)) return { kind: 'docx', token: text, host: null };
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error(`not a Feishu link: ${text}`);
  }
  if (!HOSTS.test(url.hostname)) throw new Error(`not a Feishu or Lark link: ${url.hostname}`);
  const segments = url.pathname.split('/').filter(Boolean);
  for (let i = 0; i < segments.length - 1; i++) {
    const kind = segments[i].toLowerCase();
    const token = segments[i + 1];
    if (!TOKEN.test(token)) continue;
    if (kind === 'docx' || kind === 'wiki') return { kind, token, host: url.hostname.toLowerCase() };
    if (UNSUPPORTED[kind]) throw new Error(`${text} is ${UNSUPPORTED[kind]} — only Feishu Docs (docx), directly or in a wiki, can be imported`);
  }
  throw new Error(`no document in ${text} — paste the link of a Feishu Docs page (…/docx/… or …/wiki/…)`);
}

/** Something a document references that lives in Feishu, not in its text. */
export interface FeishuMedia {
  token: string;
  kind: 'image' | 'file' | 'whiteboard';
  /** An attachment's own file name. */
  name?: string;
  mime?: string;
  bytes?: number;
}

/** Where a referenced item went: a path relative to the document, or null when it stays in Feishu. */
export type PlaceMedia = (media: FeishuMedia) => { href: string } | null;

export interface RenderedDocument {
  title: string;
  /** The body as knode-os keeps it (no frontmatter, no title heading). */
  body: string;
  /** Everything referenced, in document order, each token once. */
  media: FeishuMedia[];
}

const decodeEntities = (s: string): string =>
  s.replace(/&(amp|lt|gt|quot|apos|#39|#x27);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'" })[e] ?? _);

/** The attributes of one tag, decoded. */
function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_][\w-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? '');
  return out;
}

const fileTokenOf = (url: string): string | null => /\/file\/([A-Za-z0-9]{16,64})(?:[/?#]|$)/.exec(url)?.[1] ?? null;

export function formatBytes(n: number | undefined): string {
  if (!n || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const extOf = (name: string | undefined) => /\.([A-Za-z0-9]{1,8})$/.exec(name ?? '')?.[1].toUpperCase() ?? '';

/** Markdown link text cannot hold an unescaped bracket. */
const label = (s: string) => s.replace(/([[\]])/g, '\\$1');

/** The tags lark-cli's Markdown can carry; any other `<…>` is the document's own text. */
const LARK_TAGS = new Set([
  'title', 'grid', 'column', 'figure', 'source', 'img', 'whiteboard', 'sheet', 'bitable', 'cite', 'file',
  'callout', 'quote', 'quote-container', 'mention', 'mention-user', 'mention-doc', 'okr', 'latex',
  'vc-transcribe-tab', 'synced_reference', 'fragment', 'excerpt', 'checkbox', 'todo',
  'p', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'a', 'code', 'pre', 'br', 'hr',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8', 'h9',
]);

/** Tags whose content is a block of its own: they end a line. */
const BLOCK_TAGS = new Set(['grid', 'column', 'figure', 'callout', 'quote', 'quote-container', 'p', 'div', 'ul', 'ol', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8', 'h9', 'synced_reference', 'fragment', 'excerpt', 'vc-transcribe-tab']);

/** Inline formatting, opening and closing alike. */
const INLINE_MARKS: Record<string, string> = { b: '**', strong: '**', i: '*', em: '*', s: '~~', del: '~~', code: '`' };

const TAG = /<\/?[a-zA-Z][\w-]*(?:\s+[^<>]*?)?\s*\/?>/g;
const IMAGE = /!\[([^\]]*)\]\(\s*(https?:\/\/[^\s)]+)\s*\)/g;

/**
 * An HTML table — what lark-cli writes for a table GFM cannot hold, such as
 * merged cells — as a GFM table, each cell's text read like the rest of the
 * document. A merged cell keeps its text once; the table's shape is lost, its
 * content is not.
 */
function htmlTable(html: string, cell: (text: string) => string): string {
  const rows: string[][] = [];
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
      cell(c[1]).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim(),
    );
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return cell(html);
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
  return ['', line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line), ''].join('\n');
}

/**
 * Turn lark-cli's Markdown into knode-os's: `place` says where each picture,
 * attachment and board went. Called once with a `place` that records only, to
 * learn what to download, and again once the downloads are in.
 */
export function renderFeishuMarkdown(content: string, place: PlaceMedia, opts: { host?: string | null } = {}): RenderedDocument {
  const host = opts.host || 'feishu.cn';
  let title = '';
  const media: FeishuMedia[] = [];
  const seen = new Set<string>();
  const note = (m: FeishuMedia) => {
    if (seen.has(m.token)) return;
    seen.add(m.token);
    media.push(m);
  };

  const image = (token: string, alt: string, fallback: string): string => {
    const m: FeishuMedia = { token, kind: 'image' };
    note(m);
    const placed = place(m);
    return `![${label(alt)}](${placed ? placed.href : fallback})`;
  };

  /** One tag outside code: what it becomes. A tag Lark does not write is left as written. */
  const tag = (raw: string): string => {
    const name = /^<\/?\s*([a-zA-Z][\w-]*)/.exec(raw)?.[1].toLowerCase() ?? '';
    if (!LARK_TAGS.has(name)) return raw;
    const closing = raw.startsWith('</');
    if (INLINE_MARKS[name]) return INLINE_MARKS[name];
    if (name === 'a') return closing ? `](${linkStack.pop() ?? ''})` : (linkStack.push(attrsOf(raw).href ?? ''), '[');
    if (closing) return BLOCK_TAGS.has(name) ? '\n' : '';
    const a = attrsOf(raw);
    switch (name) {
      case 'img': {
        const token = a.token || fileTokenOf(a.src ?? '') || '';
        if (!token) return a.src ? `![${label(a.alt ?? '')}](${a.src})` : '';
        return image(token, a.alt ?? a.name ?? '', a.src || `https://${host}/file/${token}`);
      }
      case 'source': {
        if (!a.token) return a.name ? `Attachment: ${a.name}` : '';
        const m: FeishuMedia = { token: a.token, kind: 'file', name: a.name || a.token, mime: a.mime, bytes: Number(a.size) || undefined };
        note(m);
        const placed = place(m);
        if (placed) return `Attachment: [${label(m.name!)}](${placed.href})`;
        const size = [extOf(m.name), formatBytes(m.bytes)].filter(Boolean).join(', ');
        return `Attachment: ${m.name}${size ? ` (${size})` : ''} — kept in Feishu, not imported`;
      }
      case 'whiteboard': {
        if (!a.token) return '';
        const m: FeishuMedia = { token: a.token, kind: 'whiteboard' };
        note(m);
        const placed = place(m);
        return placed ? `![Whiteboard](${placed.href})` : `Whiteboard — kept in Feishu, not imported`;
      }
      case 'bitable':
        return a.token ? `Base table — kept in Feishu: [open it](https://${host}/base/${a.token}${a['table-id'] ? `?table=${a['table-id']}` : ''})` : '';
      case 'sheet':
        return a.token ? `Sheet — kept in Feishu: [open it](https://${host}/sheets/${a.token}${a['sheet-id'] ? `?sheet=${a['sheet-id']}` : ''})` : '';
      case 'br':
      case 'hr':
        return name === 'hr' ? '\n---\n' : '\n';
      case 'li':
        return '\n- ';
      default:
        // <grid>, <column>, <figure>, <cite>, <callout>, mentions…: the text inside them stays
        return BLOCK_TAGS.has(name) ? '\n' : '';
    }
  };
  const linkStack: string[] = [];

  /** One run of text outside code spans. */
  const prose = (text: string): string =>
    text
      .replace(/<title>([\s\S]*?)<\/title>/gi, (_, t: string) => {
        title ||= decodeEntities(t.trim());
        return '';
      })
      .replace(/<latex>([\s\S]*?)<\/latex>/gi, (_, t: string) => `$${decodeEntities(t.trim())}$`)
      .replace(IMAGE, (whole, alt: string, url: string) => {
        const token = fileTokenOf(url);
        return token ? image(token, alt, url) : whole;
      })
      .replace(TAG, (raw) => tag(raw));

  const out: string[] = [];
  let fence: string | null = null;
  let table: string[] | null = null;
  for (const line of content.split(/\r?\n/)) {
    if (table) {
      table.push(line);
      if (/<\/table>/i.test(line)) {
        out.push(htmlTable(table.join('\n'), prose));
        table = null;
      }
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence && /<table[\s>]/i.test(line)) {
      if (/<\/table>/i.test(line)) out.push(htmlTable(line, prose));
      else table = [line];
      continue;
    }
    if (fence) {
      out.push(line);
      if (open && open[0] === fence[0] && open.length >= fence.length && line.trim() === open) fence = null;
      continue;
    }
    if (open) {
      fence = open;
      out.push(line);
      continue;
    }
    // inline code keeps its tags as written
    const parts = line.split(/(`+[^`]*`+)/);
    out.push(parts.map((p, i) => (i % 2 === 1 ? p : prose(p))).join(''));
  }

  if (table) out.push(htmlTable(table.join('\n'), prose));
  const body = out
    .join('\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, (ws) => (ws.length >= 2 ? '  ' : '')))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, body, media };
}

/** What a document references, before anything is downloaded. */
export function scanFeishuMarkdown(content: string): RenderedDocument {
  return renderFeishuMarkdown(content, () => null);
}
