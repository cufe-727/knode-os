#!/usr/bin/env node
// codex stand-in for the eval suite's agent sessions: reads the prompt on stdin,
// prints `codex exec --json` events, writes the last message where --output-last-message says.
// An ingest prompt (llm-wiki build) writes a page per source into wiki/; anything else answers.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = arg('--output-last-message');
const cwd = arg('--cd') ?? process.cwd();
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  const emit = (e) => process.stdout.write(JSON.stringify(e) + '\n');
  emit({ type: 'thread.started', thread_id: 'fake-thread' });
  emit({ type: 'item.started', item: { type: 'command_execution', command: 'rg -n 林晓 .' } });
  let answer;
  const ingest = /Ingest these new sources into the wiki now: (.+)\./.exec(prompt);
  if (ingest) {
    const files = ingest[1].split(',').map((s) => s.trim().replace(/^raw\//, ''));
    const index = path.join(cwd, 'wiki', 'index.md');
    for (const f of files) {
      const name = f.replace(/[/.]/g, '-');
      const text = fs.readFileSync(path.join(cwd, 'raw', f), 'utf8');
      fs.mkdirSync(path.join(cwd, 'wiki', 'sources'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'wiki', 'sources', `${name}.md`), `# ${f}\n\n${text.split('\n').slice(2, 6).join('\n')} (raw/${f})\n\nSee [[林晓]].\n`);
      fs.appendFileSync(index, `- [[${name}]] — ${f}\n`);
    }
    fs.mkdirSync(path.join(cwd, 'wiki', 'entities'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'wiki', 'entities', '林晓.md'), '# 林晓\n\n林晓将入职澜舟科技，岗位为高级数据工程师 (raw/email/2026-03-05.md)。\n');
    answer = `updated ${files.length} source pages`;
  } else {
    answer = '林晓在澜舟科技担任高级数据工程师 [doc: email/2026-03-05.md]。\nFinal answer: 高级数据工程师';
  }
  emit({ type: 'item.completed', item: { type: 'agent_message', text: answer } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 60, reasoning_output_tokens: 10 } });
  if (out) fs.writeFileSync(out, answer);
});
