import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppContext } from '../context.js';
import { appendLog } from '../fs/datadir.js';
import { safePath, walkFiles } from '../fs/files.js';
import { entitiesNamed, NamedEntity } from '../graph/resolve.js';
import { extractObsidianLinks } from '../graph/wire.js';
import { applyDocScope } from '../ingest/apply.js';
import { isExcludedFile, isReservedWikiFile } from '../lineage/declared.js';
import { writeDeps } from '../lineage/deps.js';
import { applyScope } from '../lineage/scope.js';
import { parseFrontmatter } from '../markdown.js';
import { linkedName } from '../obsidian/links.js';
import { extractMarkdownLinks, resolveOkfLink } from '../okf/index.js';
import { wikiSuggestionId } from '../research/recommend.js';
import { toIso } from '../store/temporal.js';
import { ensureRecentResearch } from './pages.js';

/**
 * `wiki lint` — eslint for the knowledge product. Zero LLM. Finds:
 *
 *   orphan           a page nothing links to (not even index.md), by [[wikilink]] or Markdown link
 *   broken_link      a [[wikilink]] to a name with neither a page nor a graph entity behind it
 *   stale_research   a research page older than the newest evidence about its subject
 *   unreviewed       a quarantined research page nobody promoted for `unreviewedDays`
 *   expired          an OKF `stale_after` in the past
 *   superseded_text  a page still stating a fact a newer fact replaced
 *   open_dispute     a page whose claims are in an open dispute
 *
 * A [[link]] to a name the graph has is not a finding even with no page
 * behind it: it opens the entity (or the entity's page, filed under another
 * name). Those links are counted apart, in `entityLinks`, the entities linked
 * from the most pages first — the pages most worth writing.
 *
 * Writes `wiki/lint/<date>.md` as a view (one scope per day, like the dream
 * report) and files refresh suggestions for stale research pages.
 */

export type LintKind = 'orphan' | 'broken_link' | 'stale_research' | 'unreviewed' | 'expired' | 'superseded_text' | 'open_dispute';

export interface LintIssue {
  kind: LintKind;
  path: string;
  detail: string;
}

/** [[Links]] to graph entities that have no page: resolved, so counted here rather than as findings. */
export interface EntityLinks {
  links: number;
  entities: number;
  /** The entities, the ones linked from the most pages first (at most `REPORT_LIST`). */
  top: { id: string; name: string; type: string; pages: number }[];
}

export interface LintReport {
  issues: LintIssue[];
  counts: Record<LintKind, number>;
  entityLinks: EntityLinks;
  reportPath: string | null;
  suggestions: number;
  pages: number;
}

export interface LintOptions {
  /** Write the report page (default true). */
  report?: boolean;
  /** File refresh suggestions for stale research pages (default true). */
  file?: boolean;
  unreviewedDays?: number;
  onProgress?: (msg: string) => void;
}

interface WikiPage {
  path: string;
  text: string;
  frontmatter: Record<string, unknown>;
  body: string;
  research: Record<string, unknown> | null;
}

/** Most items the report page lists per section. */
const REPORT_LIST = 100;

function loadPages(dataDir: string): WikiPage[] {
  const out: WikiPage[] = [];
  for (const rel of walkFiles(dataDir, 'wiki')) {
    if (!rel.endsWith('.md') || isExcludedFile(rel) || isReservedWikiFile(rel)) continue;
    if (rel.startsWith('wiki/lint/') || rel.startsWith('wiki/dreams/') || rel.startsWith('wiki/learning/')) continue;
    try {
      const text = fs.readFileSync(safePath(dataDir, rel), 'utf8');
      const { frontmatter, body } = parseFrontmatter(text);
      const research = frontmatter.research && typeof frontmatter.research === 'object' && typeof frontmatter.actor === 'string' && /^agent\b/i.test(frontmatter.actor)
        ? (frontmatter.research as Record<string, unknown>)
        : null;
      out.push({ path: rel, text, frontmatter, body, research });
    } catch {
      /* unreadable page */
    }
  }
  return out;
}

