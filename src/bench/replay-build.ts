import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createContext } from '../context.js';
import { initDataDir } from '../fs/datadir.js';
import { auditDuplicateClaims } from '../graph/claim-dedupe.js';
import { refreshClaimState } from '../graph/claim-state-store.js';
import { isoWeekOf } from '../graph/store.js';
import { sync } from '../ingest/sync.js';
import { LlmClient } from '../llm/client.js';
import { Store } from '../store/db.js';

/**
 * A fresh build of a workspace from its raw documents and stored extractions,
 * without a model: `raw/docs` and `.sidecar/raw/docs` are copied into a new
 * data folder (the source is only read), `sync` replays every tier-1 sidecar,
 * and the duplicate-claim audit runs with a judge that only counts and records
 * the pairs it is shown. Embeddings are the local hash embedder's, so the
 * audit's candidates are text candidates, not vector ones.
 *
 * For a pack of weekly reports, `weeklyValues` then says of every weekly
 * metric line ("服务可用性：99.903%", "本周周活跃用户为149万") whether its week's
 * claim ended the build as a claim of that week alone — current or history —
 * after the audit's rules ran, or shares a claim (or a merge group) with
 * another week.
 *
 *   KNODE_DATABASE_KIND=pglite npx tsx src/bench/replay-build.ts <workspace> <out-dir>
 */

export interface ReplayResult {
  liveClaims: number;
  audit: Awaited<ReturnType<typeof auditDuplicateClaims>>;
  judge: { calls: number; pairs: number };
  verdictRows: number;
  weekly: WeeklyValues;
}

export interface WeeklyValues {
  values: number;
  /** Its week's claim holds that week only: a claim of its own, or a group within the week. */
  ownWeek: number;
  /** Of those, the representative of a group (the week's value and a later report's restatement of it). */
  groupedInWeek: number;
  /** Its claim, or the group it is in, holds another week as well. */
  sharedWithOtherWeek: number;
  /** No live claim of the value from its report. */
  missing: number;
  /** A few of the shared ones: report, statement, the weeks its claim holds. */
  sharedSample: string[];
}

const METRIC = /(服务可用性|支付成功率|周活跃用户)[^0-9\n]{0,12}?([\d.]+)/;

export async function weeklyValues(store: Store, dataDir: string): Promise<WeeklyValues> {
  const out: WeeklyValues = { values: 0, ownWeek: 0, groupedInWeek: 0, sharedWithOtherWeek: 0, missing: 0, sharedSample: [] };
  const root = path.join(dataDir, 'raw/docs/周报');
  if (!fs.existsSync(root)) return out;
  // a claim's week, by its live evidence and its members'
  const weeksOf = async (id: string): Promise<Set<string>> => {
    const rows = await store.query<{ attrs: { valid_from?: string | null; event_at?: string | null } }>(
      `SELECT e.attrs FROM evidence e WHERE e.kind = 'claim' AND e.tx_to IS NULL
         AND (e.target_id = $1 OR e.target_id IN (SELECT id FROM claims WHERE canonical_id = $1 AND tx_to IS NULL))`,
      [id],
    );
    return new Set(rows.map((r) => r.attrs.valid_from ?? r.attrs.event_at).filter((d): d is string => Boolean(d)).map(isoWeekOf));
  };
  for (const team of fs.readdirSync(root)) {
    for (const file of fs.readdirSync(path.join(root, team))) {
      const rel = `raw/docs/周报/${team}/${file}`;
      const text = fs.readFileSync(path.join(dataDir, rel), 'utf8');
      const m = METRIC.exec(text.split('回顾')[0]);
      const range = /(\d{4}-\d\d-\d\d) ~ (\d{4}-\d\d-\d\d)/.exec(text);
      if (!m || !range) continue;
      out.values++;
      const week = isoWeekOf(`${range[1]}T00:00:00Z`);
      const value = Number(m[2]);
      // the report's own week's claim of the value, not its restatement of an earlier week (回顾: 两周前…)
      const hits = await store.query<{ id: string; canonical_id: string | null; statement: string; from: string | null }>(
        `SELECT c.id, c.canonical_id, c.statement, COALESCE(e.attrs->>'valid_from', e.attrs->>'event_at') AS from FROM evidence e
         JOIN scopes s ON s.id = e.scope_id AND s.kind = 'tier1' AND s.key = $1 AND s.status = 'active'
         JOIN claims c ON c.id = e.target_id AND c.tx_to IS NULL
         WHERE e.kind = 'claim' AND e.tx_to IS NULL AND (e.attrs->>'value_num')::float8 = $2 AND c.statement LIKE $3`,
        [rel, value, `%${m[1]}%`],
      );
      const hit = hits.find((h) => h.from && isoWeekOf(h.from) === week) ?? hits[0];
      if (!hit) {
        out.missing++;
        continue;
      }
      const rep = hit.canonical_id ?? hit.id;
      const weeks = await weeksOf(rep);
      if (weeks.size <= 1 && (weeks.size === 0 || weeks.has(week))) {
        out.ownWeek++;
        if (hit.canonical_id || (await store.query(`SELECT 1 FROM claims WHERE canonical_id = $1 AND tx_to IS NULL LIMIT 1`, [rep])).length) out.groupedInWeek++;
      } else {
        out.sharedWithOtherWeek++;
        if (out.sharedSample.length < 20) out.sharedSample.push(`${rel} ${week}: ${hit.statement}${hit.canonical_id ? ' (merged)' : ''} → ${[...weeks].sort().join(', ')}`);
      }
    }
  }
  return out;
}

