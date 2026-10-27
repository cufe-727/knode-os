import fs from 'node:fs';
import path from 'node:path';
import { safePath, walkFiles } from '../fs/files.js';
import { parseFrontmatter, titleFromMarkdown } from '../markdown.js';

export interface ResolvedKnowledgeLink {
  path: string;
  fragment: string | null;
}

/**
 * Resolve an in-app Markdown/WikiLink destination to a real workspace file.
 *
 * Obsidian permits both vault-root paths (`[[entities/PGlite]]`) and shortest
 * unique note names (`[[PGlite]]`). Generated wiki pages also commonly link by
 * their frontmatter title or alias, which need not match the filename.
 */
export function resolveKnowledgeLink(
  dataDir: string,
  fromPath: string,
  rawTarget: string,
): ResolvedKnowledgeLink | null {
  const decoded = decodeTarget(rawTarget.trim());
  if (!decoded || decoded.includes('\0') || isExternalTarget(decoded)) return null;

  const hashAt = decoded.indexOf('#');
  const pathPart = (hashAt >= 0 ? decoded.slice(0, hashAt) : decoded).split('?', 1)[0].trim();
  const fragment = hashAt >= 0 ? decoded.slice(hashAt + 1).trim() || null : null;
  const source = normalizeRelative(fromPath);
  if (!source) return null;
  if (!pathPart) return existingFile(dataDir, source) ? { path: source, fragment } : null;

  const target = pathPart.replace(/^\/+/, '');
  // null for a path that climbs above its start (`../../raw/docs/x.md`): it can
  // still be relative to the page, which is joined before it is judged
  const clean = normalizeRelative(target);
  const sourceDir = path.posix.dirname(source);
  const vaultRoot = source === 'wiki' || source.startsWith('wiki/') ? 'wiki' : null;
  const candidates: string[] = [];

  // Explicit workspace-root paths remain workspace-root paths. Everything else
  // first follows ordinary Markdown's source-relative resolution.
  if (clean && /^(wiki|raw)(\/|$)/.test(clean)) candidates.push(clean);
  else candidates.push(path.posix.join(sourceDir, target));
  if (clean && vaultRoot && clean !== vaultRoot && !clean.startsWith(`${vaultRoot}/`)) {
    candidates.push(path.posix.join(vaultRoot, clean));
  }
  if (clean) candidates.push(clean);

  // resolveCandidate normalizes again and refuses anything outside the workspace
  for (const candidate of unique(candidates)) {
    const resolved = resolveCandidate(dataDir, candidate);
    if (resolved) return { path: resolved, fragment };
  }

  if (!vaultRoot || !clean) return null;
  const wikiFiles = markdownFiles(dataDir, vaultRoot);
  const wantedStem = path.posix.basename(clean).replace(/\.(md|markdown)$/i, '');

  // Obsidian's shortest-path lookup is case-insensitive and only resolves a
  // basename when it identifies one note unambiguously.
  if (!clean.includes('/')) {
    const basenameMatches = wikiFiles.filter((file) =>
      fold(path.posix.basename(file).replace(/\.(md|markdown)$/i, '')) === fold(wantedStem));
    if (basenameMatches.length === 1) return { path: basenameMatches[0], fragment };
  }

  const metadataMatches: string[] = [];
  for (const file of wikiFiles) {
    try {
      const parsed = parseFrontmatter(fs.readFileSync(safePath(dataDir, file), 'utf8'));
      const title = titleFromMarkdown(file, parsed);
      const aliases = Array.isArray(parsed.frontmatter.aliases)
        ? parsed.frontmatter.aliases.map(String)
        : typeof parsed.frontmatter.aliases === 'string' ? [parsed.frontmatter.aliases] : [];
      if ([title, ...aliases].some((name) => name && fold(name) === fold(clean))) metadataMatches.push(file);
    } catch {
      // One malformed or concurrently removed note must not break navigation.
    }
  }
  return metadataMatches.length === 1 ? { path: metadataMatches[0], fragment } : null;
}

/**
 * The name a link stands for when no note answers to it — `[[英伟达]]`,
 * `[[英伟达.md#估值]]` → `英伟达` — which may be an entity the graph has. A
 * link with a folder in it names a note, not an entity: empty, as for an
 * external link.
 */
export function linkedName(rawTarget: string): string {
  const decoded = decodeTarget(rawTarget.trim());
  if (!decoded || isExternalTarget(decoded)) return '';
  const name = decoded.split('#', 1)[0].split('?', 1)[0].replace(/\.(md|markdown)$/i, '').trim();
  return name.includes('/') || name.includes('\\') ? '' : name;
}

function decodeTarget(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isExternalTarget(value: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value);
}

function normalizeRelative(value: string): string | null {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized.replace(/^\.\//, '');
}

function resolveCandidate(dataDir: string, candidate: string): string | null {
  const normalized = normalizeRelative(candidate);
  if (!normalized) return null;
  const ext = path.posix.extname(normalized).toLowerCase();
  const candidates = ext
    ? [normalized]
    : [normalized, `${normalized}.md`, `${normalized}.markdown`, path.posix.join(normalized, 'index.md')];
  for (const item of candidates) {
    if (existingFile(dataDir, item)) return item;
  }
  return null;
}

function existingFile(dataDir: string, relative: string): boolean {
  try {
    const absolute = safePath(dataDir, relative);
    return fs.existsSync(absolute) && fs.statSync(absolute).isFile();
  } catch {
    return false;
  }
}

function markdownFiles(dataDir: string, root: string): string[] {
  try {
    return walkFiles(dataDir, root).filter((file) => /\.(md|markdown)$/i.test(file));
  } catch {
    return [];
  }
}

function fold(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
