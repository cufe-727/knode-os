import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RESEARCH_DIR } from '../src/fs/layout.js';
import { initDataDir } from '../src/fs/datadir.js';
import { ensureDefaultResearchTemplates, loadResearchTemplates, parseResearchTemplate, renderOutputPath, researchSlug, subjectOf, templateFor } from '../src/research/templates.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-research-templates-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('research templates', () => {
  it('seeds the protocol and one template per kind on init, never overwriting edits', () => {
    const dataDir = path.join(tmp, 'ws');
    initDataDir(dataDir);
    const dir = path.join(dataDir, RESEARCH_DIR);
    expect(fs.existsSync(path.join(dir, 'AGENTS.md'))).toBe(true);
    const all = loadResearchTemplates(dataDir);
    expect([...all.keys()].sort()).toEqual(['comparison', 'concept', 'entity', 'init', 'question', 'refresh', 'timeline', 'verify']);
    expect(fs.existsSync(path.join(dir, 'phases', 'plan.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'phases', 'init-plan.md'))).toBe(true);
    const init = all.get('init')!;
    expect(init.output).toBe('wiki/overview.md');
    expect(init.companions).toEqual([{ path: 'AGENTS.md', sections: expect.arrayContaining(['## 如何查询', '## 人工备注']) }]);
    expect(init.phases).toEqual({ plan: 'phases/init-plan.md', research: 'phases/init-research.md', synthesize: 'phases/init-synthesize.md' });
    expect(renderOutputPath(init, { kind: 'init', target: null, query: null })).toBe('wiki/overview.md');
    fs.writeFileSync(path.join(dir, 'entity.md'), fs.readFileSync(path.join(dir, 'entity.md'), 'utf8').replace('maxTurns: 40', 'maxTurns: 12'));
    expect(ensureDefaultResearchTemplates(dataDir)).toEqual([]);
    expect(templateFor(dataDir, 'entity').maxTurns).toBe(12);
    expect(templateFor(dataDir, 'entity').requires.sections).toContain('## 时间线');
  });

  it('renders output paths per kind and parses custom templates', () => {
    const entity = parseResearchTemplate('---\ntype: research-template\nkind: entity\noutput: wiki/entities/{slug}.md\n---\nbody', 'entity', 'x')!;
    expect(renderOutputPath(entity, { kind: 'entity', target: '宁德时代', query: null })).toBe('wiki/entities/宁德时代.md');
    const question = parseResearchTemplate('---\ntype: research-template\nkind: question\noutput: wiki/questions/{slug}.md\n---\nbody', 'question', 'x')!;
    expect(renderOutputPath(question, { kind: 'question', target: null, query: '宁德时代的上游供应商有哪些？' })).toBe('wiki/questions/宁德时代的上游供应商有哪些.md');
    const refresh = parseResearchTemplate('---\ntype: research-template\nkind: refresh\noutput: ""\n---\nbody', 'refresh', 'x')!;
    expect(renderOutputPath(refresh, { kind: 'refresh', target: 'wiki/entities/x.md', query: null })).toBe('wiki/entities/x.md');
    expect(parseResearchTemplate('---\ntype: playbook\n---\n', 'p', 'x')).toBeNull();
    // companions / phases: paths stay inside the data dir; unknown phases are ignored
    const custom = parseResearchTemplate('---\ntype: research-template\nkind: concept\noutput: wiki/concepts/{slug}.md\ncompanions:\n  - { path: ../escape.md, sections: ["## a"] }\n  - { path: wiki/guide.md, sections: ["## b"] }\nphases: { plan: phases/custom.md, bogus: x.md, review: /abs.md }\n---\nbody', 'concept', 'x')!;
    expect(custom.companions).toEqual([{ path: 'wiki/guide.md', sections: ['## b'] }]);
    expect(custom.phases).toEqual({ plan: 'phases/custom.md' });
    expect(subjectOf({ kind: 'init', target: null, query: null })).toBe('本知识库');
    expect(subjectOf({ kind: 'question', target: null, query: 'q?' })).toBe('q?');
    expect(researchSlug('A vs B: which is bigger?')).toBe('a-vs-b-which-is-bigger');
  });
});
