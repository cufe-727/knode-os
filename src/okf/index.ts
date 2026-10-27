import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { safePath } from '../fs/files.js';
import { initObsidianVault } from '../obsidian/vault.js';
import { normalizeCookedFrontmatter } from './normalize.js';

/** Google Open Knowledge Format version implemented by knode-os. */
export const OKF_VERSION = '0.2';

/**
 * How a declared bundle version relates to the version we implement (SPEC §12).
 * Minor bumps are additive, so an older minor is consumable through the §13
 * fallbacks and a newer minor is consumable by ignoring what we do not know.
 * Only a major bump may rename required fields, and even then §12 asks us to
 * try rather than refuse.
 */
export type OkfVersionSupport = 'undeclared' | 'current' | 'legacy-minor' | 'newer-minor' | 'unknown-major';

export function classifyOkfVersion(declared: string | null): OkfVersionSupport {
  if (declared === null) return 'undeclared';
  if (declared === OKF_VERSION) return 'current';
  const parsed = /^(\d+)\.(\d+)$/.exec(declared.trim());
  if (!parsed) return 'unknown-major';
  const [major, minor] = [Number(parsed[1]), Number(parsed[2])];
  const [ourMajor, ourMinor] = OKF_VERSION.split('.').map(Number);
  if (major !== ourMajor) return 'unknown-major';
  return minor < ourMinor ? 'legacy-minor' : 'newer-minor';
}

/**
 * SPEC §5.2 `generated`. v0.1 recorded a concept's last content change as a
 * bare `timestamp`; v0.2 records who produced it and when. `by` is an actor
 * (§7): `<producer>/<version>` for tools, `human:<id>`, or `process:<id>`.
 */
export interface OkfGenerated {
  by: string;
  at: string;
}

export function okfGenerated(by: string, at: string = new Date().toISOString()): OkfGenerated {
  return { by, at };
}

/**
 * True when a concept records machine authorship. Accepts the v0.2 mapping and
 * the legacy knode-os boolean `generated: true`, which v0.2 supersedes but
 * which is still sitting in every data directory written before the upgrade.
 */
export function isGeneratedConcept(frontmatter: Record<string, unknown> | undefined | null): boolean {
  const value = frontmatter?.generated;
  if (value === true) return true;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).by === 'string';
}

/**
 * A concept's last meaningful content change: `generated.at`, falling back to
 * a legacy v0.1 `timestamp` as SPEC §13.1 permits. Returns null when neither
 * is present or parseable.
 */
export function readGeneratedAt(frontmatter: Record<string, unknown> | undefined | null): string | null {
  const generated = frontmatter?.generated;
  if (typeof generated === 'object' && generated !== null && !Array.isArray(generated)) {
    const at = (generated as Record<string, unknown>).at;
    if (isIsoDateTime(at)) return at instanceof Date ? at.toISOString() : String(at);
  }
  const legacy = frontmatter?.timestamp;
  if (isIsoDateTime(legacy)) return legacy instanceof Date ? legacy.toISOString() : String(legacy);
  return null;
}

export type OkfDiagnosticLevel = 'error' | 'warning';

export interface OkfDiagnostic {
  level: OkfDiagnosticLevel;
  code: string;
  path: string;
  message: string;
}

export interface OkfValidationResult {
  valid: boolean;
  root: string;
  version: string | null;
  files: number;
  concepts: number;
  indexes: number;
  logs: number;
  errors: number;
  warnings: number;
  diagnostics: OkfDiagnostic[];
}

export interface OkfLink {
  label: string;
  href: string;
}

interface ParsedOkfFile {
  frontmatter: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
  parseError?: string;
}

/**
 * Extract ordinary markdown links. OKF uses these links as untyped directed
 * graph edges; images, wikilinks, external links and links in code are ignored.
 */
