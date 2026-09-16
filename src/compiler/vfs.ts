import { AppContext } from '../context.js';
import { capabilityById, listCapabilities, locatorsForEntities } from '../capability/store.js';
import { runSourceQuery } from '../datasource/execute.js';
import { queryClaims } from '../store/claims.js';
import { entitiesAsOf } from '../store/temporal.js';
import { graphSearch } from '../graph/query.js';
import { resolveTemporal } from '../store/resolver.js';

/**
 * A virtual filesystem over the knowledge base.
 *
 * Agents are good at reading files. Everything here is rendered on read rather
 * than stored — there is no directory to keep in sync, no page to regenerate,
 * and `?as_of=` works on every path because the render is just a query. It is
 * a second surface over facts the tools already expose, offered because
 * `cat /entities/宁德时代.md` is a cheaper thing to reach for than composing a
 * tool call, not because it holds anything new.
 *
 *   /                             the roots
 *   /entities/<id>.md             one entity: type, aliases, claims, neighbours
 *   /claims/<subject>.md          that subject's assertions with validity windows
 *   /capabilities/<source>/<name>.md   schema, semantics, pitfalls, sample queries
 *   /live/<capability>?<param>=<value> executes the capability and renders the rows
 */

export function isVirtualPath(p: string): boolean {
  return p.startsWith('/');
}

interface Parsed {
  segments: string[];
  params: URLSearchParams;
}

function parse(p: string): Parsed {
  const at = p.indexOf('?');
  const pathPart = at === -1 ? p : p.slice(0, at);
  const params = new URLSearchParams(at === -1 ? '' : p.slice(at + 1));
  const segments = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  return { segments, params };
}

function table(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '_(no rows)_';
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${columns.map((c) => cell(r[c])).join(' | ')} |`),
  ].join('\n');
}

const ROOT = `# knode-os virtual filesystem

Rendered on read — nothing here is stored, and every path accepts \`?as_of=<iso>\`.

| path | what it renders |
| --- | --- |
| \`/entities/<id>.md\` | one entity: type, aliases, claims, neighbours |
| \`/claims/<subject>.md\` | that subject's assertions with their validity windows |
| \`/capabilities/<source>/<name>.md\` | schema, semantics, pitfalls, sample queries |
| \`/live/<capability>?<param>=<value>\` | executes the capability and renders the rows |
`;

export async function readVirtual(ctx: AppContext, rawPath: string): Promise<string> {
  const { segments, params } = parse(rawPath);
  const asOf = params.get('as_of') || undefined;
  const temporal = resolveTemporal({ asOf, validAt: params.get('valid_at') || undefined });

  if (segments.length === 0) return ROOT;
  const [root, ...rest] = segments;

  if (root === 'entities') return renderEntity(ctx, rest.join('/').replace(/\.md$/, ''), temporal.txTime);
  if (root === 'claims') return renderClaims(ctx, rest.join('/').replace(/\.md$/, ''), temporal);
  if (root === 'capabilities') return renderCapability(ctx, rest.join('/').replace(/\.md$/, ''), temporal.txTime);
  if (root === 'live') return renderLive(ctx, rest.join('/'), params);

  throw new Error(`no such virtual path: /${segments.join('/')} — see / for the roots`);
}

async function renderEntity(ctx: AppContext, id: string, asOf: string | null): Promise<string> {
  if (!id) {
    const rows = await ctx.store.query<{ id: string; name: string; type: string; mention_count: number }>(
      `SELECT id, name, type, mention_count FROM entities WHERE tx_to IS NULL ORDER BY mention_count DESC LIMIT 200`,
    );
    return `# Entities\n\n${rows.map((r) => `- [${r.name}](/entities/${encodeURIComponent(r.id)}.md) — ${r.type}, ${r.mention_count} mentions`).join('\n')}\n`;
  }

  const [entity] = asOf
    ? await entitiesAsOf(ctx.store, [id], asOf)
    : await ctx.store.query<{ id: string; name: string; type: string; description: string; aliases: string[]; mention_count: number; evidence_count: number; wiki_path: string | null; canonical_id?: string | null }>(
      `SELECT id, name, type, description, aliases, mention_count, evidence_count, wiki_path, canonical_id FROM entities WHERE id = $1 AND tx_to IS NULL`, [id],
    );
  if (!entity) throw new Error(`no entity "${id}"${asOf ? ` as of ${asOf}` : ''}`);

  const [graph, claims, locators] = await Promise.all([
    graphSearch(ctx.store, entity.name, { depth: 1, limit: 15, track: false, temporal: resolveTemporal({ asOf }) }),
    queryClaims(ctx.store, { subject: id, limit: 40, temporal: resolveTemporal({ asOf }) }),
    locatorsForEntities(ctx.store, [id], asOf),
  ]);

  const aliases = Array.isArray(entity.aliases) ? entity.aliases : [];
  return [
    `# ${entity.name}`,
    '',
    `- type: ${entity.type}`,
    (entity as { canonical_id?: string | null }).canonical_id
      ? `- merged into: [${(entity as { canonical_id?: string | null }).canonical_id}](/entities/${encodeURIComponent((entity as { canonical_id?: string | null }).canonical_id!)}.md)`
      : null,
    aliases.length ? `- aliases: ${aliases.join(', ')}` : null,
    `- mentions: ${entity.mention_count}, evidence: ${entity.evidence_count}`,
    asOf ? `- as of: ${asOf}` : null,
    entity.description ? `\n${entity.description}` : null,
    '',
    '## Claims',
    '',
    claims.claims.length
      ? claims.claims.map((c) => `- ${c.statement}${c.validFrom || c.validTo ? ` (${c.validFrom ?? '…'}→${c.validTo ?? ''})` : ''}${c.stale ? ' **STALE**' : ''}${c.status !== 'fact' ? ` [${c.status}]` : ''} — ${c.sourcePath ?? 'source purged'}`).join('\n')
      : '_(none)_',
    '',
    '## Neighbours',
    '',
    graph.edges.length
      ? graph.edges.slice(0, 20).map((e) => `- ${e.source} —${e.type}→ ${e.target}`).join('\n')
      : '_(none)_',
    '',
    '## Reachable through',
    '',
    locators.length
      ? locators.map((l) => `- [\`${l.capabilityId}\`](/capabilities/${l.capabilityId.replace('.', '/')}.md): \`${l.param} = ${l.value}\` → [/live/${l.capabilityId}?${encodeURIComponent(l.param)}=${encodeURIComponent(l.value)}](/live/${l.capabilityId}?${encodeURIComponent(l.param)}=${encodeURIComponent(l.value)})`).join('\n')
      : '_(no live source carries this entity)_',
    '',
  ].filter((l) => l !== null).join('\n');
}

async function renderClaims(ctx: AppContext, subject: string, temporal: ReturnType<typeof resolveTemporal>): Promise<string> {
  const res = await queryClaims(ctx.store, { subject: subject || undefined, limit: 200, temporal });
  const title = subject ? `Claims about ${subject}` : 'Claims';
  return [
    `# ${title}`,
    '',
    ...(res.applied.length ? [res.applied.map((a) => `> ${a}`).join('\n'), ''] : []),
    `${res.claims.length} of ${res.matched}`,
    '',
    table(res.claims.map((c) => ({
      subject: c.subject,
      statement: c.statement,
      type: c.type,
      status: c.status,
      from: c.validFrom ?? '',
      to: c.validTo ?? '',
      stale: c.stale ? 'yes' : '',
      source: c.sourcePath ?? '',
    }))),
    '',
  ].join('\n');
}

async function renderCapability(ctx: AppContext, rel: string, asOf: string | null): Promise<string> {
  if (!rel) {
    const all = await listCapabilities(ctx.store, { asOf });
    return `# Capabilities\n\n${all.map((c) => `- [${c.id}](/capabilities/${c.id.replace('.', '/')}.md) — ${c.kind}, ${c.dialect}${c.freshnessSeconds !== null ? `, ≤${c.freshnessSeconds}s` : ''}`).join('\n')}\n`;
  }
  const id = rel.replace('/', '.');
  const cap = await capabilityById(ctx.store, id, asOf);
  if (!cap) throw new Error(`no capability "${id}"`);
  const columns = (cap.schema as { columns?: { name: string; type: string }[] })?.columns ?? [];
  return [
    `# ${cap.id}`,
    '',
    `- kind: ${cap.kind}, dialect: ${cap.dialect}, placement: ${cap.placement}`,
    `- cost: ${cap.cost}${cap.freshnessSeconds !== null ? `, freshness: ≤${cap.freshnessSeconds}s` : ''}`,
    cap.title ? `- ${cap.title}` : null,
    '',
    cap.semantics ? `## Semantics\n\n${cap.semantics}\n` : null,
    columns.length ? `## Schema\n\n${table(columns as unknown as Record<string, unknown>[])}\n` : null,
    cap.pitfalls.length ? `## Pitfalls\n\n${cap.pitfalls.map((p) => `- ${p}`).join('\n')}\n` : null,
    cap.joins.length ? `## Joins\n\n${cap.joins.map((j) => `- ${j}`).join('\n')}\n` : null,
    cap.sampleQueries.length ? `## Sample queries\n\n${cap.sampleQueries.map((q) => `- \`${q}\``).join('\n')}\n` : null,
    cap.notes.length ? `## Written by\n\n${cap.notes.map((n) => `- ${n.sourcePath}`).join('\n')}\n` : null,
  ].filter((l) => l !== null).join('\n');
}

