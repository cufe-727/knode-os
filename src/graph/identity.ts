/**
 * What tells one thing from another of the same name, read from what an
 * extraction records for a mention — its spellings, the relations it states
 * and the entities of its document. Three kinds of evidence, the strongest
 * first:
 *
 *   code     an identifier among the mention's spellings (D7T1-C1, R-71,
 *            600519.SH): letters and digits in one token. Two mentions whose
 *            codes have the same shape (digit runs aside) and differ are two
 *            things — when the context agrees (see below).
 *   owner    the target of a hierarchical relation the mention's document
 *            states for it (member_of, part_of, subsidiary_of …): its team or
 *            parent.
 *   anchors  the organizations and projects its document names.
 *
 * Owners and anchors alone never part a name: on finance (27,398 extractions,
 * 2026-11-14) 1,848 names have two or more owners — a company is a member of
 * several indices, a product part of several chains, a person on two boards —
 * and 325 names carry two codes of one shape, most of them an extraction
 * listing kinds as aliases (芯片: H100, H200 …) or one ticker padded two ways
 * (00700.HK, 700.HK). So a code parts a name only where its documents stand
 * under another roof than the other code's (entity-context.ts), and owners
 * and anchors choose among the entities a name was already parted into.
 */

import { normalizePredicate, Ontology, relationSpec } from './ontology.js';

/** An identifier among an entity's spellings. */
export interface Code {
  /** The identifier with its digit runs taken out: D#T#-C#. */
  shape: string;
  /** Upper case, leading zeros of a digit run dropped: 00700.HK and 700.HK are one. */
  value: string;
  raw: string;
}

const CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$/;

/** The code a spelling is, or null: one token of 3–24 Latin letters and digits (. _ / - inside), with at least one of each. */
export function codeOf(spelling: string): Code | null {
  const raw = spelling.normalize('NFKC').trim();
  if (raw.length < 3 || raw.length > 24 || !CODE.test(raw) || !/[A-Za-z]/.test(raw) || !/\d/.test(raw)) return null;
  const value = raw.toUpperCase().replace(/\d+/g, (d) => d.replace(/^0+(?=\d)/, ''));
  return { shape: value.replace(/\d+/g, '#'), value, raw };
}

/** The codes that identify what carries them: shape → code. */
export type Codes = Map<string, Code>;

/**
 * The codes among some spellings that identify the thing: one per shape. A
 * shape with two values names kinds or parts of the thing, not the thing
 * (芯片 with H100 and H200), and a code another one ends with is that one
 * cut short (T1-C1 beside D9T1-C1 — an extraction repeats a known name).
 */
export function codesOf(spellings: readonly (string | null | undefined)[]): Codes {
  const byShape = new Map<string, Map<string, Code>>();
  for (const s of spellings) {
    const c = typeof s === 'string' ? codeOf(s) : null;
    if (!c) continue;
    const values = byShape.get(c.shape) ?? byShape.set(c.shape, new Map()).get(c.shape)!;
    if (!values.has(c.value)) values.set(c.value, c);
  }
  const single = [...byShape.values()].filter((v) => v.size === 1).map((v) => [...v.values()][0]);
  const out: Codes = new Map();
  for (const c of single) {
    if (single.some((o) => o !== c && o.value.length > c.value.length && o.value.endsWith(c.value))) continue;
    out.set(c.shape, c);
  }
  return out;
}

/** Whether both carry the same code. */
export function sharesCode(a: Codes, b: Codes): boolean {
  for (const [shape, c] of a) if (b.get(shape)?.value === c.value) return true;
  return false;
}

/**
 * Whether two codes could be two things' identifiers of one kind: the same
 * shape with different values (D7T1-C1, D2T1-C1), or one the other with
 * something in front (T1-C1, D2T1-C1 — the first division wrote no prefix).
 */
export function codesDiffer(a: Code, b: Code): boolean {
  if (a.value === b.value) return false;
  if (a.shape === b.shape) return true;
  const [short, long] = a.value.length < b.value.length ? [a, b] : [b, a];
  return long.value.endsWith(short.value);
}

/** The code of `a` that says it is not what carries `b`: one that differs from a code of `b`, when the two have no code in common. */
export function conflictingCode(a: Codes, b: Codes): Code | null {
  if (a.size === 0 || b.size === 0 || sharesCode(a, b)) return null;
  for (const c of a.values()) for (const other of b.values()) if (codesDiffer(c, other)) return c;
  return null;
}

/**
 * Whether two things' codes say they may not be one. Not proof by itself — a
 * short code may be the long one cut short, an alias list may hold kinds —
 * which is why the documents must agree (resolve.ts, entity-context.ts).
 */
export function codesConflict(a: Codes, b: Codes): boolean {
  return conflictingCode(a, b) !== null;
}

/** One line a cache can key a mention's codes by. */
export function codesKey(codes: Codes): string {
  return [...codes.values()].map((c) => c.value).sort().join(',');
}

/** What a mention's document says about it, beside its spellings. */
export interface MentionContext {
  /** Names of its team or parent: targets of the hierarchical relations its document states for it. */
  owners?: readonly string[];
  /** Every name and alias the document's extraction lists. */
  documentNames?: ReadonlySet<string>;
  /** The organization or project the document's own hierarchical relations mostly point at, if any: whose report it is. */
  home?: string | null;
  /** The document being written (its path), for the record of a split. */
  documentPath?: string | null;
  documentId?: string | null;
}

