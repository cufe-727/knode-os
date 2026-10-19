import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseConfig } from '../src/config.js';
import { schemaNameFor } from '../src/store/backend.js';
import { Store } from '../src/store/db.js';
import { SCHEMA_VERSION } from '../src/store/migrations.js';

/**
 * Migrating workspace schemas on the external-Postgres backend, against a real
 * server. Set up like backend-postgres.test.ts and skipped the same way when no
 * Postgres with pgvector is reachable (KNODE_TEST_PG_HOST / _PORT / _USER /
 * _PASSWORD point it at one), but kept in a file of its own so branches adding
 * to that suite merge cleanly.
 */

/**
 * One throwaway database per run, named like backend-postgres.test.ts's so
 * either suite's sweep clears what an interrupted run of the other left behind.
 */
const DB_PREFIX = 'knode_backend_test_';
const runDatabase = `${DB_PREFIX}${Math.floor(Date.now() / 1000)}_${crypto.randomBytes(4).toString('hex')}`;

const dbConfig: DatabaseConfig = {
  kind: 'postgres',
  host: process.env.KNODE_TEST_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.KNODE_TEST_PG_PORT ?? 5432),
  user: process.env.KNODE_TEST_PG_USER ?? os.userInfo().username,
  password: process.env.KNODE_TEST_PG_PASSWORD ?? '',
  database: runDatabase,
  schemaPrefix: 'ws_test',
};

function adminPool(database = 'postgres'): pg.Pool {
  return new pg.Pool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user || undefined,
    ...(dbConfig.password ? { password: dbConfig.password } : {}),
    database,
    max: 1,
    connectionTimeoutMillis: 2000,
  });
}

/** Reachable *and* carrying pgvector — both are required for this backend. */
async function postgresReady(): Promise<boolean> {
  const pool = adminPool();
  try {
    const { rows } = await pool.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`);
    return rows.length > 0;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

const ready = await postgresReady();
const dirs: string[] = [];

function workspaceDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-pgtest-'));
  dirs.push(dir);
  return dir;
}

/** A run interrupted before its afterAll leaves its database behind; clear those out. */
const STALE_AFTER_SECONDS = 3600;

async function dropAbandonedDatabases(pool: pg.Pool): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - STALE_AFTER_SECONDS;
  // Unconnected is not enough on its own (a live run idles between opens); the
  // seconds stamp in the name is what tells an abandoned database from a live one.
  const { rows } = await pool.query<{ datname: string }>(
    `SELECT d.datname FROM pg_database d
      WHERE NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)`,
  );
  for (const { datname } of rows) {
    if (!datname.startsWith(DB_PREFIX)) continue;
    const stamp = Number(datname.slice(DB_PREFIX.length).split('_')[0]);
    if (!Number.isFinite(stamp) || stamp > cutoff) continue;
    await pool.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`).catch(() => {});
  }
}

afterAll(async () => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  if (!ready) return;
  // Dropping the run's database takes every workspace schema with it.
  const pool = adminPool();
  try {
    await pool.query(`DROP DATABASE IF EXISTS "${dbConfig.database}" WITH (FORCE)`);
    await dropAbandonedDatabases(pool);
  } finally {
    await pool.end().catch(() => {});
  }
});

describe.skipIf(!ready)('postgres backend: a documents table in the shared public schema', () => {
  beforeAll(async () => {
    // public is on every workspace's search_path (pgvector lives there), so a
    // table in it is visible from each workspace without belonging to any.
    const admin = adminPool();
    try {
      await admin.query(`CREATE DATABASE "${runDatabase}"`);
    } finally {
      await admin.end().catch(() => {});
    }
    const shared = adminPool(runDatabase);
    try {
      await shared.query(`CREATE TABLE public.documents (id TEXT PRIMARY KEY); INSERT INTO public.documents VALUES ('stray')`);
    } finally {
      await shared.end().catch(() => {});
    }
  });

  it('does not make a fresh workspace look like an unversioned v1 index', async () => {
    const dir = workspaceDir();
    const store = await Store.open(dir, 2048, dbConfig);
    try {
      // read as v1, it would skip the baseline and flag a lineage rebuild of a graph that never was
      expect(store.migration).toEqual({ from: 0, to: SCHEMA_VERSION });
      expect(await store.getMeta('lineage_rebuild')).toBeUndefined();

      const schema = schemaNameFor(dir, dbConfig.schemaPrefix);
      expect(
        await store.query(`SELECT table_schema FROM information_schema.tables WHERE table_name = 'documents' ORDER BY 1`),
      ).toEqual([{ table_schema: 'public' }, { table_schema: schema }]);
      expect(await store.query(`SELECT id FROM documents`)).toEqual([]);
      expect(await store.query(`SELECT id FROM public.documents`)).toEqual([{ id: 'stray' }]);
    } finally {
      await store.close();
    }
  });
});
