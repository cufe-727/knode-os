import crypto from 'node:crypto';
import fs from 'node:fs';
import { KnodeConfig } from '../config.js';
import { MAX_FILE_BYTES } from '../constants.js';
import { isTextFile, safePath, walkFiles } from '../fs/files.js';
import { isSidecarPath } from '../fs/sidecar.js';
import { rawToCookedPath } from '../ingest/cook.js';
import { DocRoot } from '../types.js';
import { ScopeKind } from './types.js';

/**
 * Declared state — what the data directory and configuration *say* should be
 * applied. `sync` diffs it against the running state (live root scopes) and
 * applies / disposes only the difference, Cordis-style configuration
 * reconciliation for knowledge.
 *
 * Sources: cooked documents whose raw original still exists, skills, the
 * purpose/schema anchors, wiki pages that are not reserved, datasource
 * configs. Views (generated pages) are sources for *search* only — their
 * classification happens in the applier, which knows the `pages` table.
 */

export interface DeclaredSource {
  kind: ScopeKind;
  key: string;
  sha: string;
  root?: DocRoot;
  bytes?: number;
}

export interface DeclareOptions {
  /** Restrict to keys under these prefixes (raw/docs prefixes map to their cooked twins). */
  prefixes?: string[];
  includeDatasources?: boolean;
  /** Cooked files whose raw originals exist (from cookDocs); others are stale and excluded. */
  cookedWanted?: Set<string>;
  /** Cooked files whose latest conversion failed — excluded from this run. */
  failedCooked?: Set<string>;
}

export const DATASOURCES_PREFIX = 'datasources';

export function declaredKey(kind: ScopeKind, key: string): string {
  return `${kind}:${key}`;
}

/** Map user-facing prefixes (raw/docs/…) onto the keys the pipeline scans. */
export function normalizePrefixes(prefixes: string[] | undefined): string[] | undefined {
  if (!prefixes || prefixes.length === 0) return undefined;
  const out = new Set<string>();
  for (const p of prefixes) {
    const clean = p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    out.add(clean);
    if (clean.startsWith('raw/docs')) out.add(rawToCookedPath(clean));
  }
  return [...out];
}

export function matchesPrefixes(key: string, prefixes: string[] | undefined): boolean {
  if (!prefixes) return true;
  return prefixes.some((p) => key === p || key.startsWith(p + '/') || key.startsWith(p));
}

export function isReservedWikiFile(rel: string): boolean {
  return /(^|\/)(index|log)\.md$/.test(rel);
}

/** Never sources: archives, sidecars, the OKF log, attachments. */
export function isExcludedFile(rel: string): boolean {
  return (
    isSidecarPath(rel)
    || rel === 'wiki/log.md'
    || rel.startsWith('wiki/.archive/')
    || rel.includes('/.archive/')
    || rel.startsWith('wiki/attachments/')
    || rel.startsWith('ledger/')
  );
}

export function fileSha(abs: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

const ROOTS: { rel: string; root: DocRoot }[] = [
  { rel: 'cooked/docs', root: 'docs' },
  { rel: 'raw/skills', root: 'skills' },
  { rel: 'cooked/traces', root: 'traces' },
  { rel: 'capabilities', root: 'capabilities' },
  { rel: 'wiki', root: 'wiki' },
];

export function enumerateDeclared(dataDir: string, config: KnodeConfig, opts: DeclareOptions = {}): Map<string, DeclaredSource> {
  const out = new Map<string, DeclaredSource>();
  const prefixes = normalizePrefixes(opts.prefixes);

  for (const { rel, root } of ROOTS) {
    const files = walkFiles(dataDir, rel)
      .filter((f) => !isExcludedFile(f))
      .concat(root === 'wiki' ? ['purpose.md', 'schema.md'].filter((f) => fs.existsSync(safePath(dataDir, f))) : []);
    for (const file of files) {
      if (!matchesPrefixes(file, prefixes)) continue;
      if (root === 'docs') {
        if (opts.cookedWanted && !opts.cookedWanted.has(file)) continue;
        if (opts.failedCooked?.has(file)) continue;
      }
      if (!isTextFile(file)) continue;
      const abs = safePath(dataDir, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      out.set(declaredKey('doc', file), { kind: 'doc', key: file, sha: fileSha(abs), root, bytes: stat.size });
    }
  }

  const wantDatasources = opts.includeDatasources ?? !prefixes;
  if (wantDatasources || prefixes?.includes(DATASOURCES_PREFIX)) {
    for (const ds of config.datasources ?? []) {
      const sha = crypto.createHash('sha256').update(JSON.stringify(ds)).digest('hex').slice(0, 24);
      out.set(declaredKey('datasource', ds.id), { kind: 'datasource', key: ds.id, sha });
    }
  }
  return out;
}