export function extractMarkdownLinks(markdown: string): OkfLink[] {
  const links: OkfLink[] = [];
  const seen = new Set<string>();
  for (const match of withoutMarkdownCode(markdown).matchAll(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g)) {
    const label = match[1].trim();
    let target = match[2].trim();
    if (target.startsWith('<')) {
      const end = target.indexOf('>');
      target = end >= 0 ? target.slice(1, end) : target.slice(1);
    } else {
      // Drop an optional markdown link title: (path.md "title").
      target = target.split(/\s+["']/)[0];
    }
    if (!label || !target) continue;
    const key = `${label}\0${target}`;
    if (!seen.has(key)) {
      seen.add(key);
      links.push({ label, href: target });
    }
  }
  return links;
}

/** The text with fenced blocks and inline code removed: a link written as code is an example, not a link. */
export function withoutMarkdownCode(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '');
}

/** Resolve an OKF link to a bundle-relative markdown path, or null if external. */
export function resolveOkfLink(sourceRel: string, href: string): string | null {
  const clean = href.trim().split('#', 1)[0].split('?', 1)[0];
  if (!clean || clean.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(clean)) return null;
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    // Keep the literal path. A malformed percent escape is a broken soft link,
    // not a reason to reject an otherwise conformant bundle.
  }
  const joined = decoded.startsWith('/')
    ? decoded.replace(/^\/+/, '')
    : path.posix.join(path.posix.dirname(sourceRel), decoded);
  let normalized = path.posix.normalize(joined).replace(/^\.\//, '');
  if (normalized === '..' || normalized.startsWith('../')) return `../${normalized.replace(/^\.\.\/?/, '')}`;
  if (decoded.endsWith('/')) normalized = path.posix.join(normalized, 'index.md');
  return normalized;
}

export interface OkfValidateOptions {
  /**
   * Validate the view knode-os indexes rather than the bytes on disk: the
   * frontmatter normalizer (src/okf/normalize.ts) is applied in memory first,
   * which is what an unannotated raw/docs subtree looks like to the pipeline.
   */
  asIndexed?: boolean;
}

/** Validate a directory against OKF v0.2's three conformance rules (SPEC §11). */
export function validateOkfBundle(bundleDir: string, opts: OkfValidateOptions = {}): OkfValidationResult {
  const root = path.resolve(bundleDir);
  const readConcept = (rel: string): string => {
    const text = fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
    return opts.asIndexed ? normalizeCookedFrontmatter(rel, text) : text;
  };
  const diagnostics: OkfDiagnostic[] = [];
  const add = (level: OkfDiagnosticLevel, code: string, rel: string, message: string) => {
    diagnostics.push({ level, code, path: rel || '.', message });
  };

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    add('error', 'bundle_not_found', '.', `OKF bundle directory not found: ${root}`);
    return finishValidation(root, null, 0, 0, 0, 0, diagnostics);
  }

  const files = listMarkdownFiles(root);
  const known = new Set(files);
  let version: string | null = null;
  let concepts = 0;
  let indexes = 0;
  let logs = 0;

  for (const rel of files) {
    const raw = readConcept(rel);
    const parsed = parseOkfFile(raw);
    const name = path.posix.basename(rel);

    if (name === 'index.md') {
      indexes++;
      const isRoot = rel === 'index.md';
      if (parsed.parseError) add('error', 'invalid_frontmatter', rel, parsed.parseError);
      if (parsed.hasFrontmatter && !isRoot) {
        add('error', 'index_frontmatter', rel, 'Only the bundle-root index.md may contain frontmatter.');
      }
      if (isRoot && parsed.hasFrontmatter && !parsed.parseError) {
        const declared = parsed.frontmatter.okf_version;
        if (declared !== undefined) version = String(declared);
      }
      if (!/^#\s+\S+/m.test(parsed.body)) {
        add('error', 'index_structure', rel, 'index.md must contain at least one section heading.');
      }
      continue;
    }

    if (name === 'log.md') {
      logs++;
      if (parsed.parseError) add('error', 'invalid_frontmatter', rel, parsed.parseError);
      if (parsed.hasFrontmatter) add('error', 'log_frontmatter', rel, 'log.md must not contain frontmatter.');
      validateLog(parsed.body, rel, add);
      continue;
    }

    concepts++;
    if (!parsed.hasFrontmatter) {
      add('error', 'missing_frontmatter', rel, 'Concept documents must start with YAML frontmatter.');
      continue;
    }
    if (parsed.parseError) {
      add('error', 'invalid_frontmatter', rel, parsed.parseError);
      continue;
    }
    const type = parsed.frontmatter.type;
    if (typeof type !== 'string' || !type.trim()) {
      add('error', 'missing_type', rel, 'Concept frontmatter must contain a non-empty string type.');
    }
    validateTrustFields(parsed.frontmatter, rel, add);
  }

  const support = classifyOkfVersion(version);
  if (support === 'undeclared') {
    if (known.has('index.md')) {
      add('warning', 'version_undeclared', 'index.md', `Bundle does not declare optional okf_version: "${OKF_VERSION}".`);
    }
  } else if (support === 'legacy-minor') {
    add('warning', 'legacy_version', 'index.md',
      `Bundle declares OKF ${version}; this build implements ${OKF_VERSION} and reads it through the v0.1 fallbacks (legacy timestamp, body # Citations).`);
  } else if (support === 'newer-minor') {
    add('warning', 'newer_minor_version', 'index.md',
      `Bundle declares OKF ${version}; this build implements ${OKF_VERSION}. Minor versions are additive, so unknown fields are preserved and ignored.`);
  } else if (support === 'unknown-major') {
    add('warning', 'unknown_version', 'index.md',
      `Bundle declares OKF ${version}; this build implements ${OKF_VERSION} and will consume it best-effort.`);
  }

  // Broken and out-of-bundle links are deliberately warnings: OKF consumers
  // must tolerate them while bundles are being grown or refactored.
  for (const rel of files) {
    const body = parseOkfFile(readConcept(rel)).body;
    for (const link of extractMarkdownLinks(body)) {
      const target = resolveOkfLink(rel, link.href);
      if (target === null) continue;
      if (target.startsWith('../')) {
        add('warning', 'link_outside_bundle', rel, `Link target leaves the bundle: ${link.href}`);
      } else if (!known.has(target)) {
        const withMd = path.posix.extname(target) ? target : `${target}.md`;
        const asIndex = path.posix.join(target, 'index.md');
        const targetAbs = path.join(root, ...target.split('/'));
        const existingDirectory = fs.existsSync(targetAbs) && fs.statSync(targetAbs).isDirectory();
        if (!existingDirectory && !known.has(withMd) && !known.has(asIndex)) {
          add('warning', 'broken_link', rel, `Link target does not exist in the bundle: ${link.href}`);
        }
      }
    }
  }

  return finishValidation(root, version, files.length, concepts, indexes, logs, diagnostics);
}

