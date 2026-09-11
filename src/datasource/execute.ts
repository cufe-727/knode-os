import { DataSourceKind, SourceDialect } from '../config.js';
import { assertReadOnlySql, sqlStringLiteral } from './guard.js';
import { DataSourceRegistry } from './registry.js';
import { QueryOptions, QueryResult } from './types.js';

/**
 * The single entry point for running a statement against a configured source.
 *
 * Only the SQL dialect goes through the SQL guard; the others are read-only by
 * construction (an HTTP source can reach nothing but its declared endpoints,
 * PromQL cannot write, the object store is opened read-only). Routing this in
 * one place is what keeps a new connector from quietly bypassing the guard, or
 * from having SQL keyword rules applied to a PromQL expression that legitimately
 * contains one.
 */
export async function runSourceQuery(
  registry: DataSourceRegistry,
  source: string,
  statement: string,
  opts: QueryOptions = {},
): Promise<QueryResult> {
  const connector = registry.get(source);
  if (connector.dialect === 'sql') assertReadOnlySql(statement);
  return connector.query(statement, opts);
}

/** How a source of this kind is spoken to. Mirrors the connectors' `dialect`. */
export function dialectForKind(kind: DataSourceKind | string): SourceDialect {
  switch (kind) {
    case 'http-json':
      return 'http';
    case 'prometheus':
      return 'promql';
    case 'object':
      return 'object';
    default:
      return 'sql';
  }
}

/**
 * Escape one interpolated value for the dialect it lands in: a SQL string
 * literal, a URL query component, a PromQL label value (double-quoted), or
 * verbatim for the object store. Used wherever an entity name or symbol is
 * rendered into a template written by a person or a playbook.
 */
export function escapeForDialect(dialect: SourceDialect, value: string): string {
  switch (dialect) {
    case 'sql':
      return sqlStringLiteral(value);
    case 'http':
      return encodeURIComponent(value);
    case 'promql':
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    default:
      return value;
  }
}

/**
 * A ready-to-run request that binds one parameter of a unit (table, endpoint,
 * metric, prefix) to a value — the shape of every "next query" the pack and
 * the planner hand to an agent.
 */
export function boundStatement(
  dialect: SourceDialect,
  unit: string,
  param: string | null,
  value: string | null,
  limit = 10,
): string {
  switch (dialect) {
    case 'sql':
      return param && value !== null
        ? `SELECT * FROM ${unit} WHERE ${param} = ${sqlStringLiteral(value)} LIMIT ${limit}`
        : `SELECT * FROM ${unit} LIMIT ${limit}`;
    case 'http':
      return param && value !== null ? `${unit}?${encodeURIComponent(param)}=${encodeURIComponent(value)}` : unit;
    case 'promql':
      return param && value !== null ? `${unit}{${param}=${escapeForDialect('promql', value)}}` : unit;
    case 'object':
      return `list ${value ?? unit}`;
    default:
      return unit;
  }
}