export async function replayBuild(bench: string, out: string): Promise<ReplayResult> {
  if (process.env.KNODE_DATABASE_KIND !== 'pglite') throw new Error('set KNODE_DATABASE_KIND=pglite: a replay build opens a database of its own');
  const dataDir = path.join(out, 'ws');
  fs.rmSync(out, { recursive: true, force: true });
  initDataDir(dataDir);
  fs.cpSync(path.join(bench, 'raw/docs'), path.join(dataDir, 'raw/docs'), { recursive: true });
  fs.cpSync(path.join(bench, '.sidecar/raw/docs'), path.join(dataDir, '.sidecar/raw/docs'), { recursive: true });
  const ctx = await createContext(dataDir);
  try {
    if (ctx.embedder.model !== 'local-hash-v1' || ctx.config.embedding.provider !== 'local') throw new Error(`refusing to build with the ${ctx.embedder.model} embedder`);
    await sync(ctx, { llmGraph: false });
    const [{ n: queued }] = await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM extraction_queue`);
    if (queued > 0) throw new Error(`${queued} documents have no replayable extraction: this build would need a model`);
    await refreshClaimState(ctx.store);
    const judge = { calls: 0, pairs: 0 };
    const shown: string[] = [];
    const llm = {
      enabled: true, label: 'count@judge', provider: 'openai', model: 'count',
      complete: async (messages: { role: string; content: string }[]) => {
        judge.calls++;
        const user = messages.find((m) => m.role === 'user')?.content ?? '';
        const blocks = user.split(/\n\n(?=Pair \d+ — )/);
        judge.pairs += blocks.length;
        for (const b of blocks) shown.push(b.split('\n').filter((l) => !l.trim().startsWith('excerpt:')).join(' ‖ '));
        return JSON.stringify({ verdicts: [] });
      },
    } as unknown as LlmClient;
    (ctx.config.review as { claimMergeMaxJudgedPerRun: number }).claimMergeMaxJudgedPerRun = 1_000_000;
    const audit = await auditDuplicateClaims({ store: ctx.store, embedder: ctx.embedder, config: ctx.config, llm });
    const [{ n: liveClaims }] = await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM claims WHERE tx_to IS NULL`);
    const [{ n: verdictRows }] = await ctx.store.query<{ n: number }>(`SELECT count(*)::int AS n FROM claim_pair_verdicts`);
    const weekly = await weeklyValues(ctx.store, dataDir);
    fs.writeFileSync(path.join(out, 'judge-pairs.jsonl'), shown.map((x) => JSON.stringify(x)).join('\n') + '\n');
    const result = { liveClaims, audit, judge, verdictRows, weekly };
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    return result;
  } finally {
    await ctx.datasources.closeAll();
    await ctx.store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [bench, out] = process.argv.slice(2);
  if (!bench || !out) {
    console.error('usage: KNODE_DATABASE_KIND=pglite tsx src/bench/replay-build.ts <workspace> <out-dir>');
    process.exit(2);
  }
  replayBuild(path.resolve(bench), path.resolve(out)).then((r) => console.log(JSON.stringify(r, null, 2)), (err) => {
    console.error(err);
    process.exit(1);
  });
}
