import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { sync } from '../src/ingest/sync.js';
import { HotEntity, hotEntities } from '../src/wiki/pages.js';

/**
 * The hot topics (wiki/index.md#hot-topics, and the research recommender) rank
 * live entities by mention count + 5 × the heat of the documents mentioning
 * them. `hotEntities` scores only the entities that can make the top K
 * instead of grouping every mention in the base; it must rank exactly as the
 * full grouping below does.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-hot-topics-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** The definition: every live entity with a mention, its heat summed over all its mention rows. */
const EVERY_MENTION = `
  SELECT e.id, e.name, e.type, e.description, e.mention_count, e.fold_sha,
         COALESCE(sum(ds.heat::float8), 0)::float AS heat
  FROM entities e
  JOIN entity_mentions m ON m.entity_id = e.id
  LEFT JOIN doc_stats ds ON ds.document_id = m.document_id
  WHERE e.tx_to IS NULL AND e.canonical_id IS NULL
  GROUP BY e.id, e.name, e.type, e.description, e.mention_count, e.fold_sha
  ORDER BY (e.mention_count + COALESCE(sum(ds.heat::float8), 0) * 5) DESC, e.name ASC
  LIMIT $1`;

describe('hot entities', () => {
  const dataDir = path.join(tmp, 'ws');
  let ctx: AppContext;

  beforeAll(async () => {
    write(dataDir, 'raw/docs/a.md', '# a\n\n[[Alpha]] meets [[Beta]], [[Gamma]] and [[Delta]].\n');
    write(dataDir, 'raw/docs/b.md', '# b\n\n[[Alpha]] again, with [[Epsilon]] and [[Zeta]].\n');
    write(dataDir, 'raw/docs/c.md', '# c\n\n[[Eta]], [[Theta]], [[Iota]] and [[Kappa]] in a quiet note.\n');
    write(dataDir, 'raw/docs/d.md', '# d\n\n[[Lambda]] and [[Mu]] are read a lot.\n');
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
  });
  afterAll(async () => {
    await ctx?.store.close();
  });

  const doc = async (p: string) => (await ctx.store.query<{ id: string }>(`SELECT id FROM documents WHERE path = $1`, [p]))[0].id;
  const ranked = (rows: HotEntity[]) => rows.map((r) => ({ id: r.id, mentions: r.mention_count, heat: r.heat }));

  it('ranks as grouping every mention does: ties at the cut, heat, merged, retired and unmentioned entities', async () => {
    const { store } = ctx;
    // counts that tie across the cut, so the name decides who is in
    const counts: Record<string, number> = { alpha: 40, beta: 30, gamma: 30, delta: 30, epsilon: 20, zeta: 20, eta: 20, theta: 5, iota: 5, kappa: 1, lambda: 2, mu: 2 };
    for (const [id, n] of Object.entries(counts)) await store.query(`UPDATE entities SET mention_count = $2 WHERE id = $1`, [id, n]);
    // heat lifts the rarely mentioned entities of a much-read document past the frequent ones
    await store.query(`INSERT INTO doc_stats (document_id, hit_count, heat) VALUES ($1, 9, 7.5), ($2, 1, 0.25)`, [await doc('raw/docs/d.md'), await doc('raw/docs/b.md')]);
    // merged into Alpha, retired, and counted but with no mention row left: none of them is hot
    await store.query(`UPDATE entities SET canonical_id = 'alpha', mention_count = 99 WHERE id = 'gamma'`);
    await store.query(`UPDATE entities SET tx_to = now(), mention_count = 98 WHERE id = 'theta'`);
    await store.query(`DELETE FROM entity_mentions WHERE entity_id = 'iota'`);
    await store.query(`UPDATE entities SET mention_count = 97 WHERE id = 'iota'`);

    for (const k of [1, 2, 3, 4, 5, 6, 8, 12, 50]) {
      const expected = await store.query<HotEntity>(EVERY_MENTION, [k]);
      expect(ranked(await hotEntities(store, k)), `top ${k}`).toEqual(ranked(expected));
    }
    const top = (await hotEntities(store, 6)).map((e) => e.id);
    expect(top.indexOf('lambda')).toBeLessThan(top.indexOf('beta'));
    expect(top.indexOf('mu')).toBeLessThan(top.indexOf('delta'));
    // of the three entities on 20 mentions, Epsilon and Zeta have b.md's heat, and Epsilon the name
    expect(top.slice(-1)).toEqual(['epsilon']);
    for (const id of ['gamma', 'theta', 'iota']) expect(top).not.toContain(id);
  });

  it('counts heat once per mention row, the way the full grouping sums it', async () => {
    const { store } = ctx;
    const [alpha] = (await hotEntities(store, 50)).filter((e) => e.id === 'alpha');
    const [{ n }] = await store.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM entity_mentions m JOIN documents d ON d.id = m.document_id WHERE m.entity_id = 'alpha' AND d.path = 'raw/docs/b.md'`,
    );
    expect(alpha.heat).toBeCloseTo(0.25 * n, 6);
  });
});
