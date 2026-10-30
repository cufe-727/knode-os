import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { correctEntity } from '../src/graph/merge.js';
import { buildOntology, CORE_PACK_YAML, FINANCE_PACK_YAML, loadOntology, ORGANIZATION_PACK_YAML, typePrecedence } from '../src/graph/ontology.js';
import { sync } from '../src/ingest/sync.js';
import { entitiesAsOf, EvidenceAtRow, foldEntityEvidence } from '../src/store/temporal.js';

/**
 * The type the entity fold settles on (src/store/temporal.ts): the most-read
 * typed reading, the ontology's declared order only to break a tie, and
 * `concept` — what tier-0 links, mind maps and mined terms write without
 * reading the entity — only when nothing typed was read. Precedence first
 * let 14 "organization" readings outrank 1,090 "theme" ones in finance.
 */

const FINANCE = typePrecedence(buildOntology([
  { name: 'core', text: CORE_PACK_YAML },
  { name: 'organization', text: ORGANIZATION_PACK_YAML },
  { name: 'finance', text: FINANCE_PACK_YAML },
]));

let seq = 0;
/** `n` evidence rows reading the entity as `type`, one per scope. */
function read(type: string, n: number, o: { extractor?: string; weight?: number } = {}): EvidenceAtRow[] {
  return Array.from({ length: n }, () => ({
    kind: 'entity',
    target_id: 'x',
    scope_id: `s${seq++}`,
    segment_id: null,
    weight: o.weight ?? 1,
    extractor: o.extractor ?? 'tier1.llm',
    attrs: { name: 'X', type, description: '', aliases: [] },
    tx_from: '2026-10-30T00:00:00.000Z',
  }));
}

const typeOf = (rows: EvidenceAtRow[], precedence: readonly string[] = FINANCE) =>
  foldEntityEvidence('x', rows, 0, { name: 'X', type: 'organization', description: '', aliases: [] }, precedence)?.type;

describe("the fold's type vote", () => {
  it('takes the most-read typed reading, whatever its place in the precedence', () => {
    // 人工智能 in finance: a theme to most readers, an organization to a few
    expect(typeOf([...read('organization', 1), ...read('theme', 3)])).toBe('theme');
    // 创业板: one product reading against the market ones
    expect(typeOf([...read('market', 4), ...read('product', 1)])).toBe('market');
    // `other` is a reading like any type: the extractor found nothing better
    expect(typeOf([...read('other', 9), ...read('indicator', 1)])).toBe('other');
  });

  it('breaks a tie by the declared order, then by name', () => {
    expect(typeOf([...read('theme', 2), ...read('organization', 2)])).toBe('organization');
    expect(typeOf([...read('theme', 2), ...read('sector', 2)])).toBe('sector');
    expect(typeOf([...read('zeta', 1), ...read('alpha', 1)])).toBe('alpha');
  });

  it('counts concept only when nothing typed was read', () => {
    // a hub's tier-0 links outnumber its typed readings by far, at half weight with the fallback type
    expect(typeOf([...read('concept', 40, { extractor: 'tier0.link', weight: 0.5 }), ...read('sector', 2)])).toBe('sector');
    expect(typeOf([...read('concept', 40), ...read('person', 1)])).toBe('person');
    expect(typeOf(read('concept', 3))).toBe('concept');
  });

  it('counts a type the ontology no longer has after concept, and keeps the row type with no readings', () => {
    expect(typeOf([...read('board', 5), ...read('concept', 1)])).toBe('concept');
    expect(typeOf([...read('board', 5), ...read('market', 1)])).toBe('market');
    expect(typeOf(read('board', 5))).toBe('board');
    const untyped = read('concept', 1).map((r) => ({ ...r, attrs: { name: 'X' } }));
    expect(typeOf(untyped)).toBe('organization');
    // the core order alone does not know the finance types, so as_of reads pass the workspace's
    const readings = [...read('theme', 3), ...read('organization', 1)];
    expect(foldEntityEvidence('x', readings, 0)?.type).toBe('organization');
    expect(foldEntityEvidence('x', readings, 0, undefined, FINANCE)?.type).toBe('theme');
  });
});

describe('the type through sync, a correction and an as_of read', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-type-vote-'));
  let ctx: AppContext | undefined;
  afterAll(async () => {
    await ctx?.datasources.closeAll();
    await ctx?.store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  it('lets the readings outvote one stray reading and the links, under a person who still decides', async () => {
    const declared = (title: string, type: string) => `---\ntitle: ${title}\nentities:\n  - { name: 人工智能, type: ${type} }\n---\n${title}：人工智能 应用加速落地。\n`;
    write('raw/docs/a.md', declared('题材复盘', 'theme'));
    write('raw/docs/b.md', declared('题材周报', 'theme'));
    write('raw/docs/c.md', declared('公司公告摘录', 'organization'));
    initDataDir(tmp);
    const config = loadConfig(tmp);
    config.ingest.concurrency = 1;
    config.graph = { ...config.graph, ontologyPacks: ['core', 'organization', 'finance'] };
    saveConfig(tmp, config);
    ctx = await createContext(tmp);
    await sync(ctx, { llmGraph: false });
    // posts that only name it: tier-0 links, the fallback type at half weight
    for (const n of [1, 2, 3]) write(`raw/docs/link${n}.md`, `---\ntitle: 盘后笔记 ${n}\n---\n今天 人工智能 板块继续走强，第 ${n} 天。\n`);
    await sync(ctx, { llmGraph: false });
    const store = ctx.store;

    const votes = await store.query<{ type: string; extractor: string; n: number }>(
      `SELECT attrs->>'type' AS type, extractor, count(*)::int AS n FROM evidence
       WHERE kind = 'entity' AND target_id = '人工智能' AND tx_to IS NULL GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    expect(votes).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'concept', extractor: 'tier0.link', n: 3 }),
      expect.objectContaining({ type: 'organization', n: 1 }),
      expect.objectContaining({ type: 'theme', n: 2 }),
    ]));
    const typeNow = async () => (await store.query<{ type: string }>(`SELECT type FROM entities WHERE id = '人工智能'`))[0].type;
    expect(await typeNow()).toBe('theme');

    // as_of reads fold the same way given the workspace's order
    const at = new Date(Date.now() + 1000).toISOString();
    expect((await entitiesAsOf(store, ['人工智能'], at, typePrecedence(loadOntology(tmp))))[0].type).toBe('theme');

    // a person's correction still decides, and taking it back returns to the readings
    await correctEntity(store, { entity: '人工智能', type: 'sector' });
    expect(await typeNow()).toBe('sector');
    await correctEntity(store, { entity: '人工智能', clear: true });
    expect(await typeNow()).toBe('theme');
  });
});
