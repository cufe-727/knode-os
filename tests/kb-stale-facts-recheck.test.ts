import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { KnodeConfig, loadConfig, saveConfig } from '../src/config.js';
import { initDataDir } from '../src/fs/datadir.js';
import { refreshClaimState } from '../src/graph/claim-state-store.js';
import { statementObject } from '../src/graph/claim-state.js';
import { sync } from '../src/ingest/sync.js';

/**
 * The third check of the 10× fixes (2026-11-16): owner statements read for
 * what they are about kept an adverb or a lead phrase in the object, active
 * voice gave none, the canonical key moved off the stored name, lists of
 * fixers linked nobody, a bare id stayed apart from its tailed form, and a
 * refine slice that always fails would stall the pass.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-stale-recheck-'));
const contexts: AppContext[] = [];
afterAll(async () => {
  for (const ctx of contexts) {
    await ctx.datasources.closeAll();
    await ctx.store.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function workspace(name: string, docs: Record<string, string>, edit?: (c: KnodeConfig) => void): Promise<AppContext> {
  const dataDir = path.join(tmp, name);
  for (const [rel, text] of Object.entries(docs)) {
    const abs = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  initDataDir(dataDir);
  const config = loadConfig(dataDir);
  config.ingest.concurrency = 1;
  edit?.(config);
  saveConfig(dataDir, config);
  const ctx = await createContext(dataDir);
  contexts.push(ctx);
  await sync(ctx, { llmGraph: false });
  return ctx;
}

const dated = (title: string, date: string, fm: string) => `---\ntitle: ${title}\ndate: ${date}\n${fm}---\n${title}\n`;
/** One claim a line; [statement, attribute, value] for a line the extractor would have given an attribute the statement does not read as. */
type Line = string | [string, string, string];
const claimDoc = (date: string, subject: string, lines: Line[]) =>
  dated(`周观察${date}`, date, `entities:\n  - { name: ${subject}, type: organization }\nclaims:\n${lines
    .map((l) => `  - { subject: ${subject}, statement: ${typeof l === 'string' ? l : l[0]}, type: other }`)
    .join('\n')}\n`);

/** A workspace of two dated documents, with the stated attributes on the stored claims, as an extraction gives them. */
async function twoDocs(name: string, subject: string, a: Line[], b: Line[]): Promise<AppContext> {
  const ctx = await workspace(name, { 'raw/docs/a.md': claimDoc('2025-03-10', subject, a), 'raw/docs/b.md': claimDoc('2025-03-17', subject, b) });
  for (const l of [...a, ...b]) {
    if (typeof l !== 'string') await ctx.store.query(`UPDATE claims SET attribute = $2, value_text = $3 WHERE statement = $1`, l);
  }
  return ctx;
}

async function currentStatements(ctx: AppContext): Promise<string[]> {
  await refreshClaimState(ctx.store);
  const rows = await ctx.store.query<{ statement: string; current: boolean }>(
    `SELECT statement, superseded_by IS NULL AS current FROM claims WHERE tx_to IS NULL AND attribute IS NOT NULL`,
  );
  return rows.filter((r) => r.current).map((r) => r.statement).sort();
}

describe('an owner change written with an adverb or a lead phrase', () => {
  it('reads the thing, not the adverb or the phrase before it', () => {
    for (const s of ['云业务由张三负责', '云业务改由李四负责', '云业务现由李四负责', '云业务交由李四负责', '云业务转由李四负责', '云业务仍由李四负责', '自2025年3月起云业务由李四负责', '从下周起，云业务由李四负责', '经董事会决定，云业务改由李四负责', '经评审云业务由李四负责']) {
      expect(statementObject(s, '负责人', ['比亚迪']), s).toBe('云业务');
    }
    expect(statementObject('经评审R-03状态为已关闭', '状态', ['R-03'])).toBe('');
    expect(statementObject('R-03（支付超时）状态为已关闭', '状态', ['R-03'])).toBe('');
    expect(statementObject('R-03(支付超时)现由赖艳负责', '负责人', ['R-03'])).toBe('');
    expect(statementObject('自4月起R-03改由赖艳负责', '负责人', ['R-03'])).toBe('');
  });

  it.each(['云业务改由李四负责', '云业务现由李四负责', '云业务交由李四负责', '云业务转由李四负责', '自2025年3月起云业务由李四负责'])('leaves one current owner when the owner changes: %s', async (later) => {
    const ctx = await twoDocs(`owner-change-${later}`, '比亚迪', ['云业务由张三负责'], [later]);
    expect(await currentStatements(ctx)).toEqual([later]);
  });

  it('leaves one current state of the subject however the line begins', async () => {
    const ctx = await twoDocs('state-change', 'R-03', [['R-03（支付超时）状态为跟进中', '状态', '跟进中']], [['经评审R-03状态为已关闭', '状态', '已关闭']]);
    expect(await currentStatements(ctx)).toEqual(['经评审R-03状态为已关闭']);
  });
});


