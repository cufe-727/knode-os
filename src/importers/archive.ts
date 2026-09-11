import fs from 'node:fs';
import path from 'node:path';
import { safePath } from '../fs/files.js';

/**
 * Importer for rookie-trade crawler archives — the envelope NDJSON layout
 * described in crawler/archive/README.md:
 *
 *   <archive>/<platform>/<target_id>/YYYY-MM.ndjson   (one envelope per line)
 *
 * Every envelope carries a pre-rendered `post_markdown` (and optionally
 * `comments_markdown`), a top-level `investment_relevant` verdict and a
 * `sort_key`. The importer groups posts per (platform, target, month) and
 * writes them into raw/docs/finance/ as markdown volumes capped at
 * `volumeChars` characters, so tier-1 extraction (which truncates each
 * document at LLM_EXTRACT_INPUT_CHARS) sees whole volumes instead of
 * truncated month dumps.
 *
 * Output is deterministic for the same inputs/options — re-imports leave
 * unchanged files byte-identical, and the ingest sha-diff skips them.
 */

export interface ArchiveImportOptions {
  /** Inclusive month lower bound, e.g. '2026-04'. */
  since?: string;
  /** Inclusive month upper bound, e.g. '2026-07'. */
  until?: string;
  /** Only these platforms (directory names under the archive root). */
  platforms?: string[];
  /** Only these target ids. */
  targets?: string[];
  /** Drop envelopes whose investment_relevant verdict is false. */
  relevantOnly?: boolean;
  /** Max characters of post content per output volume. */
  volumeChars?: number;
  onProgress?: (msg: string) => void;
}

export interface ArchiveImportStats {
  ndjsonFiles: number;
  posts: number;
  skippedIrrelevant: number;
  parseErrors: number;
  volumes: number;
  bytes: number;
  perPlatform: Record<string, number>;
}

interface Envelope {
  platform?: string;
  target?: { id?: string | number; name?: string };
  month?: string;
  post_id?: string | number;
  sort_key?: string | number;
  investment_relevant?: boolean;
  post?: { investment_relevant?: boolean };
  post_markdown?: string;
  comments_markdown?: string;
}

interface PostDoc {
  sortKey: string;
  postId: string;
  markdown: string;
}

const OUT_ROOT = 'raw/docs/finance';
const DEFAULT_VOLUME_CHARS = 9_000;
const MONTH_FILE = /^(\d{4}-\d{2})\.ndjson$/;

/** Normalize a sort_key (epoch ms number or date-ish string) into a sortable string. */
function sortValue(sk: unknown): string {
  if (typeof sk === 'number' && Number.isFinite(sk)) {
    const d = new Date(sk);
    return Number.isNaN(d.getTime()) ? String(sk) : d.toISOString();
  }
  return String(sk ?? '');
}

function isRelevant(env: Envelope): boolean {
  if (typeof env.investment_relevant === 'boolean') return env.investment_relevant;
  if (typeof env.post?.investment_relevant === 'boolean') return env.post.investment_relevant;
  return true; // unreviewed content is kept
}

