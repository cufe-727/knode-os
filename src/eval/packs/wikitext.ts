/**
 * Plain text of a Wikipedia article's wikitext, for the real-wiki-hops pack
 * (docs/design/33 §4): what a reader sees, without markup. Infoboxes become
 * `key: value` lines and tables rows of cells joined by " | ", because the
 * facts multi-hop questions ask for (a date of birth, a population, a
 * draft pick's batting hand) mostly live there; date and conversion templates
 * become their text; references, files, categories and navigation templates
 * go. No parser of Wikipedia's own is involved — a reader of the wikitext.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Splits at `sep` outside [[…]], {{…}} and {|…|}. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const two = s.slice(i, i + 2);
    if (two === '{{' || two === '[[') {
      depth++;
      cur += two;
      i++;
      continue;
    }
    if ((two === '}}' || two === ']]') && depth > 0) {
      depth--;
      cur += two;
      i++;
      continue;
    }
    if (depth === 0 && s.startsWith(sep, i)) {
      out.push(cur);
      cur = '';
      i += sep.length - 1;
      continue;
    }
    cur += s[i];
  }
  out.push(cur);
  return out;
}

/** A date template's numeric parameters as a date: 1950|5|1 → 1950-05-01 (May 1, 1950 with words). */
function dateOf(params: string[]): string {
  const nums = params.filter((p) => !p.includes('=')).map((p) => p.trim()).filter((p) => /^\d{1,4}$/.test(p));
  const [y, m, d] = nums;
  if (!y) return params.filter((p) => !p.includes('=')).join(' ').trim();
  if (!m) return y;
  const month = MONTHS[Number(m) - 1] ?? m;
  return d ? `${month} ${Number(d)}, ${y}` : `${month} ${y}`;
}

const KEEP_FIRST = new Set(['lang', 'nowrap', 'nobr', 'small', 'big', 'abbr', 'flag', 'flagcountry', 'flagicon', 'flagu', 'sic', 'avoid wrap', 'nowr', 'ill', 'interlanguage link', 'not a typo', 'proper name', 'visible anchor', 'vanchor', 'linktext', 'mvar', 'math', 'var', 'em', 'strong', 'nbsp', 'resize', 'transliteration', 'transl', 'lang-zh', 'nihongo', 'korean', 'zh', 'party name with color', 'party color cell', 'tooltip', 'abbrlink', 'section link', 'small caps', 'smallcaps', 'sortname', 'player', 'flagathlete', 'fb', 'sports', 'cricon']);
const LISTS = new Set(['ubl', 'unbulleted list', 'plainlist', 'flatlist', 'hlist', 'bulleted list', 'ublist', 'collapsible list', 'plain list', 'flat list', 'enum', 'ordered list', 'unordered list', 'pagelist']);
const DATES = /^(birth date( and age)?|death date( and age)?|birth year and age|death year and age|start date( and age)?|end date|date|dts|film date|release date|start and end dates|bda|dda|b-da|d-da|birth-date|death-date|date and age)$/;

function template(inner: string): string {
  const parts = splitTop(inner, '|');
  const name = parts[0].trim().toLowerCase().replace(/_/g, ' ').replace(/^template:/, '');
  const args = parts.slice(1);
  const positional = args.filter((a) => !/^\s*[\w\s-]+\s*=/.test(a)).map((a) => a.trim());
  if (name.startsWith('infobox') || name.startsWith('taxobox') || name.startsWith('speciesbox') || name === 'chembox' || name.startsWith('drugbox')) {
    const rows = args.map((a) => a.match(/^\s*([^=]+?)\s*=\s*([\s\S]*)$/)).filter((m): m is RegExpMatchArray => Boolean(m)).map((m) => [m[1].replace(/_/g, ' '), inline(m[2]).trim().replace(/\s*\n\s*/g, '; ')]).filter(([k, v]) => v && !/^(image|logo|caption|alt|signature|image_size|imagesize|upright|module|embed|map|pushpin|coordinates|website|footnotes)/i.test(k));
    const title = parts[0].trim().replace(/^infobox\s*/i, '');
    return `\n\n[Infobox${title ? ` ${title}` : ''}]\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n`;
  }
  if (DATES.test(name)) return dateOf(args);
  if (name === 'convert' || name === 'cvt') return positional.slice(0, 2).join(' ');
  if (name === 'circa' || name === 'c.') return `c. ${positional[0] ?? ''}`;
  if (name === 'sortname') return positional.slice(0, 2).join(' ');
  if (name === 'ill' || name === 'interlanguage link') return positional[0] ?? '';
  if (name === 'us$' || name === 'usd' || name === 'currency') return `$${positional[0] ?? ''}`;
  if (name === 'inflation' || name === 'formatnum' || name === 'nts' || name === 'ntsh' || name === 'val') return positional.find((p) => /\d/.test(p)) ?? '';
  if (name === 'efn' || name === 'refn' || name === 'sfn' || name.startsWith('cite') || name.startsWith('citation') || name === 'r' || name === 'rp') return '';
  if (LISTS.has(name)) return positional.map((p) => inline(p).replace(/^\*\s*/gm, '').trim()).filter(Boolean).join('; ');
  if (name === 'flagicon' || name === 'flagicon image') return '';
  if (KEEP_FIRST.has(name) || name.startsWith('lang-') || name.startsWith('flag')) return positional.length ? (name.startsWith('lang') && positional.length > 1 ? positional[1] : positional[0]) : '';
  if (name === 'abbr' || name === 'tooltip') return positional[0] ?? '';
  if (/^(main|see also|further|about|redirect|distinguish|for|other uses|use \w+|short description|good article|featured article|pp|coord|reflist|notelist|portal|commons|authority control|defaultsort|toc|clear|stub)/.test(name)) return '';
  if (name.endsWith('navbox') || name.endsWith('sidebar') || /\bnavbox\b|\bsidebar\b/.test(name)) return '';
  // other templates: their text when it is all they hold, otherwise nothing
  return positional.length === 1 && positional[0].length < 120 && !/^[\w\s-]*=/.test(positional[0]) && name.length <= 3 ? positional[0] : '';
}