/** One of the entities a name was parted into, beside the base entity that keeps the name (entity_namesakes). */
export interface NamesakeRule {
  id: string;
  base_id: string;
  name: string;
  label: string;
  anchors: string[];
  base_anchors: string[];
}

const lower = (s: string) => s.trim().toLowerCase();

/** The name a parted entity is written under. */
export function namesakeName(rule: Pick<NamesakeRule, 'name' | 'label'>): string {
  return `${rule.name}（${rule.label}）`;
}

/**
 * Which of a parted name's entities a mention means, or null for the base
 * entity that keeps the name. In this order:
 *
 *   1. the one labelled with a code the mention carries;
 *   2. the one whose anchors name the mention's own team or parent, when the
 *      base entity's do not;
 *   3. the one whose anchors the document names most, if it names more of
 *      them than of the base entity's, and of no other as many.
 *
 * A code that is the base entity's own gives nothing over 2 and 3: an
 * extraction that was shown the base entity's name repeats it for whichever
 * of them the document means.
 */
export function namesakeFor(rules: readonly NamesakeRule[], mention: { codes: Codes; context?: MentionContext }): NamesakeRule | null {
  if (rules.length === 0) return null;
  for (const r of rules) {
    const label = codeOf(r.label);
    if (label && mention.codes.get(label.shape)?.value === label.value) return r;
  }
  const baseAnchors = new Set(rules[0].base_anchors.map(lower));
  const pick = (names: ReadonlySet<string>): NamesakeRule | null => {
    const score = (anchors: Iterable<string>) => {
      let n = 0;
      for (const a of anchors) if (names.has(lower(a))) n++;
      return n;
    };
    const base = score(baseAnchors);
    const scored = rules.map((rule) => ({ rule, s: score(rule.anchors) })).filter((x) => x.s > 0 && x.s > base).sort((x, y) => y.s - x.s);
    if (scored.length === 0 || (scored.length > 1 && scored[1].s === scored[0].s)) return null;
    return scored[0].rule;
  };
  const owners = new Set((mention.context?.owners ?? []).map(lower));
  if (owners.size > 0) {
    const byOwner = pick(owners);
    if (byOwner) return byOwner;
  }
  return mention.context?.documentNames ? pick(mention.context.documentNames) : null;
}

/** Organizations and projects: the roofs a thing stands under. */
export const ANCHOR_TYPES: readonly string[] = ['organization', 'project'];

/** What one document's extraction says about each of its mentions. */
export interface DocumentContext {
  documentNames: ReadonlySet<string>;
  home: string | null;
  /** The context of the mention of `name` in this document. */
  of(name: string): MentionContext;
}

/**
 * The context one extraction gives its mentions. A mention's owners are the
 * targets of the hierarchical relations stated for it (the ontology's
 * `hierarchical` predicates, an inverse spelling read the right way round).
 * The document's home is the organization or project most of its
 * hierarchical relations point at — a team's report states its members —
 * when two or more do and no other gets as many.
 */
export function documentContext(
  entities: readonly { name: string; type: string; aliases?: string[] }[],
  relations: readonly { source: string; target: string; type: string }[],
  ontology: Ontology,
  doc: { path?: string | null; id?: string | null } = {},
): DocumentContext {
  const documentNames = new Set(entities.flatMap((e) => [e.name, ...(e.aliases ?? [])]).filter((n) => typeof n === 'string').map(lower));
  const named = new Map<string, { name: string; type: string; aliases?: string[] }>();
  for (const e of entities) for (const n of [e.name, ...(e.aliases ?? [])]) if (typeof n === 'string' && !named.has(lower(n))) named.set(lower(n), e);
  const owners = new Map<string, string[]>();
  const pointedAt = new Map<string, number>();
  for (const r of relations) {
    if (typeof r.source !== 'string' || typeof r.target !== 'string' || typeof r.type !== 'string') continue;
    const norm = normalizePredicate(ontology, r.type);
    if (!relationSpec(ontology, norm.type)?.hierarchical) continue;
    const [child, owner] = norm.flip ? [r.target, r.source] : [r.source, r.target];
    const ownerName = named.get(lower(owner))?.name ?? owner.trim();
    const list = owners.get(lower(child)) ?? owners.set(lower(child), []).get(lower(child))!;
    if (!list.includes(ownerName)) list.push(ownerName);
    if (ANCHOR_TYPES.includes(named.get(lower(owner))?.type ?? '')) pointedAt.set(ownerName, (pointedAt.get(ownerName) ?? 0) + 1);
  }
  const ranked = [...pointedAt.entries()].sort((a, b) => b[1] - a[1]);
  const home = ranked.length > 0 && ranked[0][1] >= 2 && (ranked.length === 1 || ranked[1][1] < ranked[0][1]) ? ranked[0][0] : null;
  return {
    documentNames,
    home,
    of: (name) => {
      const e = named.get(lower(name));
      const own = new Set<string>();
      for (const n of e ? [e.name, ...(e.aliases ?? [])] : [name]) for (const o of owners.get(lower(n)) ?? []) own.add(o);
      return { owners: [...own], documentNames, home, documentPath: doc.path ?? null, documentId: doc.id ?? null };
    },
  };
}