export interface OkfImportOptions {
  name?: string;
  /** Import even when the source is not conformant. Defaults to false. */
  allowInvalid?: boolean;
}

export interface OkfImportResult {
  source: string;
  destination: string;
  files: number;
  concepts: number;
  assets: number;
  validation: OkfValidationResult;
}

/** Copy a portable OKF bundle into raw/docs/okf without rewriting its files. */
export function importOkfBundle(dataDir: string, bundleDir: string, opts: OkfImportOptions = {}): OkfImportResult {
  const validation = validateOkfBundle(bundleDir);
  if (!validation.valid && !opts.allowInvalid) {
    const sample = validation.diagnostics.filter((d) => d.level === 'error').slice(0, 5)
      .map((d) => `${d.path}: ${d.message}`).join('; ');
    throw new Error(`OKF bundle is not conformant (${validation.errors} errors): ${sample}`);
  }

  const source = path.resolve(bundleDir);
  const name = safeBundleName(opts.name ?? path.basename(source));
  const destination = `raw/docs/okf/${name}`;
  const destAbs = safePath(dataDir, destination);
  if (fs.existsSync(destAbs)) throw new Error(`OKF import destination already exists: ${destination}`);

  fs.mkdirSync(destAbs, { recursive: true });
  try {
    const copied = copyPortableBundle(source, destAbs);
    fs.writeFileSync(path.join(destAbs, '.okf-import.json'), JSON.stringify({
      format: 'okf',
      version: validation.version,
      source,
      imported_at: new Date().toISOString(),
    }, null, 2) + '\n');
    initObsidianVault(destAbs);
    return {
      source,
      destination,
      files: copied.files,
      assets: copied.assets,
      concepts: validation.concepts,
      validation,
    };
  } catch (error) {
    fs.rmSync(destAbs, { recursive: true, force: true });
    throw error;
  }
}

export interface OkfExportResult {
  source: string;
  destination: string;
  files: number;
  concepts: number;
  assets: number;
  validation: OkfValidationResult;
}

