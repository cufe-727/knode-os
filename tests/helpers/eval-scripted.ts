import type { LlmClient } from '../../src/llm/client.js';
import type { ChatBackend, ChatRequest } from '../../src/eval/shim.js';

/* The eval suite's stand-ins for Codex and the judge (moved from tests/eval-suite.test.ts so other files can run the harness). */

/** Answers every prompt the systems send, by what the prompt is for. */
export class ScriptedBackend implements ChatBackend {
  readonly label = 'scripted';
  calls = 0;
  /** `delayMs`: each answer-stage call takes this long, as a model's would (measuring answers per minute). */
  constructor(private readonly delayMs = 0) {}
  async complete(req: ChatRequest) {
    this.calls++;
    if (this.delayMs && req.tag?.stage === 'answer') await new Promise((r) => setTimeout(r, this.delayMs));
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const user = req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    let text: string;
    if (system.includes('knowledge-graph extraction engine')) {
      text = JSON.stringify({
        entities: [
          { name: '林晓', type: 'person', description: '数据工程师', aliases: [] },
          { name: '澜舟科技', type: 'organization', description: '林晓的新公司', aliases: ['澜舟'] },
        ],
        relations: [{ source: '林晓', target: '澜舟科技', type: 'works_at', description: '入职' }],
        claims: user.includes('岗位为高级数据工程师')
          ? [{ subject: '林晓', statement: '林晓在澜舟科技的岗位是高级数据工程师', type: 'event', status: 'fact', kind: 'fact' }]
          : [],
      });
    } else if (system.includes('Summarize the document')) {
      text = '林晓的近况。\n\n## Key points\n\n- 林晓将入职澜舟科技';
    } else if (system.includes('You answer questions from a personal knowledge base')) {
      text = '林晓的岗位是高级数据工程师 [1]。\nFinal answer: 高级数据工程师\n{"citations":[1],"gaps":[]}';
    } else if (user.includes('"items":[{"label"')) {
      // a list: two of March's runs, and the left knee with a document that says so
      text = '三月的记录如下。\n{"items":[{"label":"5公里","confidence":0.9,"evidence":["diary/2026-03-04.md"]},{"label":"8公里","confidence":0.8,"evidence":["chat/2026-03-09.md"]},{"label":"左膝","confidence":0.7,"evidence":["diary/2026-03-04.md"]}]}';
    } else if (req.json) {
      text = '{}';
    } else {
      text = '林晓在澜舟科技担任高级数据工程师 [doc: email/2026-03-05.md]。\nFinal answer: 高级数据工程师';
    }
    return { text, usage: { inputTokens: 100, cachedInputTokens: 40, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 0 }, model: 'scripted' };
  }
}

/** A judge that agrees with everything, answering every verdict kind at once. */
export function scriptedJudge(): LlmClient & { calls: number } {
  const judge = {
    calls: 0,
    label: 'scripted-judge',
    model: 'scripted-judge',
    enabled: true,
    async completeJson<T>(messages: { role: string; content: string }[], opts: { onUsage?: (u: unknown) => void } = {}): Promise<T> {
      judge.calls++;
      const items = (JSON.parse(messages.find((m) => m.role === 'user')!.content) as { items: { id: string }[] }).items;
      opts.onUsage?.({ inputTokens: 50, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0 });
      return { verdicts: items.map((i) => ({ id: i.id, score: 2, keypoints: [0], abstained: false, hallucinated: false, present: true, unit: 0, verdict: 'supported', claims: ['林晓将入职澜舟科技'], pairs: [[0, 0]], correct: true, same: false, contradict: false })) } as T;
    },
  };
  return judge as unknown as LlmClient & { calls: number };
}
