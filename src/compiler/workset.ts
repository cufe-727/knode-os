import crypto from 'node:crypto';
import { AppContext } from '../context.js';
import { assertWritablePath, writeFileText } from '../fs/files.js';
import { Store } from '../store/db.js';
import { ResolvedTemporal, resolveTemporal } from '../store/resolver.js';
import { toIso } from '../store/temporal.js';

/**
 * Worksets: a pinned view for a task that outlives a single call.
 *
 * A plan can take minutes; a research session takes hours. Without a pin, every
 * step of it reads a slightly different knowledge base, and the contradiction
 * the agent reports at the end may be nothing but two reads taken either side
 * of a sync. `checkout` freezes the system time once, and every read that
 * passes the workset id answers at that instant.
 *
 * `commit` is the other half: whatever the agent concluded is written back as
 * an ordinary Source, so it is chunked, attributable and revertible like any
 * other document — not smuggled into the graph as a privileged write.
 */

export interface Workset {
  id: string;
  actor: string;
  asOf: string;
  validAt: string | null;
  note: string;
  entities: string[];
  createdAt: string;
  closedAt: string | null;
  commitPath: string | null;
}

interface Row {
  id: string; actor: string; as_of: string; valid_at: string | null; note: string;
  entities: unknown; created_at: string; closed_at: string | null; commit_path: string | null;
}

function project(r: Row): Workset {
  return {
    id: r.id,
    actor: r.actor,
    asOf: toIso(r.as_of)!,
    validAt: toIso(r.valid_at),
    note: r.note,
    entities: Array.isArray(r.entities) ? r.entities.map(String) : [],
    createdAt: toIso(r.created_at)!,
    closedAt: toIso(r.closed_at),
    commitPath: r.commit_path,
  };
}

export interface CheckoutInput {
  actor?: string;
  /** Instant to pin to. Defaults to now — the usual case is "freeze here". */
  asOf?: string;
  validAt?: string;
  note?: string;
  entities?: string[];
}

export async function checkout(store: Store, input: CheckoutInput = {}): Promise<Workset> {
  const id = `w_${crypto.randomBytes(8).toString('hex')}`;
  const asOf = toIso(input.asOf) ?? new Date().toISOString();
  const [row] = await store.query<Row>(
    `INSERT INTO worksets (id, actor, as_of, valid_at, note, entities)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6::jsonb)
     RETURNING id, actor, as_of, valid_at, note, entities, created_at, closed_at, commit_path`,
    [id, input.actor ?? 'agent', asOf, toIso(input.validAt), input.note ?? '', JSON.stringify(input.entities ?? [])],
  );
  return project(row);
}

export async function getWorkset(store: Store, id: string): Promise<Workset | null> {
  const [row] = await store.query<Row>(
    `SELECT id, actor, as_of, valid_at, note, entities, created_at, closed_at, commit_path FROM worksets WHERE id = $1`,
    [id],
  );
  return row ? project(row) : null;
}

export async function listWorksets(store: Store, opts: { actor?: string; open?: boolean } = {}): Promise<Workset[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.actor) {
    params.push(opts.actor);
    conds.push(`actor = $${params.length}`);
  }
  if (opts.open) conds.push('closed_at IS NULL');
  const rows = await store.query<Row>(
    `SELECT id, actor, as_of, valid_at, note, entities, created_at, closed_at, commit_path FROM worksets
     ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 100`,
    params,
  );
  return rows.map(project);
}

/**
 * The temporal envelope a workset pins, merged with whatever else the caller
 * asked for. An explicit `as_of` on the call still wins: a workset is a
 * default for a session, not a cage — an agent that deliberately asks "and
 * what does it look like *now*" should get an answer.
 */
export async function temporalFor(store: Store, worksetId: string | undefined, base: ResolvedTemporal): Promise<ResolvedTemporal> {
  if (!worksetId) return base;
  const ws = await getWorkset(store, worksetId);
  if (!ws) throw new Error(`unknown workset ${worksetId}`);
  if (ws.closedAt) throw new Error(`workset ${worksetId} was committed at ${ws.closedAt} — check out a new one`);
  if (base.txTime) return base;
  return {
    ...base,
    txTime: ws.asOf,
    validFrom: base.validFrom ?? ws.validAt,
    validTo: base.validTo ?? ws.validAt,
    validPoint: base.validPoint || Boolean(ws.validAt && !base.validFrom),
    notes: [...base.notes, `workset ${ws.id} pinned at ${ws.asOf}`],
  };
}

export interface CommitInput {
  worksetId: string;
  /** Where the note lands; must be a writable root. Defaults to raw/docs/notes/<id>.md. */
  path?: string;
  content: string;
  title?: string;
  /** Keep the workset open after writing (default: close it). */
  keepOpen?: boolean;
  actor?: string;
}

/**
 * Write what the task concluded back as a Source.
 *
 * It goes through the ordinary file path, which means it is picked up by the
 * next `sync` as a document with its own scope — indexed, attributable, and
 * revertible. An agent's conclusion earns no shortcut into the graph: if it is
 * wrong, deleting the file has to undo it exactly like any other bad source.
 */
export async function commitWorkset(ctx: AppContext, input: CommitInput): Promise<{ workset: Workset; path: string }> {
  const ws = await getWorkset(ctx.store, input.worksetId);
  if (!ws) throw new Error(`unknown workset ${input.worksetId}`);
  if (ws.closedAt) throw new Error(`workset ${input.worksetId} is already committed (${ws.commitPath ?? 'no file'})`);

  const rel = input.path ?? `raw/docs/notes/${ws.id}.md`;
  assertWritablePath(rel);
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(input.title ?? (ws.note || `Working notes ${ws.id}`))}`,
    `workset: ${ws.id}`,
    `asOf: ${JSON.stringify(ws.asOf)}`,
    `actor: ${JSON.stringify(input.actor ?? ws.actor)}`,
    ws.entities.length ? `entities:\n${ws.entities.map((e) => `  - { name: ${JSON.stringify(e)}, type: concept }`).join('\n')}` : null,
    '---',
    '',
  ].filter((l) => l !== null).join('\n');
  writeFileText(ctx.dataDir, rel, `${frontmatter}${input.content.trim()}\n`);

  const [row] = await ctx.store.query<Row>(
    `UPDATE worksets SET commit_path = $2, closed_at = CASE WHEN $3 THEN closed_at ELSE now() END
     WHERE id = $1
     RETURNING id, actor, as_of, valid_at, note, entities, created_at, closed_at, commit_path`,
    [ws.id, rel, Boolean(input.keepOpen)],
  );
  return { workset: project(row), path: rel };
}

export async function closeWorkset(store: Store, id: string): Promise<Workset | null> {
  const [row] = await store.query<Row>(
    `UPDATE worksets SET closed_at = COALESCE(closed_at, now()) WHERE id = $1
     RETURNING id, actor, as_of, valid_at, note, entities, created_at, closed_at, commit_path`,
    [id],
  );
  return row ? project(row) : null;
}

/** Convenience for surfaces: resolve `{workset, as_of, …}` into one envelope. */
export async function envelopeFor(
  store: Store,
  args: { workset?: string; asOf?: string; validAt?: string; validRange?: string; freshness?: string },
): Promise<ResolvedTemporal> {
  const base = resolveTemporal({
    asOf: args.asOf,
    validAt: args.validAt,
    validRange: args.validRange,
    freshness: args.freshness,
  });
  return temporalFor(store, args.workset, base);
}
