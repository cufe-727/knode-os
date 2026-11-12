import fs from 'node:fs';
import path from 'node:path';
import { loadPack, PackIssues, validatePack, writeJsonl, writeManifest } from '../pack.js';
import { CorpusDoc, GoldAlias, GoldFact, GoldLink, PackManifest, SourceRecord, Task, TaskSchema } from '../types.js';

/**
 * Writes a benchmark pack (docs/design/23 §1) for a recipe: documents into
 * corpus/, gold into gold/, tasks into tasks/<suite>.jsonl, and a manifest
 * with counts — then validates what it wrote, so a recipe that produces a
 * quote not in its document fails at build time, not in a run.
 */
export class PackWriter {
  private docs: CorpusDoc[] = [];
  private padding: CorpusDoc[] = [];
  private paddingChars = 0;
  private facts: GoldFact[] = [];
  private links: GoldLink[] = [];
  private aliases: GoldAlias[] = [];
  private tasks: Task[] = [];
  private profile: Record<string, unknown> = {};
  private sources: SourceRecord[] = [];
  private chars = 0;

  constructor(readonly dir: string, private readonly manifest: Omit<PackManifest, 'sources' | 'stats' | 'builder'> & { builder: { recipe: string; options?: Record<string, unknown> } }) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'corpus'), { recursive: true });
  }

  addSource(s: SourceRecord): void {
    this.sources.push(s);
  }

  addDoc(doc: CorpusDoc, text: string): void {
    const file = path.join(this.dir, 'corpus', doc.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    this.docs.push(doc);
    this.chars += text.length;
  }

  hasDoc(p: string): boolean {
    return this.docs.some((d) => d.path === p);
  }

  addFact(f: Omit<GoldFact, 'entities'> & { entities?: string[] }): void {
    this.facts.push({ entities: [], ...f });
  }

  addLink(l: GoldLink): void {
    this.links.push(l);
  }

  addAlias(a: GoldAlias): void {
    this.aliases.push(a);
  }

  addTask(t: Omit<Task, 'evidence'> & { evidence?: Task['evidence'] }): void {
    this.tasks.push(TaskSchema.parse({ evidence: [], ...t }));
  }

  setProfile(p: Record<string, unknown>): void {
    this.profile = { ...this.profile, ...p };
  }

  /** A document that only an update batch adds or changes (updates/<batch>/<path>). */
  addUpdate(batch: string, p: string, text: string): void {
    const file = path.join(this.dir, 'updates', batch, p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }

  /**
   * A document only scale curves stage (`--fraction` above 1, padding/<path>):
   * more of the same kind of source, which must leave every closed-world
   * task's gold as it is (validatePack checks its terms and prefixes).
   */
  addPadding(doc: CorpusDoc, text: string): void {
    const file = path.join(this.dir, 'padding', doc.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    this.padding.push(doc);
    this.paddingChars += text.length;
  }

  get docCount(): number {
    return this.docs.length;
  }

  /** Tasks added so far (a recipe choosing padding reads their closed-world terms). */
  get taskList(): readonly Task[] {
    return this.tasks;
  }

  /** Material no system may see (future events, the rename map, later papers). */
  addHoldout(p: string, text: string): void {
    const file = path.join(this.dir, 'holdout', p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }

  get taskCount(): number {
    return this.tasks.length;
  }

  finish(): PackIssues {
    writeJsonl(path.join(this.dir, 'corpus.jsonl'), this.docs);
    if (this.padding.length) writeJsonl(path.join(this.dir, 'padding.jsonl'), this.padding);
    writeJsonl(path.join(this.dir, 'gold', 'facts.jsonl'), this.facts);
    writeJsonl(path.join(this.dir, 'gold', 'links.jsonl'), this.links);
    writeJsonl(path.join(this.dir, 'gold', 'aliases.jsonl'), this.aliases);
    fs.writeFileSync(path.join(this.dir, 'gold', 'profile.json'), JSON.stringify(this.profile, null, 2) + '\n');
    const bySuite = new Map<string, Task[]>();
    for (const t of this.tasks) (bySuite.get(t.suite) ?? bySuite.set(t.suite, []).get(t.suite)!).push(t);
    for (const [suite, tasks] of bySuite) writeJsonl(path.join(this.dir, 'tasks', `${suite}.jsonl`), tasks);
    writeManifest(this.dir, {
      ...this.manifest,
      builder: { recipe: this.manifest.builder.recipe, options: this.manifest.builder.options ?? {}, builtAt: new Date().toISOString() },
      sources: this.sources,
      stats: { documents: this.docs.length, chars: this.chars, tasks: this.tasks.length, facts: this.facts.length, ...(this.padding.length ? { paddingDocuments: this.padding.length, paddingChars: this.paddingChars } : {}) },
    });
    return validatePack(loadPack(this.dir));
  }
}
