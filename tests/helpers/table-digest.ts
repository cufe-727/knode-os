import type { Queryable } from '../../src/store/db.js';

/**
 * Every table of the open schema with its row count and a hash of its rows
 * (each row's text, sorted): two digests are equal when no row was added,
 * removed or changed (docs/design/35 §8: a build is the same before and after
 * it is looked at).
 */
export async function tableDigest(q: Queryable): Promise<Record<string, { rows: number; hash: string }>> {
  const tables = await q.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p') ORDER BY 1`,
  );
  const out: Record<string, { rows: number; hash: string }> = {};
  for (const { name } of tables) {
    const [r] = await q.query<{ rows: number; hash: string | null }>(
      `SELECT count(*)::int AS rows, md5(coalesce(string_agg(t::text, '␞' ORDER BY t::text), '')) AS hash FROM "${name.replace(/"/g, '""')}" t`,
    );
    out[name] = { rows: r.rows, hash: r.hash ?? '' };
  }
  return out;
}
