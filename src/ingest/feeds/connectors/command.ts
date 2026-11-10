import { runCommand, runJsonCommand } from '../command.js';
import type { ConnectorContext, FeedConnector, FeedItem, PullResult } from '../types.js';

/**
 * Two connectors that let other programs feed a workspace (docs/design/25 §6).
 *
 * `push` never pulls: items arrive through POST /api/feeds/<id>/items,
 * `knode-os feeds push` or the knode_feed_push MCP tool — a crawler that
 * already runs elsewhere (rookie-trade's), a shortcut on a phone, an n8n flow,
 * an agent that found something worth keeping.
 *
 * `command` runs a program that speaks knode-feed/1 — any language, any
 * scraper. It gets one JSON object on stdin:
 *
 *   {"protocol":"knode-feed/1","command":"read","feed":{"id","title"},
 *    "params":{…},"state":<its last cursor or null>,"since":"<ISO>|null"}
 *
 * and writes JSON Lines on stdout:
 *
 *   {"type":"item","item":{…FeedItem…}}
 *   {"type":"state","state":<cursor>,"more":false}   a checkpoint: every item before it is safe
 *   {"type":"tombstone","id":"…"}                  an item deleted at the source
 *   {"type":"log","message":"…"}
 *   {"type":"error","message":"…"}
 *
 * As in Airbyte's protocol, a state message is a checkpoint: when the program
 * fails, the items before its last checkpoint are kept and the cursor moves
 * there; the rest come again next time. For "check" it answers one line
 * {"type":"check","ok":true,"message":"…"}.
 */

export const pushConnector: FeedConnector = {
  id: 'push',
  label: 'Pushed items',
  note: 'Never pulls. Items arrive through POST /api/feeds/<id>/items, `knode-os feeds push`, or the knode_feed_push MCP tool — from a crawler that runs elsewhere, a phone shortcut, an n8n or Zapier flow, an agent.',
  platform: 'push',
  pushOnly: true,
  params: [{ name: 'platform', label: 'Platform written into frontmatter and tags (default "push")', type: 'string', example: 'weibo' }],
  defaults: { units: { by: 'item' }, render: { period: 'item' }, schedule: {} },
};

export const PROTOCOL = 'knode-feed/1';

function spec(ctx: ConnectorContext) {
  const p = ctx.feed.params;
  const command = typeof p.command === 'string' ? p.command.trim() : '';
  if (!command) throw new Error('params.command is required');
  const args = Array.isArray(p.args) ? p.args.map(String) : typeof p.args === 'string' && p.args.trim() ? p.args.trim().split(/\s+/) : [];
  const env = p.env && typeof p.env === 'object' ? Object.fromEntries(Object.entries(p.env as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : {};
  const timeoutMs = Number(p.timeoutMs) > 0 ? Number(p.timeoutMs) : 15 * 60_000;
  return { command, args, env, timeoutMs };
}

async function pullCommand(ctx: ConnectorContext): Promise<PullResult> {
  const items: FeedItem[] = [];
  const notes: string[] = [];
  let checkpoint: { state: unknown; items: number; more: boolean } | null = null;
  let reported: string | null = null;
  const input = { protocol: PROTOCOL, command: 'read', feed: { id: ctx.feed.id, title: ctx.feed.title }, params: ctx.feed.params, state: ctx.state ?? null, since: ctx.since?.toISOString() ?? null };
  let failure: string | null = null;
  try {
    const res = await runCommand(spec(ctx), input, {
      cwd: ctx.dataDir,
      signal: ctx.signal,
      onLine: (line) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          notes.push(`not JSON: ${line.slice(0, 120)}`);
          return;
        }
        if (msg.type === 'item' && msg.item && typeof msg.item === 'object') items.push(msg.item as FeedItem);
        else if (msg.type === 'tombstone' && (typeof msg.id === 'string' || typeof msg.id === 'number')) items.push({ id: String(msg.id), publishedAt: '', deleted: true });
        else if (msg.type === 'state') checkpoint = { state: msg.state, items: items.length, more: msg.more === true };
        else if (msg.type === 'log' && typeof msg.message === 'string') ctx.log(msg.message);
        else if (msg.type === 'error') reported = String(msg.message ?? 'the program reported an error');
      },
    });
    if (res.code !== 0) failure = `exited with ${res.code}${res.stderr.trim() ? `: ${res.stderr.trim().slice(-300)}` : ''}`;
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  const error = reported ?? failure;
  const cp = checkpoint as { state: unknown; items: number; more: boolean } | null;
  if (error) {
    // keep what the last checkpoint covers; without one, nothing moves
    if (!cp) throw new Error(error);
    return { items: items.slice(0, cp.items), state: cp.state, more: cp.more, notes, error };
  }
  return { items, ...(cp ? { state: cp.state, more: cp.more } : {}), notes };
}

export const commandConnector: FeedConnector = {
  id: 'command',
  label: 'A program (knode-feed/1)',
  note: 'Runs a program of yours — a scraper in any language — that writes items as JSON Lines and checkpoints its cursor (docs/design/25 §6). It runs in the data directory with a minimal environment plus the env you give it.',
  platform: 'command',
  params: [
    { name: 'command', label: 'Executable (absolute, ~/…, ./… under the data dir, or a name on PATH)', type: 'string', required: true, example: '~/Projects/rookie-trade/crawler/knode-feed.mjs' },
    { name: 'args', label: 'Arguments', type: 'string[]' },
    { name: 'env', label: 'Environment ("env:VAR" allowed)', type: 'string' },
    { name: 'timeoutMs', label: 'Longest a pull may take (default 15 min)', type: 'number' },
    { name: 'platform', label: 'Platform written into frontmatter and tags', type: 'string' },
  ],
  defaults: { units: { by: 'item' }, render: { period: 'item' }, schedule: { every: '1h' } },
  async check(ctx) {
    const answer = await runJsonCommand<{ ok?: boolean; message?: string }>(spec(ctx), { protocol: PROTOCOL, command: 'check', feed: { id: ctx.feed.id, title: ctx.feed.title }, params: ctx.feed.params }, { cwd: ctx.dataDir, signal: ctx.signal });
    return { ok: answer.ok !== false, message: answer.message ?? (answer.ok === false ? 'the program says it cannot read its source' : 'ok') };
  },
  pull: pullCommand,
};
