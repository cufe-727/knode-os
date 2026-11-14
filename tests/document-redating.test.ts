import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { SEGMENTER_VERSION } from '../src/constants.js';
import { writeSidecarPart } from '../src/fs/sidecar.js';
import { supersedeByAttribute } from '../src/graph/claim-state-store.js';
import { documentIdFor } from '../src/ingest/apply.js';
import { sync } from '../src/ingest/sync.js';
import { toDateString } from '../src/store/temporal.js';

/**
 * A document's claims are dated when the document is applied: a stated date
 * resolved on the document's date ("去年"), else the document's date itself
 * (`date_source = 'document'`). When the rules that read a document's date
 * change (a dateline reader, a fixed rule) a sync pass applies every document
 * whose date reads otherwise now again, its stored extraction included — no
 * model — so a claim takes the date it stated, a corrected date is followed,
 * and nothing is left half re-dated.
 */

// how documents are dated: as built (`off`: no date found), or per path
const dating = vi.hoisted(() => ({ off: false, override: new Map<string, string>() }));
vi.mock('../src/ingest/docdate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/ingest/docdate.js')>();
  return {
    ...real,
    docDateOf: (file: string, fm: Record<string, unknown> | null | undefined) =>
      dating.off ? null : dating.override.get(file) ?? real.docDateOf(file, fm),
  };
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-document-redating-'));
let ctx: AppContext | undefined;
afterAll(async () => {
  await ctx?.datasources.closeAll();
  await ctx?.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const A = 'raw/docs/reports/a.md';
const B = 'raw/docs/reports/b.md';
const C = 'raw/docs/reports/c.md';

type Row = { statement: string; valid_from: unknown; valid_to: unknown; effective_at: unknown; date_source: string | null; superseded_by: string | null };
const claims = async (c: AppContext) => c.store.query<Row>(
  `SELECT statement, valid_from, valid_to, effective_at, date_source, superseded_by FROM claims WHERE tx_to IS NULL ORDER BY statement`,
);
const day = (v: unknown) => toDateString(v as string | null);

describe('a document whose date reads otherwise now', () => {
  it('is applied again: its claims take what they stated, else its date; a corrected date is followed', async () => {
    const dataDir = path.join(tmp, 'ws');
    write(dataDir, A, `---
title: 2026 年 3 月点评
date: 2026-03-01
entities:
  - { name: 支付组, type: organization }
claims:
  - { subject: 支付组, type: earnings, statement: 支付组去年营收为100亿元。, startDate: 去年, endDate: 去年 }
---
支付组去年营收100亿元。
`);
    write(dataDir, B, `---
title: 2026 年 2 月点评
date: 2026-02-01
entities:
  - { name: 支付组, type: organization }
claims:
  - { subject: 支付组, type: earnings, statement: 支付组营收为120亿元。, startDate: "2026", endDate: "2026" }
---
支付组营收120亿元。
`);
    // a source whose claims come from a stored tier-1 extraction
    const cText = '# 支付组周报\n\n支付组在岗7人。\n';
    write(dataDir, C, cText);

    // built while no document had a date
    dating.off = true;
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
    const sha = (await ctx.store.query<{ sha256: string }>(`SELECT sha256 FROM documents WHERE id = $1`, [documentIdFor(C)]))[0].sha256;
    writeSidecarPart(dataDir, C, 'tier1', {
      status: 'done', model: 'test', contentSha: sha, extractedAt: '2026-11-01T00:00:00.000Z', segmenter: SEGMENTER_VERSION,
      entities: [{ name: '支付组', type: 'organization' }],
      relations: [],
      claims: [{ subject: '支付组', statement: '支付组在岗7人。', type: 'other', status: 'fact', kind: 'fact', attribute: '在岗人数', value: 7, unit: '人' }],
    } as never);
    await sync(ctx, { llmGraph: false });
    let rows = await claims(ctx);
    let by = (s: string) => rows.find((r) => r.statement === s)!;
    // the relative date could not be resolved, and nothing was put in its place
    expect(by('支付组去年营收为100亿元。')).toMatchObject({ valid_from: null, effective_at: null, date_source: null });
    expect(by('支付组在岗7人。')).toMatchObject({ effective_at: null, date_source: null });
    expect(day(by('支付组营收为120亿元。').valid_from)).toBe('2026-01-01');

    // the date rules change (DOC_DATE_RULES bumped: these scopes were applied under older ones) and read dates now:
    // every document whose date reads otherwise is applied again, and only those
    dating.off = false;
    dating.override.set(C, '2025-09-05T00:00:00.000Z');
    await ctx.store.query(`UPDATE scopes SET meta = meta - 'dateRules' WHERE kind = 'doc'`);
    const pass = await sync(ctx, { llmGraph: false });
    expect(pass.indexed).toBe(3);
    rows = await claims(ctx);
    // "去年" resolved on the document's date, as stated: not the document's date in its place
    expect(by('支付组去年营收为100亿元。')).toMatchObject({ date_source: 'stated' });
    expect([day(by('支付组去年营收为100亿元。').valid_from), day(by('支付组去年营收为100亿元。').valid_to)]).toEqual(['2025-01-01', '2025-12-31']);
    // a claim that states no date takes the document's, and says so
    expect(by('支付组在岗7人。')).toMatchObject({ date_source: 'document', valid_from: null });
    expect(day(by('支付组在岗7人。').effective_at)).toBe('2025-09-05');
    // so last year's figure is history and this year's is current
    await supersedeByAttribute(ctx.store);
    rows = await claims(ctx);
    expect(by('支付组去年营收为100亿元。').superseded_by).not.toBeNull();
    expect(by('支付组营收为120亿元。').superseded_by).toBeNull();

    // a pass that finds nothing changed applies nothing
    expect((await sync(ctx, { llmGraph: false })).indexed).toBe(0);

    // a corrected date is followed the same way — once the rules that read it change; until then nothing is read again
    dating.override.set(C, '2025-09-12T00:00:00.000Z');
    expect((await sync(ctx, { llmGraph: false })).indexed).toBe(0);
    await ctx.store.query(`UPDATE scopes SET meta = meta - 'dateRules' WHERE kind = 'doc'`);
    expect((await sync(ctx, { llmGraph: false })).indexed).toBe(1);
    rows = await claims(ctx);
    expect(day(by('支付组在岗7人。').effective_at)).toBe('2025-09-12');
  });
});