describe('an owner written in the active voice', () => {
  it('reads the thing after 负责', () => {
    expect(statementObject('张三负责云业务', '负责人', ['比亚迪'], '张三')).toBe('云业务');
    expect(statementObject('李四将负责电池业务的工作', '负责人', ['比亚迪'], '李四')).toBe('电池业务');
    expect(statementObject('李四接手云业务', '负责人', ['比亚迪'], '李四')).toBe('云业务');
    expect(statementObject('李四负责比亚迪云业务', '负责人', ['比亚迪'], '李四')).toBe('云业务');
    expect(statementObject('赖艳负责R-03', '负责人', ['R-03'], '赖艳')).toBe('');
    expect(statementObject('赖艳负责', '负责人', ['R-03'], '赖艳')).toBe('');
    // the passive voice is read as before, the value given or not
    expect(statementObject('云业务改由李四负责', '负责人', ['比亚迪'], '李四')).toBe('云业务');
  });

  it('keeps the owners of two things apart', async () => {
    const ctx = await twoDocs('active', '比亚迪', [['张三负责云业务', '负责人', '张三']], [['李四负责电池业务', '负责人', '李四']]);
    expect(await currentStatements(ctx)).toEqual(['张三负责云业务', '李四负责电池业务'].sort());
  });

  it('leaves one current owner of one thing, active or passive', async () => {
    const ctx = await twoDocs('active-change', '比亚迪', [['张三负责云业务', '负责人', '张三']], ['云业务改由李四负责']);
    expect(await currentStatements(ctx)).toEqual(['云业务改由李四负责']);
  });
});

describe('the name a group of keys goes by', () => {
  it('is the most used key, as stored keys were named before, ties by the name stored', async () => {
    const { unifyAttributeKeys } = await import('../src/graph/claim-state.js');
    const use = (attribute: string, count: number) => ({ attribute, count, units: ['亿元'] });
    expect(unifyAttributeKeys([use('归母净利润', 5), use('净利润', 2)]).get('净利润')?.canonical).toBe('归母净利润');
    expect(unifyAttributeKeys([use('归母净利润', 2), use('净利润', 5)]).get('归母净利润')?.canonical).toBe('净利润');
    // a tie keeps the name the group already had
    expect(unifyAttributeKeys([use('归母净利润', 3), use('净利润', 3)], [], new Set(['归母净利润'])).get('净利润')?.canonical).toBe('归母净利润');
    expect(unifyAttributeKeys([use('归母净利润', 3), use('净利润', 3)], [], new Set(['净利润'])).get('归母净利润')?.canonical).toBe('净利润');
  });

  it('is not rewritten by a refresh when the counts tie', async () => {
    const { refreshAttributeKeys } = await import('../src/graph/claim-state-store.js');
    const ctx = await twoDocs('key-name', '比亚迪', [['比亚迪归母净利润为100亿元', '归母净利润', '100']], [['比亚迪净利润为120亿元', '净利润', '120']]);
    await ctx.store.query(`UPDATE claims SET value_text = NULL, value_num = 100, unit = '亿元' WHERE attribute = '归母净利润'`);
    await ctx.store.query(`UPDATE claims SET value_text = NULL, value_num = 120, unit = '亿元' WHERE attribute = '净利润'`);
    await ctx.store.query(`DELETE FROM claim_attribute_keys`);
    await ctx.store.query(`INSERT INTO claim_attribute_keys (subject_id, attribute, canonical, reason, updated_at) VALUES ('比亚迪', '净利润', '归母净利润', 'stored', now())`);
    expect(await refreshAttributeKeys(ctx.store)).toEqual({ mapped: 0, dropped: 0 });
    expect(await ctx.store.query(`SELECT attribute, canonical FROM claim_attribute_keys`)).toEqual([{ attribute: '净利润', canonical: '归母净利润' }]);
  });
});

