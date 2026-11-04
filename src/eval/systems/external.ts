import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatTag } from '../meter.js';
import { EVAL_HOME, LoadedPack } from '../pack.js';
import { citationsIn } from '../prompts.js';
import type { KnowledgeUnit } from '../types.js';
import { SystemEnv, SystemUnderTest } from './types.js';

/**
 * External knowledge-base systems (Microsoft GraphRAG, LightRAG, HippoRAG 2)
 * behind one JSON-lines protocol (docs/design/23 §3). Each runs in its own
 * virtualenv under `~/knode-eval/venvs/<id>` (`knode-os eval systems
 * install`), through an adapter script in `eval/adapters/` that speaks:
 *
 *   → {"id":1,"op":"build","corpus_dir":…,"work_dir":…,"language":…,"api_key":…}
 *   ← {"id":1,"ok":true,"result":{…}}
 *   ops: build · answer {question, mode, api_key} · retrieve {question, k} · export
 *
 * Its model calls reach the run's shim as an OpenAI endpoint (base URL in
 * OPENAI_BASE_URL, the meter tag as the API key), so it builds and answers
 * with the same model as every other system and is metered the same way.
 */

export const EXTERNAL_SYSTEMS = ['graphrag', 'lightrag', 'hipporag'] as const;
export type ExternalId = (typeof EXTERNAL_SYSTEMS)[number];

/** Packs external systems run on in a pilot (their indexing is the costliest part of a run). */
export const DEFAULT_EXTERNAL_PACKS = ['public-musique', 'synthetic-life-zh', 'law-cn'];

export function externalPacks(): string[] {
  const env = process.env.KNODE_EVAL_EXTERNAL_PACKS;
  return env ? env.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_EXTERNAL_PACKS;
}

export const venvDir = (id: string) => path.join(EVAL_HOME, 'venvs', id);
export const venvPython = (id: string) => path.join(venvDir(id), 'bin', 'python');

export function adaptersDir(): string {
  // dist/eval/systems or src/eval/systems → the repository root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'eval', 'adapters');
}

class AdapterProcess {
  private child: ChildProcess | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stderr = '';

  constructor(private readonly id: ExternalId, private readonly env: NodeJS.ProcessEnv, private readonly log: (m: string) => void) {}

  private start(): ChildProcess {
    if (this.child && this.child.exitCode === null) return this.child;
    const python = venvPython(this.id);
    if (!fs.existsSync(python)) throw new Error(`${this.id} is not installed — run \`knode-os eval systems install ${this.id}\``);
    const child = spawn(python, [path.join(adaptersDir(), `${this.id}.py`)], { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout!.on('data', (d: Buffer) => {
      this.buffer += d.toString('utf8');
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let msg: { id?: number; ok?: boolean; result?: unknown; error?: string; log?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.log) {
          this.log(`${this.id}: ${msg.log}`);
          continue;
        }
        const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
        if (!p) continue;
        clearTimeout(p.timer);
        this.pending.delete(msg.id!);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(`${this.id}: ${msg.error ?? 'adapter error'}`));
      }
    });
    child.stderr!.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString('utf8')).slice(-8000);
    });
    child.on('exit', (code) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`${this.id} adapter exited (${code}): ${this.stderr.slice(-600)}`));
      }
      this.pending.clear();
    });
    this.child = child;
    return child;
  }

  call<T>(op: string, payload: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const child = this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.id} ${op} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      child.stdin!.write(JSON.stringify({ id, op, ...payload }) + '\n');
    });
  }

  close(): void {
    this.child?.stdin?.end();
    this.child?.kill('SIGTERM');
    this.child = null;
  }
}

const processes = new Map<string, AdapterProcess>();

function adapter(id: ExternalId, env: SystemEnv): AdapterProcess {
  const key = `${id}|${env.pack.manifest.id}`;
  let p = processes.get(key);
  if (!p) {
    p = new AdapterProcess(id, {
      ...process.env,
      OPENAI_BASE_URL: env.shim.baseUrl,
      OPENAI_API_BASE: env.shim.baseUrl,
      OPENAI_API_KEY: formatTag({ system: id, stage: 'build' }),
      TIKTOKEN_CACHE_DIR: path.join(venvDir(id), 'tiktoken'),
      PYTHONUNBUFFERED: '1',
    }, env.log);
    processes.set(key, p);
  }
  return p;
}

function languageOf(pack: LoadedPack): string {
  return pack.manifest.languages[0] === 'zh' ? 'Chinese' : 'English';
}

export function externalSystem(id: ExternalId): SystemUnderTest {
  const labels: Record<ExternalId, string> = { graphrag: 'Microsoft GraphRAG', lightrag: 'LightRAG', hipporag: 'HippoRAG 2' };
  return {
    id,
    label: labels[id],
    group: id,
    kind: 'kb',
    answers: true,
    applicable: (pack) => externalPacks().includes(pack.manifest.id),
    async build(env) {
      const work = path.join(env.workDir, 'index');
      fs.rmSync(work, { recursive: true, force: true });
      fs.mkdirSync(work, { recursive: true });
      const notes = await adapter(id, env).call<Record<string, unknown>>('build', {
        corpus_dir: env.staged.dir,
        work_dir: work,
        language: languageOf(env.pack),
        api_key: formatTag({ system: id, stage: 'build' }),
        embedding_dim: env.shim.embedder?.dimensions ?? 1024,
      }, 7 * 24 * 3600_000);
      return { kbDir: work, notes };
    },
    async reopen(env) {
      const work = path.join(env.workDir, 'index');
      if (!fs.existsSync(work)) throw new Error(`no ${id} index to reopen at ${work}`);
      await adapter(id, env).call('open', { work_dir: work, corpus_dir: env.staged.dir, language: languageOf(env.pack), embedding_dim: env.shim.embedder?.dimensions ?? 1024 }, 30 * 60_000);
    },
    async answer(task, prompt, env) {
      await env.quota.wait();
      const r = await adapter(id, env).call<{ text: string; contexts?: { doc?: string }[] }>('answer', {
        question: prompt,
        mode: task.type === 'global' || task.suite === 'emergence' ? 'global' : 'local',
        api_key: formatTag({ system: id, stage: 'answer', task: task.id }),
        work_dir: path.join(env.workDir, 'index'),
      }, 60 * 60_000);
      const docs = new Set(env.staged.docs.map((d) => d.path));
      const retrieved = [...new Set((r.contexts ?? []).map((c) => c.doc).filter((d): d is string => Boolean(d && docs.has(d))))];
      return { text: r.text, citations: citationsIn(r.text, docs), retrieved };
    },
    async retrieve(query, k, env) {
      const r = await adapter(id, env).call<{ docs: string[] }>('retrieve', { question: query, k, work_dir: path.join(env.workDir, 'index'), api_key: formatTag({ system: id, stage: 'retrieve' }) }, 30 * 60_000);
      return r.docs.slice(0, k);
    },
    async exportKnowledge(env) {
      const r = await adapter(id, env).call<{ units: KnowledgeUnit[] }>('export', { work_dir: path.join(env.workDir, 'index'), corpus_dir: env.staged.dir }, 60 * 60_000);
      return r.units;
    },
    async release() {
      for (const [key, p] of processes) {
        if (key.startsWith(`${id}|`)) {
          p.close();
          processes.delete(key);
        }
      }
    },
  };
}
