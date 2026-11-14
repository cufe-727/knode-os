import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { SEGMENTER_VERSION } from '../src/constants.js';
import { writeSidecarPart } from '../src/fs/sidecar.js';
import { supersedeByAttribute } from '../src/graph/claim-state-store.js';
import { rekeyState, rekeyWeeklyReadings } from '../src/graph/claim-rekey.js';
import { applyMerge } from '../src/graph/merge.js';
import { documentIdFor } from '../src/ingest/apply.js';
import { sync } from '../src/ingest/sync.js';
import { toDateString } from '../src/store/temporal.js';

/**
 * A document's claims are dated when the document is applied: a stated date
 * resolved on the document's date ("去年"), else the document's date itself
 * (`date_source = 'document'`). When the rules that read a document's date
 * change, a sync pass reads every document's date again and re-dates, in
 * place, the documents whose date reads otherwise now: the document's date,
 * the dates of its evidence (relative ones read again from the stored words)
 * and what folds from them. Nothing is applied again: no entity is resolved
 * again, no id changes, no scope is replaced, nothing anyone decided moves.
 * A document whose date reads the same, or whose stored extraction is not
 * there to read, is only marked as checked.
 */

// how documents are dated: as built (`off`: no date found), or per path
const dating = vi.hoisted(() => ({ off: false, main: false, override: new Map<string, string>() }));
vi.mock('../src/ingest/docdate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/ingest/docdate.js')>();
  return {
    ...real,
    docDateOf: (file: string, ...rest: unknown[]) =>
      dating.off ? null
        : dating.override.has(file) ? dating.override.get(file)!
        // as main reads a date: frontmatter and path, never the text
        : dating.main ? real.docDateOf(file, rest[0] as Record<string, unknown>)
        : (real.docDateOf as (...a: unknown[]) => string | null)(file, ...rest),
  };
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-document-redating-'));
const opened: AppContext[] = [];
afterAll(async () => {
  for (const c of opened) {
    await c.datasources.closeAll();
    await c.store.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

type Row = { id: string; statement: string; valid_from: unknown; valid_to: unknown; effective_at: unknown; observed_at: unknown; date_source: string | null; superseded_by: string | null };
const claims = (c: AppContext) => c.store.query<Row>(
  `SELECT id, statement, valid_from, valid_to, effective_at, observed_at, date_source, superseded_by FROM claims WHERE tx_to IS NULL ORDER BY statement`,
);
const day = (v: unknown) => toDateString(v as string | null);

/** Everything a re-date must leave as it is: ids, scopes, merges, when each piece of evidence was written. */
async function identity(c: AppContext) {
  const q = <T>(sql: string) => c.store.query<T>(sql);
  return {
    entities: await q<{ id: string; canonical_id: string | null; tx_to: unknown }>(`SELECT id, canonical_id, tx_to IS NULL AS live FROM entities ORDER BY id`),
    relations: await q<{ id: string }>(`SELECT id, tx_to IS NULL AS live FROM relations ORDER BY id`),
    claims: await q<{ id: string }>(`SELECT id, tx_to IS NULL AS live, canonical_id FROM claims ORDER BY id`),
    scopes: await q<{ id: string }>(`SELECT id, kind, key, status FROM scopes ORDER BY id`),
    evidence: await q<{ id: string }>(`SELECT id::text, kind, target_id, scope_id, segment_id, tx_from, tx_to FROM evidence ORDER BY id`),
    mentions: await q<{ n: number }>(`SELECT count(*)::int AS n FROM entity_mentions`),
  };
}

/** A workspace applied under older date rules: none of its scopes says which rules it was checked against. */
const olderRules = (c: AppContext) => c.store.query(`UPDATE scopes SET meta = meta - 'dateRules' WHERE kind = 'doc'`);

const tier1 = (c: AppContext, file: string, sha: string, body: Record<string, unknown>) => writeSidecarPart(c.dataDir, file, 'tier1', {
  status: 'done', model: 'test', contentSha: sha, extractedAt: '2026-11-01T00:00:00.000Z', segmenter: SEGMENTER_VERSION, ...body,
} as never);
const shaOf = async (c: AppContext, file: string) =>
  (await c.store.query<{ sha256: string }>(`SELECT sha256 FROM documents WHERE id = $1`, [documentIdFor(file)]))[0].sha256;

async function open(name: string, files: [string, string][]): Promise<AppContext> {
  const dataDir = path.join(tmp, name);
  for (const [p, t] of files) write(dataDir, p, t);
  const ctx = await createContext(dataDir);
  opened.push(ctx);
  return ctx;
}

describe('a document whose date reads otherwise now', () => {
  const A = 'raw/docs/reports/a.md';
  const B = 'raw/docs/reports/b.md';
  const C = 'raw/docs/reports/c.md';
  const D = 'raw/docs/reports/d.md';

  it('is re-dated in place: its claims take what they stated, else its date, and nothing else changes', async () => {
    const ctx = await open('dates', [
      [A, `---
title: 2026 年 3 月点评
date: 2026-03-01
entities:
  - { name: 支付组, type: organization }
claims:
  - { subject: 支付组, type: earnings, statement: 支付组去年营收为100亿元。, startDate: 去年, endDate: 去年 }
---
支付组去年营收100亿元。
`],
      [B, `---
title: 2026 年 2 月点评
date: 2026-02-01
entities:
  - { name: 支付组, type: organization }
claims:
  - { subject: 支付组, type: earnings, statement: 支付组营收为120亿元。, startDate: "2026", endDate: "2026" }
---
支付组营收120亿元。
`],
      [C, '# 支付团队周报\n\n支付团队在岗7人，孙欣负责结算中台。\n'],
      [D, '# 支付组周报\n\n支付组负责风控引擎。孙欣在支付组。\n'],
    ]);
    // built while no document had a date
    dating.off = true;
    await sync(ctx, { llmGraph: false });
    tier1(ctx, C, await shaOf(ctx, C), {
      entities: [{ name: '支付团队', type: 'organization' }, { name: '孙欣', type: 'person' }, { name: '结算中台', type: 'project' }],
      relations: [{ source: '孙欣', target: '支付团队', type: 'member_of' }, { source: '支付团队', target: '结算中台', type: 'related_to', description: '支付团队负责结算中台' }],
      claims: [
        { subject: '支付团队', statement: '支付团队在岗7人。', type: 'other', status: 'fact', kind: 'fact', attribute: '在岗人数', value: 7, unit: '人' },
        { subject: '支付团队', statement: '支付团队上月在岗5人。', type: 'other', status: 'fact', kind: 'fact', startDate: '上月', endDate: '上月' },
      ],
    });
    tier1(ctx, D, await shaOf(ctx, D), {
      entities: [{ name: '支付组', type: 'organization' }, { name: '孙欣', type: 'person' }, { name: '风控引擎', type: 'project' }],
      relations: [{ source: '孙欣', target: '支付组', type: 'member_of' }, { source: '支付组', target: '风控引擎', type: 'related_to' }],
      claims: [{ subject: '支付组', statement: '支付组负责风控引擎。', type: 'other', status: 'fact', kind: 'fact' }],
    });
    await sync(ctx, { llmGraph: false });
    // a person decided 支付团队 is 支付组
    const team = (await ctx.store.query<{ id: string; name: string }>(`SELECT id, name FROM entities WHERE tx_to IS NULL AND name IN ('支付团队', '支付组')`));
    await applyMerge(ctx.store, { entityId: team.find((e) => e.name === '支付团队')!.id, canonicalId: team.find((e) => e.name === '支付组')!.id });

    let rows = await claims(ctx);
    let by = (s: string) => rows.find((r) => r.statement === s)!;
    // the relative date could not be resolved, and nothing was put in its place
    expect(by('支付组去年营收为100亿元。')).toMatchObject({ valid_from: null, effective_at: null, date_source: null });
    expect(by('支付团队在岗7人。')).toMatchObject({ effective_at: null, date_source: null });
    const before = await identity(ctx);
    const folds = await ctx.store.query<{ id: string; fold_sha: string }>(`SELECT id, fold_sha FROM claims WHERE tx_to IS NULL ORDER BY id`);

    // the date rules change (DOC_DATE_RULES bumped: these scopes were checked under older ones) and read dates now
    dating.off = false;
    dating.override.set(C, '2025-09-05T00:00:00.000Z');
    // D keeps no date under the new rules either
    dating.override.set(D, null as unknown as string);
    await olderRules(ctx);
    const pass = await sync(ctx, { llmGraph: false });
    expect(pass.errors).toBe(0);

    // no entity resolved again, no id, scope, merge or supporter changed
    expect(await identity(ctx)).toEqual(before);
    rows = await claims(ctx);
    by = (s: string) => rows.find((r) => r.statement === s)!;
    // "去年" resolved on the document's date, as stated: not the document's date in its place
    expect(by('支付组去年营收为100亿元。')).toMatchObject({ date_source: 'stated' });
    expect([day(by('支付组去年营收为100亿元。').valid_from), day(by('支付组去年营收为100亿元。').valid_to)]).toEqual(['2025-01-01', '2025-12-31']);
    // a stored extraction's relative date read again from its words
    expect([day(by('支付团队上月在岗5人。').valid_from), day(by('支付团队上月在岗5人。').valid_to), by('支付团队上月在岗5人。').date_source]).toEqual(['2025-08-01', '2025-08-31', 'stated']);
    // a claim that states no date takes the document's, and says so
    expect(by('支付团队在岗7人。')).toMatchObject({ date_source: 'document', valid_from: null });
    expect(day(by('支付团队在岗7人。').effective_at)).toBe('2025-09-05');
    expect(day(by('支付团队在岗7人。').observed_at)).toBe('2025-09-05');
    // the document without a date is untouched: its claim folds as it did
    const after = new Map((await ctx.store.query<{ id: string; fold_sha: string }>(`SELECT id, fold_sha FROM claims WHERE tx_to IS NULL`)).map((r) => [r.id, r.fold_sha]));
    expect(after.get(by('支付组负责风控引擎。').id)).toBe(folds.find((f) => f.id === by('支付组负责风控引擎。').id)!.fold_sha);
    const [doc] = await ctx.store.query<{ doc_date: unknown }>(`SELECT doc_date FROM documents WHERE id = $1`, [documentIdFor(C)]);
    expect(day(doc.doc_date)).toBe('2025-09-05');
    // so last year's figure is history and this year's is current
    await supersedeByAttribute(ctx.store);
    rows = await claims(ctx);
    expect(by('支付组去年营收为100亿元。').superseded_by).not.toBeNull();
    expect(by('支付组营收为120亿元。').superseded_by).toBeNull();

    // a pass that finds nothing changed touches nothing
    const settled = await identity(ctx);
    expect((await sync(ctx, { llmGraph: false })).indexed).toBe(0);
    expect(await identity(ctx)).toEqual(settled);

    // a corrected date is followed the same way, once the rules that read it change; until then nothing is read again
    dating.override.set(C, '2025-09-12T00:00:00.000Z');
    await sync(ctx, { llmGraph: false });
    expect(day((await claims(ctx)).find((r) => r.statement === '支付团队在岗7人。')!.effective_at)).toBe('2025-09-05');
    await olderRules(ctx);
    await sync(ctx, { llmGraph: false });
    rows = await claims(ctx);
    expect(day(by('支付团队在岗7人。').effective_at)).toBe('2025-09-12');
    expect([day(by('支付团队上月在岗5人。').valid_from), day(by('支付团队上月在岗5人。').valid_to)]).toEqual(['2025-08-01', '2025-08-31']);
    expect(await identity(ctx)).toEqual(settled);
  });

  it('keeps what it knows when the stored extraction cannot be read again', async () => {
    const E = 'raw/docs/reports/e.md';
    const F = 'raw/docs/reports/f.md';
    const ctx = await open('unreadable', [
      [E, '# 支付组周报\n\n支付组在岗7人，孙欣负责结算中台。\n'],
      [F, '# 风控组周报\n\n风控组在岗4人。\n'],
    ]);
    dating.off = true;
    await sync(ctx, { llmGraph: false });
    tier1(ctx, E, await shaOf(ctx, E), {
      entities: [{ name: '支付组', type: 'organization' }, { name: '结算中台', type: 'project' }],
      relations: [{ source: '支付组', target: '结算中台', type: 'related_to' }],
      claims: [{ subject: '支付组', statement: '支付组在岗7人。', type: 'other', status: 'fact', kind: 'fact' }],
    });
    tier1(ctx, F, await shaOf(ctx, F), {
      entities: [{ name: '风控组', type: 'organization' }],
      relations: [],
      claims: [{ subject: '风控组', statement: '风控组在岗4人。', type: 'other', status: 'fact', kind: 'fact' }],
    });
    await sync(ctx, { llmGraph: false });
    const count = async () => (await ctx.store.query<{ c: number; r: number }>(
      `SELECT (SELECT count(*)::int FROM claims WHERE tx_to IS NULL) AS c, (SELECT count(*)::int FROM relations WHERE tx_to IS NULL) AS r`,
    ))[0];
    expect(await count()).toEqual({ c: 2, r: 1 });
    const before = await identity(ctx);

    // E's extraction is being redone (not replayable), F's is damaged
    tier1(ctx, E, await shaOf(ctx, E), { status: 'partial' });
    const fPath = path.join(ctx.dataDir, '.sidecar', F, 'tier1.json');
    const broken = JSON.parse(fs.readFileSync(fPath, 'utf8'));
    delete broken.relations;
    delete broken.claims;
    fs.writeFileSync(fPath, JSON.stringify(broken));
    dating.off = false;
    dating.override.set(E, '2025-09-05T00:00:00.000Z');
    dating.override.set(F, '2025-09-05T00:00:00.000Z');
    await olderRules(ctx);
    const logs: string[] = [];
    const pass = await sync(ctx, { llmGraph: false, onProgress: (m: string) => logs.push(m) });
    // nothing disposed that cannot be put back, no model extraction queued
    expect(await count()).toEqual({ c: 2, r: 1 });
    expect(await identity(ctx)).toEqual(before);
    expect((await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM extraction_queue`))[0].n).toBe(0);
    expect(pass.errors).toBe(0);
    // said once, then marked: the next pass is quiet
    expect(logs.filter((l) => l.includes(F)).length).toBe(1);
    const again: string[] = [];
    const next = await sync(ctx, { llmGraph: false, onProgress: (m: string) => again.push(m) });
    expect(next.errors).toBe(0);
    expect(again.filter((l) => l.includes(F) || l.includes(E))).toEqual([]);
  });

  it('is checked on a wiki page too', async () => {
    const W = 'wiki/notes/支付组.md';
    const ctx = await open('wiki', [
      [W, `---
title: 支付组
date: 2026-03-01
entities:
  - { name: 支付组, type: organization }
claims:
  - { subject: 支付组, type: other, statement: 支付组上月营收为9亿元。, startDate: 上月, endDate: 上月 }
---
支付组是一个团队。
`],
    ]);
    dating.off = true;
    await sync(ctx, { llmGraph: false });
    expect((await claims(ctx)).find((r) => r.statement === '支付组上月营收为9亿元。')).toMatchObject({ valid_from: null, date_source: null });
    dating.off = false;
    await olderRules(ctx);
    await sync(ctx, { llmGraph: false });
    const row = (await claims(ctx)).find((r) => r.statement === '支付组上月营收为9亿元。')!;
    expect([day(row.valid_from), day(row.valid_to), row.date_source]).toEqual(['2026-02-01', '2026-02-28', 'stated']);
  });

  it('gets its dateline on the first sync after an upgrade, and only it changes', async () => {
    const R = 'raw/docs/周报/支付组/w36.md';
    const N = 'raw/docs/周报/支付组/notes.md';
    const P = 'raw/docs/周报/支付组/2025-09-01-plan.md';
    const ctx = await open('upgrade', [
      [R, '# 支付组周报\n\n日期：2025-09-05\n\n支付组本周在岗7人，孙欣负责结算中台。\n'],
      [N, '# 支付组笔记\n\n支付组负责风控引擎。\n'],
      [P, '# 支付组计划\n\n支付组计划扩编。\n'],
    ]);
    // indexed on main: no dateline read, no date rules recorded
    dating.main = true;
    dating.override.clear();
    await sync(ctx, { llmGraph: false });
    tier1(ctx, R, await shaOf(ctx, R), {
      entities: [{ name: '支付组', type: 'organization' }, { name: '孙欣', type: 'person' }, { name: '结算中台', type: 'project' }],
      relations: [{ source: '孙欣', target: '结算中台', type: 'related_to', description: '孙欣负责结算中台', validFrom: '本周' }],
      claims: [
        { subject: '支付组', statement: '支付组本周在岗7人。', type: 'other', status: 'fact', kind: 'fact', attribute: '在岗人数', value: 7, unit: '人', startDate: '本周', endDate: '本周' },
        { subject: '支付组', statement: '孙欣负责结算中台。', type: 'other', status: 'fact', kind: 'fact' },
      ],
    });
    tier1(ctx, N, await shaOf(ctx, N), {
      entities: [{ name: '支付组', type: 'organization' }, { name: '风控引擎', type: 'project' }],
      relations: [{ source: '支付组', target: '风控引擎', type: 'related_to' }],
      claims: [{ subject: '支付组', statement: '支付组负责风控引擎。', type: 'other', status: 'fact', kind: 'fact' }],
    });
    await sync(ctx, { llmGraph: false });
    await olderRules(ctx);
    const dated = async () => new Map((await ctx.store.query<{ path: string; doc_date: unknown }>(`SELECT path, doc_date FROM documents WHERE root = 'docs'`)).map((d) => [d.path, day(d.doc_date)]));
    expect(await dated()).toEqual(new Map([[R, null], [N, null], [P, '2025-09-01']]));
    const before = await identity(ctx);
    const folds = new Map((await ctx.store.query<{ id: string; fold_sha: string }>(`SELECT id, fold_sha FROM claims`)).map((r) => [r.id, r.fold_sha]));
    const relFolds = new Map((await ctx.store.query<{ id: string; fold_sha: string }>(`SELECT id, fold_sha FROM relations`)).map((r) => [r.id, r.fold_sha]));
    expect((await rekeyState(ctx.store)).done).toBe(true);

    // upgraded
    dating.main = false;
    const logs: string[] = [];
    const pass = await sync(ctx, { llmGraph: false, onProgress: (m) => logs.push(m) });
    expect(pass).toMatchObject({ indexed: 0, errors: 0 });
    expect(await dated()).toEqual(new Map([[R, '2025-09-05'], [N, null], [P, '2025-09-01']]));
    expect(logs.filter((l) => l.startsWith('re-dated'))).toEqual([`re-dated ${R}: none → 2025-09-05 (2 claim, 1 relation dates)`]);
    // no entity, claim or relation id changed, nothing opened or closed
    expect(await identity(ctx)).toEqual(before);
    // only the re-dated document's rows fold otherwise
    const changed = (await ctx.store.query<{ id: string; statement: string; fold_sha: string }>(`SELECT id, statement, fold_sha FROM claims`)).filter((r) => folds.get(r.id) !== r.fold_sha).map((r) => r.statement).sort();
    expect(changed).toEqual(['孙欣负责结算中台。', '支付组本周在岗7人。']);
    const relChanged = (await ctx.store.query<{ id: string; description: string; fold_sha: string }>(`SELECT id, description, fold_sha FROM relations`)).filter((r) => relFolds.get(r.id) !== r.fold_sha);
    expect(relChanged.map((r) => r.description)).toEqual(['孙欣负责结算中台']);
    const reading = (await claims(ctx)).find((r) => r.statement === '支付组本周在岗7人。')!;
    expect([day(reading.valid_from), day(reading.valid_to), reading.date_source]).toEqual(['2025-09-01', '2025-09-07', 'stated']);

    // a second sync does nothing
    const again: string[] = [];
    expect(await sync(ctx, { llmGraph: false, onProgress: (m) => again.push(m) })).toMatchObject({ indexed: 0, errors: 0 });
    expect(again.filter((l) => l.startsWith('re-dated'))).toEqual([]);
    expect(await identity(ctx)).toEqual(before);

    // the reading is now one of its week: the claim re-key, set to visit it again, moves it
    expect(await rekeyState(ctx.store)).toEqual({ cursor: null, done: false });
    await rekeyWeeklyReadings(ctx.store);
    const moved = (await claims(ctx)).find((r) => r.statement === '支付组本周在岗7人。')!;
    expect(moved.id).not.toBe(reading.id);
    expect((await rekeyState(ctx.store)).done).toBe(true);
  });
});
