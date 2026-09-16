import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { AppContext } from '../context.js';
import { safePath } from '../fs/files.js';
import { frontmatterExtraction } from '../graph/frontmatter.js';
import { loadOntology, normalizePredicate } from '../graph/ontology.js';
import { buildWikiIndex, extractObsidianLinks } from '../graph/wire.js';
import { validateOkfBundle } from '../okf/index.js';
import { normalizeDateExpr } from '../store/dates.js';
import { ResearchJob } from './jobs.js';
import { claimSourceIssues, requiredSections, ResearchProfile } from './profile.js';
import { ResearchTemplate } from './templates.js';
import { RunWorkspace } from './workspace.js';

/**
 * Post-run validation — the lint gate between "the agent wrote a file" and
 * "the knowledge base has a new source". Structural checks are errors (the
 * job is retried once with the reasons in its brief); quality hints are
 * warnings kept on the job. The page is also *normalized*: the actor and
 * research keys are stamped with the values the runner knows to be true, so
 * trust attribution never depends on the agent remembering to write them.
 */

export interface ValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  frontmatter: Record<string, unknown>;
  /** The page was rewritten to stamp actor / research / sources. */
  normalized: boolean;
}

function headingPresent(body: string, heading: string): boolean {
  const want = heading.replace(/^#+\s*/, '').trim().toLowerCase();
  return body.split('\n').some((line) => {
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line.trim());
    return Boolean(m && m[2].toLowerCase().startsWith(want));
  });
}

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export async function validateResearchPage(
  ctx: AppContext,
  input: { job: ResearchJob; template: ResearchTemplate; ws: RunWorkspace; profile?: ResearchProfile | null },
): Promise<ValidationReport> {
  const { template, ws } = input;
  const errors: string[] = [];
  const warnings: string[] = [];
  const abs = safePath(ctx.dataDir, ws.outputPath);
  if (!fs.existsSync(abs)) {
    return { ok: false, errors: [`no page at ${ws.outputPath} — the agent must write it with knode_write`], warnings, frontmatter: {}, normalized: false };
  }
  let text = fs.readFileSync(abs, 'utf8');
  let parsed: { data: Record<string, unknown>; content: string };
  try {
    const p = matter(text);
    parsed = { data: { ...(p.data as Record<string, unknown>) }, content: p.content };
  } catch (err) {
    return { ok: false, errors: [`frontmatter is not valid YAML: ${err instanceof Error ? err.message : err}`], warnings, frontmatter: {}, normalized: false };
  }
  const fm = parsed.data;

  // stamp what the runner knows: authorship and provenance are not the agent's to get wrong
  let normalized = false;
  if (fm.actor !== ws.actor) {
    fm.actor = ws.actor;
    normalized = true;
  }
  const research = fm.research && typeof fm.research === 'object' ? (fm.research as Record<string, unknown>) : null;
  if (!research || research.job !== ws.research.job) {
    fm.research = ws.research;
    normalized = true;
  }
  if (typeof fm.sources === 'string') {
    fm.sources = [fm.sources];
    normalized = true;
  }
  if (!Array.isArray(fm.sources)) {
    fm.sources = [];
    normalized = true;
  }
  if (typeof fm.generated === 'object' && fm.generated && !Array.isArray(fm.generated)) {
    // OKF authorship stays, but an explicit actor makes this a Source (see ingest/apply classify)
  }

  if (typeof fm.title !== 'string' || !fm.title.trim()) errors.push('frontmatter.title is required');
  if (typeof fm.type !== 'string' || !fm.type.trim()) errors.push('frontmatter.type is required');
  for (const key of template.requires.frontmatter) {
    if (key === 'actor' || key === 'research') continue;
    const v = fm[key];
    if (v === undefined || v === null || v === '') errors.push(`frontmatter.${key} is required`);
  }

  // sources: verifiable paths only (virtual /entities/… paths count)
  const sources = (fm.sources as unknown[]).map(String).map((s) => s.trim()).filter(Boolean);
  const verifiable = sources.filter((s) => {
    if (s.startsWith('/')) return true;
    try {
      return fs.existsSync(safePath(ctx.dataDir, s));
    } catch {
      return false;
    }
  });
  for (const s of sources) if (!verifiable.includes(s)) warnings.push(`source not found: ${s}`);
  if (template.requires.frontmatter.includes('sources') && verifiable.length === 0) errors.push('no verifiable source in frontmatter.sources (paths relative to the data dir)');

  // sections (the template's, plus the evidence table when the profile requires one)
  for (const heading of requiredSections(template, input.profile)) {
    if (!headingPresent(parsed.content, heading)) errors.push(`missing section ${heading}`);
  }

  // relations / claims against the ontology and date grammar
  const declared = frontmatterExtraction({ relations: fm.relations, claims: fm.claims }, { defaultSource: typeof fm.title === 'string' ? fm.title : undefined });
  const ontology = loadOntology(ctx.dataDir);
  for (const r of declared?.relations ?? []) {
    const n = normalizePredicate(ontology, r.type);
    if (n.unknown) warnings.push(`relation predicate "${r.type}" is not in the ontology (stored as related_to)`);
    for (const [label, v] of [['from', r.validFrom], ['to', r.validTo]] as const) {
      if (v && !normalizeDateExpr(v)) warnings.push(`relation ${r.type} → ${r.target}: unparsable ${label} date "${v}"`);
    }
  }
  if (Array.isArray(fm.claims)) {
    for (const raw of fm.claims) {
      if (!raw || typeof raw !== 'object') continue;
      const o = raw as Record<string, unknown>;
      if (typeof o.statement !== 'string' || !o.statement.trim()) {
        warnings.push('a claim without a statement was ignored');
        continue;
      }
      for (const key of ['eventDate', 'startDate', 'endDate']) {
        const v = o[key];
        if (v !== undefined && v !== null && v !== '' && !normalizeDateExpr(v)) warnings.push(`claim "${o.statement.slice(0, 40)}": unparsable ${key} "${String(v)}"`);
      }
    }
    // verification.minSourcesPerClaim (profile): facts need their own sources once the bar is above one
    const bar = claimSourceIssues(fm.claims, input.profile?.verification.minSourcesPerClaim ?? 1);
    errors.push(...bar.errors);
    warnings.push(...bar.warnings);
  }

  // wikilinks that resolve nowhere are gaps, not failures
  const index = buildWikiIndex(ctx.dataDir, 'wiki');
  for (const link of extractObsidianLinks(parsed.content)) {
    const base = `${path.posix.basename(link.target.replace(/\.md$/i, ''))}.md`.toLowerCase();
    if (!index.byBasename.has(base)) warnings.push(`wikilink [[${link.target}]] has no page yet`);
  }

  // a person's prose on an existing page must survive
  if (ws.humanParagraphs.length > 0) {
    const flat = squash(parsed.content);
    const dropped = ws.humanParagraphs.filter((p) => !flat.includes(squash(p)));
    if (dropped.length > 0) errors.push(`${dropped.length} human-written paragraph(s) of the existing page were dropped; keep them verbatim`);
  }

  if (normalized) {
    text = matter.stringify(parsed.content.replace(/^\n+/, ''), fm).replace(/\n{3,}/g, '\n\n');
    if (!text.endsWith('\n')) text += '\n';
    fs.writeFileSync(abs, text);
  }

  // OKF conformance of the bundle as indexed, restricted to this file
  try {
    const okf = validateOkfBundle(safePath(ctx.dataDir, 'wiki'), { asIndexed: true });
    const rel = ws.outputPath.replace(/^wiki\//, '');
    for (const d of (okf as unknown as { diagnostics?: Array<Record<string, unknown>> }).diagnostics ?? []) {
      const level = String(d.level ?? d.severity ?? '');
      const where = String(d.path ?? d.file ?? d.concept ?? '');
      if (level === 'error' && where.includes(rel)) errors.push(`OKF: ${String(d.message ?? d.code ?? 'invalid concept')}`);
    }
  } catch (err) {
    warnings.push(`OKF validation skipped: ${err instanceof Error ? err.message : err}`);
  }

  return { ok: errors.length === 0, errors, warnings, frontmatter: fm, normalized };
}
