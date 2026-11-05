import fs from 'node:fs';
import path from 'node:path';
import { stripMarkers } from './metrics/text.js';
import { loadPack, seededKey } from './pack.js';
import { RunStore } from './runstore.js';
import type { Task } from './types.js';

/**
 * A person checks the judge (docs/design/23 §6): `export` writes a blind CSV
 * of sampled judged answers — no system names, a column for the person's
 * 0/1/2 — and `import` reads it back and reports how often the judge agreed,
 * with Cohen's κ. The id → (system, task) map stays in the run directory.
 */

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function exportAudit(runDir: string, n: number): string {
  const store = new RunStore(runDir);
  const meta = store.meta();
  const packDirs = new Map<string, Task[]>();
  const taskOf = (pack: string, id: string): Task | undefined => {
    if (!packDirs.has(pack)) {
      const dir = (meta?.packs ?? []).map((p) => path.isAbsolute(p) ? p : path.join(path.dirname(runDir), '..', 'packs', p)).find((p) => p.endsWith(pack));
      packDirs.set(pack, dir && fs.existsSync(dir) ? loadPack(dir).tasks : []);
    }
    return packDirs.get(pack)!.find((t) => t.id === id);
  };
  const graded = store.allScores().filter((s) => s.metric === 'correctness' && s.value !== null);
  const sample = [...graded].sort((a, b) => seededKey('audit', a.key).localeCompare(seededKey('audit', b.key))).slice(0, n);
  const answers = new Map(store.allAnswers().map((a) => [`${a.pack}|${a.system}|${a.taskId}`, a]));
  const map: Record<string, { pack: string; system: string; taskId: string; judge: number }> = {};
  const lines = ['id,question,reference,answer,judge_score,human_score'];
  sample.forEach((s, i) => {
    const id = `a${String(i + 1).padStart(3, '0')}`;
    const a = answers.get(`${s.pack}|${s.system}|${s.taskId}`);
    const t = taskOf(s.pack, s.taskId!);
    map[id] = { pack: s.pack, system: s.system, taskId: s.taskId!, judge: Math.round((s.value ?? 0) * 2) };
    lines.push([id, t?.question ?? '', t?.answer ?? (t?.scoring === 'abstain' ? '(not in the sources)' : ''), stripMarkers(a?.text ?? '').slice(0, 2000), Math.round((s.value ?? 0) * 2), ''].map(csvCell).join(','));
  });
  const file = path.join(runDir, 'audit.csv');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  fs.writeFileSync(path.join(runDir, 'audit-map.json'), JSON.stringify(map, null, 2));
  return file;
}

export function importAudit(runDir: string, file: string): { n: number; agreement: number; kappa: number; confusion: number[][] } {
  const rows = parseCsv(fs.readFileSync(file, 'utf8')).slice(1).filter((r) => r.length >= 6 && r[5].trim() !== '');
  const confusion = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const r of rows) {
    const j = Math.max(0, Math.min(2, Number(r[4])));
    const h = Math.max(0, Math.min(2, Number(r[5])));
    if (Number.isInteger(j) && Number.isInteger(h)) confusion[h][j]++;
  }
  const n = confusion.flat().reduce((s, x) => s + x, 0);
  const agree = confusion[0][0] + confusion[1][1] + confusion[2][2];
  const po = n ? agree / n : 0;
  let pe = 0;
  for (let k = 0; k < 3; k++) {
    const rowSum = confusion[k].reduce((s, x) => s + x, 0);
    const colSum = confusion.reduce((s, r) => s + r[k], 0);
    pe += n ? (rowSum / n) * (colSum / n) : 0;
  }
  const result = { n, agreement: po, kappa: pe < 1 ? (po - pe) / (1 - pe) : 1, confusion };
  fs.writeFileSync(path.join(runDir, 'audit-result.json'), JSON.stringify(result, null, 2));
  return result;
}
