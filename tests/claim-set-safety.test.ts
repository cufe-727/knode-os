import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, KnodeConfig } from '../src/config.js';
import { entityKeyKinds } from '../src/graph/normalize.js';
import { EmbeddingProvider } from '../src/ingest/embeddings.js';
import type { ChatMessage, LlmClient } from '../src/llm/client.js';
import { ask } from '../src/search/ask.js';
import { computeClaimSet } from '../src/search/claimset.js';
import { classifyQuestion } from '../src/search/route.js';
import { Store, toVectorLiteral, VECTOR_TYPE } from '../src/store/db.js';

/**
 * docs/design/34 §1, after the review of 2026-11-16: a computed set says
 * nothing rather than something wrong. Finance-style claims — a typo a later
 * claim replaced, a forecast, two currencies, a quarter and a half-year, a
 * merged spelling, look-alike names — and the switch that keeps it off.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-claim-set-safety-'));
let store: Store;

class FixtureEmbedder implements EmbeddingProvider {
  readonly model = 'fixture-v1';
  readonly dimensions = 4;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0, 0]);
  }
}
const embedder = new FixtureEmbedder();

async function addEntity(id: string, name: string, type: string, canonical: string | null = null): Promise<void> {
  await store.query(`INSERT INTO entities (id, name, type, mention_count, aliases, description, canonical_id) VALUES ($1, $2, $3, 5, '[]'::jsonb, '', $4)`, [id, name, type, canonical]);
  for (const key of entityKeyKinds(name).keys()) {
    await store.query(`INSERT INTO entity_alias_keys (entity_id, alias_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, key]);
  }
}

async function addDoc(id: string, title: string, date: string | null, content: string, mentions: string[] = []): Promise<void> {
  const p = `raw/docs/${id}.md`;
  await store.query(`INSERT INTO documents (id, path, root, title, sha256, bytes, status, doc_date) VALUES ($1, $2, 'docs', $3, $4, 10, 'indexed', $5)`, [id, p, title, `sha-${id}`, date]);
  await store.query(`INSERT INTO chunks (id, document_id, seq, content, token_count, tsv) VALUES ($1, $2, 0, $3, 3, to_tsvector('simple', $3))`, [`c-${id}`, id, content]);
  await store.query(`INSERT INTO embeddings (chunk_id, model, embedding) VALUES ($1, $2, $3::${VECTOR_TYPE})`, [`c-${id}`, embedder.model, toVectorLiteral([1, 0, 0, 0])]);
  await store.query(`INSERT INTO scopes (id, kind, key, sha, status, applied_at) VALUES ($1, 'tier1', $2, $3, 'active', now())`, [`s-${id}`, p, `sha-${id}`]);
  for (const e of mentions) {
    await store.query(`INSERT INTO entity_mentions (entity_id, chunk_id, document_id, scope_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [e, `c-${id}`, id, `s-${id}`]);
  }
}

let claimNo = 0;
interface ClaimExtra {
  id?: string; object?: string; attribute?: string; num?: number; text?: string; unit?: string; at?: string | null;
  from?: string; to?: string; kind?: string; status?: string; supersededBy?: string; correction?: boolean;
}
async function addClaim(doc: string, subject: string, statement: string, x: ClaimExtra = {}): Promise<string> {
  const id = x.id ?? `cl-${++claimNo}`;
  await store.query(
    `INSERT INTO claims (id, subject_id, object_id, type, statement, status, kind, chunk_id, primary_scope_id, evidence_count, tx_from,
                         attribute, value_num, value_text, unit, effective_at, valid_from, valid_to, correction, superseded_by)
     VALUES ($1, $2, $3, 'other', $4, $5, $6, $7, $8, 1, now(), $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [id, subject, x.object ?? null, statement, x.status ?? 'fact', x.kind ?? 'fact', `c-${doc}`, `s-${doc}`, x.attribute ?? null, x.num ?? null, x.text ?? null,
      x.unit ?? null, x.at ?? null, x.from ?? null, x.to ?? null, x.correction ?? false, x.supersededBy ?? null],
  );
  await store.query(`INSERT INTO evidence (kind, target_id, scope_id, weight, extractor, tx_from) VALUES ('claim', $1, $2, 1, 'fixture', now())`, [id, `s-${doc}`]);
  return id;
}
const d = (s: string) => `${s}T00:00:00Z`;

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, '.knode'), { recursive: true });
  store = await Store.open(tmp, embedder.dimensions);
  await store.indexing;
  await addEntity('catl', '宁德时代', 'organization');
  await addEntity('catl-v', 'CATL', 'organization', 'catl'); // a spelling merged into 宁德时代
  await addEntity('byd', '比亚迪', 'organization');
  await addEntity('tesla', '特斯拉', 'organization');
  await addEntity('bmw', '宝马', 'organization');

  await addDoc('r1', '宁德时代2025年一季报点评', d('2025-04-20'), '宁德时代一季度营收847亿元。', ['catl']);
  await addDoc('r2', '宁德时代2025年中报点评', d('2025-08-01'), '宁德时代上半年营收1789亿元。', ['catl']);
  await addDoc('r3', '宁德时代深度：2026年展望', d('2025-09-10'), '预计宁德时代2026年营收4500亿元。', ['catl']);
  await addDoc('r4', 'CATL overseas note', d('2025-10-10'), 'CATL revenue was 59 billion USD.', ['catl-v']);
  await addDoc('r5', '宁德时代周报', d('2026-01-05'), '宁德时代本周要点。', ['catl']);

  // revenue: a typo a later claim of the same quarter replaced, a quarter, a half-year, a forecast, another currency
  const fix = await addClaim('r1', 'catl', '宁德时代2025年一季度营收847亿元', { attribute: '营收', num: 847, unit: '亿元', at: d('2025-04-20'), from: d('2025-01-01'), to: d('2025-03-31') });
  await addClaim('r1', 'catl', '宁德时代2025年一季度营收8470亿元', { attribute: '营收', num: 8470, unit: '亿元', at: d('2025-04-10'), supersededBy: fix });
  await addClaim('r2', 'catl', '宁德时代2025年上半年营收1789亿元', { attribute: '营收', num: 1789, unit: '亿元', at: d('2025-08-01') });
  await addClaim('r3', 'catl', '预计宁德时代2026年营收4500亿元', { attribute: '营收', num: 4500, unit: '亿元', at: d('2025-09-10'), kind: 'prediction', status: 'suspected' });
  await addClaim('r2', 'catl', '宁德时代上半年海外营收折合59亿美元', { attribute: '营收', num: 59, unit: '亿美元', at: d('2025-08-20') });
  // risks, and claims that merely say "需要注意"
  await addClaim('r2', 'catl', '宁德时代面临原材料价格波动风险', {});
  await addClaim('r2', 'catl', '宁德时代存在海外建厂政策风险', {});
  await addClaim('r2', 'byd', '比亚迪二季度销量需要注意同比口径变化', { object: 'catl' });
  await addClaim('r2', 'tesla', '特斯拉储能订单交付节奏需要注意', { object: 'catl' });
  // customers, one of them filed under the merged spelling
  await addClaim('r1', 'tesla', '特斯拉是宁德时代的客户', { object: 'catl', at: d('2025-04-20') });
  await addClaim('r2', 'bmw', '宝马是宁德时代的客户', { object: 'catl', at: d('2025-08-01') });
  await addClaim('r2', 'catl-v', 'CATL 的客户包括多家欧洲车企', { at: d('2025-08-01') });
  await addClaim('r4', 'byd', '比亚迪是CATL的客户', { object: 'catl-v', at: d('2025-10-10') });
});

afterAll(async () => {
  await store?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const set = (q: string, named: string[], now = '2026-11-16') => computeClaimSet(store, q, classifyQuestion(q), named, { now });

function recordingLlm(): { llm: LlmClient; prompts: string[] } {
  const prompts: string[] = [];
  const llm = {
    enabled: true,
    complete: async (messages: ChatMessage[]) => {
      prompts.push(messages.map((m) => m.content).join('\n'));
      return 'ok\n{"citations":[],"gaps":[]}';
    },
    completeJson: async () => {
      throw new Error('no JSON call expected');
    },
  } as unknown as LlmClient;
  return { llm, prompts };
}

const withRouter = (router: Partial<NonNullable<KnodeConfig['retrieval']['router']>>): KnodeConfig => {
  const c = defaultConfig();
  c.retrieval.router = { ...c.retrieval.router!, ...router };
  return c;
};

describe('the switches', () => {
  it('computes no set unless the workspace or the call turns computed sets on', async () => {
    const q = '宁德时代有哪些客户？';
    expect((await ask(store, defaultConfig(), embedder, recordingLlm().llm, q)).computed).toBeUndefined();
    expect((await ask(store, withRouter({ computedSets: true }), embedder, recordingLlm().llm, q)).computed).toBeDefined();
    expect((await ask(store, defaultConfig(), embedder, recordingLlm().llm, q, { computed: true })).computed).toBeDefined();
    expect((await ask(store, withRouter({ computedSets: true }), embedder, recordingLlm().llm, q, { computed: false })).computed).toBeUndefined();
  });
});
