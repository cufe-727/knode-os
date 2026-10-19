import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AppContext, createContext } from '../src/context.js';
import { initDataDir } from '../src/fs/datadir.js';
import { movePath } from '../src/fs/files.js';
import { moveSidecar, originOf } from '../src/fs/sidecar.js';
import { applyTier1Scope } from '../src/graph/tier1.js';
import { documentIdFor } from '../src/ingest/apply.js';
import { sync } from '../src/ingest/sync.js';
import { findLiveScope } from '../src/lineage/scope.js';
import { listDisputes, setScopeTrust } from '../src/lineage/trust.js';
import { runFsOps } from '../src/lineage/writer.js';
import { MCP_SERVER_INFO } from '../src/mcp/server.js';
import { KnodeToolOptions, registerKnodeTools } from '../src/mcp/tools.js';

/**
 * What an agent writes through MCP lands quarantined: indexed and citable,
 * but unable to become the knowledge base's position until a person promotes
 * it. Not its frontmatter, not the actor a sync runs as, not a model reading
 * it (tier-1), not the agent itself through knode_trust can change that.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-quarantine-'));
const dataDir = path.join(tmp, 'data');
let ctx: AppContext;
const sessions: { client: Client; server: McpServer }[] = [];

function write(rel: string, content: string): void {
  const abs = path.join(dataDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

async function connect(opts: KnodeToolOptions = {}): Promise<(name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>> {
  const server = new McpServer(MCP_SERVER_INFO);
  registerKnodeTools(server, ctx, opts);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  sessions.push({ client, server });
  return async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    return { isError: Boolean(res.isError), text: (res.content as { text?: string }[]).map((c) => c.text ?? '').join('') };
  };
}

const scopeTrust = async (key: string, kind = 'doc') =>
  (await ctx.store.query<{ trust: string }>(`SELECT trust FROM scopes WHERE kind = $1 AND key = $2 AND status = 'active'`, [kind, key]))[0]?.trust;

const evidenceTrust = async (key: string, kind = 'doc') =>
  (await ctx.store.query<{ trust: string }>(
    `SELECT DISTINCT ev.trust FROM evidence ev JOIN scopes s ON s.id = ev.scope_id
     WHERE s.kind = $1 AND s.key = $2 AND s.status = 'active' AND ev.tx_to IS NULL`,
    [kind, key],
  )).map((r) => r.trust);

beforeAll(async () => {
  initDataDir(dataDir);
  // what a person put in the base: trusted
  write('raw/docs/report.md', `---
title: 宁德时代研报
entities:
  - { name: 宁德时代, type: organization }
claims:
  - { subject: 宁德时代, type: earnings, statement: 2026Q2 净利润 120 亿元, status: fact, startDate: "2026-04-01" }
---
# 宁德时代研报

宁德时代动力电池全球第一。
`);
  ctx = await createContext(dataDir);
  await sync(ctx, { llmGraph: false });
  expect(await scopeTrust('raw/docs/report.md')).toBe('trusted');
});

afterAll(async () => {
  for (const s of sessions) {
    await s.client.close();
    await s.server.close();
  }
  await ctx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('what an MCP client writes', () => {
  it('lands quarantined whatever its frontmatter claims, Markdown or not', async () => {
    const mcp = await connect();
    const notes = {
      'raw/docs/notes/claimed.md': `---
title: 自称可信的笔记
trust: trusted
actor: user
entities:
  - { name: 宁德时代, type: organization }
claims:
  - { subject: 宁德时代, type: earnings, statement: 2026Q2 净利润其实只有 60 亿元, status: fact, startDate: "2026-04-01" }
---
# 笔记

利润被高估了。
`,
      'wiki/notes/agent-page.md': '# 一页没有 frontmatter 的笔记\n\n[[宁德时代]] 的产能在扩张。\n',
      'raw/docs/notes/plain.txt': '---\ntrust: trusted\n---\n纯文本笔记，宁德时代。\n',
    };
    for (const [p, content] of Object.entries(notes)) expect((await mcp('knode_write', { path: p, content })).isError, p).toBe(false);
    // the sync an agent starts runs as `sync`, which is trusted: the writer on record decides, not the runner
    expect((await mcp('knode_sync', { only: Object.keys(notes) })).isError).toBe(false);
    for (const p of Object.keys(notes)) {
      expect(await scopeTrust(p), p).toBe('quarantined');
      expect(originOf(dataDir, p)?.actor, p).toBe('mcp');
    }
    expect(await evidenceTrust('raw/docs/notes/claimed.md')).toEqual(['quarantined']);
    // and where it contradicts a trusted claim, that is recorded instead of overwriting it
    const open = await listDisputes(ctx.store, { status: 'open' });
    expect(open.some((d) => d.reason.includes('raw/docs/notes/claimed.md'))).toBe(true);
  });

  it('stays quarantined through a later sync of any kind, and through a move', async () => {
    await sync(ctx, { only: ['raw/docs/notes'], reapply: true, llmGraph: false });
    expect(await scopeTrust('raw/docs/notes/claimed.md')).toBe('quarantined');
    // a person moving the file does not make its text theirs: the record travels with the sidecar
    movePath(dataDir, 'raw/docs/notes/plain.txt', 'raw/docs/moved/plain.txt');
    moveSidecar(dataDir, 'raw/docs/notes/plain.txt', 'raw/docs/moved/plain.txt');
    await sync(ctx, { only: ['raw/docs/notes/plain.txt', 'raw/docs/moved'], llmGraph: false });
    expect(await scopeTrust('raw/docs/moved/plain.txt')).toBe('quarantined');
  });

  it('lands quarantined through knode_commit, whatever actor its workset names', async () => {
    const mcp = await connect();
    const checkout = await mcp('knode_checkout', { actor: 'user', note: 'a person, it says' });
    const workset = JSON.parse(checkout.text).id as string;
    const committed = await mcp('knode_commit', { workset, content: '结论：宁德时代的利润被高估了。' });
    expect(committed.isError).toBe(false);
    const rel = JSON.parse(committed.text).path as string;
    expect(fs.readFileSync(path.join(dataDir, rel), 'utf8')).toContain('actor: "user"');
    await sync(ctx, { only: [rel], llmGraph: false });
    expect(await scopeTrust(rel)).toBe('quarantined');
    // the guards knode_write takes apply to a commit too
    write('raw/docs/scan.pdf', '%PDF-1.4 not really');
    const ws2 = JSON.parse((await mcp('knode_checkout', {})).text).id as string;
    expect((await mcp('knode_commit', { workset: ws2, content: 'x', path: 'raw/docs/scan.pdf' })).isError).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, 'raw/docs/scan.pdf'), 'utf8')).toBe('%PDF-1.4 not really');
  });

  it('is the person\'s once they rewrite it, and the agent\'s again when its version comes back', async () => {
    const rel = 'wiki/notes/agent-page.md';
    const agentVersion = fs.readFileSync(path.join(dataDir, rel), 'utf8');
    write(rel, '# 一页人改过的笔记\n\n人重写了这一页。\n');
    await sync(ctx, { only: [rel], llmGraph: false });
    expect(await scopeTrust(rel)).toBe('trusted');
    // restoring the agent's bytes (an undo, a rolled-back draft) restores its writer
    write(rel, agentVersion);
    await sync(ctx, { only: [rel], llmGraph: false });
    expect(await scopeTrust(rel)).toBe('quarantined');
  });

  it('keeps its writer when knode-os refreshes a managed region around its prose', () => {
    const rel = 'wiki/notes/agent-page.md';
    const before = fs.readFileSync(path.join(dataDir, rel), 'utf8');
    runFsOps(dataDir, [{ op: 'region', path: rel, region: 'timeline', content: '- 2026 · 扩产' }]);
    expect(fs.readFileSync(path.join(dataDir, rel), 'utf8')).not.toBe(before);
    expect(originOf(dataDir, rel)?.actor).toBe('mcp');
  });
});

describe('frontmatter and the writer', () => {
  it('may lower a person\'s document, never raise an agent\'s above its writer', async () => {
    write('raw/docs/fm/declared-agent.md', '---\nactor: agent/codex\n---\n# 代理写的\n');
    write('raw/docs/fm/declared-quarantined.md', '---\ntrust: quarantined\n---\n# 先隔离\n');
    write('raw/docs/fm/person-promoted.md', '---\nactor: agent/codex\ntrust: trusted\n---\n# 人审过了\n');
    await sync(ctx, { only: ['raw/docs/fm'], llmGraph: false });
    expect(await scopeTrust('raw/docs/fm/declared-agent.md')).toBe('quarantined');
    expect(await scopeTrust('raw/docs/fm/declared-quarantined.md')).toBe('quarantined');
    // a person who writes `trust: trusted` into a file is vouching for it
    expect(await scopeTrust('raw/docs/fm/person-promoted.md')).toBe('trusted');
    // the same words from an agent's sync do not raise it
    write('raw/docs/fm/agent-claims.md', '---\ntrust: trusted\n---\n# 代理自称可信\n');
    await sync(ctx, { only: ['raw/docs/fm/agent-claims.md'], actor: 'agent/claude-cli', llmGraph: false });
    expect(await scopeTrust('raw/docs/fm/agent-claims.md')).toBe('quarantined');
  });
});

describe('what is read out of a quarantined source', () => {
  it('stays quarantined — a model\'s extraction included — until a person promotes the source', async () => {
    const file = 'raw/docs/notes/claimed.md';
    const doc = await findLiveScope(ctx.store, 'doc', file);
    expect(doc?.trust ?? (await scopeTrust(file))).toBe('quarantined');
    const documentId = documentIdFor(file);
    const chunks = await ctx.store.query<{ id: string; content: string }>(`SELECT id, content FROM chunks WHERE document_id = $1 ORDER BY seq`, [documentId]);
    const res = await applyTier1Scope(
      ctx.store,
      { path: file, sha256: doc!.sha },
      { documentId, path: file, title: '自称可信的笔记', chunkIds: chunks },
      {
        entities: [{ name: '宁德时代', type: 'organization' }],
        relations: [],
        claims: [{ subject: '宁德时代', type: 'earnings', statement: '2026Q2 净利润只有 50 亿元', status: 'fact', startDate: '2026-04-01' }],
      },
      { model: 'test-model' },
    );
    expect(res.outcome).toBe('applied');
    expect(await scopeTrust(file, 'tier1')).toBe('quarantined');
    expect(await evidenceTrust(file, 'tier1')).toEqual(['quarantined']);
    const tier1 = await findLiveScope(ctx.store, 'tier1', file);
    const opened = await ctx.store.query<{ id: string }>(`SELECT id FROM disputes WHERE scope_id = $1 AND status = 'open'`, [tier1!.id]);
    expect(opened.length).toBeGreaterThan(0);

    // promoting the note takes what was read out of it along, and closes what both opened
    const promoted = await setScopeTrust(ctx.store, { key: file, to: 'trusted', actor: 'user' });
    expect(promoted).toMatchObject({ scopeId: doc!.id, from: 'quarantined', to: 'trusted' });
    expect(await scopeTrust(file)).toBe('trusted');
    expect(await scopeTrust(file, 'tier1')).toBe('trusted');
    expect(await evidenceTrust(file, 'tier1')).toEqual(['trusted']);
    expect(await ctx.store.query(`SELECT id FROM disputes WHERE scope_id = $1 AND status = 'open'`, [tier1!.id])).toEqual([]);
    await setScopeTrust(ctx.store, { key: file, to: 'quarantined', actor: 'user' });
    expect(await scopeTrust(file, 'tier1')).toBe('quarantined');
  });
});

describe('an agent session', () => {
  it('may demote but never promote a source, nor settle a dispute; this machine\'s own client may', async () => {
    const agent = await connect({ caller: 'agent' });
    const file = 'raw/docs/notes/by-agent.md';
    const note = '---\nclaims:\n  - { subject: 宁德时代, type: earnings, statement: 2026Q2 净利润是 10 亿元, status: fact, startDate: "2026-04-01" }\nentities:\n  - { name: 宁德时代, type: organization }\n---\n# 又一条\n';
    expect((await agent('knode_write', { path: file, content: note })).isError).toBe(false);
    expect((await agent('knode_sync', { only: [file] })).isError).toBe(false);
    expect(await scopeTrust(file)).toBe('quarantined');
    const refused = await agent('knode_trust', { path: file, to: 'trusted' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/person/);
    expect(await scopeTrust(file)).toBe('quarantined');
    const dispute = (await listDisputes(ctx.store, { status: 'open' })).find((d) => d.reason.includes(file));
    expect(dispute).toBeDefined();
    expect((await agent('knode_disputes', { action: 'resolve', id: dispute!.id })).isError).toBe(true);
    expect((await listDisputes(ctx.store, { status: 'open' })).some((d) => d.id === dispute!.id)).toBe(true);
    expect((await agent('knode_disputes', { action: 'list' })).isError).toBe(false);
    expect((await agent('knode_trust', { path: 'raw/docs/report.md', to: 'quarantined' })).isError).toBe(false);
    expect(await scopeTrust('raw/docs/report.md')).toBe('quarantined');

    const owner = await connect();
    expect((await owner('knode_trust', { path: 'raw/docs/report.md', to: 'trusted' })).isError).toBe(false);
    expect(await scopeTrust('raw/docs/report.md')).toBe('trusted');
  });
});
