import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { sync } from '../src/ingest/sync.js';
import { listSuggestions } from '../src/store/queries.js';
import { lintWiki } from '../src/wiki/lint.js';
import { markSupersededClaims } from '../src/wiki/refine.js';

/**
 * wiki lint: orphans, broken links, stale / unreviewed research pages,
 * expired pages and superseded statements, reported as a view page and
 * filed as refresh suggestions.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-lint-'));
let ctx: AppContext | undefined;
afterAll(async () => {
  await ctx?.datasources.closeAll();
  await ctx?.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('wiki lint', () => {
  it('finds orphans, broken links, stale and unreviewed research pages, expired pages and superseded text', async () => {
    const dataDir = path.join(tmp, 'ws');
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    write(dataDir, 'raw/docs/2026-01-10-old.md', `---
title: 旧年报
entities:
  - { name: 宁德时代, type: organization }
claims:
  - { subject: 宁德时代, type: ceo, statement: 张三担任 CFO, startDate: "2019-01-01" }
---
张三担任 CFO。
`);
    write(dataDir, 'wiki/entities/宁德时代.md', `---
type: organization
title: 宁德时代
aliases: [CATL]
sources: [raw/docs/2026-01-10-old.md]
actor: agent/claude-cli
research: { job: r_x, kind: entity, template: entity, at: "${old}", agent: claude-cli }
---
# 宁德时代

## 概要

张三担任 CFO（来源：raw/docs/2026-01-10-old.md）。见 [[电池]]。
`);
    write(dataDir, 'wiki/concepts/电池.md', `---
type: concept
title: 电池
---
# 电池

动力电池的核心厂商包括 [[宁德时代]] 与 [[不存在的页]]。
`);
    write(dataDir, 'wiki/concepts/孤儿.md', `---
type: concept
title: 孤儿
---
# 孤儿

没有任何页面链接到这里。
`);
    write(dataDir, 'wiki/concepts/过期.md', `---
type: concept
title: 过期
stale_after: "2020-01-01T00:00:00Z"
---
# 过期

见 [[电池]]。
`);
    ctx = await createContext(dataDir);
    await sync(ctx, { llmGraph: false });
    // newer evidence about 宁德时代 after the research page was written, replacing the CFO fact
    write(dataDir, 'raw/docs/2026-09-01-new.md', `---
title: 新公告
entities:
  - { name: 宁德时代, type: organization }
claims:
  - { subject: 宁德时代, type: ceo, statement: 李四担任 CFO, startDate: "2026-09-01" }
---
李四接替张三担任 CFO。
`);
    await sync(ctx, { llmGraph: false });
    await markSupersededClaims(ctx.store);

    const report = await lintWiki(ctx, { unreviewedDays: 0 });
    const has = (kind: string, p: string) => report.issues.some((i) => i.kind === kind && i.path === p);
    expect(has('orphan', 'wiki/concepts/孤儿.md')).toBe(true);
    expect(has('orphan', 'wiki/concepts/电池.md')).toBe(false); // linked from 宁德时代 and 过期
    expect(has('broken_link', 'wiki/concepts/电池.md')).toBe(true);
    expect(has('expired', 'wiki/concepts/过期.md')).toBe(true);
    expect(has('stale_research', 'wiki/entities/宁德时代.md')).toBe(true);
    expect(has('superseded_text', 'wiki/entities/宁德时代.md')).toBe(true);
    expect(has('unreviewed', 'wiki/entities/宁德时代.md')).toBe(true);
    expect(report.counts.orphan).toBeGreaterThanOrEqual(1);
    // the report is a view page, and the stale page became a refresh suggestion
    expect(report.reportPath).toMatch(/^wiki\/lint\/\d{4}-\d{2}-\d{2}\.md$/);
    expect(fs.existsSync(path.join(dataDir, report.reportPath!))).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, report.reportPath!), 'utf8')).toContain('## broken_link');
    expect(await ctx.store.query(`SELECT kind FROM pages WHERE path = $1 AND tx_to IS NULL`, [report.reportPath])).toEqual([{ kind: 'lint' }]);
    const refresh = (await listSuggestions(ctx.store, { status: 'pending' })).find((s) => s.kind === 'wiki' && (s.payload as { target?: string })?.target === 'wiki/entities/宁德时代.md');
    expect(refresh?.payload).toMatchObject({ kind: 'refresh' });
    // idempotent: running again files nothing new
    expect((await lintWiki(ctx, { unreviewedDays: 0 })).suggestions).toBe(0);
  });
});
