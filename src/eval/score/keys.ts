import { recordKey } from '../runstore.js';
import type { AnswerRecord } from '../types.js';

/**
 * Keys of what scoring writes for one answer. A run that repeats its answers
 * (`eval run --repeat`) puts the repeat index on the answer record; a repeat
 * other than the first gets keys (and judge items) of its own, and the first
 * keeps the keys runs had before repeats existed.
 */

/** The answer's repeat index, or undefined for the first answer (or a run without repeats). */
export function repeatOf(a: Pick<AnswerRecord, 'repeat'>): number | undefined {
  return typeof a.repeat === 'number' && a.repeat !== 0 ? a.repeat : undefined;
}

/** The key of one score of one answer. */
export function scoreKey(a: Pick<AnswerRecord, 'pack' | 'system' | 'taskId' | 'repeat'>, metric: string): string {
  const r = repeatOf(a);
  return r === undefined ? recordKey('score', a.pack, a.system, a.taskId, metric) : recordKey('score', a.pack, a.system, a.taskId, metric, `r${r}`);
}

/** The id of one judge item about one answer (`kind`: grade, list, match). */
export function judgeItemKey(kind: string, a: Pick<AnswerRecord, 'pack' | 'system' | 'taskId' | 'repeat'>): string {
  const r = repeatOf(a);
  return r === undefined ? recordKey(kind, a.pack, a.system, a.taskId) : recordKey(kind, a.pack, a.system, a.taskId, `r${r}`);
}
