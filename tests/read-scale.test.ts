import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listCapabilities } from '../src/capability/store.js';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { claimsForEntities, graphOverview, graphSearch } from '../src/graph/query.js';
import { sync } from '../src/ingest/sync.js';
import { findLiveScope } from '../src/lineage/scope.js';
import { queryClaims } from '../src/store/claims.js';
import { resolveScopeFilter, resolveTemporal } from '../src/store/resolver.js';

/**
 * The read paths at the sizes a real workspace reaches: an `as_of` read folds
 * every row it matched from evidence, and a graph search's frontier past the
 * seeds holds every neighbour it reached. Both bind more ids than one
 * statement can (Postgres and PGlite both stop at 65,535 parameters), so the
 * ids go to the database as one array parameter.
 */

const MAX_PARAMS = 65_535;
/** Partners of the hub, claims about it, and claims about 甲公司: each more than one statement can bind. */
const n = 70_000;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-read-scale-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const entityDoc = (name: string) =>
  ['---', `title: ${name}`, 'entities:', `  - { name: ${name}, type: organization }`, '---', `# ${name}`, '', `[[${name}]] 的资料。`, ''].join('\n');

describe('reads at scale', () => {
  const dataDir = path.join(tmp, 'ws');
  let ctx: AppContext;
  let hub: string;
  let asOf: string;
  // a source filter makes every read also check each row's support
  const filter = resolveScopeFilter({ sources: ['raw/docs'] });

  beforeAll(async () => {
    expect(n).toBeGreaterThan(MAX_PARAMS);
    initDataDir(dataDir);
    write(dataDir, 'raw/docs/hub.md', entityDoc('枢纽集团'));
    write(dataDir, 'raw/docs/partners.md', entityDoc('合作方名录'));
    write(dataDir, 'raw/docs/jia.md', entityDoc('甲公司'));
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
    const { store } = ctx;
    const idOf = async (name: string) => (await store.query<{ id: string }>(`SELECT id FROM entities WHERE name = $1`, [name]))[0].id;
    hub = await idOf('枢纽集团');
    const jia = await idOf('甲公司');
    const partners = (await findLiveScope(store, 'doc', 'raw/docs/partners.md'))!.id;
    const jiaDoc = (await findLiveScope(store, 'doc', 'raw/docs/jia.md'))!.id;

    // the hub: an edge to each of n partners, all standing on partners.md
    await store.query(
      `INSERT INTO entities (id, name, type, evidence_count) SELECT 'partner-' || g, '合作方' || g, 'organization', 1 FROM generate_series(1, $1::int) AS g`,
      [n],
    );
    await store.query(
      `INSERT INTO relations (id, source_id, target_id, type, weight, evidence_count)
       SELECT 'edge-' || g, $2, 'partner-' || g, 'supplies', 1, 1 FROM generate_series(1, $1::int) AS g`,
      [n, hub],
    );
    await store.query(
      `INSERT INTO evidence (kind, target_id, scope_id, weight, extractor, attrs, tx_from)
       SELECT k.kind, k.prefix || g, $2, 1, 'test.bulk', k.attrs || jsonb_build_object('name', '合作方' || g), now()
       FROM generate_series(1, $1::int) AS g,
            (VALUES ('entity', 'partner-', '{"type": "organization"}'::jsonb), ('relation', 'edge-', '{}'::jsonb)) AS k(kind, prefix, attrs)`,
      [n, partners],
    );
    // n claims about the hub, each reported by a note of its own and naming one partner
    await store.query(
      `INSERT INTO scopes (id, kind, key, sha, status, actor, applied_at)
       SELECT 'note-' || g, 'doc', 'raw/docs/notes/' || g || '.md', 'sha-' || g, 'active', 'test', now() FROM generate_series(1, $1::int) AS g`,
      [n],
    );
    await store.query(
      `INSERT INTO claims (id, subject_id, object_id, statement, status, evidence_count, primary_scope_id)
       SELECT 'deal-' || g, $2, 'partner-' || g, '枢纽集团与合作方' || g || '签约', 'fact', 1, 'note-' || g FROM generate_series(1, $1::int) AS g`,
      [n, hub],
    );
    await store.query(
      `INSERT INTO evidence (kind, target_id, scope_id, weight, extractor, attrs, tx_from)
       SELECT 'claim', 'deal-' || g, 'note-' || g, 1, 'test.bulk', jsonb_build_object('status', 'fact', 'object_id', 'partner-' || g), now()
       FROM generate_series(1, $1::int) AS g`,
      [n],
    );
    // n claims about 甲公司, all from jia.md
    await store.query(
      `INSERT INTO claims (id, subject_id, statement, status, evidence_count, primary_scope_id)
       SELECT 'jia-' || g, $2, '甲公司第' || g || '项业务收入增长', 'fact', 1, $3 FROM generate_series(1, $1::int) AS g`,
      [n, jia, jiaDoc],
    );
    await store.query(
      `INSERT INTO evidence (kind, target_id, scope_id, weight, extractor, attrs, tx_from)
       SELECT 'claim', 'jia-' || g, $2, 1, 'test.bulk', '{"status": "fact"}'::jsonb, now() FROM generate_series(1, $1::int) AS g`,
      [n, jiaDoc],
    );
    asOf = new Date().toISOString();
  });
  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
  });

  it('answers a claims query as of a time over more claims than one statement can bind', async () => {
    const res = await queryClaims(ctx.store, { subject: '甲公司', temporal: resolveTemporal({ asOf }), filter, limit: 5 });
    expect(res.matched).toBe(n);
    expect(res.claims).toHaveLength(5);
    for (const c of res.claims) expect(c).toMatchObject({ subject: '甲公司', status: 'fact', sourcePath: 'raw/docs/jia.md' });
  });

  it('reads the claims about a subject as of a time from more sources than one statement can bind', async () => {
    const claims = await claimsForEntities(ctx.store, [hub], 5, { temporal: resolveTemporal({ asOf }), filter });
    expect(claims).toHaveLength(5);
    for (const c of claims) {
      // the object's name and the source's path are looked up for every claim the read matched
      const g = /^deal-(\d+)$/.exec(c.id)![1];
      expect(c).toMatchObject({ subject: '枢纽集团', object: `合作方${g}`, path: `raw/docs/notes/${g}.md` });
    }
  });

  it('reads the claims about more subjects than one statement can bind', async () => {
    const subjects = [hub, ...Array.from({ length: n }, (_, i) => `partner-${i + 1}`)];
    const claims = await claimsForEntities(ctx.store, subjects, 5, { filter });
    expect(claims).toHaveLength(5);
    for (const c of claims) expect(c.subject).toBe('枢纽集团');
  });

  for (const when of ['now', 'as of a time'] as const) {
    it(`searches the graph ${when} around a hub with more neighbours than one statement can bind`, async () => {
      const temporal = when === 'now' ? undefined : resolveTemporal({ asOf });
      const res = await graphSearch(ctx.store, '枢纽集团', { depth: 2, limit: 10, filter, temporal, track: false });
      // one hop reaches every partner, and the second hop starts from all of them
      expect(res.nodes[0].name).toBe('枢纽集团');
      expect(res.nodes).toHaveLength(10);
      expect(res.edges).toHaveLength(9);
      for (const e of res.edges) expect(e).toMatchObject({ source: hub, type: 'supplies' });
      expect(res.claims).toHaveLength(12);
    });
  }

  it('lays out an overview of more nodes than one statement can bind', async () => {
    const res = await graphOverview(ctx.store, n + 10);
    expect(res.nodes.length).toBeGreaterThan(n);
    expect(res.edges.filter((e) => e.source === hub && e.type === 'supplies')).toHaveLength(n);
  });

  it('lists a catalog of more capabilities than one statement can bind', async () => {
    const { store } = ctx;
    const partners = (await findLiveScope(store, 'doc', 'raw/docs/partners.md'))!.id;
    await store.query(
      `INSERT INTO capabilities (id, scope_id, kind, source_id, name, tx_from)
       SELECT 'warehouse.table_' || g, $2, 'table', 'warehouse', 'table_' || g, now() FROM generate_series(1, $1::int) AS g`,
      [n, partners],
    );
    await store.query(
      `INSERT INTO capability_notes (capability_id, scope_id, source_path, semantics, tx_from)
       VALUES ('warehouse.table_7', $1, 'capabilities/warehouse.md', '每日收盘后更新', now())`,
      [partners],
    );
    const caps = await listCapabilities(store, { excludeBuiltin: true });
    expect(caps).toHaveLength(n);
    expect(caps.find((c) => c.id === 'warehouse.table_7')?.notes.map((x) => x.semantics)).toEqual(['每日收盘后更新']);
  });
});
