import crypto from 'node:crypto';
import fs from 'node:fs';
import { KnodeConfig } from '../config.js';
import { MAX_FILE_BYTES } from '../constants.js';
import { isTextFile, safePath, walkFiles } from '../fs/files.js';
import { CAPABILITIES_DIR, hasSidecarSegment, RAW_DOCS, RAW_SKILLS, RAW_TRACES, WIKI_DIR } from '../fs/layout.js';
import { DocRoot } from '../types.js';
import { ScopeKind } from './types.js';

/**
 * Declared state — what the data directory and configuration *say* should be
 * applied. `sync` diffs it against the running state (live root scopes) and
 * applies / disposes only the difference, Cordis-style configuration
 * reconciliation for knowledge.
 *
 * Sources: prepared raw/docs originals and trace episodes (keyed by their raw
 * path, enumerated from the prepare step's maps — never by walking, since a
 * PDF is not a text file and a `.jsonl` transcript is), skills, the
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
  /** Restrict to keys under these prefixes. */
  prefixes?: string[];
  includeDatasources?: boolean;
  /** Prepared raw/docs sources → sha of their indexed text (from prepareDocs). Undefined: docs untouched this run. */
  docs?: Map<string, string>;
  /** Prepared trace episodes → sha of their Markdown (from prepareEpisodes). Undefined: traces untouched this run. */
  traces?: Map<string, string>;
  /** Sources whose latest conversion failed — excluded from this run so their last good state survives. */
  failed?: Set<string>;
}

export const DATASOURCES_PREFIX = 'datasources';

export function declaredKey(kind: ScopeKind, key: string): string {
  return `${kind}:${key}`;
}

/** Clean user-facing prefixes (separators, leading/trailing slashes); keys are raw paths, so no mapping is needed. */
export function normalizePrefixes(prefixes: string[] | undefined): string[] | undefined {
  if (!prefixes || prefixes.length === 0) return undefined;
  const out = new Set<string>();
  for (const p of prefixes) out.add(p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, ''));
  return [...out];
}

/** A prefix matches the key itself or anything below it — `raw/docs/a` never matches `raw/docs/ab.md`. */
export function matchesPrefixes(key: string, prefixes: string[] | undefined): boolean {
  if (!prefixes) return true;
  return prefixes.some((p) => key === p || key.startsWith(p + '/'));
}

export function isReservedWikiFile(rel: string): boolean {
  return /(^|\/)(index|log)\.md$/.test(rel);
}

/** Never sources: archives, sidecars, the OKF log, attachments. */
export function isExcludedFile(rel: string): boolean {
  return (
    hasSidecarSegment(rel)
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

/** Roots enumerated by walking; raw/docs and raw/traces come from the prepare maps instead. */
const WALKED_ROOTS: { rel: string; root: DocRoot }[] = [
  { rel: RAW_SKILLS, root: 'skills' },
  { rel: CAPABILITIES_DIR, root: 'capabilities' },
  { rel: WIKI_DIR, root: 'wiki' },
];
const PREPARED_ROOTS: { rel: string; root: DocRoot; map: 'docs' | 'traces' }[] = [
  { rel: RAW_DOCS, root: 'docs', map: 'docs' },
  { rel: RAW_TRACES, root: 'traces', map: 'traces' },
];

export function enumerateDeclared(dataDir: string, config: KnodeConfig, opts: DeclareOptions = {}): Map<string, DeclaredSource> {
  const out = new Map<string, DeclaredSource>();
  const prefixes = normalizePrefixes(opts.prefixes);

  for (const { root, map } of PREPARED_ROOTS) {
    const prepared = opts[map];
    if (!prepared) continue;
    for (const [key, sha] of prepared) {
      if (!matchesPrefixes(key, prefixes) || opts.failed?.has(key)) continue;
      out.set(declaredKey('doc', key), { kind: 'doc', key, sha, root });
    }
  }

  for (const { rel, root } of WALKED_ROOTS) {
    const files = walkFiles(dataDir, rel)
      .filter((f) => !isExcludedFile(f))
      .concat(root === 'wiki' ? ['purpose.md', 'schema.md'].filter((f) => fs.existsSync(safePath(dataDir, f))) : []);
    for (const file of files) {
      if (!matchesPrefixes(file, prefixes)) continue;
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