/** The page an ordinary Markdown link on `from` reaches, read as OKF reads it: relative to the page, `/` the wiki root. */
function markdownTarget(from: string, href: string, pages: Set<string>): string | null {
  if (!from.startsWith('wiki/')) return null;
  const rel = resolveOkfLink(from.slice('wiki/'.length), href);
  if (!rel || rel.startsWith('../')) return null;
  return [`wiki/${rel}`, `wiki/${rel}.md`].find((p) => pages.has(p)) ?? null;
}

export async function lintWiki(ctx: AppContext, opts: LintOptions = {}): Promise<LintReport> {
  const progress = opts.onProgress ?? (() => {});
  const { store, dataDir } = ctx;
  const pages = loadPages(dataDir);
  const issues: LintIssue[] = [];
  const byBase = new Map<string, string[]>();
  for (const p of pages) {
    const base = path.posix.basename(p.path, '.md').toLowerCase();
    (byBase.get(base) ?? byBase.set(base, []).get(base)!).push(p.path);
  }
  const indexText = fs.existsSync(path.join(dataDir, 'wiki', 'index.md')) ? fs.readFileSync(path.join(dataDir, 'wiki', 'index.md'), 'utf8') : '';
  const pagePaths = new Set(pages.map((p) => p.path));
  const inbound = new Map<string, number>();
  const linkTo = (from: string, target: string) => {
    if (target !== from) inbound.set(target, (inbound.get(target) ?? 0) + 1);
  };
  const sources = [...pages.map((p) => ({ path: p.path, body: p.body })), { path: 'wiki/index.md', body: indexText }];
  const wikilinks = sources.map((src) =>
    extractObsidianLinks(src.body).map((l) => {
      const base = path.posix.basename(l.target.replace(/\.md$/i, '')).toLowerCase();
      return { raw: l.target, resolved: byBase.get(base) ?? [] };
    }),
  );
  // a name no page answers to may still be an entity the graph has: the link opens it, or its page
  const named = await entitiesNamed(store, wikilinks.flat().filter((l) => l.resolved.length === 0).map((l) => linkedName(l.raw)));
  const unpaged = new Map<string, { entity: NamedEntity; pages: number }>();
  let entityLinkCount = 0;
  sources.forEach((src, i) => {
    const seen = new Set<string>();
    for (const l of wikilinks[i]) {
      const entity = l.resolved.length === 0 ? named.get(linkedName(l.raw)) : undefined;
      const targets = entity?.wikiPath && pagePaths.has(entity.wikiPath) ? [entity.wikiPath] : l.resolved;
      for (const t of targets) linkTo(src.path, t);
      if (targets.length > 0 || src.path === 'wiki/index.md') continue;
      if (!entity) {
        issues.push({ kind: 'broken_link', path: src.path, detail: `[[${l.raw}]] names no page and no graph entity` });
        continue;
      }
      entityLinkCount++;
      const u = unpaged.get(entity.id) ?? unpaged.set(entity.id, { entity, pages: 0 }).get(entity.id)!;
      if (!seen.has(entity.id)) {
        seen.add(entity.id);
        u.pages++;
      }
    }
    // an ordinary Markdown link reaches a page as surely as a wikilink (index.md links overview.md that way)
    for (const link of extractMarkdownLinks(src.body)) {
      const target = markdownTarget(src.path, link.href, pagePaths);
      if (target) linkTo(src.path, target);
    }
  });
  const entityLinks: EntityLinks = {
    links: entityLinkCount,
    entities: unpaged.size,
    top: [...unpaged.values()]
      .sort((a, b) => b.pages - a.pages || a.entity.name.localeCompare(b.entity.name))
      .slice(0, REPORT_LIST)
      .map((u) => ({ id: u.entity.id, name: u.entity.name, type: u.entity.type, pages: u.pages })),
  };
  for (const p of pages) {
    if (p.path.startsWith('wiki/sources/') || p.path.startsWith('wiki/questions/')) continue; // reached from their indexes / search, not links
    if (!inbound.get(p.path)) issues.push({ kind: 'orphan', path: p.path, detail: 'no page (nor index.md) links here' });
  }

  const now = new Date().toISOString();
  const unreviewedMs = (opts.unreviewedDays ?? 7) * 24 * 3600 * 1000;
  for (const p of pages) {
    const staleAfter = toIso(typeof p.frontmatter.stale_after === 'string' ? p.frontmatter.stale_after : null);
    if (staleAfter && staleAfter < now) issues.push({ kind: 'expired', path: p.path, detail: `stale_after ${staleAfter.slice(0, 10)} has passed` });
    if (!p.research) continue;
    const [scope] = await store.query<{ trust: string; applied_at: string | Date }>(
      `SELECT trust, applied_at FROM scopes WHERE kind = 'doc' AND key = $1 AND status = 'active' ORDER BY applied_at DESC LIMIT 1`,
      [p.path],
    );
    if (scope?.trust === 'quarantined' && Date.now() - new Date(scope.applied_at).getTime() > unreviewedMs) {
      issues.push({ kind: 'unreviewed', path: p.path, detail: `quarantined since ${toIso(scope.applied_at)?.slice(0, 10)} — promote or demote it` });
    }
    const [entity] = await store.query<{ id: string }>(`SELECT id FROM entities WHERE wiki_path = $1 AND tx_to IS NULL`, [p.path]);
    const writtenAt = toIso(typeof p.research.at === 'string' ? p.research.at : null);
    if (entity) {
      const [latest] = await store.query<{ at: string | Date | null }>(
        `SELECT GREATEST(
            (SELECT max(tx_from) FROM claims c WHERE c.subject_id = $1 AND c.tx_to IS NULL AND c.primary_scope_id <> (SELECT id FROM scopes WHERE kind = 'doc' AND key = $2 AND status = 'active' ORDER BY applied_at DESC LIMIT 1)),
            (SELECT max(tx_from) FROM relations r WHERE (r.source_id = $1 OR r.target_id = $1) AND r.tx_to IS NULL)
          ) AS at`,
        [entity.id, p.path],
      );
      const newest = toIso(latest?.at ?? null);
      if (writtenAt && newest && newest > writtenAt) {
        issues.push({ kind: 'stale_research', path: p.path, detail: `written ${writtenAt.slice(0, 10)}, newer evidence about ${entity.id} on ${newest.slice(0, 10)}` });
      }
      const superseded = await store.query<{ statement: string }>(
        `SELECT statement FROM claims WHERE subject_id = $1 AND tx_to IS NULL AND canonical_id IS NULL AND superseded_by IS NOT NULL`,
        [entity.id],
      );
      for (const s of superseded) {
        if (s.statement.length >= 8 && p.body.includes(s.statement)) issues.push({ kind: 'superseded_text', path: p.path, detail: `still states "${s.statement.slice(0, 60)}", which a newer fact replaced` });
      }
    }
  }

  const disputed = await store.query<{ key: string; n: number }>(
    `SELECT s.key, count(*)::int AS n FROM disputes d
     JOIN scopes s ON s.id = d.scope_id
     WHERE d.status = 'open' AND s.key LIKE 'wiki/%' GROUP BY s.key`,
  );
  for (const d of disputed) issues.push({ kind: 'open_dispute', path: d.key, detail: `${d.n} open dispute(s) with trusted claims` });

  const counts = { orphan: 0, broken_link: 0, stale_research: 0, unreviewed: 0, expired: 0, superseded_text: 0, open_dispute: 0 } as Record<LintKind, number>;
  for (const i of issues) counts[i.kind]++;

  // stale research pages become refresh recommendations
  let suggestions = 0;
  if (opts.file ?? true) {
    for (const i of issues.filter((x) => x.kind === 'stale_research' || x.kind === 'superseded_text')) {
      const id = wikiSuggestionId('refresh', i.path);
      const [existing] = await store.query<{ status: string }>(`SELECT status FROM suggestions WHERE id = $1`, [id]);
      if (existing && existing.status !== 'stale') continue;
      await store.query(
        `INSERT INTO suggestions (id, kind, title, body, evidence, status, payload)
         VALUES ($1, 'wiki', $2, $3, $4::jsonb, 'pending', $5::jsonb)
         ON CONFLICT (id) DO UPDATE SET status = 'pending', body = EXCLUDED.body, payload = EXCLUDED.payload`,
        [id, `刷新页面：${path.posix.basename(i.path, '.md')}`, `wiki lint：${i.detail}。接受后由研究 agent 重新核对并更新这一页。`, JSON.stringify([i.detail]), JSON.stringify({ kind: 'refresh', target: i.path, score: 0.5, reasons: [i.detail], pagePath: i.path })],
      );
      const [entity] = await store.query<{ id: string }>(`SELECT id FROM entities WHERE wiki_path = $1 AND tx_to IS NULL`, [i.path]);
      if (entity) await writeDeps(store, { kind: 'suggestion', id }, [{ kind: 'entity', id: entity.id, required: true }]);
      suggestions++;
    }
  }

  let reportPath: string | null = null;
  if (opts.report ?? true) {
    const today = now.slice(0, 10);
    reportPath = `wiki/lint/${today}.md`;
    const lines = [
      '---',
      `title: Wiki lint ${today}`,
      'type: lint',
      `description: Health check of the wiki on ${today} — ${issues.length} findings over ${pages.length} pages.`,
      `generated: { by: "knode-os/lint", at: "${now}" }`,
      `knode: ${JSON.stringify({ view: 'lint', inputs: {} })}`,
      '---',
      '',
      `# Wiki lint — ${today}`,
      '',
      `> ${pages.length} pages · ${issues.length} findings: ${Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}${entityLinks.links ? ` · ${entityLinks.links} links to ${entityLinks.entities} entities without a page` : ''}`,
      '',
    ];
    for (const kind of Object.keys(counts) as LintKind[]) {
      const list = issues.filter((i) => i.kind === kind);
      if (list.length === 0) continue;
      lines.push(`## ${kind} (${list.length})`, '');
      for (const i of list.slice(0, REPORT_LIST)) lines.push(`- \`${i.path}\` — ${i.detail}`);
      if (list.length > REPORT_LIST) lines.push(`- … ${list.length - REPORT_LIST} more`);
      lines.push('');
    }
    if (entityLinks.entities > 0) {
      lines.push(`## entities without a page (${entityLinks.entities})`, '', 'Links to these name an entity the graph has, so they open it and are not findings. Linked from the most pages first:', '');
      // a name a wikilink cannot carry (`C#`, `A|B`) is listed as text
      for (const e of entityLinks.top) lines.push(`- ${/[[\]|#^]/.test(e.name) ? `\`${e.name}\`` : `[[${e.name}]]`} (${e.type}) — linked from ${e.pages} ${e.pages === 1 ? 'page' : 'pages'}`);
      if (entityLinks.entities > entityLinks.top.length) lines.push(`- … ${entityLinks.entities - entityLinks.top.length} more`);
      lines.push('');
    }
    const report = lines.join('\n');
    const sha = crypto.createHash('sha256').update(report.replace(/at: "[^"]+"/, '')).digest('hex').slice(0, 24);
    const res = await applyScope(store, { kind: 'lint', key: today }, sha, { actor: 'lint', meta: { findings: issues.length } }, async (w) => {
      await w.writeFile(reportPath!, report);
      await w.page({ path: reportPath!, kind: 'lint', generator: 'lint@1', inputs_sha: sha, file_sha: crypto.createHash('sha256').update(report).digest('hex'), regions: [] });
    });
    if (res.outcome === 'applied') {
      await applyDocScope(ctx, reportPath, 'wiki', { queueTier1: false, actor: 'lint' });
      appendLog(dataDir, 'lint', `${issues.length} findings over ${pages.length} pages → ${reportPath}`);
    }
    try {
      await ensureRecentResearch(ctx, { actor: 'lint' });
    } catch {
      /* index region is best-effort */
    }
  }
  progress(`wiki lint: ${issues.length} findings over ${pages.length} pages${entityLinks.links ? `, ${entityLinks.links} links to ${entityLinks.entities} entities without a page` : ''}${suggestions ? `, ${suggestions} refresh suggestions` : ''}`);
  return { issues, counts, entityLinks, reportPath, suggestions, pages: pages.length };
}