/**
 * Execute a capability and render its rows. This is the one virtual path that
 * reaches outside the process, so it goes through the same executor every
 * other live read uses — dialect-routed, guarded, row-capped.
 */
async function renderLive(ctx: AppContext, rel: string, params: URLSearchParams): Promise<string> {
  const id = rel.replace(/\.md$/, '');
  const cap = await capabilityById(ctx.store, id);
  if (!cap) throw new Error(`no capability "${id}"`);
  if (cap.kind === 'tool') throw new Error(`"${id}" is a built-in tool — call it directly rather than through /live`);

  const binding = [...params.entries()].filter(([k]) => k !== 'as_of' && k !== 'valid_at' && k !== 'limit');
  const maxRows = Number(params.get('limit')) || 50;
  let statement: string;
  switch (cap.dialect) {
    case 'sql': {
      const where = binding.map(([k, v]) => `${k} = '${v.replace(/'/g, "''")}'`).join(' AND ');
      statement = `SELECT * FROM ${cap.name}${where ? ` WHERE ${where}` : ''} LIMIT ${Math.floor(maxRows)}`;
      break;
    }
    case 'http':
      statement = binding.length ? `${cap.name}?${new URLSearchParams(binding)}` : cap.name;
      break;
    case 'promql':
      statement = binding.length ? `${cap.name}{${binding.map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`).join(',')}}` : cap.name;
      break;
    default:
      statement = `list ${binding[0]?.[1] ?? cap.name}`;
  }

  const res = await runSourceQuery(ctx.datasources, cap.sourceId, statement, { maxRows });
  return [
    `# ${cap.id}`,
    '',
    `> \`${statement}\``,
    `> read at ${res.asOf} in ${res.elapsedMs}ms — ${res.rowCount} rows${res.truncated ? ' (truncated)' : ''}`,
    '',
    table(res.rows),
    '',
  ].join('\n');
}
