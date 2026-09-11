import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { KnodeConfig } from '../config.js';
import { appendLog } from '../fs/datadir.js';
import { walkAbsolute } from '../fs/files.js';
import { Store } from '../store/db.js';

/**
 * Trace & skill collection. Mirrors agent session transcripts into the data
 * directory so the nightly dream (and search) can learn from them:
 *
 *   Claude Code   ~/.claude/projects/<project-slug>/<session>.jsonl  →  raw/traces/claude/<slug>/<session>.jsonl
 *   Codex CLI     ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl       →  raw/traces/codex/YYYY/MM/DD/rollout-*.jsonl
 *   skills        ~/.claude/skills/**, ~/.codex/prompts/**           →  raw/skills/<origin>/**
 */

export interface SyncStats {
  copied: number;
  unchanged: number;
  skills: number;
}

export interface SyncTracesOptions {
  /** Explicit user syncs may import history that predates a workspace reset. */
  ignoreSince?: boolean;
}

const MAX_TRACE_BYTES = 64 * 1024 * 1024;
const TRACE_SYNC_SINCE_FILE = '.knode/trace-sync-since';

export async function syncTraces(store: Store, config: KnodeConfig, options: SyncTracesOptions = {}): Promise<SyncStats> {
  const stats: SyncStats = { copied: 0, unchanged: 0, skills: 0 };
  const pauseFile = path.join(store.dataDir, TRACE_SYNC_SINCE_FILE);
  if (!options.ignoreSince && fs.existsSync(pauseFile)) return stats;
  if (options.ignoreSince) fs.rmSync(pauseFile, { force: true });

  await syncTree(store, config.trace.claudeProjectsDir, path.join(store.dataDir, 'raw/traces/claude'), 'claude', stats);
  await syncTree(store, config.trace.codexSessionsDir, path.join(store.dataDir, 'raw/traces/codex'), 'codex', stats);

  for (const dir of config.trace.skillDirs) {
    if (!fs.existsSync(dir)) continue;
    const origin = dir.includes('.codex') ? 'codex' : 'claude';
    const dest = path.join(store.dataDir, 'raw/skills', origin);
    stats.skills += copyNewer(dir, dest, (f) => /\.(md|markdown|txt|json|yaml|yml)$/i.test(f));
  }

  if (stats.copied > 0 || stats.skills > 0) {
    appendLog(store.dataDir, 'trace-sync', `${stats.copied} traces, ${stats.skills} skill files`);
  }
  return stats;
}

async function syncTree(
  store: Store,
  srcRoot: string,
  destRoot: string,
  source: 'claude' | 'codex',
  stats: SyncStats,
): Promise<void> {
  if (!fs.existsSync(srcRoot)) return;
  const files = walkAbsolute(srcRoot).filter((f) => f.endsWith('.jsonl'));
  for (const absSrc of files) {
    const rel = path.relative(srcRoot, absSrc);
    const absDest = path.join(destRoot, rel);
    try {
      const srcStat = fs.statSync(absSrc);
      if (srcStat.size === 0 || srcStat.size > MAX_TRACE_BYTES) continue;
      if (fs.existsSync(absDest)) {
        const destStat = fs.statSync(absDest);
        if (destStat.size === srcStat.size && destStat.mtimeMs >= srcStat.mtimeMs) {
          stats.unchanged++;
          continue;
        }
      }
      fs.mkdirSync(path.dirname(absDest), { recursive: true });
      fs.copyFileSync(absSrc, absDest);
      fs.utimesSync(absDest, srcStat.atime, srcStat.mtime);
      stats.copied++;
      await registerTrace(store, source, rel, absDest, srcStat);
    } catch {
      // unreadable session file — skip silently, retry next sync
    }
  }
}

async function registerTrace(store: Store, source: 'claude' | 'codex', rel: string, absDest: string, stat: fs.Stats): Promise<void> {
  const relPosix = rel.split(path.sep).join('/');
  const dataPath = `raw/traces/${source}/${relPosix}`;
  const id = crypto.createHash('sha256').update(dataPath).digest('hex').slice(0, 24);
  const base = path.basename(rel, '.jsonl');
  const sessionId = base.replace(/^rollout-[\d-]*T?[\d-]*-?/, '') || base;
  const project = source === 'claude' ? relPosix.split('/')[0] ?? null : null;
  const startedAt = firstTimestamp(absDest) ?? stat.mtime.toISOString();
  const sha = crypto.createHash('sha256').update(fs.readFileSync(absDest)).digest('hex');
  await store.query(
    `INSERT INTO traces (id, source, session_id, path, project, started_at, bytes, sha256, analyzed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)
     ON CONFLICT (id) DO UPDATE SET bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256,
       started_at = EXCLUDED.started_at,
       analyzed_at = CASE WHEN traces.sha256 = EXCLUDED.sha256 THEN traces.analyzed_at ELSE NULL END`,
    [id, source, sessionId, dataPath, project, startedAt, stat.size, sha],
  );
}

/** Read the first few lines of a JSONL trace looking for a timestamp field. */
function firstTimestamp(file: string): string | null {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.toString('utf8', 0, n).split('\n').slice(0, 10)) {
      try {
        const obj = JSON.parse(line);
        const ts = obj.timestamp ?? obj.ts ?? obj.created_at ?? obj.time;
        if (typeof ts === 'string' && !Number.isNaN(Date.parse(ts))) return new Date(ts).toISOString();
      } catch {
        /* partial line */
      }
    }
  } catch {
    /* unreadable */
  }
  return null;
}

function copyNewer(srcRoot: string, destRoot: string, filter: (f: string) => boolean): number {
  let copied = 0;
  for (const absSrc of walkAbsolute(srcRoot)) {
    if (!filter(absSrc)) continue;
    const rel = path.relative(srcRoot, absSrc);
    const absDest = path.join(destRoot, rel);
    try {
      const srcStat = fs.statSync(absSrc);
      if (fs.existsSync(absDest)) {
        const d = fs.statSync(absDest);
        if (d.size === srcStat.size && d.mtimeMs >= srcStat.mtimeMs) continue;
      }
      fs.mkdirSync(path.dirname(absDest), { recursive: true });
      fs.copyFileSync(absSrc, absDest);
      fs.utimesSync(absDest, srcStat.atime, srcStat.mtime);
      copied++;
    } catch {
      /* skip unreadable */
    }
  }
  return copied;
}
