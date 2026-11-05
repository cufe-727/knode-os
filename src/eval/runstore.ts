import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AnswerRecord, BuildRecord, ScoreRecord } from './types.js';

/**
 * A run's records on disk (`~/knode-eval/runs/<stamp>/`): append-only JSONL,
 * one line per build, answer and score, each under a key made from what it
 * depends on. A resumed run reads the files back and skips every key it
 * already has — an interrupted pilot picks up at the next unanswered task,
 * not at the start.
 */

export function recordKey(...parts: (string | number | undefined | null)[]): string {
  return crypto.createHash('sha1').update(parts.map((p) => String(p ?? '')).join('␟')).digest('hex').slice(0, 20);
}

export interface RunMeta {
  id: string;
  createdAt: string;
  gitSha: string | null;
  knodeVersion: string;
  packs: string[];
  systems: string[];
  suites: string[];
  model: { connection: string; label: string; buildEffort: string; answerEffort: string };
  judge: { connection: string; label: string };
  embedding: string;
  fraction: number;
  seed: string | number;
  limit: number | null;
  versions: Record<string, string>;
  notes?: string;
}

export class RunStore {
  readonly dir: string;
  private builds = new Map<string, BuildRecord>();
  private answers = new Map<string, AnswerRecord>();
  private scores = new Map<string, ScoreRecord>();

  constructor(dir: string) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true });
    for (const r of this.readAll<BuildRecord>('builds.jsonl')) this.builds.set(r.key, r);
    for (const r of this.readAll<AnswerRecord>('answers.jsonl')) this.answers.set(r.key, r);
    for (const r of this.readAll<ScoreRecord>('scores.jsonl')) this.scores.set(r.key, r);
  }

  private readAll<T>(name: string): T[] {
    const file = path.join(this.dir, name);
    if (!fs.existsSync(file)) return [];
    const out: T[] = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      // a line cut by a crash mid-write is the only record that can be lost
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        /* skip */
      }
    }
    return out;
  }

  private append(name: string, rec: unknown): void {
    fs.appendFileSync(path.join(this.dir, name), JSON.stringify(rec) + '\n');
  }

  writeMeta(meta: RunMeta): void {
    fs.writeFileSync(path.join(this.dir, 'run.json'), JSON.stringify(meta, null, 2) + '\n');
  }

  meta(): RunMeta | null {
    const file = path.join(this.dir, 'run.json');
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as RunMeta) : null;
  }

  build(key: string): BuildRecord | undefined {
    return this.builds.get(key);
  }

  putBuild(rec: BuildRecord): void {
    this.builds.set(rec.key, rec);
    this.append('builds.jsonl', rec);
  }

  answer(key: string): AnswerRecord | undefined {
    return this.answers.get(key);
  }

  putAnswer(rec: AnswerRecord): void {
    this.answers.set(rec.key, rec);
    this.append('answers.jsonl', rec);
  }

  score(key: string): ScoreRecord | undefined {
    return this.scores.get(key);
  }

  putScore(rec: ScoreRecord): void {
    this.scores.set(rec.key, rec);
    this.append('scores.jsonl', rec);
  }

  allBuilds(): BuildRecord[] {
    return [...this.builds.values()];
  }

  allAnswers(): AnswerRecord[] {
    return [...this.answers.values()];
  }

  allScores(): ScoreRecord[] {
    return [...this.scores.values()];
  }

  /** A line of the run's own log, for what happened between records (pauses, skips, failures). */
  log(event: string, detail: Record<string, unknown> = {}): void {
    this.append('events.jsonl', { at: new Date().toISOString(), event, ...detail });
  }

  /** A per-system working directory under the run (a knode workspace, a wiki, a venv's index). */
  workDir(...parts: string[]): string {
    const dir = path.join(this.dir, 'work', ...parts);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  cacheDir(): string {
    const dir = path.join(this.dir, 'cache');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}