describe('several fixers, or one with help', () => {
  it('reads every fixer a list names, and for 协助 the one who fixed', async () => {
    const { fixerSpans } = await import('../src/graph/backrefs.js');
    const has = (s: string, names: string[], not: string[] = []) => {
      const spans = fixerSpans(s);
      for (const n of names) expect(spans, `${s}: ${n}`).toContain(n);
      for (const n of not) expect(spans, `${s}: not ${n}`).not.toContain(n);
    };
    has('上周那起缓存击穿已由方杰、李明修复', ['方杰', '李明']);
    has('上周那起缓存击穿已由方杰和李明修复', ['方杰', '李明']);
    has('上周那起缓存击穿已由方杰与李明共同修复', ['方杰', '李明']);
    has('方杰、李明已修复上周的缓存击穿', ['方杰', '李明']);
    has('上周那起缓存击穿由李明协助方杰修复', ['方杰'], ['李明']);
    has('上周那起缓存击穿在李明协助下由方杰修复', ['方杰'], ['李明']);
    has("Last week's cache stampede was fixed by Fang Jie and Li Ming", ['Fang Jie', 'Li Ming']);
    has("Last week's cache stampede was fixed by Fang Jie, Li Ming and Wang Wu", ['Fang Jie', 'Li Ming', 'Wang Wu']);
    has('上周那起支付超时已修复，客户张三和李四确认', [], ['张三', '李四']);
  });

  it('links each of them', async () => {
    const { linkBackReferences } = await import('../src/graph/backrefs.js');
    const rep = (date: string, fm: string) => dated('平台组周报', date, fm);
    const ctx = await workspace('fixers', {
      'raw/docs/周报/平台组/w05.md': rep('2025-02-03', 'entities:\n  - { name: INC-001-T1, type: event }\nclaims:\n  - { subject: INC-001-T1, statement: INC-001-T1为P1级缓存击穿事故, type: event }\n'),
      'raw/docs/周报/平台组/w06.md': rep('2025-02-10', 'entities:\n  - { name: 方杰, type: person }\n  - { name: 李明, type: person }\nclaims:\n  - { subject: 方杰, object: 李明, statement: 上周那起缓存击穿已由方杰和李明修复, type: event }\n'),
    });
    const config = { review: { ...ctx.config.review, backReferences: { periodic: ['raw/docs/周报'] } } };
    // one relation a fixer, under one link
    expect((await linkBackReferences(ctx.store, { config })).linked).toBe(2);
    const [scope] = await ctx.store.query<{ meta: { people: string[] } }>(`SELECT meta FROM scopes WHERE kind = 'backref' AND status = 'active'`);
    expect(scope.meta.people).toEqual(['方杰', '李明']);
    const sources = await ctx.store.query<{ source_id: string }>(`SELECT source_id FROM relations WHERE tx_to IS NULL AND target_id = 'inc-001-t1' ORDER BY source_id COLLATE "C"`);
    expect(sources.map((r) => r.source_id).sort()).toEqual(['方杰', '李明']);
  });
});

describe('a bare identifier no incident carries', () => {
  it('stays its own entity, even with one tailed form in the workspace, through refine', async () => {
    const { splitEntities } = await import('../src/graph/entity-context.js');
    const fm = (title: string, entities: string) => `---\ntitle: ${title}\nentities:\n${entities}---\n${title}\n`;
    const ctx = await workspace('bare-id', {
      'raw/docs/a.md': fm('a', '  - { name: INC-006-T1, type: event }\n'),
      'raw/docs/b.md': fm('b', '  - { name: INC-006, type: event }\n'),
    });
    for (const identity of ['name', 'context'] as const) {
      await splitEntities(ctx.store, { config: { ...ctx.config, review: { ...ctx.config.review, identity } } });
      const live = await ctx.store.query<{ id: string }>(`SELECT id FROM entities WHERE tx_to IS NULL AND canonical_id IS NULL AND id LIKE 'inc-006%' ORDER BY id COLLATE "C"`);
      // "only INC-006-T1 so far" is a fact about the reports read, not about the text: INC-006-T2 may come next week
      expect(live.map((r) => r.id), identity).toEqual(['inc-006', 'inc-006-t1']);
    }
  });
});

