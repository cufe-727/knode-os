import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { initDataDir } from '../src/fs/datadir.js';
import { namesApartByCode, nameCode } from '../src/graph/resolve.js';
import { sync } from '../src/ingest/sync.js';

/**
 * Facts the 10× reports benchmark showed missing or stale in a built knowledge
 * base (2026-11-15): incidents of one title taken by another incident's
 * entity, and the rest of this file's cases.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-stale-facts-'));
const contexts: AppContext[] = [];
afterAll(async () => {
  for (const ctx of contexts) {
    await ctx.datasources.closeAll();
    await ctx.store.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

async function workspace(name: string, docs: Record<string, string>): Promise<AppContext> {
  const dataDir = path.join(tmp, name);
  for (const [rel, text] of Object.entries(docs)) write(dataDir, rel, text);
  initDataDir(dataDir);
  const config = loadConfig(dataDir);
  config.ingest.concurrency = 1;
  saveConfig(dataDir, config);
  const ctx = await createContext(dataDir);
  contexts.push(ctx);
  await sync(ctx, { llmGraph: false });
  return ctx;
}

describe('identifiers of one kind', () => {
  it('reads the identifier a name is', () => {
    expect(nameCode('INC-020-D3T3')?.value).toBe('INC-20-D3T3');
    expect(nameCode('事故INC-020-D3T3')?.value).toBe('INC-20-D3T3');
    expect(nameCode('活动页白屏')).toBeNull();
    expect(namesApartByCode('INC-017-D7T3', 'INC-020-D3T3')).toBe(true);
    expect(namesApartByCode('INC-020-D3T3', '事故INC-020-D3T3')).toBe(false);
    expect(namesApartByCode('INC-020-D3T3', '活动页白屏')).toBe(false);
  });

  it('gives each incident its own entity although both list the title as an alias', async () => {
    const ctx = await workspace('incidents', {
      'raw/docs/a.md': `---
title: 七部增长组周报
entities:
  - { name: INC-017-D7T3, type: event, aliases: ["活动页白屏"] }
claims:
  - { subject: INC-017-D7T3, statement: INC-017-D7T3已由周磊修复, type: event }
---
INC-017-D7T3（P1）活动页白屏，周磊修复。
`,
      'raw/docs/b.md': `---
title: 三部增长组周报
entities:
  - { name: INC-020-D3T3, type: event, aliases: ["活动页白屏"] }
claims:
  - { subject: INC-020-D3T3, statement: INC-020-D3T3已由吴婷修复, type: event }
---
INC-020-D3T3（P1）活动页白屏，吴婷修复。
`,
    });
    const rows = await ctx.store.query<{ subject_id: string; statement: string }>(`SELECT subject_id, statement FROM claims WHERE tx_to IS NULL ORDER BY statement`);
    expect(rows).toEqual([
      { subject_id: 'inc-017-d7t3', statement: 'INC-017-D7T3已由周磊修复' },
      { subject_id: 'inc-020-d3t3', statement: 'INC-020-D3T3已由吴婷修复' },
    ]);
    // the title alone still finds an incident of that title
    const both = await ctx.store.query<{ id: string }>(`SELECT id FROM entities WHERE tx_to IS NULL AND id LIKE 'inc-%' ORDER BY id`);
    expect(both.map((r) => r.id)).toEqual(['inc-017-d7t3', 'inc-020-d3t3']);
  });
});

describe('a title several incidents carry', () => {
  it('resolves to none of them', async () => {
    const ctx = await workspace('shared-title', {
      'raw/docs/a.md': `---\ntitle: a\nentities:\n  - { name: INC-001-T1, type: event, aliases: ["登录失败事故"] }\n---\nINC-001-T1 登录失败事故\n`,
      'raw/docs/b.md': `---\ntitle: b\nentities:\n  - { name: INC-005-T3, type: event, aliases: ["登录失败事故"] }\n---\nINC-005-T3 登录失败事故\n`,
      'raw/docs/c.md': `---\ntitle: c\nentities:\n  - { name: 登录失败事故, type: event }\nclaims:\n  - { subject: 登录失败事故, statement: 上周发生的登录失败事故已由贾洋修复, type: event }\n---\n上周发生的登录失败事故已由贾洋修复\n`,
    });
    const [row] = await ctx.store.query<{ subject_id: string }>(`SELECT subject_id FROM claims WHERE tx_to IS NULL AND statement LIKE '上周%'`);
    expect(row.subject_id).toBe('登录失败事故');
  });

  it('gives a numbered incident its own entity rather than the title entity its alias names', async () => {
    const ctx = await workspace('numbered', {
      'raw/docs/a.md': `---\ntitle: a\nentities:\n  - { name: INC-001-T1, type: event, aliases: ["登录失败事故"] }\n---\nINC-001-T1 登录失败事故\n`,
      'raw/docs/b.md': `---\ntitle: b\nentities:\n  - { name: 登录失败事故, type: event }\n---\n登录失败事故\n`,
      'raw/docs/c.md': `---\ntitle: c\nentities:\n  - { name: INC-005-T3, type: event, aliases: ["登录失败事故"] }\nclaims:\n  - { subject: INC-005-T3, statement: INC-005-T3已由尹婷修复, type: event }\n---\nINC-005-T3 登录失败事故\n`,
    });
    const [row] = await ctx.store.query<{ subject_id: string }>(`SELECT subject_id FROM claims WHERE tx_to IS NULL AND statement LIKE 'INC-005%'`);
    expect(row.subject_id).toBe('inc-005-t3');
  });
});
