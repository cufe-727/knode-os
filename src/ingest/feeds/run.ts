import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LlmConfig } from '../../config.js';
import { safePath } from '../../fs/files.js';
import { setScopeTrust } from '../../lineage/trust.js';
import { storableText } from '../../markdown.js';
import { pluginRegistry } from '../../plugins/registry.js';
import { decodeText, guardedFetch } from '../../research/fetch.js';
import { search } from '../../search/search.js';
import { redactSecrets } from '../conversations/render.js';
import { isConvertibleFile } from '../convert.js';
import { htmlToMarkdown } from '../converters/html.js';
import { writeIfChanged } from '../feishu/mirror.js';
import { holdDest } from '../folders.js';
import { sync, SyncContext, SyncStats } from '../sync.js';
import { feedDest, feedProblem, feedSecret, pipelineKey } from './definitions.js';
import { canonicalUrl, DedupeIndex, FeedLedger, FeedState, monthOf } from './ledger.js';
import { groupOf, KeptUnit, renderPeriod, unitPeriod, unitTitle } from './render.js';
import { redacts, runFilterLayer, runTransformLayer, StageRuntime } from './stages.js';
import type { ConnectorContext, FeedAttachment, FeedConnector, FeedDefinition, FeedItem, FeedUnit, TransformOutput, UnitDecision } from './types.js';
import { buildUnits, Period } from './units.js';

/**
 * One run of a feed (docs/design/26 §3):
 *
 *   pull (connector, from its cursor) + pushed items
 *     → normalize → keep in the ledger (new items and new revisions only)
 *     → the periods those items fall in, and those of units still pending
 *     → units of each period → filter → transform (cached per unit hash and pipeline key)
 *     → render each period's documents → write those that changed → one scoped sync
 *
 * The cursor is committed only after the items it covers are in the ledger,
 * so a crash between the two pulls them again rather than losing them. Runs
 * of one feed never overlap (`runFeed` queues them).
 */

export interface FeedRunOptions {
  /** Ask the connector for new items (default: unless it only takes pushes). */
  pull?: boolean;
  /** Items pushed in (POST /api/feeds/:id/items, `knode-os feeds push`). */
  items?: unknown[];
  /** A preview: nothing is kept, written or synced; the documents come back in the result. */
  dryRun?: boolean;
  /** Decide every unit the run renders again, ignoring cached decisions. */
  redecide?: boolean;
  /** Render every period the ledger holds, not only those that changed. */
  all?: boolean;
  /** Index what was written (default true). */
  sync?: boolean;
  /** Why a model stage must wait (the quota floor), or null. */
  hold?: (llm: LlmConfig) => Promise<string | null>;
  limiter?: StageRuntime['limiter'];
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
  /** Tests: the client a model stage runs on. */
  clientFor?: StageRuntime['clientFor'];
  now?: Date;
}

export interface FeedRunDocument {
  path: string;
  written: boolean;
  units: number;
  /** Previews only. */
  content?: string;
}

export interface FeedRunResult {
  feed: string;
  ok: boolean;
  /** The pull failed (what was pushed and what was pending still went through). */
  error: string | null;
  pulled: number;
  pushed: number;
  /** New items and new revisions. */
  changed: number;
  unchanged: number;
  /** Units decided this run (not from cache). */
  decided: number;
  kept: number;
  dropped: number;
  pending: number;
  documents: FeedRunDocument[];
  removed: string[];
  more: boolean;
  notes: string[];
  sync: SyncStats | null;
  /** Per unit decided this run: what happened to it (previews and the CLI show it). */
  decisions: Array<{ unit: string; kind: FeedUnit['kind']; status: UnitDecision['status']; by: string; reason?: string; score?: number; title: string }>;
}

/* -------------------------------- helpers -------------------------------- */

const queues = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(job, job);
  const settled = next.catch(() => {});
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return next;
}

const MAX_TEXT = 200_000;

