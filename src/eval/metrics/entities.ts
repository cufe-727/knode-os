import type { GoldAlias, KnowledgeUnit } from '../types.js';
import { normalizeAnswer } from './text.js';

/**
 * Entity resolution scored without a model (docs/design/28 §4): B-cubed
 * precision and recall of the entity clusters a system exported against the
 * pack's gold alias clusters.
 *
 * Every name of every real entity is an item: (entity, name). A system
 * entity claims the names in its title (and in a parenthesis such as
 * "Orion (formerly Atlas)") and those its text lists on an alias line
 * ("aliases: …", "别名：…", "formerly …"). An item belongs to the system
 * entity that claims its name; a name two real entities share (namesakes)
 * goes to the claiming entity whose title or text names that entity's
 * context (its team), and to the first claimant when none does. An item no
 * system entity claims is a cluster of its own.
 *
 * B-cubed precision of an item: the share of its system cluster that is the
 * same real entity; recall: the share of the real entity's names in its
 * system cluster. Both are averaged over the items of the real entities the
 * system found at all (`found` is that share of entities), so a system is
 * not scored on entities it never extracted — `found` reports those.
 */

export interface EntityResolution {
  precision: number;
  recall: number;
  f1: number;
  /** Gold entities with at least one name claimed by a system entity, over all gold entities. */
  found: number;
  /** Gold entities found. */
  n: number;
  /** System entities holding names of two or more real entities. */
  merged: number;
  /** Real entities whose names are split over two or more system entities. */
  split: number;
}

const norm = (s: string) => normalizeAnswer(s).replace(/\s+/g, '');

const ALIAS_LINE = /^(?:[-*]\s*)?(?:\*\*)?(?:aliases?|also known as|aka|formerly|previously|renamed(?: to)?|别名|又称|又名|曾用名|原名|旧称|简称|改名为|更名为)(?:\*\*)?\s*[:：]?\s*(.+)$/gim;

/** The names a system entity claims: its title, a parenthesis in it, and its alias lines. */
export function claimedNames(u: Pick<KnowledgeUnit, 'title' | 'text'>): string[] {
  const title = (u.title ?? '').replace(/^.*\//, '').replace(/\.md$/i, '').trim();
  const names = new Set<string>();
  const add = (x: string) => {
    const t = x.replace(/^(?:formerly|previously|原名|原|旧称|aka|又称)\s*/i, '').replace(/[“”"'《》]/g, '').trim();
    if (t && t.length <= 60) names.add(t);
  };
  const paren = title.match(/^(.*?)\s*[（(]([^（）()]*)[）)]\s*$/);
  if (paren) {
    add(paren[1]);
    for (const part of paren[2].split(/[,，、;；/]/)) add(part);
  } else if (title) add(title);
  for (const m of (u.text ?? '').matchAll(ALIAS_LINE)) for (const part of m[1].split(/[,，、;；/|]/)) add(part);
  return [...names];
}

export function entityResolution(gold: GoldAlias[], entities: Pick<KnowledgeUnit, 'id' | 'title' | 'text'>[]): EntityResolution | null {
  if (!gold.length) return null;
  // which system entities claim each normalized name
  const claims = new Map<string, number[]>();
  entities.forEach((u, ui) => {
    for (const n of claimedNames(u)) {
      const k = norm(n);
      if (!k) continue;
      const list = claims.get(k) ?? claims.set(k, []).get(k)!;
      if (!list.includes(ui)) list.push(ui);
    }
  });
  const shared = new Map<string, number>();
  for (const g of gold) for (const n of new Set(g.aliases.map(norm))) shared.set(n, (shared.get(n) ?? 0) + 1);
  const haystack = entities.map((u) => norm(`${u.title ?? ''} ${(u.text ?? '').slice(0, 2000)}`));

  // items: (gold entity, name) with the system entity holding it (-1: none)
  const items: { g: number; sys: number }[] = [];
  gold.forEach((g, gi) => {
    // a canonical that only disambiguates ("陈伟 (平台组)") is no name the sources use
    const forms = [...new Set([...(/[（(]/.test(g.canonical) ? [] : [g.canonical]), ...g.aliases].map(norm).filter(Boolean))];
    for (const n of forms) {
      const claimants = claims.get(n) ?? [];
      let sys = claimants[0] ?? -1;
      if (claimants.length > 1 || (shared.get(n) ?? 0) > 1) {
        const ctx = (g.context ?? []).map(norm).filter(Boolean);
        const fit = claimants.find((ui) => ctx.some((c) => haystack[ui].includes(c)));
        if (fit !== undefined) sys = fit;
      }
      items.push({ g: gi, sys });
    }
  });
  const foundGold = new Set(items.filter((i) => i.sys >= 0).map((i) => i.g));
  const scored = items.filter((i) => foundGold.has(i.g));
  if (!scored.length) return { precision: 0, recall: 0, f1: 0, found: 0, n: 0, merged: 0, split: 0 };
  const bySys = new Map<number, { g: number }[]>();
  for (const it of scored) if (it.sys >= 0) (bySys.get(it.sys) ?? bySys.set(it.sys, []).get(it.sys)!).push(it);
  const byGold = new Map<number, number>();
  for (const it of scored) byGold.set(it.g, (byGold.get(it.g) ?? 0) + 1);
  let p = 0;
  let r = 0;
  for (const it of scored) {
    const cluster = it.sys >= 0 ? bySys.get(it.sys)! : [it];
    const same = cluster.filter((x) => x.g === it.g).length;
    p += same / cluster.length;
    r += same / byGold.get(it.g)!;
  }
  const precision = p / scored.length;
  const recall = r / scored.length;
  const merged = [...bySys.values()].filter((c) => new Set(c.map((x) => x.g)).size > 1).length;
  const split = [...foundGold].filter((g) => new Set(scored.filter((x) => x.g === g).map((x) => x.sys)).size > 1).length;
  return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0, found: foundGold.size / gold.length, n: foundGold.size, merged, split };
}
