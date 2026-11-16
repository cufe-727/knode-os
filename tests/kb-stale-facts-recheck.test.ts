import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { KnodeConfig, loadConfig, saveConfig } from '../src/config.js';
import { initDataDir } from '../src/fs/datadir.js';
import { refreshClaimState } from '../src/graph/claim-state-store.js';
import { statementObject } from '../src/graph/claim-state.js';
import { sync } from '../src/ingest/sync.js';

/**
 * The third check of the 10× fixes (2026-11-16): owner statements read for
 * what they are about kept an adverb or a lead phrase in the object, active
 * voice gave none, the canonical key moved off the stored name, lists of
 * fixers linked nobody, a bare id stayed apart from its tailed form, and a
 * refine slice that always fails would stall the pass.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-stale-recheck-'));
const contexts: AppContext[] = [];
afterAll(async () => {
  for (const ctx of contexts) {
    await ctx.datasources.closeAll();
    await ctx.store.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function workspace(name: string, docs: Record<string, string>, edit?: (c: KnodeConfig) => void): Promise<AppContext> {
  const dataDir = path.join(tmp, name);
  for (const [rel, text] of Object.entries(docs)) {
    const abs = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  initDataDir(dataDir);
  const config = loadConfig(dataDir);
  config.ingest.concurrency = 1;
  edit?.(config);
  saveConfig(dataDir, config);
  const ctx = await createContext(dataDir);
  contexts.push(ctx);
  await sync(ctx, { llmGraph: false });
  return ctx;
}

const dated = (title: string, date: string, fm: string) => `---\ntitle: ${title}\ndate: ${date}\n${fm}---\n${title}\n`;
/** One claim a line; [statement, attribute, value] for a line the extractor would have given an attribute the statement does not read as. */
type Line = string | [string, string, string];
const claimDoc = (date: string, subject: string, lines: Line[]) =>
  dated(`周观察${date}`, date, `entities:\n  - { name: ${subject}, type: organization }\nclaims:\n${lines
    .map((l) => `  - { subject: ${subject}, statement: ${typeof l === 'string' ? l : l[0]}, type: other }`)
    .join('\n')}\n`);

/** A workspace of two dated documents, with the stated attributes on the stored claims, as an extraction gives them. */
async function twoDocs(name: string, subject: string, a: Line[], b: Line[]): Promise<AppContext> {
  const ctx = await workspace(name, { 'raw/docs/a.md': claimDoc('2025-03-10', subject, a), 'raw/docs/b.md': claimDoc('2025-03-17', subject, b) });
  for (const l of [...a, ...b]) {
    if (typeof l !== 'string') await ctx.store.query(`UPDATE claims SET attribute = $2, value_text = $3 WHERE statement = $1`, l);
  }
  return ctx;
}

async function currentStatements(ctx: AppContext): Promise<string[]> {
  await refreshClaimState(ctx.store);
  const rows = await ctx.store.query<{ statement: string; current: boolean }>(
    `SELECT statement, superseded_by IS NULL AS current FROM claims WHERE tx_to IS NULL AND attribute IS NOT NULL`,
  );
  return rows.filter((r) => r.current).map((r) => r.statement).sort();
}

describe('an owner change written with an adverb or a lead phrase', () => {
  it('reads the thing, not the adverb or the phrase before it', () => {
    for (const s of ['云业务由张三负责', '云业务改由李四负责', '云业务现由李四负责', '云业务交由李四负责', '云业务转由李四负责', '云业务仍由李四负责', '自2025年3月起云业务由李四负责', '从下周起，云业务由李四负责', '经董事会决定，云业务改由李四负责', '经评审云业务由李四负责']) {
      expect(statementObject(s, '负责人', ['比亚迪']), s).toBe('云业务');
    }
    expect(statementObject('经评审R-03状态为已关闭', '状态', ['R-03'])).toBe('');
    expect(statementObject('R-03（支付超时）状态为已关闭', '状态', ['R-03'])).toBe('');
    expect(statementObject('R-03(支付超时)现由赖艳负责', '负责人', ['R-03'])).toBe('');
    expect(statementObject('自4月起R-03改由赖艳负责', '负责人', ['R-03'])).toBe('');
  });

  it.each(['云业务改由李四负责', '云业务现由李四负责', '云业务交由李四负责', '云业务转由李四负责', '自2025年3月起云业务由李四负责'])('leaves one current owner when the owner changes: %s', async (later) => {
    const ctx = await twoDocs(`owner-change-${later}`, '比亚迪', ['云业务由张三负责'], [later]);
    expect(await currentStatements(ctx)).toEqual([later]);
  });

  it('leaves one current state of the subject however the line begins', async () => {
    const ctx = await twoDocs('state-change', 'R-03', [['R-03（支付超时）状态为跟进中', '状态', '跟进中']], [['经评审R-03状态为已关闭', '状态', '已关闭']]);
    expect(await currentStatements(ctx)).toEqual(['经评审R-03状态为已关闭']);
  });
});


describe('an owner written in the active voice', () => {
  it('reads the thing after 负责', () => {
    expect(statementObject('张三负责云业务', '负责人', ['比亚迪'], '张三')).toBe('云业务');
    expect(statementObject('李四将负责电池业务的工作', '负责人', ['比亚迪'], '李四')).toBe('电池业务');
    expect(statementObject('李四接手云业务', '负责人', ['比亚迪'], '李四')).toBe('云业务');
    expect(statementObject('李四负责比亚迪云业务', '负责人', ['比亚迪'], '李四')).toBe('云业务');
    expect(statementObject('赖艳负责R-03', '负责人', ['R-03'], '赖艳')).toBe('');
    expect(statementObject('赖艳负责', '负责人', ['R-03'], '赖艳')).toBe('');
    // the passive voice is read as before, the value given or not
    expect(statementObject('云业务改由李四负责', '负责人', ['比亚迪'], '李四')).toBe('云业务');
  });

  it('keeps the owners of two things apart', async () => {
    const ctx = await twoDocs('active', '比亚迪', [['张三负责云业务', '负责人', '张三']], [['李四负责电池业务', '负责人', '李四']]);
    expect(await currentStatements(ctx)).toEqual(['张三负责云业务', '李四负责电池业务'].sort());
  });

  it('leaves one current owner of one thing, active or passive', async () => {
    const ctx = await twoDocs('active-change', '比亚迪', [['张三负责云业务', '负责人', '张三']], ['云业务改由李四负责']);
    expect(await currentStatements(ctx)).toEqual(['云业务改由李四负责']);
  });
});
