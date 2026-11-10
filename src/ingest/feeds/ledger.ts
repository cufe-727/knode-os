import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LEDGER_DIR } from '../../fs/layout.js';
import type { FeedItem, UnitDecision } from './types.js';

/**
 * A feed's ledger — ledger/feeds/<id>/, machine truth beside events.jsonl:
 *
 *   items/<YYYY-MM>.jsonl  every revision of every item the connector produced
 *                          (month of its publishedAt, UTC), appended, never edited
 *   index.json             item id → its latest revision's hash and month
 *   decisions.jsonl        what the filter and transform layers decided per unit,
 *                          appended; the last line for a unit wins
 *   state.json             the connector's cursor and how the last runs went
 *
 * The documents a feed writes under raw/docs are rendered from here, so a
 * changed filter, template or prompt can render the history again without
 * fetching anything, and a dropped item can be looked at and its verdict
 * questioned. The ledger is not indexed and not in the file tree.
 */

export const FEEDS_LEDGER = `${LEDGER_DIR}/feeds`;

export function feedLedgerDir(dataDir: string, feedId: string): string {
  return path.join(dataDir, FEEDS_LEDGER, feedId);
}

/** What the feed's runs leave for the next one. */
export interface FeedState {
  /** The connector's cursor (opaque here). */
  cursor?: unknown;
  /** The connector and parameters the cursor belongs to: another configuration starts over. */
  paramsKey?: string;
  firstRunAt?: string;
  lastRunAt?: string;
  /** The last run that pulled without an error. */
  lastOkAt?: string;
  lastError?: string | null;
  /** Failed runs in a row, for backoff. */
  failures?: number;
  /** The connector said more was waiting. */
  more?: boolean;
  /** Counts over the feed's life. */
  totals?: { items: number; kept: number; dropped: number };
}

interface IndexEntry {
  /** Content hash of the latest revision. */
  h: string;
  /** The month file it lives in. */
  m: string;
  /** publishedAt, threadId and replyTo: enough to find a thread's start without reading items. */
  p?: string;
  t?: string;
  r?: string;
}

/** A stable hash of what makes an item's content: the fields a person would see change. */
export function itemHash(item: FeedItem): string {
  const { observedAt: _observed, attachments, ...rest } = item;
  // where an attachment was downloaded to is ours, not the source's
  const atts = attachments?.map(({ path: _path, bytes: _bytes, ...a }) => a);
  return crypto.createHash('sha256').update(stableJson({ ...rest, attachments: atts })).digest('hex').slice(0, 20);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function monthOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '0000-00' : d.toISOString().slice(0, 7);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function readLines<T>(file: string): T[] {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // a line cut by a crash mid-append: the next pull brings the item again
    }
  }
  return out;
}

export interface UpsertResult {
  /** New items and new revisions of known ones. */
  changed: FeedItem[];
  /** Seen before with the same content. */
  unchanged: number;
}

/** One feed's ledger, opened for a run. Not safe for two writers: the runner serializes runs per feed. */
export class FeedLedger {
  readonly dir: string;
  private index: Record<string, IndexEntry> | null = null;
  private decisions: Map<string, UnitDecision> | null = null;

  constructor(readonly dataDir: string, readonly feedId: string) {
    this.dir = feedLedgerDir(dataDir, feedId);
  }

  private get indexFile(): string {
    return path.join(this.dir, 'index.json');
  }

  private loadIndex(): Record<string, IndexEntry> {
    this.index ??= readJson<Record<string, IndexEntry>>(this.indexFile, {});
    return this.index;
  }

  has(id: string): boolean {
    return id in this.loadIndex();
  }

  get size(): number {
    return Object.keys(this.loadIndex()).length;
  }

  /**
   * Keep new items and new revisions; an item seen with the same content is
   * not written again. `observedAt` is the first sighting, kept across revisions.
   */
  upsert(items: FeedItem[], now = new Date().toISOString()): UpsertResult {
    const index = this.loadIndex();
    const byMonth = new Map<string, string[]>();
    const changed: FeedItem[] = [];
    let unchanged = 0;
    const firstSeen = new Map<string, string>();
    for (const raw of items) {
      if (!raw || typeof raw.id !== 'string' || !raw.id) continue;
      const hash = itemHash(raw);
      const prev = index[raw.id];
      if (prev && prev.h === hash) {
        unchanged++;
        continue;
      }
      let observedAt = raw.observedAt ?? now;
      if (prev) {
        // the first sighting stays the first sighting
        const before = firstSeen.get(raw.id) ?? this.find(raw.id)?.observedAt;
        if (before) observedAt = before;
      }
      firstSeen.set(raw.id, observedAt);
      const item: FeedItem = { ...raw, observedAt };
      const month = monthOf(item.publishedAt);
      const lines = byMonth.get(month) ?? [];
      lines.push(JSON.stringify({ h: hash, item }));
      byMonth.set(month, lines);
      index[raw.id] = { h: hash, m: month, p: item.publishedAt, ...(item.threadId ? { t: item.threadId } : {}), ...(item.replyTo ? { r: item.replyTo } : {}) };
      changed.push(item);
    }
    for (const [month, lines] of byMonth) {
      const file = path.join(this.dir, 'items', `${month}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${lines.join('\n')}\n`);
    }
    if (changed.length) writeJson(this.indexFile, index);
    return { changed, unchanged };
  }

  /** When a kept item was published, from the index alone. */
  publishedOf(id: string): string | undefined {
    return this.loadIndex()[id]?.p;
  }

  /** Whether an item would be new or changed, without keeping it (a preview). */
  isChanged(item: FeedItem): boolean {
    const prev = this.loadIndex()[item.id];
    return !prev || prev.h !== itemHash(item);
  }

