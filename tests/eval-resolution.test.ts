import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bcubed, goldMatcher, scanSidecars } from '../src/eval/resolution.js';
import type { GoldAlias } from '../src/eval/types.js';

/** Entity resolution measured without a model (src/eval/resolution.ts): the mention-level score and the sidecar scan. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-eval-resolution-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const GOLD: GoldAlias[] = [
  { canonical: '陈伟 (平台组)', aliases: ['陈伟'], kind: 'person', context: ['平台组', '数据工程师'] },
  { canonical: '陈伟 (支付组)', aliases: ['陈伟'], kind: 'person', context: ['支付组', '测试工程师'] },
  { canonical: '罗芳', aliases: ['罗芳'], kind: 'person' },
  { canonical: '日志保留天数', aliases: ['日志保留天数', 'T1-C2', '保留期'], kind: 'setting', context: ['平台组'] },
  { canonical: '日志保留天数', aliases: ['日志保留天数', 'D2T1-C2', '保留期'], kind: 'setting', context: ['二部平台组'] },
];

describe('scoring mentions against gold alias clusters', () => {
  it('tells namesakes apart by the folder of the document, and leaves out what the gold cannot place', () => {
    const match = goldMatcher(GOLD);
    expect(match('raw/docs/周报/平台组/a.md', ['陈伟'])).toBe(0);
    expect(match('raw/docs/周报/支付组/a.md', ['陈伟'])).toBe(1);
    expect(match('raw/docs/月报/pmo-01.md', ['陈伟'])).toBe(-1);
    expect(match('raw/docs/月报/pmo-01.md', ['罗芳'])).toBe(2);
    // a code names one of them wherever it is written; a name the first division's code was repeated for goes by the folder
    expect(match('raw/docs/月报/pmo-01.md', ['日志保留天数', 'D2T1-C2'])).toBe(4);
    expect(match('raw/docs/周报/二部平台组/a.md', ['T1-C2', '日志保留天数'])).toBe(4);
    expect(match('raw/docs/周报/平台组/a.md', ['保留期'])).toBe(3);
    expect(match('raw/docs/周报/平台组/a.md', ['安全团队'])).toBe(-1);
  });

  it('computes B-cubed precision and recall over the mentions', () => {
    // one system entity holds two real ones: half of each mention's cluster is the other
    const merged = bcubed([{ gold: 'a', sys: 'x' }, { gold: 'a', sys: 'x' }, { gold: 'b', sys: 'x' }, { gold: 'b', sys: 'x' }]);
    expect(merged).toMatchObject({ precision: 0.5, recall: 1, merged: 1, split: 0, n: 4 });
    const split = bcubed([{ gold: 'a', sys: 'x' }, { gold: 'a', sys: 'y' }]);
    expect(split).toMatchObject({ precision: 1, recall: 0.5, merged: 0, split: 1 });
    expect(bcubed([{ gold: 'a', sys: 'x' }, { gold: 'b', sys: 'y' }])).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(bcubed([])).toMatchObject({ precision: 0, recall: 0, n: 0 });
  });
});

describe('scanning sidecars for what refine would part', () => {
  it('finds the setting two teams each have under a code of their own, and not a hub', () => {
    const sidecar = (key: string, t1: unknown) => {
      const dir = path.join(tmp, 'ws', '.sidecar', key);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'tier1.json'), JSON.stringify(t1));
    };
    const report = (team: string, k: number, aliases: string[]) => sidecar(`raw/docs/周报/${team}/w${k}.md`, {
      status: 'done',
      entities: [{ name: team, type: 'organization' }, { name: '日志保留天数', type: 'component', aliases }, { name: 'DRAM', type: 'product', aliases: k % 2 ? ['DDR4'] : ['DDR5'] }],
      relations: [],
      claims: [],
    });
    for (let k = 0; k < 4; k++) {
      report('平台组', k, k < 2 ? ['T1-C2'] : []);
      report('二部平台组', k, k < 2 ? ['D2T1-C2'] : []);
    }
    sidecar('raw/docs/pending.md', { status: 'partial', entities: [{ name: '日志保留天数', type: 'component', aliases: ['D9T1-C2'] }] });
    const r = scanSidecars(path.join(tmp, 'ws'));
    expect(r.sidecars).toBe(8);
    // DRAM is a product: a category, which no code parts
    expect(r.codedCandidates).toBe(1);
    expect(r.coded).toHaveLength(1);
    expect(r.coded[0]).toMatchObject({ name: '日志保留天数', documents: 8 });
    // nothing is left for the name itself: the code with the most documents keeps it, the other is the entity added
    expect(r.coded[0].parts).toHaveLength(1);
    expect(r.coded[0].parts[0].documents).toBe(4);
    expect(r.people).toEqual([]);
    // the write-time path: a document of either team arriving after the split is filed where refine put it —
    // the coded ones by their code, the others by the team they name
    expect(r.coded[0].follow).toEqual({ same: 8, elsewhere: 0, base: 0 });
    expect(r.follow).toEqual({ same: 8, elsewhere: 0, base: 0 });
  });
});
