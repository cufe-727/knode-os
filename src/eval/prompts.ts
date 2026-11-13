import { extractFinalAnswer, jsonIn } from './metrics/text.js';
import { Citation, Task } from './types.js';

/**
 * The words every system answers under (docs/design/23 §3). One prompt for
 * all of them: the same output rules, the same `Final answer:` line, the
 * same JSON for emergence probes — so what differs between systems is the
 * knowledge they bring, not the instructions they were given.
 */

const OUTPUT_RULES = `Rules:
- Answer in the language of the question.
- Use only what the knowledge available to you supports. If it does not contain the answer, say so plainly instead of guessing.
- Cite the source documents you relied on as [doc: <path>], using their paths.
- End with one line: "Final answer: <the short answer>" (for an explanation or a list, one sentence that states it).`;

const SET_RULES = `Rules:
- Base every item on the available knowledge and cite the documents behind it.
- End with a JSON object on its own lines: {"items":[{"label":"<item>","confidence":<0-1>,"evidence":["<path>", …]}, …]} — at most 10 items, most important first.`;

const LABEL_RULES = (choices?: string[]) => `Rules:
- Base the answer on the available knowledge and cite the documents behind it.
- End with a JSON object on its own lines: {"label":"<answer>","confidence":<0-1>,"evidence":["<path>", …]}${choices?.length ? ` where label is one of: ${choices.map((c) => JSON.stringify(c)).join(', ')}` : ''}.`;

/**
 * Rules for a corpus-level list (aggregate, timeline, contradiction, profile):
 * every item it should hold, not the top few, in the same JSON as a set probe.
 */
const LIST_RULES = (task: Task) => {
  const n = task.list?.maxItems ?? 10;
  const what = {
    aggregate: 'one item per thing asked for — list every one the documents support, not a sample',
    timeline: 'one item per change or state, in chronological order, each with its date ("date": "YYYY-MM-DD", or YYYY-MM when only the month is known)',
    contradiction: 'one item per side of each disagreement: what that side says, with the documents that say it as its evidence',
    profile: 'one item per distinct fact the documents state — cover all of them, not a summary',
    structured: 'one item per group the question asks for (a team, a quarter, a person, a week), each label naming the group and its exact figure — every group, nothing else',
    connection: 'one item per other thing that is the same, by its ID or name — every one the documents support',
    lookalike: 'one item per thing asked for, by its ID or name — only those of the entity the question names',
  }[task.type as 'aggregate' | 'timeline' | 'contradiction' | 'profile' | 'structured' | 'connection' | 'lookalike'] ?? 'one item per thing asked for';
  const shape = task.list?.ordered
    ? '{"items":[{"label":"<item>","date":"YYYY-MM-DD","confidence":<0-1>,"evidence":["<path>", …]}, …]}'
    : '{"items":[{"label":"<item>","confidence":<0-1>,"evidence":["<path>", …]}, …]}';
  return `Rules:
- Base every item on the available knowledge and cite the documents behind it by their paths.
- Items: ${what}. Keep each label short and specific (names, numbers and dates as the documents give them).
- End with a JSON object on its own lines: ${shape} — at most ${n} items.`;
};

/** The task as a system sees it: question, the as-of date when there is one, and the output rules for its scoring. */
export function taskPrompt(task: Task): string {
  const asOf = task.asOf ? `\n(Answer as of ${task.asOf}.)` : '';
  if (task.scoring === 'set' && task.list) return `${task.question}${asOf}\n\n${LIST_RULES(task)}`;
  if (task.scoring === 'set') return `${task.question}${asOf}\n\n${SET_RULES}`;
  if (task.scoring === 'label' || task.scoring === 'choice') return `${task.question}${asOf}\n\n${LABEL_RULES(task.choices)}`;
  return `${task.question}${asOf}\n\n${OUTPUT_RULES}`;
}

/**
 * Document paths an answer cites, kept only when they name a corpus document,
 * or one `resolve` finds for a name that is not a corpus path.
 */
export function citationsIn(text: string, docs: Set<string>, resolve?: (cited: string) => string | undefined): Citation[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    const p = raw.trim().replace(/^\.\//, '').replace(/^(?:raw\/docs|raw|corpus)\//, '').replace(/[)\].,;:，。]+$/, '');
    const doc = docs.has(p) ? p : resolve?.(p);
    if (doc) out.add(doc);
  };
  for (const m of text.matchAll(/\[doc:\s*([^\]]+)\]/gi)) m[1].split(/[,;，]/).forEach(add);
  // a bare path the system wrote without the bracket form
  for (const m of text.matchAll(/(?:^|[\s(（\["'`])((?:raw\/docs\/|raw\/|corpus\/)?[\w\-./一-鿿]+\.(?:md|txt|markdown))/gu)) add(m[1]);
  for (const ev of (jsonIn(text)?.evidence as unknown[] | undefined) ?? []) if (typeof ev === 'string') add(ev);
  return [...out].map((doc) => ({ doc }));
}

export interface ParsedItems {
  items: { label: string; confidence: number | null; evidence: string[]; date?: string }[];
  label: string | null;
  confidence: number | null;
}

/** The JSON a set / label / choice task asks for, read leniently. */
export function parseStructured(text: string): ParsedItems {
  const json = jsonIn(text) ?? {};
  const conf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
  const rawItems = Array.isArray(json.items) ? (json.items as unknown[]) : [];
  return {
    items: rawItems
      .map((it) => (typeof it === 'string' ? { label: it } : (it as Record<string, unknown>)))
      .filter((it) => typeof it.label === 'string' && it.label.trim())
      .map((it) => ({
        label: String(it.label).trim(), confidence: conf(it.confidence), evidence: Array.isArray(it.evidence) ? it.evidence.map(String) : [],
        ...(typeof it.date === 'string' && it.date.trim() ? { date: it.date.trim() } : {}),
      })),
    label: typeof json.label === 'string' ? json.label.trim() : typeof json.choice === 'string' ? json.choice.trim() : null,
    confidence: conf(json.confidence),
  };
}

export { extractFinalAnswer };
