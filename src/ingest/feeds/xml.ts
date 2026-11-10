/**
 * A small, forgiving XML reader for feeds (RSS 2.0, RSS 1.0/RDF, Atom, the
 * arXiv API): elements, attributes, text and CDATA, the predefined and
 * numeric entities. No DTDs, no external entities (so nothing to expand or
 * fetch), no validation. Element names keep their prefix (`dc:creator`);
 * `local()` matches without it. An HTML parser would not do: it treats
 * `<link>` as a void element, and RSS puts the URL inside it.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Text directly inside, CDATA included, children's text not. */
  text: string;
  /** Text and child elements in document order (mixed content). */
  nodes: Array<string | XmlElement>;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ent.toLowerCase()] ?? whole;
  });
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

/** Parse a document; returns a synthetic root whose children are the top-level elements. */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: '#root', attrs: {}, children: [], text: '', nodes: [] };
  const stack: XmlElement[] = [root];
  const addText = (el: XmlElement, t: string) => {
    if (!t) return;
    el.text += t;
    const last = el.nodes[el.nodes.length - 1];
    if (typeof last === 'string') el.nodes[el.nodes.length - 1] = last + t;
    else el.nodes.push(t);
  };
  const src = xml.replace(/^﻿/, '');
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      addText(top, decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i) addText(top, decodeEntities(src.slice(i, lt)));
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      addText(top, src.slice(lt + 9, end < 0 ? src.length : end));
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt + 2);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    // find the tag's end, skipping '>' inside quoted attribute values
    let j = lt + 1;
    let quote = '';
    while (j < src.length) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    const body = src.slice(lt + 1, j);
    i = j + 1;
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      // close up to the matching element; a stray close tag is ignored
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameEnd = inner.search(/[\s/]/);
    const name = (nameEnd < 0 ? inner : inner.slice(0, nameEnd)).trim();
    if (!name) continue;
    const el: XmlElement = { name, attrs: nameEnd < 0 ? {} : parseAttrs(inner.slice(nameEnd)), children: [], text: '', nodes: [] };
    top.children.push(el);
    top.nodes.push(el);
    if (!selfClosing) stack.push(el);
  }
  return root;
}

/** The name without its namespace prefix, lower-cased. */
export function local(name: string): string {
  const at = name.indexOf(':');
  return (at >= 0 ? name.slice(at + 1) : name).toLowerCase();
}

export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!el) return undefined;
  const want = name.toLowerCase();
  return el.children.find((c) => c.name.toLowerCase() === want) ?? (want.includes(':') ? undefined : el.children.find((c) => local(c.name) === want));
}

export function children(el: XmlElement | undefined, name: string): XmlElement[] {
  if (!el) return [];
  const want = name.toLowerCase();
  return el.children.filter((c) => c.name.toLowerCase() === want || (!want.includes(':') && local(c.name) === want));
}

/** All text inside, depth first (for an element that holds inline markup). */
export function textOf(el: XmlElement | undefined): string {
  if (!el) return '';
  const all = (e: XmlElement): string => e.nodes.map((n) => (typeof n === 'string' ? n : all(n))).join('');
  return all(el).trim();
}

/** Every element with this local name, at any depth. */
export function findAll(el: XmlElement, name: string): XmlElement[] {
  const want = name.toLowerCase();
  const out: XmlElement[] = [];
  const visit = (e: XmlElement) => {
    for (const c of e.children) {
      if (local(c.name) === want) out.push(c);
      visit(c);
    }
  };
  visit(el);
  return out;
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The markup inside an element, serialized again (Atom's type="xhtml" content). */
export function innerXml(el: XmlElement | undefined): string {
  if (!el) return '';
  const inner = (e: XmlElement): string => e.nodes.map((n) => (typeof n === 'string' ? escapeText(n) : out(n))).join('');
  const out = (e: XmlElement): string => {
    const attrs = Object.entries(e.attrs).filter(([k]) => !k.startsWith('xmlns')).map(([k, v]) => ` ${local(k)}="${escapeText(v).replace(/"/g, '&quot;')}"`).join('');
    return `<${local(e.name)}${attrs}>${inner(e)}</${local(e.name)}>`;
  };
  return inner(el);
}
