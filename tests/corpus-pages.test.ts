import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { sync } from '../src/ingest/sync.js';
import { ensureCorpusPages, mentionCandidates } from '../src/wiki/corpus.js';
import { extendsName, passageAround, rootsOf, TIMELINE_PAGE_CLAIMS, timelinePeriods } from '../src/wiki/corpus-views.js';
import { reconcileViews } from '../src/wiki/pages.js';

/**
 * Pages across documents (src/wiki/corpus-views.ts, src/wiki/corpus.ts):
 * where a family of names is mentioned, every dated claim in order, and where
 * the sources disagree — each line with the document it comes from, each
 * kind listed in its directory's index.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-corpus-pages-'));
const dataDir = path.join(tmp, 'ws');
let ctx: AppContext;

function write(rel: string, content: string): void {
  const abs = path.join(dataDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
const read = (rel: string) => fs.readFileSync(path.join(dataDir, 'wiki', rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(dataDir, 'wiki', rel));
const bullets = (text: string) => text.split('\n').filter((l) => l.startsWith('- '));

beforeAll(async () => {
  // a family of model names over three papers, and a word that only starts like one
  write('raw/docs/papers/alpha.md', `---
title: Alpha Bench
entities:
  - { name: Gemini, type: product }
  - { name: Gemini 1.5, type: product }
claims:
  - { subject: Alpha Bench, type: event, statement: Alpha Bench was released, eventDate: "2024-03-01" }
---
We compare Gemini 1.5 with two open models. Gemini 1.5 wins on recall, and Gemini answers fastest.
`);
  write('raw/docs/papers/beta.md', `---
title: Beta Agents
entities:
  - { name: Gemini-3 Pro, type: product }
claims:
  - { subject: Beta Agents, type: other, statement: Beta Agents scores 81 on the suite, status: disputed }
---
The agents run on Gemini-3 Pro.
`);
  write('raw/docs/papers/gamma.md', `---
title: Gamma Survey
entities:
  - { name: Gemini, type: product }
claims:
  - { subject: Beta Agents, type: other, statement: Beta Agents scores 64 on the suite }
  - { subject: Gamma Survey, type: event, statement: Gamma Survey was published, eventDate: "2019-07-15" }
---
Surveyed systems include Gemini.
`);
  write('raw/docs/papers/delta.md', `---
title: Delta Sky
---
The Geminids peak in December; Geminid meteors are bright.
`);
  // a statute in two chapters: articles name 国务院, one in an article's second paragraph
  write('raw/docs/statute/01.md', `---
title: 示范法 · 第一章
entities:
  - { name: 国务院, type: organization }
claims:
  - { subject: 示范法, type: event, statement: 示范法于2021年6月10日通过, eventDate: "2021-06-10" }
---
第一条　为了规范示范活动，制定本法。

第二条　国务院有关部门负责示范工作。

第三条　示范单位应当公开信息。

具体办法由国务院规定。
`);
  write('raw/docs/statute/02.md', `---
title: 示范法 · 第二章
entities:
  - { name: 国务院, type: organization }
---
第十条　国务院建立示范协调机制。
`);
  write('raw/docs/statute/03.md', `---
title: 示范法 · 第三章
entities:
  - { name: 国务院, type: organization }
---
第二十条　省级人民政府可以参照国务院的规定执行。
`);
  ctx = await createContext(dataDir);
  await sync(ctx, { llmGraph: false });
});

afterAll(async () => {
  await ctx?.datasources.closeAll();
  await ctx?.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('names and variants', () => {
  it('take a model line as variants, and nothing in CJK', () => {
    expect(extendsName('Gemini 1.5', 'Gemini')).toBe(true);
    expect(extendsName('Gemini-3 Pro', 'gemini')).toBe(true);
    expect(extendsName('Qwen2.5-Coder', 'Qwen')).toBe(true);
    expect(extendsName('Geminid', 'Gemini')).toBe(false);
    expect(extendsName('GPT4', 'GPT4')).toBe(false);
    expect(extendsName('国务院证券监督管理机构', '国务院')).toBe(false);
    expect(rootsOf('Gemini-3 Pro')).toEqual(['gemini', 'gemini-3']);
  });

  it('count whole names, the longest first', async () => {
    const { nameHits } = await import('../src/wiki/corpus-views.js');
    const hits = nameHits('gemini 1.5 beats gemini; the geminids and gemini-3 pro', ['gemini', 'gemini 1.5', 'gemini-3 pro']);
    expect(Object.fromEntries(hits.counts)).toEqual({ 'gemini 1.5': 1, gemini: 1, 'gemini-3 pro': 1 });
    expect(Object.fromEntries(nameHits('国务院证券监督管理机构和国务院', ['国务院']).counts)).toEqual({ 国务院: 2 });
  });

  it('cut a passage around its first hit', () => {
    const text = `${'x'.repeat(100)} the agents run on Gemini-3 Pro for every task`;
    expect(passageAround(text, ['gemini-3 pro'])).toMatch(/^….{0,40}Gemini-3 Pro for every task$/);
    expect(passageAround('nothing here', ['gemini'])).toBeNull();
  });
});

describe('mention pages', () => {
  it('are written for a family three documents name, a variant under its root', async () => {
    const candidates = await mentionCandidates(ctx.store);
    expect(candidates.map((c) => c.name)).toEqual(expect.arrayContaining(['Gemini', '国务院']));
    expect(candidates.map((c) => c.name)).not.toContain('Gemini 1.5');
    const written = await ensureCorpusPages(ctx);
    expect(written).toEqual(expect.arrayContaining(['wiki/mentions/gemini.md', 'wiki/mentions/国务院.md']));
  });

  it('list every document that names the family, with the names it uses and its passage', () => {
    const text = read('mentions/gemini.md');
    expect(text).toContain('# Gemini — where it is mentioned');
    expect(text).toContain('_3 documents name Gemini or a name that extends it (');
    const lines = bullets(text);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('- Alpha Bench — raw/docs/papers/alpha.md · Gemini 1.5 ×2, Gemini · “We compare Gemini 1.5 with two open models. Gemini 1.5 wins on recall, and Gemini answers fastest.”');
    expect(lines[1]).toBe('- Beta Agents — raw/docs/papers/beta.md · Gemini-3 Pro · “The agents run on Gemini-3 Pro.”');
    expect(lines[2]).toMatch(/^- Gamma Survey — raw\/docs\/papers\/gamma\.md · Gemini · /);
    // a whole word in Latin text: the meteors are not Gemini
    expect(text).not.toContain('delta.md');
  });

  it('name the articles a statute mentions it in, also in an article\'s second paragraph', () => {
    const lines = bullets(read('mentions/国务院.md'));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^- 示范法 · 第一章 — raw\/docs\/statute\/01\.md · 国务院 ×2 · 第二条, 第三条 · “/);
    expect(lines[1]).toMatch(/^- 示范法 · 第二章 — raw\/docs\/statute\/02\.md · 国务院 · 第十条 · “/);
  });

  it('are listed in the index, the most documents first', () => {
    const index = read('mentions/index.md');
    expect(index).toContain('<!-- knode:begin mentions -->');
    expect(index).toMatch(/\* \[Gemini\]\(gemini\.md\) \(product\) `3 documents`/);
    expect(index).toMatch(/\* \[国务院\]\(国务院\.md\) \(organization\) `3 documents`/);
  });

  it('take in a new document when a document pass touches the family', async () => {
    write('raw/docs/papers/epsilon.md', `---
title: Epsilon Eval
entities:
  - { name: Gemini 1.5, type: product }
---
Epsilon evaluates Gemini 1.5 on long inputs.
`);
    await sync(ctx, { llmGraph: false });
    const [variant] = await ctx.store.query<{ id: string }>(`SELECT id FROM entities WHERE name = 'Gemini 1.5' AND tx_to IS NULL`);
    // the sync has already written the page again (the variant's entity changed); the pass finds it current
    await ensureCorpusPages(ctx, { focus: { entities: [variant.id], claims: [] } });
    expect(bullets(read('mentions/gemini.md'))).toHaveLength(4);
    expect(read('mentions/gemini.md')).toContain('- Epsilon Eval — raw/docs/papers/epsilon.md · Gemini 1.5 · “Epsilon evaluates Gemini 1.5 on long inputs.”');
  });
});

describe('timelines', () => {
  it('put every dated claim of every entity on one page while they fit, in order, with sources', () => {
    expect(exists('timelines/all.md')).toBe(true);
    const text = read('timelines/all.md');
    expect(text).toContain('# Timeline');
    expect(text).toContain('_3 dated claims of every entity, in order:');
    const lines = bullets(text);
    expect(lines).toEqual([
      '- 2019-07-15 · Gamma Survey: Gamma Survey was published `fact` — raw/docs/papers/gamma.md',
      '- 2024-03-01 · Alpha Bench: Alpha Bench was released `fact` — raw/docs/papers/alpha.md',
      '- 2021-06-10 · 示范法: 示范法于2021年6月10日通过 `fact` — raw/docs/statute/01.md',
    ].sort((a, b) => a.slice(2, 12).localeCompare(b.slice(2, 12))));
    expect(text).toMatch(/## 2019\n\n- 2019-07-15/);
    expect(read('timelines/index.md')).toMatch(/\* \[all\]\(all\.md\) `3 claims` 2019-07-15 … 2024-03-01/);
  });

  it('split by decade, then year, then month past the page limit', () => {
    const years = new Map([
      ['2015', { n: 3, months: new Map([['2015-01', 3]]), first: '2015-01-02', last: '2015-01-09' }],
      ['2024', { n: 250, months: new Map([['2024-05', 250]]), first: '2024-05-01', last: '2024-05-30' }],
      ['2025', { n: TIMELINE_PAGE_CLAIMS + 1, months: new Map([['2025-01', 200], ['2025-02', TIMELINE_PAGE_CLAIMS - 199]]), first: '2025-01-01', last: '2025-02-28' }],
    ]);
    expect(timelinePeriods(years).map((p) => p.period)).toEqual(['2010s', '2024', '2025-01', '2025-02']);
    years.delete('2025');
    expect(timelinePeriods(years).map((p) => p.period)).toEqual(['all']);
    expect(timelinePeriods(new Map())).toEqual([]);
  });

  it('take in a new dated claim when a document pass writes it', async () => {
    write('raw/docs/papers/zeta.md', `---
title: Zeta Note
claims:
  - { subject: Zeta Note, type: event, statement: Zeta Note was drafted, eventDate: "2023-01-05" }
---
A note.
`);
    await sync(ctx, { llmGraph: false });
    const [claim] = await ctx.store.query<{ id: string }>(`SELECT id FROM claims WHERE statement = 'Zeta Note was drafted' AND tx_to IS NULL`);
    // a new claim is no input of the page: the focused pass is what writes it in
    expect(await ensureCorpusPages(ctx, { focus: { entities: [], claims: [claim.id] } })).toContain('wiki/timelines/all.md');
    expect(read('timelines/all.md')).toContain('- 2023-01-05 · Zeta Note: Zeta Note was drafted `fact` — raw/docs/papers/zeta.md');
  });
});

describe('disagreements', () => {
  it('bring together the conflicts the Judge found and the disputed claims, each side with its source', async () => {
    const [a] = await ctx.store.query<{ id: string }>(`SELECT id FROM claims WHERE statement = 'Beta Agents scores 81 on the suite' AND tx_to IS NULL`);
    const [b] = await ctx.store.query<{ id: string }>(`SELECT id FROM claims WHERE statement = 'Beta Agents scores 64 on the suite' AND tx_to IS NULL`);
    await ctx.store.query(
      `INSERT INTO claim_pair_verdicts (pair_id, a_id, b_id, relation, confidence, reason, model) VALUES ('p1', $1, $2, 'conflict', 0.9, 'two scores for one suite', 'test')`,
      [a.id, b.id],
    );
    expect(await ensureCorpusPages(ctx, { focus: { entities: [], claims: [b.id] } })).toContain('wiki/disagreements/1.md');
    const text = read('disagreements/1.md');
    expect(text).toContain('_2 disagreements in all, by subject:');
    expect(text).toMatch(/## Beta Agents\n\n- Beta Agents scores 81 on the suite — raw\/docs\/papers\/beta\.md ⟷ Beta Agents scores 64 on the suite — raw\/docs\/papers\/gamma\.md \(two scores for one suite\)\n- Beta Agents scores 81 on the suite `disputed` — raw\/docs\/papers\/beta\.md/);
    expect(read('disagreements/index.md')).toMatch(/\* \[Page 1\]\(1\.md\) `2` — Beta Agents/);
  });
});

describe('the pages as views', () => {
  it('have nothing left to do once written, and are written again when an input changes', async () => {
    expect((await reconcileViews(ctx, { llm: false })).regenerated).toBe(0);
    expect(await ensureCorpusPages(ctx)).toEqual([]);
    write('raw/docs/papers/beta.md', `---
title: Beta Agents
entities:
  - { name: Gemini-3 Pro, type: product }
claims:
  - { subject: Beta Agents, type: other, statement: Beta Agents scores 81 on the suite, status: disputed }
---
The agents run on Gemini-3 Pro, and on Gemini-3 Pro only.
`);
    await sync(ctx, { llmGraph: false });
    await reconcileViews(ctx, { llm: false });
    expect(read('mentions/gemini.md')).toContain('- Beta Agents — raw/docs/papers/beta.md · Gemini-3 Pro ×2 · “The agents run on Gemini-3 Pro, and on Gemini-3 Pro only.”');
  });
});