  /**
   * When the thread an item belongs to began: the earliest item sharing its
   * threadId, or the root its replyTo chain leads to. A reply is rendered in
   * its thread's document, wherever its own date falls.
   */
  threadStart(item: FeedItem): string {
    const index = this.loadIndex();
    let start = item.publishedAt;
    const earlier = (p?: string) => {
      if (p && Date.parse(p) < Date.parse(start)) start = p;
    };
    let parent = item.replyTo;
    const seen = new Set<string>();
    while (parent && index[parent] && !seen.has(parent)) {
      seen.add(parent);
      earlier(index[parent].p);
      if (index[parent].t && !item.threadId) item = { ...item, threadId: index[parent].t };
      parent = index[parent].r;
    }
    if (item.threadId) for (const e of Object.values(index)) if (e.t === item.threadId) earlier(e.p);
    return start;
  }

  /** The latest revision of one item. */
  find(id: string): FeedItem | null {
    const entry = this.loadIndex()[id];
    if (!entry) return null;
    let found: FeedItem | null = null;
    for (const line of readLines<{ h: string; item: FeedItem }>(path.join(this.dir, 'items', `${entry.m}.jsonl`))) {
      if (line.item?.id === id) found = line.item;
    }
    return found;
  }

  /** The months items are kept under, oldest first. */
  months(): string[] {
    try {
      return fs.readdirSync(path.join(this.dir, 'items')).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).map((n) => n.slice(0, 7)).sort();
    } catch {
      return [];
    }
  }

  /** The latest revision of every item kept under these months. */
  itemsIn(months: string[]): FeedItem[] {
    const latest = new Map<string, FeedItem>();
    const index = this.loadIndex();
    for (const month of [...new Set(months)].sort()) {
      for (const line of readLines<{ h: string; item: FeedItem }>(path.join(this.dir, 'items', `${month}.jsonl`))) {
        const item = line.item;
        if (!item?.id) continue;
        // only the revision the index names: an item moved to another month by an edited date lives there now
        if (index[item.id] && index[item.id].h !== line.h) continue;
        latest.set(item.id, item);
      }
    }
    return [...latest.values()];
  }

  /* ------------------------------ decisions ----------------------------- */

  private get decisionsFile(): string {
    return path.join(this.dir, 'decisions.jsonl');
  }

  private loadDecisions(): Map<string, UnitDecision> {
    if (!this.decisions) {
      this.decisions = new Map();
      for (const d of readLines<UnitDecision>(this.decisionsFile)) if (d?.unit) this.decisions.set(d.unit, d);
    }
    return this.decisions;
  }

  decision(unitId: string): UnitDecision | undefined {
    return this.loadDecisions().get(unitId);
  }

  allDecisions(): UnitDecision[] {
    return [...this.loadDecisions().values()];
  }

  recordDecisions(list: UnitDecision[]): void {
    if (!list.length) return;
    const map = this.loadDecisions();
    for (const d of list) map.set(d.unit, d);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.decisionsFile, `${list.map((d) => JSON.stringify(d)).join('\n')}\n`);
  }

  /** Rewrite decisions.jsonl with one line per unit (it only grows otherwise). */
  compactDecisions(): void {
    const list = [...this.loadDecisions().values()];
    const file = this.decisionsFile;
    if (!fs.existsSync(file)) return;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, list.length ? `${list.map((d) => JSON.stringify(d)).join('\n')}\n` : '');
    fs.renameSync(tmp, file);
  }

  /* -------------------------------- state ------------------------------- */

  state(): FeedState {
    return readJson<FeedState>(path.join(this.dir, 'state.json'), {});
  }

  saveState(state: FeedState): void {
    writeJson(path.join(this.dir, 'state.json'), state);
  }
}

/**
 * Identities seen across a workspace's feeds (ledger/feeds/.dedupe.json):
 * dedupe key → the feed and item that holds it first. The `dedupe` filter
 * with `across: workspace` drops a unit whose key another feed already holds.
 */
export class DedupeIndex {
  private readonly file: string;
  private map: Record<string, string> | null = null;
  private dirty = false;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, FEEDS_LEDGER, '.dedupe.json');
  }

  private load(): Record<string, string> {
    this.map ??= readJson<Record<string, string>>(this.file, {});
    return this.map;
  }

  /** Who holds `key`, or null. */
  holder(key: string): string | null {
    return this.load()[key] ?? null;
  }

  /** Claim `key` for `owner` (`feed:item`) unless someone holds it; true when `owner` holds it now. */
  claim(key: string, owner: string): boolean {
    const map = this.load();
    if (map[key] && map[key] !== owner) return false;
    if (!map[key]) {
      map[key] = owner;
      this.dirty = true;
    }
    return true;
  }

  /** Let go of every key a feed holds (the feed was deleted). */
  release(feedId: string): void {
    const map = this.load();
    for (const [k, v] of Object.entries(map)) {
      if (v.startsWith(`${feedId}:`)) {
        delete map[k];
        this.dirty = true;
      }
    }
  }

  save(): void {
    if (!this.dirty || !this.map) return;
    writeJson(this.file, this.map);
    this.dirty = false;
  }
}

/** A canonical form of a URL for identity: no fragment, no tracking parameters, no trailing slash. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) if (/^(utm_|spm$|from$|share|ref$|ref_src$|s$|t$)/i.test(key)) u.searchParams.delete(key);
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    const s = u.toString();
    return s.endsWith('/') && u.pathname !== '/' ? s.slice(0, -1) : s;
  } catch {
    return url.trim();
  }
}
