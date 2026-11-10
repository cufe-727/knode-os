import crypto from 'node:crypto';
import { itemHash } from './ledger.js';
import type { FeedItem, FeedUnit, RenderSpec, UnitSpec } from './types.js';

/**
 * Items → units (what the filter and transform layers decide on) and units →
 * periods (what a document holds). Both are pure functions of the items, so a
 * period rendered again from the ledger comes out the same.
 */

const DEFAULT_GAP_MINUTES = 30;
const DEFAULT_WINDOW_ITEMS = 40;
const DEFAULT_WINDOW_CHARS = 3000;

const time = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

function byTime(a: FeedItem, b: FeedItem): number {
  return time(a.publishedAt) - time(b.publishedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function unitOf(kind: FeedUnit['kind'], items: FeedItem[]): FeedUnit {
  const sorted = [...items].sort(byTime);
  const hash = crypto.createHash('sha256').update(sorted.map((i) => `${i.id}:${itemHash(i)}`).join('\n')).digest('hex').slice(0, 20);
  return { id: sorted[0].id, kind, items: sorted, hash, publishedAt: sorted[0].publishedAt, endedAt: sorted[sorted.length - 1].publishedAt };
}

/** The units a set of items makes; deleted items take no part. */
export function buildUnits(items: FeedItem[], spec: UnitSpec): FeedUnit[] {
  const live = items.filter((i) => !i.deleted).sort(byTime);
  if (spec.by === 'item') return live.map((i) => unitOf('item', [i]));
  if (spec.by === 'thread') {
    // a reply joins its thread; a reply to a reply follows its parent
    const byId = new Map(live.map((i) => [i.id, i]));
    const rootOf = (item: FeedItem): string => {
      if (item.threadId) return `t:${item.threadId}`;
      let cur = item;
      const seen = new Set<string>();
      while (cur.replyTo && byId.has(cur.replyTo) && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = byId.get(cur.replyTo)!;
      }
      return cur.threadId ? `t:${cur.threadId}` : `i:${cur.id}`;
    };
    const groups = new Map<string, FeedItem[]>();
    for (const item of live) {
      const key = rootOf(item);
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups.values()].map((g) => unitOf(g.length > 1 ? 'thread' : 'item', g)).sort((a, b) => time(a.publishedAt) - time(b.publishedAt));
  }
  // windows: per channel, cut where the conversation went quiet or the window grew too long
  const gap = (spec.gapMinutes ?? DEFAULT_GAP_MINUTES) * 60_000;
  const maxItems = spec.maxItems ?? DEFAULT_WINDOW_ITEMS;
  const maxChars = spec.maxChars ?? DEFAULT_WINDOW_CHARS;
  const byChannel = new Map<string, FeedItem[]>();
  for (const item of live) {
    const key = item.channel?.id ?? '';
    byChannel.set(key, [...(byChannel.get(key) ?? []), item]);
  }
  const out: FeedUnit[] = [];
  for (const list of byChannel.values()) {
    let current: FeedItem[] = [];
    let chars = 0;
    for (const item of list) {
      const len = (item.text ?? '').length;
      const last = current[current.length - 1];
      if (current.length && (time(item.publishedAt) - time(last.publishedAt) > gap || current.length >= maxItems || chars + len > maxChars)) {
        out.push(unitOf(current.length > 1 ? 'window' : 'item', current));
        current = [];
        chars = 0;
      }
      current.push(item);
      chars += len;
    }
    if (current.length) out.push(unitOf(current.length > 1 ? 'window' : 'item', current));
  }
  return out.sort((a, b) => time(a.publishedAt) - time(b.publishedAt));
}

/* --------------------------------- time ---------------------------------- */

/** The machine's zone, unless the feed names one. */
export function feedTimezone(render: Pick<RenderSpec, 'timezone'>): string {
  return render.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock parts of an instant in a zone. */
export function zonedParts(iso: string | Date, timeZone: string): ZonedParts {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timeZone, f);
  }
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const parts = Object.fromEntries(f.formatToParts(Number.isNaN(d.getTime()) ? new Date(0) : d).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second) };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function zonedDate(iso: string, timeZone: string): string {
  const p = zonedParts(iso, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function zonedTime(iso: string, timeZone: string, seconds = false): string {
  const p = zonedParts(iso, timeZone);
  return seconds ? `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` : `${pad(p.hour)}:${pad(p.minute)}`;
}

/** An instant as ISO 8601 with the zone's offset, e.g. 2026-11-09T10:30:00+08:00. */
export function zonedIso(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = zonedParts(d, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offset = Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** ISO week of a calendar date: [week-year, week]. */
export function isoWeek(year: number, month: number, day: number): [number, number] {
  const d = new Date(Date.UTC(year, month - 1, day));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return [d.getUTCFullYear(), Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7)];
}

/** The Monday of an ISO week, as YYYY-MM-DD. */
function isoWeekMonday(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (dow - 1));
  return d.toISOString().slice(0, 10);
}

export interface Period {
  /** 2026-11-09, 2026-W45, 2026-11, or the unit's id for item documents. */
  key: string;
  /** The date a document of this period is dated: the day, the week's Monday, the month's first. */
  date: string;
  /** Months (UTC, as the ledger shards them) whose items may fall in this period. */
  months: string[];
}

function monthsAround(date: string, days: number): string[] {
  const start = Date.parse(`${date}T00:00:00Z`);
  const out = new Set<string>();
  for (let t = start - 86_400_000; t <= start + (days + 1) * 86_400_000; t += 86_400_000) out.add(new Date(t).toISOString().slice(0, 7));
  return [...out].sort();
}

/** The period an instant falls in. */
export function periodOf(iso: string, period: RenderSpec['period'], timeZone: string, unitId = ''): Period {
  const p = zonedParts(iso, timeZone);
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  if (period === 'day') return { key: date, date, months: monthsAround(date, 1) };
  if (period === 'week') {
    const [wy, w] = isoWeek(p.year, p.month, p.day);
    const monday = isoWeekMonday(p.year, p.month, p.day);
    return { key: `${wy}-W${pad(w)}`, date: monday, months: monthsAround(monday, 7) };
  }
  if (period === 'month') {
    const first = `${p.year}-${pad(p.month)}-01`;
    return { key: `${p.year}-${pad(p.month)}`, date: first, months: monthsAround(first, 31) };
  }
  return { key: unitId, date, months: monthsAround(date, 1) };
}
