import fs from 'node:fs';
import path from 'node:path';

/** Shared helpers for the bench suite (reports live under <data>/eval/). */

export const EVAL_DIR = 'eval';
export const REPORTS_DIR = 'eval/reports';
export const QA_FILE = 'eval/qa.jsonl';

/** A generated QA pair grounded in one chunk — the retrieval/answer ground truth. */
export interface QaItem {
  id: string;
  question: string;
  answer: string;
  chunkId: string;
  documentId: string;
  path: string;
  platform: string;
}

export function ensureEvalDirs(dataDir: string): void {
  fs.mkdirSync(path.join(dataDir, REPORTS_DIR), { recursive: true });
}

export function writeReport(dataDir: string, name: string, json: unknown, markdown: string): { jsonPath: string; mdPath: string } {
  ensureEvalDirs(dataDir);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const base = path.join(dataDir, REPORTS_DIR, `${name}-${stamp}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(json, null, 2) + '\n');
  fs.writeFileSync(`${base}.md`, markdown);
  return { jsonPath: `${base}.json`, mdPath: `${base}.md` };
}

export function loadQaSet(dataDir: string): QaItem[] {
  const file = path.join(dataDir, QA_FILE);
  if (!fs.existsSync(file)) throw new Error(`QA set not found at ${file} — run \`knode-os bench qa-gen\` first`);
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as QaItem);
}

export function saveQaSet(dataDir: string, items: QaItem[]): string {
  ensureEvalDirs(dataDir);
  const file = path.join(dataDir, QA_FILE);
  fs.writeFileSync(file, items.map((i) => JSON.stringify(i)).join('\n') + '\n');
  return file;
}

/** Map with bounded concurrency, preserving input order. Failed items yield undefined. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onError?: (err: unknown, item: T, index: number) => void,
): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        onError?.(err, items[i], i);
        out[i] = undefined;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function summarizeLatency(ms: number[]): { avg: number; p50: number; p95: number } {
  if (ms.length === 0) return { avg: 0, p50: 0, p95: 0 };
  const sorted = [...ms].sort((a, b) => a - b);
  return {
    avg: Math.round(ms.reduce((s, x) => s + x, 0) / ms.length),
    p50: Math.round(percentile(sorted, 50)),
    p95: Math.round(percentile(sorted, 95)),
  };
}

/** Platform from an imported finance doc path, or the top-level root otherwise. */
export function platformOfPath(p: string): string {
  const m = /^(?:cooked|raw)\/docs\/finance\/([^/]+)\//.exec(p);
  return m ? m[1] : p.split('/')[0];
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function mdTable(headers: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}
