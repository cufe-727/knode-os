import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { supersedeByAttribute } from '../src/graph/claim-state-store.js';
import { sync } from '../src/ingest/sync.js';
import { recountAll } from '../src/lineage/fold.js';
import { claimsAsOf, foldClaimEvidence, toDateString } from '../src/store/temporal.js';

/**
 * A claim that states no date of its own is dated by its document: the date
 * goes to `effective_at` with `date_source = 'document'` (inferred, not
 * stated), while `valid_from` / `valid_to` stay what the source stated. The
 * document's date is read at fold time, so a `doc_date` found after the
 * extraction was applied (a dateline reader, a backfill) dates the claim at
 * its next fold, and an attribute series made of such claims supersedes.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-claim-document-dates-'));
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

const report = (value: number, extra = '') => `---
title: 支付组周报
entities:
  - { name: 支付组, type: organization }
claims:
  - { subject: 支付组, type: other, statement: 支付组在岗${value}人。 }
${extra}---
支付组在岗${value}人。
`;

type Row = { statement: string; valid_from: unknown; valid_to: unknown; observed_at: unknown; effective_at: unknown; date_source: string | null; superseded_by: string | null };
async function claims(c: AppContext): Promise<Row[]> {
  return c.store.query<Row>(
    `SELECT statement, valid_from, valid_to, observed_at, effective_at, date_source, superseded_by FROM claims WHERE tx_to IS NULL ORDER BY statement`,
  );
}

describe('a claim with no stated date', () => {
  it('takes its document date as an inferred effective date, now or once the document has one', async () => {
    const dataDir = path.join(tmp, 'ws');
    // no frontmatter date, no date in the path: the documents have no doc_date
    write(dataDir, 'raw/docs/周报/支付组/a.md', report(7));
    write(dataDir, 'raw/docs/周报/支付组/b.md', report(8));
    // a document dated by its frontmatter: its claim is dated by it at apply, as before
    write(dataDir, 'raw/docs/周报/支付组/c.md', report(9, '  - { subject: 支付组, type: other, statement: 支付组本月完成两次演练。, startDate: "2025-03" }\ndate: 2025-03-14\n'));
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });

    let rows = await claims(ctx);
    const by = (s: string) => rows.find((r) => r.statement.includes(s))!;
    // while the document has no date the claim has none either, and says nothing about where one came from
    expect(by('在岗7人')).toMatchObject({ effective_at: null, date_source: null, valid_from: null });
    expect(by('在岗8人')).toMatchObject({ effective_at: null, date_source: null });
    // dated by its document: inferred, the stated window left empty
    expect(by('在岗9人')).toMatchObject({ date_source: 'document', valid_from: null, valid_to: null });
    expect(toDateString(by('在岗9人').effective_at as string)).toBe('2025-03-14');
    expect(toDateString(by('在岗9人').observed_at as string)).toBe('2025-03-14');
    // a date the claim states stays stated
    expect(by('演练')).toMatchObject({ date_source: 'stated' });
    expect(toDateString(by('演练').valid_from as string)).toBe('2025-03-01');

    // undated claims take no part in a series: nothing is superseded among a / b
    await supersedeByAttribute(ctx.store);
    rows = await claims(ctx);
    expect(by('在岗7人').superseded_by).toBeNull();
    expect(by('在岗8人').superseded_by).toBeNull();

    // the documents get dates afterwards (what a dateline reader or a backfill writes) and the claims are refolded
    await ctx.store.query(`UPDATE documents SET doc_date = '2025-03-07T00:00:00Z' WHERE path = 'raw/docs/周报/支付组/a.md'`);
    await ctx.store.query(`UPDATE documents SET doc_date = '2025-03-21T00:00:00Z' WHERE path = 'raw/docs/周报/支付组/b.md'`);
    await ctx.store.tx((q) => recountAll(q));
    rows = await claims(ctx);
    expect(by('在岗7人')).toMatchObject({ date_source: 'document', valid_from: null, valid_to: null });
    expect(toDateString(by('在岗7人').effective_at as string)).toBe('2025-03-07');
    expect(toDateString(by('在岗7人').observed_at as string)).toBe('2025-03-07');
    expect(toDateString(by('在岗8人').effective_at as string)).toBe('2025-03-21');
    // a date the evidence recorded at apply wins over the document's date now
    await ctx.store.query(`UPDATE documents SET doc_date = '2030-01-01T00:00:00Z' WHERE path = 'raw/docs/周报/支付组/c.md'`);
    await ctx.store.tx((q) => recountAll(q));
    rows = await claims(ctx);
    expect(toDateString(by('在岗9人').effective_at as string)).toBe('2025-03-14');

    // now a series by date: 7 (03-07) → 9 (03-14) → 8 (03-21); only the newest is current
    await supersedeByAttribute(ctx.store);
    rows = await claims(ctx);
    expect(by('在岗7人').superseded_by).not.toBeNull();
    expect(by('在岗9人').superseded_by).not.toBeNull();
    expect(by('在岗8人').superseded_by).toBeNull();

    // an as_of read folds the same way
    const [subject] = await ctx.store.query<{ subject_id: string }>(`SELECT subject_id FROM claims WHERE statement = '支付组在岗7人。'`);
    const past = await claimsAsOf(ctx.store, [subject.subject_id], new Date().toISOString());
    expect(toDateString(past.find((c) => c.statement === '支付组在岗7人。')!.effective_at)).toBe('2025-03-07');
  });

  it('folds without the document lookup as before: only the evidence\'s own dates count', () => {
    const ev = (attrs: Record<string, unknown>, scope = 's1') => ({ kind: 'claim', target_id: 'c', scope_id: scope, segment_id: null, weight: 1, extractor: 'x', attrs, tx_from: '2026-01-01T00:00:00Z' });
    const row = { id: 'c', subject_id: 's', statement: '支付组在岗7人。' };
    expect(foldClaimEvidence(row, [ev({ statement: row.statement })])).toMatchObject({ effective_at: null, date_source: null, observed_at: null });
    const docs = new Map([['s1', { documentId: 'd1', docDate: '2025-03-07T00:00:00.000Z' }]]);
    expect(foldClaimEvidence(row, [ev({ statement: row.statement })], undefined, docs)).toMatchObject({
      effective_at: '2025-03-07T00:00:00.000Z', date_source: 'document', observed_at: '2025-03-07T00:00:00.000Z', valid_from: null,
    });
    // a supporter from a scope that read no document stays undated
    expect(foldClaimEvidence(row, [ev({ statement: row.statement }, 's2')], undefined, docs)).toMatchObject({ effective_at: null, date_source: null });
  });
});
