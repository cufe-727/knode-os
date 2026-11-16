import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EVAL_HOME, loadPack, seededKey, type PackIssues } from '../pack.js';
import type { SourceRecord, Task } from '../types.js';
import type { RecipeContext } from './index.js';
import { writeMeasure } from './measure.js';
import type { PackWriter } from './writer.js';

/**
 * Shared ground of the real-document recipes (docs/design/33 §4): packs
 * built from public datasets that were downloaded beforehand into
 * `~/knode-eval/downloads/<name>/` (each with its SHA256SUMS and SOURCE.md),
 * so a build reads local files only and never fetches. Every task's gold
 * comes from the dataset; none is drafted by a model.
 *
 * Conventions every such recipe keeps:
 * - documents sit at opaque paths (`<kind>/<hash>.md`) whose names say
 *   nothing about their content, so no answer can be read from a file name;
 *   the title is the document's first line instead;
 * - one shared corpus holds every question's documents, so retrieval is over
 *   everything, and the sampled pack (`questions: 300`) keeps the whole corpus;
 * - `meta` keeps the dataset's own question type and id, `meta.hops`,
 *   `meta.stratum` (what the sample is stratified by) and `meta.family`
 *   (the question family of design 33 §3 it belongs to);
 * - after the writer validates, the pack is measured (`measure.json`).
 */

export const downloadsDir = () => path.join(EVAL_HOME, 'downloads');

/** The question families of design 33 §3. */
export type Family = 'aggregates' | 'current-state' | 'renames-aliases' | 'hops' | 'timelines' | 'lookalikes-unanswerables' | 'controls';

/** Where a recipe's download lies: `options.from`, else `~/knode-eval/downloads/<name>`. */
export function sourceDir(ctx: RecipeContext, name: string): string {
  const dir = path.resolve(String(ctx.options.from ?? path.join(downloadsDir(), name)));
  if (!fs.existsSync(dir)) throw new Error(`no download at ${dir}: fetch the dataset first (its SOURCE.md says how), or pass {"from": "<dir>"}`);
  return dir;
}

/**
 * The source record of a downloaded file: url, sha256 and size from the
 * folder's SHA256SUMS (`<sha256>  <name>  <bytes>  <url>`), else hashed here.
 */
export function localRecord(dir: string, rel: string, license: string, note?: string): SourceRecord {
  const sums = path.join(dir, 'SHA256SUMS');
  if (fs.existsSync(sums)) {
    for (const line of fs.readFileSync(sums, 'utf8').split('\n')) {
      const [sha256, name, bytes, url] = line.split(/ {2}/);
      if (name === rel && sha256) return { url, license, sha256, bytes: Number(bytes), ...(note ? { note } : {}) };
    }
  }
  const file = path.join(dir, rel);
  if (!fs.existsSync(file)) return { url: `file://${file}`, license, note: `${note ? `${note}; ` : ''}not present in this download` };
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return { url: `file://${file}`, license, sha256, bytes: fs.statSync(file).size, ...(note ? { note } : {}) };
}

export const shortHash = (...parts: string[]) => crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);

/** An opaque corpus path: the folder names the kind of document, the name is a hash of its key. */
export const opaquePath = (folder: string, key: string, ext = '.md') => `${folder}/${shortHash(key)}${ext}`;

/** Tasks in a seeded round-robin over `meta.stratum`, cut to `n`: every stratum is drawn once before any is drawn twice. */
export function sampleByStratum(tasks: Task[], n: number, seed: string | number): Task[] {
  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    const s = String(t.meta?.stratum ?? t.type);
    (groups.get(s) ?? groups.set(s, []).get(s)!).push(t);
  }
  const lists = [...groups.entries()]
    .sort((a, b) => seededKey(seed, a[0]).localeCompare(seededKey(seed, b[0])))
    .map(([, l]) => l.sort((a, b) => seededKey(seed, a.id).localeCompare(seededKey(seed, b.id))));
  const out: Task[] = [];
  for (let round = 0; out.length < Math.min(n, tasks.length); round++) for (const l of lists) if (round < l.length && out.length < n) out.push(l[round]);
  // keep the dataset's order in the pack, the sample is only a choice
  const keep = new Set(out.map((t) => t.id));
  return tasks.filter((t) => keep.has(t.id));
}

/** `questions` as a recipe option: a number, or everything. */
export function questionCount(ctx: RecipeContext): number | undefined {
  const q = ctx.options.questions;
  if (q === undefined || q === 'all' || q === null) return undefined;
  const n = Number(q);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`questions: a positive whole number or "all" (got ${String(q)})`);
  return n;
}

/** The pack id: the base for the full set, `<base>-<n>` for a sample. */
export const packIdFor = (base: string, n: number | undefined, total: number) => (n && n < total ? `${base}-${n}` : base);

/** Adds the tasks (sampled when asked), validates, and writes the pack's measurement. */
export function finishRealPack(writer: PackWriter, tasks: Task[], ctx: RecipeContext): PackIssues {
  for (const t of tasks) writer.addTask(t);
  const issues = writer.finish();
  const m = writeMeasure(loadPack(writer.dir));
  ctx.log(`measured: ${m.documents} documents, ${(m.chars / 1e6).toFixed(1)}M characters, median document ${m.docChars.p50} characters; ` +
    `a gold document holds a question term in ${m.literalTerm}, one found in ≤10 documents in ${m.selectiveTerm['<=10docs']}; single-document ${m.singleDocument}`);
  if (m.lint.answerInFileName.length) issues.errors.push(`${m.lint.answerInFileName.length} tasks have an answer in a file name: ${m.lint.answerInFileName.slice(0, 5).join(', ')}`);
  if (m.lint.duplicateQuestionDifferentGold.length) issues.errors.push(`${m.lint.duplicateQuestionDifferentGold.length} questions are asked twice with different gold: ${m.lint.duplicateQuestionDifferentGold.slice(0, 3).map((g) => g.join(' / ')).join('; ')}`);
  return issues;
}

/** A number as the dataset writes it, without thousands separators or a currency sign ("-$0.04" → "-0.04"); null when it is not one. */
export function plainNumber(s: string): string | null {
  const t = s.normalize('NFKC').trim().replace(/^\((.*)\)$/, '-$1');
  const m = t.match(/^(-?)\s*[$¥€£]?\s*(-?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(%|元|美元)?$/);
  if (!m) return null;
  const sign = m[1] || m[2] ? '-' : '';
  return `${sign}${m[3].replace(/,/g, '')}${m[4] ?? ''}`;
}

/** One unit of a number's last written digit with value scoring's slack (1.01 for a whole number, 0.0101 for two decimals). */
export function roundingTolerance(plain: string): number {
  const decimals = plain.split('.')[1]?.length ?? 0;
  return Number((1.01 * 10 ** -decimals).toFixed(decimals + 4));
}
