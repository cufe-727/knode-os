import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from '../src/config.js';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { readSidecarPart, updateSidecarPart } from '../src/fs/sidecar.js';
import { buildExtractRequest, parseExtractReply, RawExtractReply } from '../src/graph/llm-extract.js';
import { buildOntology, CORE_PACK_YAML, FINANCE_PACK_YAML, ORGANIZATION_PACK_YAML } from '../src/graph/ontology.js';
import { claimsForEntities } from '../src/graph/query.js';
import { CLAIM_TYPES, claimTypeOf, normalizeClaimKind, normalizeClaimType } from '../src/graph/store.js';
import { sync } from '../src/ingest/sync.js';
import { claimTag } from '../src/search/ask.js';
import { queryClaims } from '../src/store/claims.js';
import { markSupersededClaims } from '../src/wiki/refine.js';

/**
 * The closed claim vocabulary and the claim kind: what the tier-1 prompt asks
 * for, how a reply is mapped onto the lists, and how a kind reaches the fold,
 * the query surface and supersession.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-claim-vocab-'));
let ctx: AppContext | undefined;
afterAll(async () => {
  await ctx?.datasources.closeAll();
  await ctx?.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const FINANCE = buildOntology([{ name: 'core', text: CORE_PACK_YAML }, { name: 'organization', text: ORGANIZATION_PACK_YAML }, { name: 'finance', text: FINANCE_PACK_YAML }]);

describe('closed claim vocabulary', () => {
  it('maps the old free labels, Chinese names and near misses onto the list; unknown → other', () => {
    const offered = CLAIM_TYPES.filter((t) => !t.system).map((t) => t.id);
    expect(offered).toEqual(['price_move', 'technical', 'earnings', 'guidance', 'fundamentals', 'valuation', 'fund_flow', 'holding', 'management', 'recommendation', 'outlook', 'macro', 'policy', 'event', 'risk', 'method', 'other']);
    expect(CLAIM_TYPES.filter((t) => t.supersedes).map((t) => t.id)).toEqual(['price_move', 'technical', 'earnings', 'guidance', 'valuation', 'fund_flow', 'holding', 'recommendation', 'outlook', 'macro']);
    expect(normalizeClaimType('cfo')).toBe('management');
    expect(normalizeClaimType('supply')).toBe('fundamentals');
    expect(claimTypeOf('revenue')).toBe('earnings');
    expect(claimTypeOf('made up')).toBeUndefined();
    expect(normalizeClaimType('earnings')).toBe('earnings');
    expect(normalizeClaimType('  Earnings ')).toBe('earnings');
    expect(normalizeClaimType('financials')).toBe('earnings');
    expect(normalizeClaimType('业绩')).toBe('earnings');
    expect(normalizeClaimType('市场表现')).toBe('price_move');
    expect(normalizeClaimType('股价表现')).toBe('price_move');
    expect(normalizeClaimType('Price-Move')).toBe('price_move');
    expect(normalizeClaimType('行情判断')).toBe('outlook');
    expect(normalizeClaimType('市场判断')).toBe('outlook');
    expect(normalizeClaimType('capacity')).toBe('fundamentals');
    expect(normalizeClaimType('capability')).toBe('fundamentals');
    expect(normalizeClaimType('decision')).toBe('event');
    expect(normalizeClaimType('方法论')).toBe('method');
    expect(normalizeClaimType('something the model made up')).toBe('other');
    expect(normalizeClaimType('')).toBe('other');
    expect(normalizeClaimType(undefined)).toBe('other');
    // the probe's own type passes through but is never offered
    expect(normalizeClaimType('absence')).toBe('absence');
    expect(CLAIM_TYPES.find((t) => t.id === 'absence')?.system).toBe(true);

    expect(normalizeClaimKind('prediction')).toBe('prediction');
    expect(normalizeClaimKind('Forecast')).toBe('prediction');
    expect(normalizeClaimKind('预测')).toBe('prediction');
    expect(normalizeClaimKind('观点')).toBe('opinion');
    expect(normalizeClaimKind('rumour')).toBe('rumor');
    expect(normalizeClaimKind('传闻')).toBe('rumor');
    expect(normalizeClaimKind('fact')).toBe('fact');
    expect(normalizeClaimKind(undefined)).toBe('fact');
    expect(normalizeClaimKind('whatever')).toBe('fact');
  });

  it('asks for the finance types, the closed list, a kind and a context-free description', () => {
    const req = buildExtractRequest({ path: 'raw/docs/a.md', title: 'A' }, '宁德时代涨停。', { ontology: FINANCE, claims: true });
    const system = req.messages[0].content;
    expect(system).toContain('- index (指数): a stock-market or asset index');
    expect(system).toContain('- indicator (指标)');
    expect(system).toContain('- sector (行业 / 板块)');
    expect(system).toContain('- constituent_of: A is a constituent of index B');
    expect(system).toContain('- recommends:');
    expect(system).toContain('not what this document says about it');
    expect(system).toContain('- type: exactly one of\n  - price_move:');
    expect(system).toContain('  - method: a trading or investment method');
    expect(system).not.toContain('- absence');
    expect(system).toContain('- kind: "fact"');
    expect(system).toContain('without attribution phrases');
    expect(system).toContain('"claims":[{"subject","object","type","kind","statement","status","eventDate","startDate","endDate"}]');
    // without claims the entity rules still carry the new description rule
    const noClaims = buildExtractRequest({ path: 'raw/docs/a.md', title: 'A' }, 'x', { ontology: FINANCE, claims: false });
    expect(noClaims.messages[0].content).toContain('not what this document says about it');
    expect(noClaims.messages[0].content).not.toContain('"kind"');
  });

  it('parses a reply onto the lists: type by synonym, kind by spelling, defaults when missing', () => {
    const reply = {
      entities: [{ name: '宁德时代', type: 'organization', aliases: ['300750'] }],
      relations: [],
      claims: [
        { subject: '宁德时代', statement: '宁德时代明年营收翻倍', type: '市场表现', kind: '预测', status: 'fact' },
        { subject: '宁德时代', statement: '宁德时代估值偏高', type: 'Valuation', kind: 'opinion', status: 'suspected' },
        { subject: '宁德时代', statement: '宁德时代涨停', type: 'weird label' },
        { subject: '', statement: 'dropped: no subject', type: 'earnings' },
      ],
    } as unknown as RawExtractReply;
    const out = parseExtractReply(reply, { withClaims: true, askSubject: false });
    expect(out.claims.map((c) => [c.type, c.kind, c.status])).toEqual([
      ['price_move', 'prediction', 'fact'],
      ['valuation', 'opinion', 'suspected'],
      ['other', 'fact', undefined],
    ]);
    expect(parseExtractReply(reply, { withClaims: false, askSubject: false }).claims).toEqual([]);
  });

  it('tags a view or forecast by its kind, a fact by its status', () => {
    expect(claimTag({ status: 'fact', kind: 'fact' })).toBe('fact');
    expect(claimTag({ status: 'suspected' })).toBe('suspected');
    expect(claimTag({ status: 'fact', kind: 'opinion' })).toBe('opinion');
    expect(claimTag({ status: 'suspected', kind: 'prediction' })).toBe('prediction, suspected');
  });

  it('stores the kind and the mapped type, folds them, filters by kind, and supersedes facts only — per object', async () => {
    const dir = path.join(tmp, 'ws');
    initDataDir(dir);
    const config = loadConfig(dir);
    config.graph = { ...config.graph, ontologyPacks: ['core', 'organization', 'finance'] };
    saveConfig(dir, config);
    const key = 'raw/docs/catl.md';
    fs.mkdirSync(path.join(dir, 'raw/docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, key), '# 宁德时代\n\n宁德时代2024年营收3600亿元，2025年营收4000亿元；张三持有宁德时代和比亚迪。上证指数收于3000点。\n');
    ctx = await createContext(dir);
    await sync(ctx, { llmGraph: false });
    const meta = readSidecarPart(dir, key, 'meta')!;
    updateSidecarPart(dir, key, 'tier1', () => ({
      status: 'done',
      entities: [
        { name: '宁德时代', type: 'organization', aliases: ['300750'], description: '全球最大的动力电池制造商' },
        { name: '比亚迪', type: 'organization' },
        { name: '张三', type: 'person' },
        { name: '上证指数', type: 'index' },
      ],
      relations: [{ source: '宁德时代', target: '上证指数', type: '成分股' }],
      claims: [
        { subject: '宁德时代', type: '业绩', statement: '宁德时代2024年营收3600亿元', status: 'fact', startDate: '2024' },
        { subject: '宁德时代', type: 'earnings', statement: '宁德时代2025年营收4000亿元', status: 'fact', startDate: '2025' },
        { subject: '宁德时代', type: 'earnings', kind: 'prediction', statement: '宁德时代2026年营收将达5000亿元', status: 'fact', startDate: '2026' },
        { subject: '宁德时代', type: '股价表现', kind: 'opinion', statement: '宁德时代估值偏高', status: 'suspected' },
        { subject: '张三', object: '宁德时代', type: 'holding', statement: '张三持有宁德时代', status: 'fact', startDate: '2023' },
        { subject: '张三', object: '比亚迪', type: 'holding', statement: '张三持有比亚迪', status: 'fact', startDate: '2024' },
        { subject: '上证指数', type: 'nonsense-label', kind: 'rumor', statement: '上证指数将被重新编制', status: 'suspected' },
      ],
      model: 'test-model',
      contentSha: meta.contentSha256,
      extractedAt: new Date().toISOString(),
    }));
    await sync(ctx, { llmGraph: false });

    // the finance type is accepted by the writer once the workspace lists the pack; the predicate is the pack's
    expect(await ctx.store.query(`SELECT type FROM entities WHERE id = '上证指数' AND tx_to IS NULL`)).toEqual([{ type: 'index' }]);
    expect(await ctx.store.query(`SELECT type FROM relations WHERE tx_to IS NULL AND type <> 'related_to' ORDER BY type`)).toEqual([{ type: 'constituent_of' }]);

    const rows = await ctx.store.query<{ statement: string; type: string; kind: string; status: string }>(
      `SELECT statement, type, kind, status FROM claims WHERE tx_to IS NULL ORDER BY statement`,
    );
    const byStatement = new Map(rows.map((r) => [r.statement, r]));
    expect(byStatement.get('宁德时代2024年营收3600亿元')).toMatchObject({ type: 'earnings', kind: 'fact' });
    expect(byStatement.get('宁德时代2026年营收将达5000亿元')).toMatchObject({ type: 'earnings', kind: 'prediction', status: 'fact' });
    expect(byStatement.get('宁德时代估值偏高')).toMatchObject({ type: 'price_move', kind: 'opinion', status: 'suspected' });
    expect(byStatement.get('上证指数将被重新编制')).toMatchObject({ type: 'other', kind: 'rumor' });
    expect(byStatement.get('张三持有比亚迪')).toMatchObject({ type: 'holding', kind: 'fact' });

    // the query surface carries and filters by kind
    const all = await queryClaims(ctx.store, { subject: '宁德时代' });
    expect(all.claims.map((c) => c.kind).sort()).toEqual(['fact', 'fact', 'opinion', 'prediction']);
    const predictions = await queryClaims(ctx.store, { subject: '宁德时代', kinds: ['prediction'] });
    expect(predictions.claims.map((c) => c.statement)).toEqual(['宁德时代2026年营收将达5000亿元']);
    expect((await queryClaims(ctx.store, { subject: '宁德时代', kinds: ['bogus'] })).matched).toBe(0);
    expect((await claimsForEntities(ctx.store, ['宁德时代'], 12)).find((c) => c.statement === '宁德时代估值偏高')?.kind).toBe('opinion');
    expect(await ctx.store.query(`SELECT kind FROM v_claims WHERE statement = '宁德时代估值偏高'`)).toEqual([{ kind: 'opinion' }]);

    // supersession: the 2025 result replaces the 2024 one; the 2026 forecast neither replaces nor is replaced;
    // the two holdings are about different objects and both stay current
    await markSupersededClaims(ctx.store);
    const marks = await ctx.store.query<{ statement: string; superseded_by: string | null }>(`SELECT statement, superseded_by FROM claims WHERE tx_to IS NULL`);
    const superseded = new Map(marks.map((m) => [m.statement, m.superseded_by]));
    const id2025 = (await ctx.store.query<{ id: string }>(`SELECT id FROM claims WHERE statement = '宁德时代2025年营收4000亿元'`))[0].id;
    expect(superseded.get('宁德时代2024年营收3600亿元')).toBe(id2025);
    expect(superseded.get('宁德时代2025年营收4000亿元')).toBeNull();
    expect(superseded.get('宁德时代2026年营收将达5000亿元')).toBeNull();
    expect(superseded.get('张三持有宁德时代')).toBeNull();
    expect(superseded.get('张三持有比亚迪')).toBeNull();
    expect((await queryClaims(ctx.store, { subject: '宁德时代', types: ['earnings'] })).claims.map((c) => c.statement).sort())
      .toEqual(['宁德时代2025年营收4000亿元', '宁德时代2026年营收将达5000亿元']);
  });
});
