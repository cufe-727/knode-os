import fs from 'node:fs';
import path from 'node:path';
import { AppContext } from '../context.js';
import { readDatasourceStatus } from '../datasource/sync.js';
import { isSeedTemplate, readGuide } from '../fs/datadir.js';
import { LIVE_STATUSES, latestJob } from '../research/jobs.js';
import { collectableTraces, traceCollectionPaused } from '../traces/sync.js';
import { LintSummary, parseLintSummary } from '../wiki/lint.js';

/**
 * Notices: what a person should know about a workspace, in place of folders
 * the file tree no longer shows (wiki/lint, wiki/datasets) and of state no
 * folder shows at all (trace collection waiting for a yes, a purpose nobody
 * wrote, a wiki never initialized). Computed on request from what is on disk
 * and in the index; nothing is stored.
 *
 * They go out as data, not sentences: each client words a notice in its own
 * language and knows the action its kind offers. `key` changes when a notice
 * says something new, so a client that keeps dismissals by key shows it again
 * then. The ledger has no notice: nothing in it asks anything of a person, and
 * History already reads it.
 */

export type Notice =
  | { id: 'lint'; key: string; level: 'info'; report: string; date: string; summary: LintSummary; previous: { date: string; summary: LintSummary } | null }
  | { id: 'traces-off'; key: string; level: 'info'; sessions: number; bytes: number }
  | { id: 'purpose'; key: string; level: 'info'; path: string }
  | { id: 'initialize'; key: string; level: 'info'; overview: boolean; guide: boolean }
  | { id: 'datasources'; key: string; level: 'warn'; at: string; sources: number; errors: string[] };

const LINT_DIR = 'wiki/lint';
const LINT_REPORT = /^(\d{4}-\d{2}-\d{2})\.md$/;

export async function listNotices(ctx: AppContext): Promise<Notice[]> {
  const notices: Notice[] = [];
  const add = (n: Notice | null) => {
    if (n) notices.push(n);
  };
  add(datasourcesNotice(ctx));
  add(lintNotice(ctx.dataDir));
  add(purposeNotice(ctx.dataDir));
  add(await initializeNotice(ctx));
  add(tracesNotice(ctx));
  return notices;
}

/** The newest lint report, with the one before it for the change since. */
function lintNotice(dataDir: string): Notice | null {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(dataDir, LINT_DIR)).filter((n) => LINT_REPORT.test(n)).sort().reverse();
  } catch {
    return null;
  }
  const read = (name: string) => {
    try {
      const summary = parseLintSummary(fs.readFileSync(path.join(dataDir, LINT_DIR, name), 'utf8'));
      return summary ? { date: name.replace(/\.md$/, ''), summary } : null;
    } catch {
      return null;
    }
  };
  const latest = names.length ? read(names[0]) : null;
  if (!latest || latest.summary.findings === 0) return null;
  const previous = names.length > 1 ? read(names[1]) : null;
  return { id: 'lint', key: latest.date, level: 'info', report: `${LINT_DIR}/${names[0]}`, date: latest.date, summary: latest.summary, previous };
}

/** purpose.md still says nothing: generators and the nightly review read it to decide what matters. */
function purposeNotice(dataDir: string): Notice | null {
  let text = '';
  try {
    text = fs.readFileSync(path.join(dataDir, 'purpose.md'), 'utf8');
  } catch {
    /* a missing purpose says as little as the template */
  }
  if (text.trim() && !isSeedTemplate('purpose.md', text)) return null;
  return { id: 'purpose', key: 'purpose.md', level: 'info', path: 'purpose.md' };
}

/** Documents are in but nobody initialized the wiki: no overview, no guide for agents. Quiet while an initialization runs. */
async function initializeNotice(ctx: AppContext): Promise<Notice | null> {
  let overviewText = '';
  try {
    overviewText = fs.readFileSync(path.join(ctx.dataDir, 'wiki', 'overview.md'), 'utf8');
  } catch {
    /* missing: as good as the template */
  }
  const overview = Boolean(overviewText.trim()) && !isSeedTemplate('wiki/overview.md', overviewText);
  const guide = readGuide(ctx.dataDir) !== null;
  if (overview && guide) return null;
  const [docs] = await ctx.store.query<{ any: boolean }>(`SELECT EXISTS (SELECT 1 FROM documents WHERE path LIKE 'raw/docs/%') AS any`);
  if (!docs?.any) return null;
  const job = await latestJob(ctx.store, 'init');
  if (job && LIVE_STATUSES.includes(job.status)) return null;
  return { id: 'initialize', key: `${overview}-${guide}`, level: 'info', overview, guide };
}

/** Collection is paused here and there are sessions it would collect. */
function tracesNotice(ctx: AppContext): Notice | null {
  if (!traceCollectionPaused(ctx.dataDir)) return null;
  const { sessions, bytes } = collectableTraces(ctx.config);
  if (sessions === 0) return null;
  return { id: 'traces-off', key: 'paused', level: 'info', sessions, bytes };
}

/** The last pass over the configured datasources failed somewhere: their dataset pages may be stale or missing. */
function datasourcesNotice(ctx: AppContext): Notice | null {
  if (ctx.config.datasources.length === 0) return null;
  const status = readDatasourceStatus(ctx.dataDir);
  if (!status || status.errors.length === 0) return null;
  return { id: 'datasources', key: status.at, level: 'warn', at: status.at, sources: status.sources, errors: status.errors.slice(0, 20) };
}
