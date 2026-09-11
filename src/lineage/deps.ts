import { Queryable } from '../store/migrations.js';
import { ArtifactKind, DepDecl, DepRow, TouchedSet } from './types.js';

/**
 * Spatial composability: artifacts (wiki pages, suggestions) declare the graph
 * inputs they were built from. When an input's fold changes the artifact is
 * marked dirty (regenerate); when a *required* input is tombstoned the
 * artifact is archived. Inputs are never other artifacts, which is what keeps
 * propagation acyclic.
 */

export interface Propagation {
  dirtyPages: string[];
  archivedPages: string[];
  staleSuggestions: string[];
}

export function emptyPropagation(): Propagation {
  return { dirtyPages: [], archivedPages: [], staleSuggestions: [] };
}

export function mergePropagation(a: Propagation, b: Propagation): Propagation {
  return {
    dirtyPages: [...new Set([...a.dirtyPages, ...b.dirtyPages])],
    archivedPages: [...new Set([...a.archivedPages, ...b.archivedPages])],
    staleSuggestions: [...new Set([...a.staleSuggestions, ...b.staleSuggestions])],
  };
}

export async function readDeps(q: Queryable, artifact: { kind: ArtifactKind; id: string }): Promise<DepRow[]> {
  return q.query<DepRow>(
    `SELECT input_kind, input_id, required, input_sha FROM deps WHERE artifact_kind = $1 AND artifact_id = $2 ORDER BY input_kind, input_id`,
    [artifact.kind, artifact.id],
  );
}

export async function writeDeps(q: Queryable, artifact: { kind: ArtifactKind; id: string }, inputs: (DepDecl | DepRow)[]): Promise<void> {
  await q.query(`DELETE FROM deps WHERE artifact_kind = $1 AND artifact_id = $2`, [artifact.kind, artifact.id]);
  const seen = new Set<string>();
  for (const d of inputs) {
    const kind = 'kind' in d ? d.kind : d.input_kind;
    const id = 'kind' in d ? d.id : d.input_id;
    const key = `${kind}|${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const required = 'kind' in d ? Boolean(d.required) : d.required;
    const sha = 'kind' in d ? d.sha ?? null : d.input_sha;
    await q.query(
      `INSERT INTO deps (artifact_kind, artifact_id, input_kind, input_id, required, input_sha)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [artifact.kind, artifact.id, kind, id, required, sha],
    );
  }
}

/**
 * Mark dependents of changed / tombstoned inputs. Runs inside the apply or
 * dispose transaction. `archive` is false while a scope is being *replaced*:
 * the replacing apply usually restores the same evidence a moment later, so a
 * required input that is only transiently dead marks the page dirty (re-planned
 * by reconcileViews, which archives it only if the input is really gone).
 */
export async function propagate(q: Queryable, changed: TouchedSet, tombstoned: TouchedSet, txTime: string, opts: { archive?: boolean } = {}): Promise<Propagation> {
  const archive = opts.archive ?? true;
  const out = emptyPropagation();
  const inputs: { kind: string; id: string; dead: boolean }[] = [];
  const push = (kind: string, ids: Set<string>, dead: Set<string>) => {
    for (const id of ids) inputs.push({ kind, id, dead: dead.has(id) });
  };
  push('entity', changed.entities, tombstoned.entities);
  push('relation', changed.relations, tombstoned.relations);
  push('claim', changed.claims, tombstoned.claims);
  push('document', changed.documents, tombstoned.documents);
  push('dataset', changed.datasets, tombstoned.datasets);
  if (inputs.length === 0) return out;

  const rows: { artifact_kind: ArtifactKind; artifact_id: string; input_kind: string; input_id: string; required: boolean }[] = [];
  for (let i = 0; i < inputs.length; i += 200) {
    const batch = inputs.slice(i, i + 200);
    const params: unknown[] = [];
    const conds = batch.map((inp) => {
      params.push(inp.kind, inp.id);
      return `(input_kind = $${params.length - 1} AND input_id = $${params.length})`;
    });
    rows.push(...await q.query<(typeof rows)[number]>(
      `SELECT artifact_kind, artifact_id, input_kind, input_id, required FROM deps WHERE ${conds.join(' OR ')}`,
      params,
    ));
  }
  if (rows.length === 0) return out;

  const dead = new Set(inputs.filter((i) => i.dead).map((i) => `${i.kind}|${i.id}`));
  const byArtifact = new Map<string, { kind: ArtifactKind; id: string; archive: boolean; reasons: string[] }>();
  for (const r of rows) {
    const key = `${r.artifact_kind}|${r.artifact_id}`;
    const cur = byArtifact.get(key) ?? { kind: r.artifact_kind, id: r.artifact_id, archive: false, reasons: [] };
    const isDead = dead.has(`${r.input_kind}|${r.input_id}`);
    if (isDead && r.required && archive) cur.archive = true;
    cur.reasons.push(`${r.input_kind}:${r.input_id}${isDead ? ' (gone)' : ''}`);
    byArtifact.set(key, cur);
  }

  for (const a of byArtifact.values()) {
    const reason = JSON.stringify({ at: txTime, inputs: a.reasons.slice(0, 20) });
    if (a.kind === 'page') {
      if (a.archive) {
        const r = await q.query<{ path: string }>(
          `UPDATE pages SET status = 'archived', tx_to = COALESCE(tx_to, $2::timestamptz), dirty_reason = $3::jsonb
           WHERE path = $1 AND status <> 'archived' RETURNING path`,
          [a.id, txTime, reason],
        );
        if (r.length) out.archivedPages.push(a.id);
      } else {
        const r = await q.query<{ path: string }>(
          `UPDATE pages SET status = 'dirty', dirty_reason = $2::jsonb WHERE path = $1 AND status = 'active' RETURNING path`,
          [a.id, reason],
        );
        if (r.length) out.dirtyPages.push(a.id);
      }
    } else if (a.kind === 'suggestion' && a.archive && archive) {
      const r = await q.query<{ id: string }>(
        `UPDATE suggestions SET status = 'stale' WHERE id = $1 AND status = 'pending' RETURNING id`,
        [a.id],
      );
      if (r.length) out.staleSuggestions.push(a.id);
    }
  }
  return out;
}