/** Export the native wiki/ bundle after proving that it is OKF-conformant. */
export function exportOkfBundle(dataDir: string, destinationDir: string): OkfExportResult {
  const source = safePath(dataDir, 'wiki');
  const validation = validateOkfBundle(source);
  if (!validation.valid) {
    throw new Error(`wiki/ is not OKF-conformant (${validation.errors} errors); run \`knode-os okf migrate\` and validate again.`);
  }
  const destination = path.resolve(destinationDir);
  if (fs.existsSync(destination)) throw new Error(`OKF export destination already exists: ${destination}`);
  fs.mkdirSync(destination, { recursive: true });
  try {
    const copied = copyPortableBundle(source, destination);
    initObsidianVault(destination);
    return {
      source,
      destination,
      files: copied.files,
      assets: copied.assets,
      concepts: validation.concepts,
      validation,
    };
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

export interface OkfMigrationResult {
  changed: string[];
  skipped: string[];
  validation: OkfValidationResult;
}

/**
 * Upgrade an existing knode-os wiki to the OKF v0.2 conventions: declare the
 * version, give every concept a type, convert the legacy log, and fold the
 * v0.1 `generated: true` + `timestamp` pair into `generated: { by, at }`.
 * Content and unknown frontmatter keys are preserved; malformed YAML is left
 * untouched and reported in skipped so a human can repair it safely.
 */
export function migrateWikiToOkf(dataDir: string, dryRun = false): OkfMigrationResult {
  const root = safePath(dataDir, 'wiki');
  if (!fs.existsSync(root)) throw new Error('wiki/ does not exist; run `knode-os init` first.');
  const changed: string[] = [];
  const skipped: string[] = [];

  for (const rel of listMarkdownFiles(root)) {
    const abs = path.join(root, ...rel.split('/'));
    const raw = fs.readFileSync(abs, 'utf8');
    const parsed = parseOkfFile(raw);
    const name = path.posix.basename(rel);
    let next = raw;

    if (rel === 'index.md') {
      if (parsed.parseError) {
        skipped.push(rel);
        continue;
      }
      const declared = parsed.frontmatter.okf_version;
      if (!parsed.hasFrontmatter) {
        next = `---\nokf_version: "${OKF_VERSION}"\n---\n\n${raw}`;
      } else if (declared === undefined) {
        next = injectFrontmatterField(raw, `okf_version: "${OKF_VERSION}"`);
      } else if (classifyOkfVersion(String(declared)) === 'legacy-minor') {
        next = replaceInFrontmatter(raw, (block) => block.replace(
          /^okf_version:[ \t]*.*$/m, `okf_version: "${OKF_VERSION}"`));
      }
    } else if (name === 'index.md') {
      if (parsed.parseError) {
        skipped.push(rel);
        continue;
      }
      if (parsed.hasFrontmatter) {
        const title = typeof parsed.frontmatter.title === 'string' ? parsed.frontmatter.title.trim() : '';
        next = parsed.body.replace(/^\s+/, '');
        if (!/^#\s+\S+/m.test(next)) next = `# ${title || titleFromRel(rel)}\n\n${next}`;
      }
    } else if (name === 'log.md') {
      const normalized = normalizeLegacyLog(raw);
      if (normalized === null) {
        skipped.push(rel);
        continue;
      }
      next = normalized;
    } else {
      if (parsed.parseError) {
        skipped.push(rel);
        continue;
      }
      if (!parsed.hasFrontmatter) {
        next = `---\ntype: ${JSON.stringify(inferType(rel))}\ntitle: ${JSON.stringify(titleFromBody(raw, rel))}\n---\n\n${raw}`;
      } else {
        if (typeof parsed.frontmatter.type !== 'string' || !parsed.frontmatter.type.trim()) {
          next = injectFrontmatterField(next, `type: ${JSON.stringify(inferType(rel))}`);
        }
        next = upgradeGeneratedFrontmatter(next, parsed.frontmatter);
      }
    }

    if (next !== raw) {
      changed.push(rel);
      if (!dryRun) fs.writeFileSync(abs, next);
    }
  }

  return { changed, skipped, validation: validateOkfBundle(root) };
}

function parseOkfFile(raw: string): ParsedOkfFile {
  const hasFrontmatter = raw.startsWith('---\n') || raw.startsWith('---\r\n');
  if (!hasFrontmatter) return { frontmatter: {}, body: raw, hasFrontmatter: false };
  if (!/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(raw)) {
    return {
      frontmatter: {}, body: raw, hasFrontmatter: true,
      parseError: 'Frontmatter has no closing --- delimiter.',
    };
  }
  try {
    const parsed = matter(raw);
    return { frontmatter: parsed.data as Record<string, unknown>, body: parsed.content, hasFrontmatter: true };
  } catch (error) {
    return {
      frontmatter: {}, body: raw, hasFrontmatter: true,
      parseError: `Frontmatter is not parseable YAML: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function listMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (abs: string, prefix: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) visit(child, rel);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(rel);
    }
  };
  visit(root, '');
  return out;
}

/** Copy notes and attachments while excluding source-control and Vault state. */
function copyPortableBundle(source: string, destination: string): { files: number; assets: number } {
  let files = 0;
  let assets = 0;
  const visit = (from: string, to: string) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) {
        visit(src, dst);
      } else if (entry.isFile()) {
        fs.copyFileSync(src, dst);
        files++;
        if (!entry.name.endsWith('.md')) assets++;
      }
    }
  };
  visit(source, destination);
  return { files, assets };
}

function validateLog(
  body: string,
  rel: string,
  add: (level: OkfDiagnosticLevel, code: string, rel: string, message: string) => void,
): void {
  if (!/^#\s+\S+/m.test(body)) add('error', 'log_structure', rel, 'log.md must start with a title heading.');
  const dates: string[] = [];
  let inDate = false;
  for (const line of body.split(/\r?\n/)) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(h2[1])) {
        add('error', 'log_date', rel, `Log date heading must use YYYY-MM-DD: ${h2[1]}`);
      } else {
        dates.push(h2[1]);
      }
      inDate = true;
    } else if (/^\s*[-*]\s+/.test(line) && !inDate) {
      add('error', 'log_entry_outside_date', rel, 'Log entries must appear below an ISO date heading.');
    }
  }
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] > dates[i - 1]) {
      add('error', 'log_order', rel, 'Log date groups must be newest first.');
      break;
    }
  }
}

/**
 * Soft checks for the v0.2 trust family (SPEC §5.2). None of these can fail a
 * bundle: §11 forbids rejecting a concept over an optional family.
 */
function validateTrustFields(
  frontmatter: Record<string, unknown>,
  rel: string,
  add: (level: OkfDiagnosticLevel, code: string, rel: string, message: string) => void,
): void {
  const generated = frontmatter.generated;
  if (generated === true || generated === false) {
    add('warning', 'legacy_generated_flag', rel,
      'generated is a boolean; OKF v0.2 reserves it for { by, at }. Run `knode-os okf migrate` to convert it.');
  } else if (typeof generated === 'object' && generated !== null && !Array.isArray(generated)) {
    const { by, at } = generated as Record<string, unknown>;
    if (typeof by !== 'string' || !by.trim()) {
      add('warning', 'generated_by_missing', rel, 'generated.by is required within generated and must be an actor string.');
    }
    if (at !== undefined && !isIsoDateTime(at)) {
      add('warning', 'generated_at_not_iso8601', rel, 'generated.at should be an ISO 8601 datetime.');
    }
  }

  for (const entry of verifiedEntries(frontmatter.verified)) {
    if (typeof entry.by !== 'string' || !entry.by.trim()) {
      add('warning', 'verified_by_missing', rel, 'Each verified entry needs a by actor.');
    }
    if (entry.at !== undefined && !isIsoDateTime(entry.at)) {
      add('warning', 'verified_at_not_iso8601', rel, 'verified[].at should be an ISO 8601 datetime.');
    }
  }

  if (frontmatter.status !== undefined && !['draft', 'stable', 'deprecated'].includes(String(frontmatter.status))) {
    add('warning', 'unknown_status', rel, 'status should be one of draft, stable, deprecated.');
  }
  if (frontmatter.stale_after !== undefined && !isIsoDateTime(frontmatter.stale_after)) {
    add('warning', 'stale_after_not_iso8601', rel, 'stale_after should be an absolute ISO 8601 datetime.');
  }
  if (frontmatter.tags !== undefined && !Array.isArray(frontmatter.tags)) {
    add('warning', 'tags_not_list', rel, 'The optional tags field should be a YAML list.');
  }
  if (frontmatter.timestamp !== undefined) {
    if (!isIsoDateTime(frontmatter.timestamp)) {
      add('warning', 'timestamp_not_iso8601', rel, 'The optional timestamp field should be an ISO 8601 datetime.');
    }
    if (frontmatter.generated === undefined) {
      add('warning', 'legacy_timestamp', rel,
        'timestamp is a v0.1 field superseded by generated.at (SPEC §13.1); it is still read as a fallback.');
    }
  }
}

/** SPEC §5.2: a bare verified mapping MUST be read as a one-element list. */
function verifiedEntries(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null);
  if (typeof value === 'object' && value !== null) return [value as Record<string, unknown>];
  return [];
}

function finishValidation(
  root: string,
  version: string | null,
  files: number,
  concepts: number,
  indexes: number,
  logs: number,
  diagnostics: OkfDiagnostic[],
): OkfValidationResult {
  const errors = diagnostics.filter((d) => d.level === 'error').length;
  const warnings = diagnostics.length - errors;
  return { valid: errors === 0, root, version, files, concepts, indexes, logs, errors, warnings, diagnostics };
}

function isIsoDateTime(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
}

function safeBundleName(value: string): string {
  const name = value.normalize('NFKC').trim().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '');
  if (!name || name === '.' || name === '..' || name.startsWith('.')) throw new Error(`Invalid OKF bundle name: ${value}`);
  return name;
}

/** Rewrite the frontmatter block in place, leaving the body byte-for-byte. */
function replaceInFrontmatter(raw: string, edit: (block: string) => string): string {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(raw);
  if (!match) return raw;
  const edited = edit(match[2]);
  if (edited === match[2]) return raw;
  return match[1] + edited + match[3] + raw.slice(match[0].length);
}

/**
 * SPEC §13.1: v0.1 recorded machine authorship as knode-os's `generated: true`
 * plus a `timestamp`; v0.2 records it as `generated: { by, at }`. The actor is
 * `knode-os/migrated` because the original producer is no longer recoverable.
 * A `timestamp` we cannot parse is left alone rather than silently dropped.
 */
function upgradeGeneratedFrontmatter(raw: string, frontmatter: Record<string, unknown>): string {
  if (frontmatter.generated !== true) return raw;
  const at = readGeneratedAt(frontmatter);
  const value = at ? `{ by: "knode-os/migrated", at: "${at}" }` : '{ by: "knode-os/migrated" }';
  return replaceInFrontmatter(raw, (block) => {
    const eol = block.includes('\r\n') ? '\r\n' : '\n';
    return block
      .split(/\r?\n/)
      .filter((line) => at === null || !/^timestamp:[ \t]/.test(line))
      .map((line) => (/^generated:[ \t]*true[ \t]*$/.test(line) ? `generated: ${value}` : line))
      .join(eol);
  });
}

function injectFrontmatterField(raw: string, line: string): string {
  const eol = raw.startsWith('---\r\n') ? '\r\n' : '\n';
  return raw.replace(/^---\r?\n/, `---${eol}${line}${eol}`);
}

function inferType(rel: string): string {
  const first = rel.split('/')[0];
  const map: Record<string, string> = { entities: 'Entity', concepts: 'Concept', sources: 'Source', dreams: 'Dream' };
  return map[first] ?? (rel === 'overview.md' ? 'Overview' : 'Concept');
}

function titleFromRel(rel: string): string {
  return path.posix.basename(rel, '.md').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function titleFromBody(body: string, rel: string): string {
  return /^#\s+(.+?)\s*$/m.exec(body)?.[1].trim() || titleFromRel(rel);
}

/** Convert the legacy knode-os timestamp-per-line log to OKF date groups. */
function normalizeLegacyLog(raw: string): string | null {
  // Already structurally OKF: leave byte-for-byte unchanged.
  if (/^##\s+\d{4}-\d{2}-\d{2}\s*$/m.test(raw) || !/^\s*[-*]\s+/m.test(raw)) {
    const title = /^#\s+\S+/m.test(raw) ? raw : `# Directory Update Log\n\n${raw}`;
    return title;
  }
  const groups = new Map<string, string[]>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*[-*]\s+(\d{4}-\d{2}-\d{2})T\S+\s+([^:]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, date, op, detail] = match;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date)!.push(`* **${op.trim()}**: ${detail.trim()}`);
  }
  if (groups.size === 0) return null;
  const lines = ['# Directory Update Log', ''];
  for (const date of [...groups.keys()].sort().reverse()) {
    lines.push(`## ${date}`, '', ...groups.get(date)!, '');
  }
  return lines.join('\n');
}