/** Expands templates innermost first. */
function expandTemplates(s: string): string {
  for (let guard = 0; guard < 50 && s.includes('{{'); guard++) {
    const next = s.replace(/\{\{((?:(?!\{\{|\}\})[\s\S])*)\}\}/g, (_, inner: string) => template(inner));
    if (next === s) break;
    s = next;
  }
  return s.replace(/\{\{|\}\}/g, '');
}

/** Links, emphasis and tags of a span of text. */
function inline(s: string): string {
  return s
    .replace(/\[\[(?:file|image|category|media):[^[\]]*(?:\[\[[^\]]*\]\][^[\]]*)*\]\]/gi, '')
    .replace(/\[\[([^|\]]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[(?:https?:)?\/\/[^\s\]]+\s+([^\]]+)\]/g, '$1')
    .replace(/\[(?:https?:)?\/\/[^\s\]]+\]/g, '')
    .replace(/'''''|'''|''/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/** A cell's content without its attributes (`style="…" | content`). */
function cell(c: string): string {
  const parts = splitTop(c, '|');
  const content = parts.length > 1 && /=|^\s*$/.test(parts[0]) && !parts[0].includes('[[') ? parts.slice(1).join('|') : c;
  return inline(content).replace(/\s*\n\s*/g, ' ').trim();
}

/** A table as lines of cells: a caption, then each row's cells joined by " | ". */
function table(body: string): string {
  const lines = body.split('\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let caption = '';
  for (const raw of lines.slice(1)) {
    const l = raw.trim();
    if (l.startsWith('|}')) break;
    if (l.startsWith('|+')) caption = cell(l.slice(2));
    else if (l.startsWith('|-')) {
      if (row.length) rows.push(row);
      row = [];
    } else if (l.startsWith('!')) row.push(...splitTop(l.slice(1), '!!').flatMap((c) => splitTop(c, '||')).map(cell));
    else if (l.startsWith('|')) row.push(...splitTop(l.slice(1), '||').map(cell));
    else if (row.length) row[row.length - 1] += ` ${inline(l)}`;
  }
  if (row.length) rows.push(row);
  return `\n${caption ? `[Table: ${caption}]\n` : ''}${rows.map((r) => r.filter((c) => c !== '').join(' | ')).filter(Boolean).join('\n')}\n`;
}

/** Tables innermost first (a table may hold one). */
function expandTables(s: string): string {
  for (let guard = 0; guard < 20 && s.includes('{|'); guard++) {
    const next = s.replace(/(^|\n)\s*\{\|((?:(?!\n\s*\{\|)[\s\S])*?)\n\s*\|\}/g, (_, pre: string, inner: string) => `${pre}${table(`{|${inner}\n|}`)}`);
    if (next === s) break;
    s = next;
  }
  return s;
}

export function wikitextToText(wikitext: string): string {
  let s = wikitext.replace(/\r/g, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<ref[^>/]*\/>/gi, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  s = s.replace(/<(gallery|timeline|math|score|syntaxhighlight|imagemap|mapframe|graph)[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = expandTemplates(s);
  s = expandTables(s);
  // list marks before headings: a heading comes out starting with "#"
  s = s.replace(/^[*#:;]+\s*/gm, '- ');
  s = s.replace(/^(=+)\s*(.*?)\s*\1\s*$/gm, (_, eq: string, h: string) => `\n${'#'.repeat(Math.min(6, eq.length))} ${inline(h)}\n`);
  s = inline(s);
  s = s.replace(/__[A-Z]+__/g, '');
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^(- \s*\n)+/gm, '')
    .trim();
}
