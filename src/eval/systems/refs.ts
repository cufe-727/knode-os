import fs from 'node:fs';
import path from 'node:path';
import type { LoadedPack } from '../pack.js';
import { chat, SystemUnderTest } from './types.js';

/**
 * Reference points, not knowledge bases: what the model answers from memory
 * alone (contamination — a pack whose questions it answers closed-book
 * measures nothing), and with the whole corpus in its prompt (the ceiling a
 * knowledge base has to justify its build cost against).
 */

/** Characters of corpus a long-context prompt may hold (≈ 150k tokens of mixed Chinese and English). */
export const LONG_CONTEXT_CHARS = 360_000;

export function closedBook(): SystemUnderTest {
  return {
    id: 'closed-book',
    label: 'Closed book (model only)',
    group: 'closed-book',
    kind: 'reference',
    answers: true,
    async answer(task, prompt, env) {
      const text = await chat(env, { system: 'closed-book', stage: 'answer', task: task.id }, [
        { role: 'system', content: 'You answer from your own knowledge. No documents are available to you, so do not cite any.' },
        { role: 'user', content: prompt },
      ]);
      return { text };
    },
  };
}

function corpusChars(pack: LoadedPack): number {
  return pack.docs.reduce((s, d) => {
    try {
      return s + fs.statSync(path.join(pack.dir, 'corpus', d.path)).size;
    } catch {
      return s;
    }
  }, 0);
}

export function longContext(limit = LONG_CONTEXT_CHARS): SystemUnderTest {
  let context = '';
  return {
    id: 'long-context',
    label: 'Long context (whole corpus in the prompt)',
    group: 'long-context',
    kind: 'reference',
    answers: true,
    // file bytes over-count Chinese characters three to one: a conservative test
    applicable: (pack) => corpusChars(pack) <= limit * 1.5,
    async build(env) {
      const parts: string[] = [];
      for (const d of env.staged.docs) parts.push(`<document path="${d.path}">\n${fs.readFileSync(path.join(env.staged.dir, d.path), 'utf8')}\n</document>`);
      context = parts.join('\n\n').slice(0, limit);
      return { notes: { contextChars: context.length } };
    },
    async reopen(env) {
      await this.build!(env);
    },
    async answer(task, prompt, env) {
      const text = await chat(env, { system: 'long-context', stage: 'answer', task: task.id }, [
        { role: 'system', content: `You answer questions about the document collection below.\n\n${context}` },
        { role: 'user', content: prompt },
      ]);
      return { text };
    },
  };
}
