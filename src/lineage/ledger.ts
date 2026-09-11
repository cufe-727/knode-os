import fs from 'node:fs';
import path from 'node:path';
import { Queryable } from '../store/migrations.js';
import { ScopeKind } from './types.js';

/**
 * The machine-facing truth: an append-only event log in the data directory.
 * Files remain the human-facing truth; the PGlite database is a projection of
 * both and can be rebuilt (`knode-os rebuild`) by replaying this log and
 * re-applying the declared sources.
 *
 * Events are small (one line per apply/dispose/purge/feedback) and never
 * contain document content — only keys, hashes and ids.
 */

export const LEDGER_DIR = 'ledger';
export const LEDGER_EVENTS = 'ledger/events.jsonl';

export interface LedgerScopeRef {
  id: string;
  kind: ScopeKind;
  key: string;
  sha: string;
  parent: string | null;
}

export type LedgerEvent =
  | { seq: number; ts: string; ev: 'apply'; actor: string; scope: LedgerScopeRef; stats?: Record<string, number> }
  | { seq: number; ts: string; ev: 'dispose'; actor: string; scope: LedgerScopeRef; reason: string; attic?: string | null }
  | { seq: number; ts: string; ev: 'purge'; actor: string; scope: LedgerScopeRef }
  | { seq: number; ts: string; ev: 'feedback'; actor: string; kind: string; id: string; payload?: unknown }
  | { seq: number; ts: string; ev: 'migrate'; actor: string; from: number; to: number }
  | { seq: number; ts: string; ev: 'rebuild'; actor: string; note?: string };

export function ledgerPath(dataDir: string): string {
  return path.join(dataDir, LEDGER_EVENTS);
}

export function appendLedger(dataDir: string, event: LedgerEvent): void {
  const file = ledgerPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(event) + '\n');
}

/** Read every event (the log is small: one line per source change). */
export function readLedger(dataDir: string, opts: { since?: number } = {}): LedgerEvent[] {
  const file = ledgerPath(dataDir);
  if (!fs.existsSync(file)) return [];
  const out: LedgerEvent[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as LedgerEvent;
      if (opts.since !== undefined && ev.seq <= opts.since) continue;
      out.push(ev);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

export function ledgerTail(dataDir: string): { seq: number; ts: string } | null {
  const events = readLedger(dataDir);
  const last = events[events.length - 1];
  return last ? { seq: last.seq, ts: last.ts } : null;
}

/** Next ledger sequence number, allocated inside the scope transaction so DB rows and log lines agree. */
export async function nextLedgerSeq(q: Queryable): Promise<number> {
  const [row] = await q.query<{ seq: number | string }>(
    `INSERT INTO meta (key, value) VALUES ('ledger_seq', '{"seq":1}'::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = jsonb_build_object('seq', (meta.value->>'seq')::bigint + 1)
     RETURNING (value->>'seq')::bigint AS seq`,
  );
  return Number(row?.seq ?? 1);
}

/** Re-seed the sequence counter from the log (rebuild path). */
export async function seedLedgerSeq(q: Queryable, dataDir: string): Promise<number> {
  const tail = ledgerTail(dataDir);
  const seq = tail?.seq ?? 0;
  await q.query(
    `INSERT INTO meta (key, value) VALUES ('ledger_seq', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ seq })],
  );
  return seq;
}

/** Last apply/dispose per (kind, key) — used by rebuild to keep original timestamps. */
export function ledgerTimeline(dataDir: string): Map<string, { apply?: LedgerEvent & { ev: 'apply' }; dispose?: LedgerEvent & { ev: 'dispose' } }> {
  const out = new Map<string, { apply?: LedgerEvent & { ev: 'apply' }; dispose?: LedgerEvent & { ev: 'dispose' } }>();
  for (const ev of readLedger(dataDir)) {
    if (ev.ev !== 'apply' && ev.ev !== 'dispose') continue;
    const k = `${ev.scope.kind}:${ev.scope.key}`;
    const cur = out.get(k) ?? {};
    if (ev.ev === 'apply') {
      cur.apply = ev;
      cur.dispose = undefined;
    } else {
      cur.dispose = ev;
    }
    out.set(k, cur);
  }
  return out;
}