function validIso(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return null;
  const n = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(String(value));
  const d = typeof value === 'object' ? value : new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Items that came without a date of their own: they take the date they were first seen. */
const undated = new WeakSet<FeedItem>();

/** An item as the ledger keeps it, or null when it has no identity. HTML becomes Markdown here. */
export function normalizeItem(raw: unknown, now: Date): FeedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const url = typeof r.url === 'string' && r.url.trim() ? r.url.trim() : undefined;
  const id = typeof r.id === 'string' || typeof r.id === 'number' ? String(r.id).trim() : url ? canonicalUrl(url) : '';
  if (!id) return null;
  let text = typeof r.text === 'string' ? r.text : undefined;
  if ((!text || !text.trim()) && typeof r.html === 'string' && r.html.trim()) {
    text = htmlToMarkdown(r.html, { baseUrl: url, whole: true }).markdown;
  }
  const dated = validIso(r.publishedAt) ?? validIso(r.date);
  const item: FeedItem = { id: id.slice(0, 500), publishedAt: dated ?? now.toISOString() };
  if (!dated) undated.add(item);
  if (url) item.url = url;
  if (typeof r.title === 'string' && r.title.trim()) item.title = storableText(r.title.trim()).slice(0, 500);
  if (text !== undefined) item.text = storableText(text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[… ${text.length - MAX_TEXT} more characters]` : text).trim();
  const author = r.author as Record<string, unknown> | string | undefined;
  if (typeof author === 'string' && author.trim()) item.author = { name: author.trim() };
  else if (author && typeof author === 'object' && (author.name || author.id)) item.author = { name: String(author.name ?? author.id), ...(author.id ? { id: String(author.id) } : {}), ...(author.url ? { url: String(author.url) } : {}) };
  const channel = r.channel as Record<string, unknown> | undefined;
  if (channel && typeof channel === 'object' && (channel.id || channel.name)) item.channel = { id: String(channel.id ?? channel.name), name: String(channel.name ?? channel.id), ...(channel.kind ? { kind: String(channel.kind) } : {}) };
  const updated = validIso(r.updatedAt);
  if (updated) item.updatedAt = updated;
  const observed = validIso(r.observedAt);
  if (observed) item.observedAt = observed;
  if (r.format === 'text') item.format = 'text';
  for (const key of ['threadId', 'replyTo', 'lang', 'dedupeKey'] as const) if (typeof r[key] === 'string' && (r[key] as string).trim()) item[key] = (r[key] as string).trim();
  if (Array.isArray(r.attachments)) {
    const kinds = new Set(['image', 'file', 'audio', 'video', 'link']);
    item.attachments = (r.attachments as Array<Record<string, unknown>>)
      .filter((a) => a && typeof a === 'object' && kinds.has(String(a.kind)))
      .map((a) => JSON.parse(JSON.stringify({ kind: a.kind, url: a.url, path: a.path, name: a.name, mime: a.mime, bytes: a.bytes, text: a.text })) as FeedAttachment);
    if (!item.attachments.length) delete item.attachments;
  }
  if (Array.isArray(r.tags)) item.tags = r.tags.map(String).map((t) => t.trim()).filter(Boolean).slice(0, 30);
  if (r.origin && typeof r.origin === 'object' && (r.origin as Record<string, unknown>).platform) item.origin = JSON.parse(JSON.stringify(r.origin));
  if (r.meta && typeof r.meta === 'object' && !Array.isArray(r.meta)) item.meta = JSON.parse(JSON.stringify(r.meta));
  if (r.deleted === true) item.deleted = true;
  return item;
}

export function connectorContext(ctx: SyncContext, feed: FeedDefinition, state: unknown, since: Date | null, log: (m: string) => void, signal: AbortSignal): ConnectorContext {
  const web = ctx.config.research.web;
  return {
    dataDir: ctx.dataDir,
    config: ctx.config,
    feed,
    state,
    since,
    signal,
    secret: feedSecret,
    log: (m) => log(`feed ${feed.id}: ${m}`),
    async fetch(url, opts = {}) {
      const res = await guardedFetch(url, web, {
        headers: opts.headers,
        accept: opts.accept,
        maxBytes: opts.maxBytes ?? 20 * 1024 * 1024,
        timeoutMs: opts.timeoutMs ?? 60_000,
        trusted: opts.trusted ?? true,
        allowErrorStatus: opts.allowErrorStatus,
      });
      const { text } = decodeText(res.body, res.charset, res.contentType);
      return { status: res.status, url: res.finalUrl, headers: res.headers, contentType: res.contentType, text, body: res.body };
    },
  };
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp', 'image/tiff': '.tiff',
  'application/pdf': '.pdf', 'text/html': '.html', 'application/epub+zip': '.epub',
};

/** Download what items carry into <dest>/assets/, so the Convert stage reads it; once per attachment. */
async function downloadAttachments(ctx: SyncContext, feed: FeedDefinition, connector: FeedConnector, cctx: ConnectorContext, items: FeedItem[], dest: string, log: (m: string) => void): Promise<void> {
  const assets = `${dest}/assets`;
  const assetsAbs = safePath(ctx.dataDir, assets);
  let budget = 100;
  for (const item of items) {
    for (const att of item.attachments ?? []) {
      if (att.path || att.kind === 'link' || budget <= 0) continue;
      const name = crypto.createHash('sha1').update(`${feed.id}\0${att.url ?? ''}\0${att.name ?? ''}`).digest('hex').slice(0, 16);
      const existing = fs.existsSync(assetsAbs) ? fs.readdirSync(assetsAbs).find((f) => f.startsWith(`${name}.`)) : undefined;
      if (existing) {
        att.path = `${assets}/${existing}`;
        continue;
      }
      budget--;
      try {
        fs.mkdirSync(assetsAbs, { recursive: true });
        if (connector.download) {
          const got = await connector.download(cctx, item, att, path.join(assetsAbs, name));
          if (got) {
            att.path = path.relative(ctx.dataDir, got.path).split(path.sep).join('/');
            if (got.mime) att.mime = got.mime;
            att.bytes = got.bytes;
          }
          continue;
        }
        if (!att.url || !/^https?:/i.test(att.url)) continue;
        const res = await guardedFetch(att.url, ctx.config.research.web, { maxBytes: feed.attachments.maxBytes, timeoutMs: 60_000, trusted: false });
        if (res.truncated) continue;
        const fromUrl = path.extname(new URL(res.finalUrl).pathname).toLowerCase();
        const ext = EXT_BY_MIME[res.contentType] ?? (fromUrl && fromUrl.length <= 6 ? fromUrl : '');
        if (!ext || !isConvertibleFile(`x${ext}`)) continue;
        fs.writeFileSync(path.join(assetsAbs, `${name}${ext}`), res.body);
        att.path = `${assets}/${name}${ext}`;
        att.mime = res.contentType || att.mime;
        att.bytes = res.body.length;
      } catch (err) {
        log(`feed ${feed.id}: could not download ${att.url ?? att.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}

async function fetchPage(ctx: SyncContext, url: string): Promise<{ title: string | null; markdown: string }> {
  const res = await guardedFetch(url, ctx.config.research.web, { maxBytes: 5 * 1024 * 1024, timeoutMs: 45_000, trusted: false, accept: 'text/html,application/xhtml+xml,text/plain;q=0.8' });
  const { text } = decodeText(res.body, res.charset, res.contentType);
  if (/html|xml/.test(res.contentType) || /^\s*</.test(text)) {
    const conv = htmlToMarkdown(text, { baseUrl: res.finalUrl });
    return { title: conv.meta.title, markdown: conv.markdown };
  }
  return { title: null, markdown: text };
}

interface DocsIndex {
  [docKey: string]: string[];
}

function readDocsIndex(ledger: FeedLedger): DocsIndex {
  try {
    return JSON.parse(fs.readFileSync(path.join(ledger.dir, 'docs.json'), 'utf8')) as DocsIndex;
  } catch {
    return {};
  }
}

function writeDocsIndex(ledger: FeedLedger, docs: DocsIndex): void {
  fs.mkdirSync(ledger.dir, { recursive: true });
  const file = path.join(ledger.dir, 'docs.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(docs));
  fs.renameSync(`${file}.tmp`, file);
}

function paramsKey(feed: FeedDefinition): string {
  return crypto.createHash('sha256').update(`${feed.connector}\0${JSON.stringify(feed.params)}`).digest('hex').slice(0, 16);
}

/* ---------------------------------- run ---------------------------------- */

/** Run a feed once: pull, decide, render, write, index. */
export function runFeed(ctx: SyncContext, feed: FeedDefinition, opts: FeedRunOptions = {}): Promise<FeedRunResult> {
  return serialize(`${ctx.dataDir}\0${feed.id}`, () => runFeedNow(ctx, feed, opts));
}

async function runFeedNow(ctx: SyncContext, feed: FeedDefinition, opts: FeedRunOptions): Promise<FeedRunResult> {
  const problem = feedProblem(feed);
  if (problem) throw new Error(`feed ${feed.id}: ${problem}`);
  const connector = pluginRegistry().feedConnector(feed.connector)!;
  const log = opts.onProgress ?? (() => {});
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const ledger = new FeedLedger(ctx.dataDir, feed.id);
  const state: FeedState = ledger.state();
  const dest = feedDest(feed);
  const abort = new AbortController();
  const signal = opts.signal ?? abort.signal;
  const result: FeedRunResult = {
    feed: feed.id, ok: true, error: null, pulled: 0, pushed: 0, changed: 0, unchanged: 0, decided: 0, kept: 0, dropped: 0, pending: 0,
    documents: [], removed: [], more: false, notes: [], sync: null, decisions: [],
  };

  // a feed whose connector or parameters changed starts over from its backfill: the old cursor means nothing to it
  const pkeyParams = paramsKey(feed);
  const cursor = state.paramsKey === pkeyParams ? state.cursor : undefined;

  /* 1. pull */
  let incoming: FeedItem[] = [];
  let nextCursor = cursor;
  const pull = opts.pull ?? !connector.pushOnly;
  const since = cursor === undefined ? new Date(now.getTime() - (feed.backfillDays ?? connector.defaults?.backfillDays ?? 7) * 86_400_000) : null;
  const cctx = connectorContext(ctx, feed, cursor, since, log, signal);
  if (pull && connector.pull) {
    log(`feed ${feed.id}: pulling from ${connector.label}`);
    try {
      const pulled = await connector.pull(cctx);
      const items = (pulled.items ?? []).map((i) => normalizeItem(i, now)).filter((i): i is FeedItem => i !== null);
      // the first pull's horizon, by the last time an item changed or reached the source: an old issue edited this
      // week counts, and so does a post relayed into a group today that was written last month (meta.deliveredAt)
      const latest = (i: FeedItem) => Math.max(Date.parse(i.publishedAt), Date.parse(i.updatedAt ?? '') || 0, Date.parse(String(i.meta?.deliveredAt ?? '')) || 0);
      incoming = since ? items.filter((i) => latest(i) >= since.getTime() - 86_400_000) : items;
      result.pulled = incoming.length;
      nextCursor = pulled.state === undefined ? cursor : pulled.state;
      result.more = Boolean(pulled.more);
      result.notes.push(...(pulled.notes ?? []));
      if (pulled.error) {
        // partial progress: what came before the failure is kept and the cursor moves to it
        result.ok = false;
        result.error = pulled.error;
      }
    } catch (err) {
      result.ok = false;
      result.error = err instanceof Error ? err.message : String(err);
      log(`feed ${feed.id}: pull failed: ${result.error}`);
    }
  }
  const pushed = (opts.items ?? []).map((i) => normalizeItem(i, now)).filter((i): i is FeedItem => i !== null);
  result.pushed = pushed.length;
  incoming.push(...pushed);
  // an undated item keeps the date it was first seen, or every pull would make it new again
  for (const item of incoming) {
    if (!undated.has(item)) continue;
    const first = ledger.publishedOf(item.id);
    if (first) item.publishedAt = first;
  }

  /* 2. keep what is new */
  // where a changed item was dated before: a revision that moved to another period leaves its old document too
  const movedFrom = new Map<string, string>();
  for (const item of incoming) {
    const before = ledger.publishedOf(item.id);
    if (before && before !== item.publishedAt) movedFrom.set(item.id, before);
  }
  let changed: FeedItem[];
  if (dryRun) {
    changed = incoming.filter((i) => ledger.isChanged(i));
    result.unchanged = incoming.length - changed.length;
  } else {
    if (feed.attachments.download) {
      const fresh = incoming.filter((i) => ledger.isChanged(i));
      if (fresh.some((i) => i.attachments?.length)) await downloadAttachments(ctx, feed, connector, cctx, fresh, dest, log);
    }
    const up = ledger.upsert(incoming, now.toISOString());
    changed = up.changed;
    result.unchanged = up.unchanged;
    if (pull && nextCursor !== cursor) {
      // a pull that threw returns no cursor (nextCursor stays the old one); one that stopped part way returns its own
      state.cursor = nextCursor;
      state.paramsKey = pkeyParams;
    } else if (pull && !result.error) {
      state.paramsKey = pkeyParams;
    }
  }
  result.changed = changed.length;

  /* 3. which periods to render */
  const pkey = pipelineKey(ctx.dataDir, feed);
  const pendingDecisions = ledger.allDecisions().filter((d) => d.status === 'pending');
  const changedIds = new Set(changed.map((i) => i.id));
  const pendingIds = new Set(pendingDecisions.map((d) => d.unit));
  const startOf = (item: FeedItem) => (feed.units.by === 'thread' ? ledger.threadStart(item) : item.publishedAt);
  const months = new Set<string>();
  const around = (iso: string) => {
    const t = Date.parse(iso);
    for (const d of [-1, 0, 1]) months.add(monthOf(new Date(t + d * 16 * 86_400_000).toISOString()));
  };
  if (opts.all) for (const m of ledger.months()) months.add(m);
  for (const item of changed) around(startOf(item));
  for (const d of pendingDecisions) around(d.publishedAt);
  for (const [id, before] of movedFrom) if (changedIds.has(id)) around(before);
  // a thread's replies may come weeks after it began
  if (feed.units.by === 'thread') for (const m of [...months]) for (let k = 1; k <= 2; k++) months.add(monthOf(new Date(Date.parse(`${m}-15T00:00:00Z`) + k * 30 * 86_400_000).toISOString()));

  const pool = new Map<string, FeedItem>();
  for (const item of ledger.itemsIn([...months])) pool.set(item.id, item);
  // a preview has not kept its items: they join the pool as they would after the run
  if (dryRun) for (const item of changed) pool.set(item.id, item);

  const units = months.size || dryRun ? buildUnits([...pool.values()], feed.units) : [];
  const targets = new Map<string, { group: string; period: Period }>();
  const unitKey = (u: FeedUnit) => {
    const group = groupOf(u, feed);
    const period = unitPeriod(u, feed);
    return { key: `${group}\0${period.key}`, group, period };
  };
  for (const u of units) {
    if (opts.all || pendingIds.has(u.id) || u.items.some((i) => changedIds.has(i.id))) {
      const k = unitKey(u);
      targets.set(k.key, { group: k.group, period: k.period });
    }
  }
  // the period a moved item left is rendered again without it
  for (const item of changed) {
    const before = movedFrom.get(item.id);
    if (!before || feed.render.period === 'item') continue;
    const was: FeedUnit = { id: item.id, kind: 'item', items: [item], hash: '', publishedAt: before, endedAt: before };
    const k = unitKey(was);
    if (!targets.has(k.key)) targets.set(k.key, { group: k.group, period: k.period });
  }
  const inTarget = units.filter((u) => targets.has(unitKey(u).key));
  // a pending unit that no longer exists — its window merged into another, its items deleted — is settled
  const built = new Set(units.map((u) => u.id));
  const superseded = pendingDecisions.filter((d) => !built.has(d.unit));
  if (superseded.length && !dryRun) {
    ledger.recordDecisions(superseded.map((d) => ({ ...d, status: 'drop' as const, by: 'superseded', reason: 'its items now belong to another unit, or were deleted', at: now.toISOString() })));
  }
  if (inTarget.length) log(`feed ${feed.id}: ${changed.length} new or changed item(s), ${targets.size} document period(s) to render`);

  /* 4. decide what is not decided */
  const decisions = new Map<string, UnitDecision>();
  const toDecide: FeedUnit[] = [];
  for (const u of inTarget) {
    const d = ledger.decision(u.id);
    if (!opts.redecide && d && d.hash === u.hash && d.pipeline === pkey && d.status !== 'pending') decisions.set(u.id, d);
    else toDecide.push(u);
  }
  if (toDecide.length) {
    const rt: StageRuntime = {
      dataDir: ctx.dataDir,
      config: ctx.config,
      feed,
      log,
      signal,
      hold: opts.hold,
      limiter: opts.limiter,
      dedupe: new DedupeIndex(ctx.dataDir),
      dryRun,
      clientFor: opts.clientFor,
      budget: { calls: feed.maxModelCalls },
      fetchPage: (url) => fetchPage(ctx, url),
      similar: async (text, k) => (await search(ctx.store, ctx.embedder, text, { k, track: false })).map((r) => ({ path: r.path, text: r.content })),
    };
    log(`feed ${feed.id}: deciding ${toDecide.length} unit(s)`);
    const filtered = await runFilterLayer(rt, toDecide);
    const keep = toDecide.filter((u) => filtered.get(u.id)?.status === 'keep');
    const transformed = keep.length ? await runTransformLayer(rt, keep) : new Map();
    if (!dryRun) rt.dedupe.save();
    const at = now.toISOString();
    const fresh: UnitDecision[] = [];
    for (const u of toDecide) {
      const f = filtered.get(u.id)!;
      const t = transformed.get(u.id);
      let status: UnitDecision['status'] = f.status;
      let by = f.by;
      let reason = f.reason;
      if (status === 'keep' && t && t.status !== 'ok') {
        status = t.status === 'drop' ? 'drop' : 'pending';
        by = t.by ?? by;
        reason = t.reason ?? reason;
      }
      const output: TransformOutput | undefined = status === 'keep' && t ? t.output : undefined;
      const group = groupOf(u, feed);
      const d: UnitDecision = {
        unit: u.id, hash: u.hash, status, by, pipeline: pkey, publishedAt: u.publishedAt, at,
        ...(group ? { group } : {}),
        ...(f.score !== undefined ? { score: f.score } : {}),
        ...(reason ? { reason } : {}),
        ...(f.tags?.length ? { tags: f.tags } : {}),
        ...(output && Object.keys(output).length ? { output } : {}),
      };
      decisions.set(u.id, d);
      fresh.push(d);
      result.decisions.push({ unit: u.id, kind: u.kind, status, by, ...(reason ? { reason } : {}), ...(f.score !== undefined ? { score: f.score } : {}), title: unitTitle(u, output ?? {}) });
    }
    if (!dryRun) ledger.recordDecisions(fresh);
    result.decided = fresh.length;
    result.kept = fresh.filter((d) => d.status === 'keep').length;
    result.dropped = fresh.filter((d) => d.status === 'drop').length;
    result.pending = fresh.filter((d) => d.status === 'pending').length;
  }

  /* 5. render, write, index */
  const post = redacts(feed) ? (body: string) => redactSecrets(body).text : undefined;
  const docsIndex = readDocsIndex(ledger);
  const written: string[] = [];
  const removed: string[] = [];
  const release = dryRun ? () => {} : holdDest(ctx.dataDir, dest);
  try {
    for (const [key, target] of targets) {
      const kept: KeptUnit[] = inTarget
        .filter((u) => unitKey(u).key === key && decisions.get(u.id)?.status === 'keep')
        .map((u) => {
          const d = decisions.get(u.id)!;
          // what the filter said it is about, then what the transforms tagged it with
          return { unit: u, output: d.output ?? {}, tags: [...new Set([...(d.tags ?? []), ...(d.output?.tags ?? [])])] };
        });
      const docs = renderPeriod(feed, connector, target.group, target.period, kept, post);
      const before = docsIndex[key] ?? [];
      for (const doc of docs) {
        if (dryRun) {
          result.documents.push({ path: doc.path, written: false, units: doc.units, content: doc.content });
          continue;
        }
        const didWrite = writeIfChanged(safePath(ctx.dataDir, doc.path), doc.content);
        if (didWrite) written.push(doc.path);
        result.documents.push({ path: doc.path, written: didWrite, units: doc.units });
      }
      const now = docs.map((d) => d.path);
      for (const old of before) {
        if (now.includes(old) || !(old === dest || old.startsWith(`${dest}/`))) continue;
        if (!dryRun && fs.existsSync(safePath(ctx.dataDir, old))) {
          fs.rmSync(safePath(ctx.dataDir, old), { force: true });
          removed.push(old);
        }
      }
      if (now.length) docsIndex[key] = now;
      else delete docsIndex[key];
    }
    if (!dryRun) writeDocsIndex(ledger, docsIndex);
    result.removed = removed;
    // what the run did is kept before it is indexed: the documents and the ledger are on disk, and indexing
    // waits its turn behind every other sync in the process (a startup sync of a large workspace can take
    // many minutes) — a crash in that wait leaves files the next sync indexes, never a lost cursor
    if (!dryRun) {
      const at = now.toISOString();
      state.firstRunAt ??= at;
      state.lastRunAt = at;
      if (!result.error) {
        if (pull) state.lastOkAt = at;
        state.failures = 0;
        state.lastError = null;
      } else {
        state.failures = (state.failures ?? 0) + 1;
        state.lastError = result.error;
      }
      state.more = result.more;
      const totals = state.totals ?? { items: 0, kept: 0, dropped: 0 };
      state.totals = { items: ledger.size, kept: totals.kept + result.kept, dropped: totals.dropped + result.dropped };
      ledger.saveState(state);
      if (result.decided > 500) ledger.compactDecisions();
    }
    const keys = [...written, ...removed];
    if (!dryRun && keys.length && opts.sync !== false) {
      result.sync = await sync(ctx, { only: keys, onProgress: log });
      if (feed.trust === 'quarantine') {
        for (const key of written) await setScopeTrust(ctx.store, { key, to: 'quarantined', actor: `feed:${feed.id}` }).catch(() => {});
      }
    }
  } finally {
    release();
  }

  if (result.decided || written.length || removed.length) {
    log(`feed ${feed.id}: ${result.changed} new or changed, ${result.kept} kept, ${result.dropped} dropped, ${result.pending} pending; ${written.length} document(s) written${removed.length ? `, ${removed.length} removed` : ''}`);
  }
  return result;
}

/** Push items into a feed: kept and processed like pulled ones (the connector is not asked). */
export function pushToFeed(ctx: SyncContext, feed: FeedDefinition, items: unknown[], opts: Omit<FeedRunOptions, 'items' | 'pull'> = {}): Promise<FeedRunResult> {
  return runFeed(ctx, feed, { ...opts, items, pull: false });
}

/** What a run would pull, decide and write, without keeping or writing anything. Model stages do run. */
export function previewFeed(ctx: SyncContext, feed: FeedDefinition, opts: Omit<FeedRunOptions, 'dryRun'> = {}): Promise<FeedRunResult> {
  return runFeed(ctx, feed, { ...opts, dryRun: true, sync: false });
}