describe('a refine slice that fails', () => {
  const projects = ['甲项目', '乙项目', '丙项目', '丁项目'];
  const docs: Record<string, string> = {};
  for (const [k, date] of [[1, '2025-03-03'], [2, '2025-03-10']] as const) {
    docs[`raw/docs/w${k}.md`] = dated(`周报${k}`, date, `entities:\n${projects.map((p) => `  - { name: ${p}, type: project }`).join('\n')}\nclaims:\n${projects.map((p, i) => `  - { subject: ${p}, statement: ${p}进度为${10 * k + i}%, type: other }`).join('\n')}\n`);
  }

  it('skips the subject that fails every time and records it, and the pass goes on', async () => {
    const { refreshClaimStateStep } = await import('../src/graph/claim-state-store.js');
    const ctx = await workspace('slice-fails', docs);
    // one subject whose slice throws however often it is tried
    const apply = async (subjects: string[]) => {
      if (subjects.includes('乙项目')) throw new Error('bad subject');
      return { keys: 0, superseded: 0 };
    };
    const done: string[] = [];
    for (let i = 0; i < 6; i++) {
      try {
        const r = await refreshClaimStateStep(ctx.store, { budget: 4, apply });
        if (r.passDone) { done.push('pass'); break; }
      } catch { done.push('failed'); }
    }
    expect(done.at(-1)).toBe('pass');
    expect(done.filter((d) => d === 'failed').length).toBeLessThanOrEqual(3);
    const skipped = await ctx.store.getMeta<{ root: string; error: string }[]>('claim_state_skipped');
    expect(skipped?.map((s) => s.root)).toEqual(['乙项目']);
    expect(skipped?.[0].error).toMatch(/bad subject/);
  });

  it('retries a failure that is not the slice\'s, a bounded number of times', async () => {
    const { refreshClaimStateStep } = await import('../src/graph/claim-state-store.js');
    const ctx = await workspace('slice-down', docs);
    let calls = 0;
    const apply = async () => { calls++; throw new Error('database gone'); };
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i++) {
      try { outcomes.push((await refreshClaimStateStep(ctx.store, { budget: 4, apply })).passDone ? 'pass' : 'step'); } catch { outcomes.push('failed'); }
    }
    // every subject failing is the store's trouble: the slice (two subjects) is retried, then let go and recorded, never retried forever
    expect(outcomes).toEqual(['failed', 'failed', 'step', 'failed', 'failed', 'pass']);
    expect(calls).toBe(18);
    const skipped = await ctx.store.getMeta<{ root: string }[]>('claim_state_skipped');
    expect(skipped?.map((s) => s.root)).toEqual(['丁项目', '丙项目', '乙项目', '甲项目'].sort((a, b) => (a < b ? -1 : 1)));
  });
});

describe('owner changes worded in ways the clause reading does not cover', () => {
  const first: [string, string, string] = ['云业务由张三负责', '负责人', '张三'];
  it.each([
    ['原由张三负责的云业务现由李四负责', '李四'],
    ['云业务负责人变更为李四', '李四'],
    ['张三不再负责云业务，改由李四接手', '李四'],
    ['李四接管了张三负责的云业务', '李四'],
  ])('lands on the series of the thing it names: %s', async (later, value) => {
    const ctx = await twoDocs(`worded-${later}`, '比亚迪', [first], [[later, '负责人', value]]);
    expect(await currentStatements(ctx)).toEqual([later]);
  });

  it('reads an English owner line with "now" as the same thing', async () => {
    const ctx = await twoDocs('worded-en', 'BYD', [['Cloud is owned by Zhang San', 'lead', 'Zhang San']], [['Cloud is now owned by Li Si', 'lead', 'Li Si']]);
    expect(await currentStatements(ctx)).toEqual(['Cloud is now owned by Li Si']);
  });

  it('keeps two owners named together both current, and a later owner supersedes them both', async () => {
    const ctx = await twoDocs('co-owners', '比亚迪', [['云业务由王五负责', '负责人', '王五']], [['张三、李四共同负责云业务', '负责人', '张三'], ['云业务由张三和李四共同负责', '负责人', '李四']]);
    // two owners of one thing on one day: both current, neither supersedes the other
    expect(await currentStatements(ctx)).toEqual(['张三、李四共同负责云业务', '云业务由张三和李四共同负责'].sort());
  });

  it('settles a reading on the one known thing the statement names, else leaves it', async () => {
    const { settleSeriesObjects } = await import('../src/graph/claim-state.js');
    const row = (statement: string, about: string, object = '') => ({ statement, about, object });
    expect(settleSeriesObjects([row('云业务由张三负责', '云业务'), row('原由张三负责的云业务现由李四负责', '')])).toEqual(['~云业务', '~云业务']);
    // an object a claim carries is a known thing too: the reading joins its series
    expect(settleSeriesObjects([row('云业务由张三负责', '', 'cloud'), row('云业务改由李四负责', '云业务')], [{ key: 'cloud', names: ['云业务'] }])).toEqual(['cloud', 'cloud']);
    // two known things named, or none: as read
    expect(settleSeriesObjects([row('云业务由张三负责', '云业务'), row('电池业务由李四负责', '电池业务'), row('云业务和电池业务由王五负责', '')])).toEqual(['~云业务', '~电池业务', '']);
    expect(settleSeriesObjects([row('云业务由张三负责', '云业务'), row('由李四负责', '')])).toEqual(['~云业务', '']);
  });
});