function renderPost(env: Envelope): string {
  const parts: string[] = [];
  const post = (env.post_markdown ?? '').trim();
  if (post) parts.push(post);
  const comments = (env.comments_markdown ?? '').trim();
  if (comments) parts.push(comments);
  return parts.join('\n\n');
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function volumeContent(
  platform: string,
  targetId: string,
  targetName: string,
  month: string,
  part: number,
  posts: PostDoc[],
): string {
  const title = `${targetName || targetId} ${month} · ${platform} · part ${part}`;
  const fm = [
    '---',
    `title: ${yamlString(title)}`,
    `platform: ${yamlString(platform)}`,
    `target: ${yamlString(targetId)}`,
    `target_name: ${yamlString(targetName)}`,
    `month: ${yamlString(month)}`,
    `part: ${part}`,
    `posts: ${posts.length}`,
    `source: rookie-trade-archive`,
    '---',
  ].join('\n');
  const body = posts.map((p) => p.markdown).join('\n\n---\n\n');
  return `${fm}\n\n# ${title}\n\n${body}\n`;
}

/** Split a month's posts into volumes capped at ~volumeChars characters of content. */
function splitVolumes(posts: PostDoc[], volumeChars: number): PostDoc[][] {
  const volumes: PostDoc[][] = [];
  let current: PostDoc[] = [];
  let size = 0;
  for (const p of posts) {
    if (current.length > 0 && size + p.markdown.length > volumeChars) {
      volumes.push(current);
      current = [];
      size = 0;
    }
    current.push(p);
    size += p.markdown.length;
  }
  if (current.length > 0) volumes.push(current);
  return volumes;
}

function listDirs(abs: string): string[] {
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function importArchive(
  dataDir: string,
  archiveDir: string,
  opts: ArchiveImportOptions = {},
): ArchiveImportStats {
  const stats: ArchiveImportStats = {
    ndjsonFiles: 0, posts: 0, skippedIrrelevant: 0, parseErrors: 0, volumes: 0, bytes: 0, perPlatform: {},
  };
  const progress = opts.onProgress ?? (() => {});
  const volumeChars = opts.volumeChars ?? DEFAULT_VOLUME_CHARS;
  const root = path.resolve(archiveDir);
  if (!fs.existsSync(root)) throw new Error(`archive directory not found: ${root}`);

  for (const platform of listDirs(root)) {
    if (opts.platforms && !opts.platforms.includes(platform)) continue;
    for (const target of listDirs(path.join(root, platform))) {
      if (opts.targets && !opts.targets.includes(target)) continue;
      const targetAbs = path.join(root, platform, target);
      const months = fs.readdirSync(targetAbs)
        .map((f) => ({ file: f, m: MONTH_FILE.exec(f)?.[1] }))
        .filter((x): x is { file: string; m: string } => Boolean(x.m))
        .filter((x) => (!opts.since || x.m >= opts.since) && (!opts.until || x.m <= opts.until))
        .sort((a, b) => a.m.localeCompare(b.m));
      if (months.length === 0) continue;

      const outDirRel = `${OUT_ROOT}/${platform}/${target}`;
      const outDirAbs = safePath(dataDir, outDirRel);
      fs.mkdirSync(outDirAbs, { recursive: true });

      for (const { file, m: month } of months) {
        stats.ndjsonFiles++;
        const lines = fs.readFileSync(path.join(targetAbs, file), 'utf8').split('\n');
        let targetName = target;
        const posts: PostDoc[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let env: Envelope;
          try {
            env = JSON.parse(trimmed) as Envelope;
          } catch {
            stats.parseErrors++;
            continue;
          }
          if (env.target?.name) targetName = String(env.target.name);
          if (opts.relevantOnly && !isRelevant(env)) {
            stats.skippedIrrelevant++;
            continue;
          }
          const markdown = renderPost(env);
          if (!markdown) continue;
          posts.push({ sortKey: sortValue(env.sort_key), postId: String(env.post_id ?? ''), markdown });
        }
        posts.sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.postId.localeCompare(b.postId));
        stats.posts += posts.length;
        stats.perPlatform[platform] = (stats.perPlatform[platform] ?? 0) + posts.length;

        // stale volumes from a previous import (different filters → fewer parts)
        for (const existing of fs.readdirSync(outDirAbs)) {
          if (existing.startsWith(`${month}-p`) && existing.endsWith('.md')) {
            fs.rmSync(path.join(outDirAbs, existing), { force: true });
          }
        }
        const volumes = splitVolumes(posts, volumeChars);
        volumes.forEach((vol, i) => {
          const part = i + 1;
          const content = volumeContent(platform, target, targetName, month, part, vol);
          const outAbs = path.join(outDirAbs, `${month}-p${String(part).padStart(2, '0')}.md`);
          fs.writeFileSync(outAbs, content);
          stats.volumes++;
          stats.bytes += Buffer.byteLength(content);
        });
        progress(`${platform}/${target}/${month}: ${posts.length} posts → ${volumes.length} volumes`);
      }
    }
  }
  return stats;
}
