/**
 * Reading a long document in parts. A prospectus converted to Markdown runs
 * to tens of thousands of lines — far more than an agent should pull into its
 * context at once — so `knode_read` can return the outline, one section by
 * its heading, or a range of lines, each with enough of a header to say where
 * the slice sits and how to read on.
 */

export interface ReadSlice {
  section?: string;
  offset?: number;
  limit?: number;
  outline?: boolean;
}

const MAX_SLICE_CHARS = 80_000;

interface Heading {
  line: number;
  level: number;
  text: string;
}

function headings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ line: i + 1, level: m[1].length, text: m[2].trim() });
  });
  return out;
}

const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s*_`#:：.,，。'"’“”()（）-]+/g, ' ').trim();

function cap(text: string, from: number, lines: string[], to: number): string {
  if (text.length <= MAX_SLICE_CHARS) return text;
  // cut on a line, and say where to go on
  let size = 0;
  let last = from;
  for (let i = from - 1; i < to; i++) {
    size += lines[i].length + 1;
    if (size > MAX_SLICE_CHARS) break;
    last = i + 1;
  }
  return `${lines.slice(from - 1, last).join('\n')}\n\n…（截断于第 ${last} 行；继续读用 offset=${last + 1}）`;
}

export function readSection(content: string, slice: ReadSlice): string {
  const lines = content.split('\n');
  const all = headings(lines);
  if (slice.outline) {
    const shown = all.slice(0, 400);
    return [
      `${lines.length} lines, ${content.length} characters, ${all.length} headings${all.length > shown.length ? ` (first ${shown.length} shown)` : ''}:`,
      ...shown.map((h) => `${String(h.line).padStart(6)}  ${'  '.repeat(h.level - 1)}${'#'.repeat(h.level)} ${h.text}`),
    ].join('\n');
  }
  if (slice.section !== undefined) {
    const want = fold(slice.section);
    if (!want) throw new Error('section is empty');
    const hit = all.find((h) => fold(h.text) === want) ?? all.find((h) => fold(h.text).startsWith(want)) ?? all.find((h) => fold(h.text).includes(want));
    if (!hit) {
      const near = all.filter((h) => h.level <= 3).slice(0, 60).map((h) => h.text);
      throw new Error(`no heading matches "${slice.section}" — headings: ${near.join(' | ')}${all.length > near.length ? ' …(outline: true lists all)' : ''}`);
    }
    const next = all.find((h) => h.line > hit.line && h.level <= hit.level);
    const end = next ? next.line - 1 : lines.length;
    const body = lines.slice(hit.line - 1, end).join('\n');
    return `（第 ${hit.line}–${end} 行，共 ${lines.length} 行）\n\n${cap(body, hit.line, lines, end)}`;
  }
  const from = Math.max(1, Math.floor(slice.offset ?? 1));
  const count = Math.max(1, Math.floor(slice.limit ?? 400));
  const to = Math.min(lines.length, from + count - 1);
  if (from > lines.length) return `（文档只有 ${lines.length} 行）`;
  const body = lines.slice(from - 1, to).join('\n');
  const more = to < lines.length ? `\n\n…（还有 ${lines.length - to} 行；继续读用 offset=${to + 1}）` : '';
  return `（第 ${from}–${to} 行，共 ${lines.length} 行）\n\n${cap(body, from, lines, to)}${more}`;
}
