import fs from 'node:fs';
import path from 'node:path';
import { weightedTokens } from '../estimate/codex.js';
import { costOf, priceOf } from '../estimate/services.js';
import type { CallUsage } from '../llm/usage.js';
import { emptyUsage, Usage } from './types.js';

/**
 * One meter for every system (docs/design/23 §4). Each model call — through
 * the shim, a Codex agent session, or the judge — lands here as an event
 * tagged with the system, the stage and, for an answer, the task. A build's
 * cost is the sum of its system's events between two marks; an answer's is
 * the sum of its task's events. Events are appended to `meter.jsonl`, so
 * the cost of a run survives a restart.
 */

export interface MeterTag {
  system: string;
  stage: string;
  task?: string;
}

export interface MeterEvent extends MeterTag {
  at: string;
  model: string;
  ms: number;
  ok: boolean;
  /** Answered from the response cache: the usage is the original call's. */
  replayed: boolean;
  usage: CallUsage | null;
  embeddingTokens?: number;
  embeddingCalls?: number;
}

/** Parse a shim tag carried as the bearer token: `sys=<system>;stage=<stage>;task=<task>`. */
export function parseTag(raw: string | undefined | null, fallbackStage = 'call'): MeterTag {
  const out: MeterTag = { system: 'unknown', stage: fallbackStage };
  for (const part of (raw ?? '').split(';')) {
    const [k, ...rest] = part.split('=');
    const v = rest.join('=').trim();
    if (!v) continue;
    if (k.trim() === 'sys') out.system = v;
    else if (k.trim() === 'stage') out.stage = v;
    else if (k.trim() === 'task') out.task = v;
  }
  return out;
}

export function formatTag(tag: MeterTag): string {
  return [`sys=${tag.system}`, `stage=${tag.stage}`, ...(tag.task ? [`task=${tag.task}`] : [])].join(';');
}

export class Meter {
  private events: MeterEvent[] = [];
  private readonly file: string | null;

  constructor(file?: string) {
    this.file = file ?? null;
    if (this.file && fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.events.push(JSON.parse(line) as MeterEvent);
        } catch {
          /* a torn last line */
        }
      }
    }
    if (this.file) fs.mkdirSync(path.dirname(this.file), { recursive: true });
  }

  record(ev: Omit<MeterEvent, 'at'>): void {
    const full: MeterEvent = { at: new Date().toISOString(), ...ev };
    this.events.push(full);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(full) + '\n');
  }

  /** A position in the event log; `since(mark)` reads what came after. */
  mark(): number {
    return this.events.length;
  }

  since(mark: number, filter: (ev: MeterEvent) => boolean = () => true): MeterEvent[] {
    return this.events.slice(mark).filter(filter);
  }

  all(filter: (ev: MeterEvent) => boolean = () => true): MeterEvent[] {
    return this.events.filter(filter);
  }

  usage(filter: (ev: MeterEvent) => boolean, mark = 0): Usage {
    return sumEvents(this.since(mark, filter));
  }

  /** Usage per stage of one system since a mark. */
  stages(system: string, mark = 0): Record<string, Usage> {
    const out: Record<string, Usage> = {};
    for (const ev of this.since(mark, (e) => e.system === system)) {
      out[ev.stage] = sumEvents([ev], out[ev.stage]);
    }
    return out;
  }
}

export function sumEvents(events: MeterEvent[], into: Usage = emptyUsage()): Usage {
  for (const ev of events) {
    if (ev.embeddingCalls || ev.embeddingTokens) {
      into.embeddingCalls += ev.embeddingCalls ?? 0;
      into.embeddingTokens += ev.embeddingTokens ?? 0;
      into.llmMs += ev.ms;
      continue;
    }
    into.calls++;
    if (!ev.ok) into.failedCalls++;
    if (ev.replayed) into.replayedCalls++;
    into.llmMs += ev.ms;
    const u = ev.usage;
    if (!u) continue;
    into.inputTokens += u.inputTokens;
    into.cachedInputTokens += u.cachedInputTokens;
    into.outputTokens += u.outputTokens;
    into.reasoningTokens += u.reasoningTokens;
    into.weightedTokens += weightedTokens({
      input: u.inputTokens, cached: u.cachedInputTokens, cacheWrite: u.cacheWriteTokens, output: u.outputTokens, reasoning: u.reasoningTokens,
    });
    into.costUsd += u.costUsd ?? priceUsage(ev.model, u);
  }
  return into;
}

/** USD at the model's published price, 0 when it has none (Codex plan models are reported in weighted tokens). */
export function priceUsage(model: string, u: CallUsage): number {
  const p = priceOf(model.replace(/@.*$/, ''));
  return p ? costOf(p.price, { input: u.inputTokens, cached: u.cachedInputTokens, cacheWrite: u.cacheWriteTokens, output: u.outputTokens }) : 0;
}
