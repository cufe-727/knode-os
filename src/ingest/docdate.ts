import path from 'node:path';
import { dateStart } from '../store/dates.js';

/**
 * A source's reference date: when its content is *about*. Read from
 * frontmatter first (`date`, `published`, `as_of`, OKF `generated.at` …),
 * then from a date in the path (`reports/2026-05-catl.md`, `20260510.pdf`).
 * Never the file mtime — copying a workspace would silently re-date every
 * claim and break idempotent re-ingest.
 */
const FRONTMATTER_KEYS = ['date', 'doc_date', 'docDate', 'published', 'published_at', 'publishedAt', 'as_of', 'asOf', 'report_date', 'reportDate', 'issued', 'created'];

export function docDateOf(file: string, frontmatter: Record<string, unknown> | undefined | null): string | null {
  const fm = frontmatter ?? {};
  for (const key of FRONTMATTER_KEYS) {
    const v = fm[key];
    if (v === undefined || v === null || v === '') continue;
    const iso = dateStart(v);
    if (iso) return iso;
  }
  const generated = fm.generated;
  if (generated && typeof generated === 'object' && !Array.isArray(generated)) {
    const at = (generated as Record<string, unknown>).at;
    const iso = dateStart(at);
    if (iso) return iso;
  }
  return dateFromPath(file);
}

/** `2026-05-10`, `2026_05_10`, `20260510`, `2026-05`, `2026年5月` anywhere in the file name or its parent folders. */
export function dateFromPath(file: string): string | null {
  const segments = file.replace(/\\/g, '/').split('/');
  const base = path.posix.basename(file).replace(/\.[^.]+$/, '');
  const candidates = [base, ...segments.slice(0, -1).reverse()];
  for (const seg of candidates) {
    let m: RegExpExecArray | null;
    if ((m = /(?:^|\D)((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)/.exec(seg))) {
      const iso = dateStart(`${m[1]}-${m[2]}-${m[3]}`);
      if (iso) return iso;
    }
    if ((m = /(?:^|\D)((?:19|20)\d{2})年(1[0-2]|0?[1-9])月(?:(\d{1,2})日)?/.exec(seg))) {
      const iso = dateStart(m[3] ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : `${m[1]}-${m[2].padStart(2, '0')}`);
      if (iso) return iso;
    }
    if ((m = /(?:^|\D)((?:19|20)\d{2})[-_.](0[1-9]|1[0-2])(?![-_.\d])/.exec(seg))) {
      const iso = dateStart(`${m[1]}-${m[2]}`);
      if (iso) return iso;
    }
    if ((m = /(?:^|\D)((?:19|20)\d{2})\s*[qQ]([1-4])(?!\d)/.exec(seg))) {
      const iso = dateStart(`${m[1]}Q${m[2]}`);
      if (iso) return iso;
    }
  }
  return null;
}
