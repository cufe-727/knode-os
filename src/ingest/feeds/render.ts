import crypto from 'node:crypto';
import path from 'node:path';
import { writeMatter } from '../../markdown.js';
import { segmentName } from '../feishu/mirror.js';
import { feedDest } from './definitions.js';
import type { FeedConnector, FeedDefinition, FeedItem, FeedUnit, TransformOutput } from './types.js';
import { feedTimezone, Period, periodOf, zonedDate, zonedIso, zonedTime } from './units.js';

/**
 * Units → Markdown documents (docs/design/25 §5, after docs/design/08 §4–5).
 *
 * A period document holds one `##` section per kept unit, oldest first; an
 * item document is one unit. Rendering is stable: a section's bytes depend on
 * its unit alone, so a day that gains messages keeps every earlier section
 * byte-identical — its chunks, vectors and extraction are reused (as with
 * followed conversations, docs/design/24 D7). Nothing in a document says when
 * it was rendered.
 */

export interface KeptUnit {
  unit: FeedUnit;
  output: TransformOutput;
  tags: string[];
}

export interface RenderedDocument {
  /** Data-dir relative path. */
  path: string;
  content: string;
  units: number;
}

/** The folder level a unit's document sits under when the feed groups by author or channel ('' when it does not). */
export function groupOf(unit: FeedUnit, feed: Pick<FeedDefinition, 'render'>): string {
  const first = unit.items[0];
  if (feed.render.by === 'author') return segmentName(first.author?.name ?? first.author?.id ?? '', 'unknown');
  if (feed.render.by === 'channel') return segmentName(first.channel?.name ?? first.channel?.id ?? '', 'unknown');
  return '';
}

/** The period a unit's document covers. A thread belongs to the period it began in (`start`). */
export function unitPeriod(unit: FeedUnit, feed: Pick<FeedDefinition, 'render'>, start = unit.publishedAt): Period {
  return periodOf(start, feed.render.period, feedTimezone(feed.render), unit.id);
}

const short = (id: string) => crypto.createHash('sha1').update(id).digest('hex').slice(0, 8);

/** The first line of a text, cut at a sentence end or `max` characters. */
export function firstLine(text: string, max = 40): string {
  const line = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#>*_`]/g, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const sentence = /^(.{4,}?[。！？!?；;]|.{8,}?[.](?=\s))/u.exec(line)?.[1] ?? line;
  const chars = [...sentence];
  return chars.length > max ? `${chars.slice(0, max).join('').trim()}…` : sentence.trim();
}

export function unitTitle(unit: FeedUnit, output: TransformOutput): string {
  if (output.title?.trim()) return output.title.trim();
  const first = unit.items[0];
  if (first.title?.trim()) return first.title.trim();
  if (unit.kind === 'window') return `${unit.items.length} messages`;
  return firstLine(first.text ?? '') || first.id;
}

/** Where a document of `period` in `group` is written (part 1). */
export function documentPath(feed: FeedDefinition, group: string, period: Period, title: string): string {
  const base = [feedDest(feed), group].filter(Boolean).join('/');
  const [y, m] = period.date.split('-');
  switch (feed.render.period) {
    case 'day':
      return `${base}/${y}/${m}/${period.key}.md`;
    case 'week':
      return `${base}/${period.key.slice(0, 4)}/${period.key}.md`;
    case 'month':
      return `${base}/${y}/${period.key}.md`;
    default:
      return `${base}/${y}/${m}/${segmentName(title, 'item').slice(0, 60)}__${short(period.key)}.md`;
  }
}

/* --------------------------------- bodies -------------------------------- */

const hasCjk = (s: string) => /[㐀-鿿]/.test(s);

/** A message's text made safe inside a section: no line of it can start a heading or a fence of its own. */
function inert(text: string): string {
  return text.replace(/^(\s{0,3})(#{1,6}\s)/gm, '$1\\$2').replace(/^(\s{0,3})(```|~~~)/gm, '$1\\$2').trim();
}

function attachmentLines(item: FeedItem, docPath: string): string[] {
  const out: string[] = [];
  for (const a of item.attachments ?? []) {
    const label = (a.name || a.kind).replace(/[[\]]/g, '');
    if (a.path) {
      const rel = path.posix.relative(path.posix.dirname(docPath), a.path);
      out.push(a.kind === 'image' ? `![${label}](${encodeURI(rel)})` : `[${label}](${encodeURI(rel)})`);
    } else if (a.url && /^https?:/i.test(a.url)) {
      out.push(`- ${a.kind}: [${label}](${a.url})`);
    } else {
      out.push(`- ${a.kind}: ${label}`);
    }
    if (a.text?.trim()) out.push(`  ${a.text.trim().replace(/\n+/g, ' ')}`);
  }
  return out;
}

function itemBody(item: FeedItem, docPath: string): string {
  const parts: string[] = [];
  if (item.text?.trim()) parts.push(inert(item.text));
  const atts = attachmentLines(item, docPath);
  if (atts.length) parts.push(atts.join('\n'));
  return parts.join('\n\n');
}

/** The default Markdown of a unit: one item's body, a thread's posts, a window's lines. */
export function defaultUnitBody(unit: FeedUnit, feed: FeedDefinition, docPath: string): string {
  const tz = feedTimezone(feed.render);
  if (unit.kind === 'item') return itemBody(unit.items[0], docPath);
  if (unit.kind === 'thread') {
    const [root, ...replies] = unit.items;
    const lines = [itemBody(root, docPath)];
    for (const r of replies) {
      const who = r.author?.name ?? 'someone';
      const body = itemBody(r, docPath).replace(/\n/g, '\n  ');
      lines.push(`- **${who}** (${zonedDate(r.publishedAt, tz)} ${zonedTime(r.publishedAt, tz)}): ${body}`);
    }
    return lines.filter(Boolean).join('\n\n');
  }
  return unit.items
    .map((item) => {
      const who = item.author?.name ?? 'someone';
      const text = itemBody(item, docPath) || '(no text)';
      const sep = hasCjk(text) || hasCjk(who) ? '：' : ': ';
      return `- ${zonedTime(item.publishedAt, tz, true)} ${who}${sep}${text.replace(/\n/g, '\n  ')}`;
    })
    .join('\n');
}

/** What every section body passes through before it is written (the redact stage). */
export type BodyFilter = (body: string) => string;

function unitBody(kept: KeptUnit, feed: FeedDefinition, connector: FeedConnector | undefined, docPath: string, post?: BodyFilter): string {
  const body = kept.output.markdown?.trim() ? kept.output.markdown.trim() : (connector?.render?.(kept.unit, feed) ?? defaultUnitBody(kept.unit, feed, docPath)).trim();
  return post ? post(body) : body;
}

function people(unit: FeedUnit): string {
  const names = [...new Set(unit.items.map((i) => i.author?.name).filter((n): n is string => Boolean(n)))];
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
}

function metaLine(kept: KeptUnit): string {
  const first = kept.unit.items[0];
  const bits = [`id: ${kept.unit.id}`];
  if (first.url) bits.push(`[link](${first.url})`);
  if (first.origin) bits.push(`origin: ${[first.origin.platform, first.origin.account].filter(Boolean).join('/')}${first.origin.url ? ` (${first.origin.url})` : ''}`);
  if (kept.tags.length) bits.push(`tags: ${kept.tags.join(', ')}`);
  return `> ${bits.join(' · ')}`;
}

function section(kept: KeptUnit, feed: FeedDefinition, connector: FeedConnector | undefined, docPath: string, post?: BodyFilter): string {
  const tz = feedTimezone(feed.render);
  const { unit } = kept;
  const clock = (iso: string) => (feed.render.period === 'day' ? zonedTime(iso, tz) : `${zonedDate(iso, tz).slice(5)} ${zonedTime(iso, tz)}`);
  const when = unit.kind === 'window' && unit.endedAt !== unit.publishedAt ? `${clock(unit.publishedAt)}–${zonedTime(unit.endedAt, tz)}` : clock(unit.publishedAt);
  const title = unitTitle(unit, kept.output).replace(/\s+/g, ' ');
  const head = [when, people(unit), title].filter(Boolean).join(' · ');
  const lines = [`## ${head}`];
  if (kept.output.context?.trim()) lines.push(`_${kept.output.context.trim().replace(/\s+/g, ' ')}_`);
  lines.push(metaLine(kept));
  const body = unitBody(kept, feed, connector, docPath, post);
  return `${lines.join('\n')}\n\n${body}`.trim();
}

/* ------------------------------- frontmatter ----------------------------- */

const DEFAULT_TYPES: Record<string, string> = { 'feishu-chat': 'ChatArchive', email: 'Email', arxiv: 'Paper', github: 'RepositoryUpdate', rss: 'Post', x: 'Post', web: 'WebPage' };

function docType(feed: FeedDefinition, period: boolean): string {
  return feed.render.type ?? DEFAULT_TYPES[feed.connector] ?? (period ? 'FeedDigest' : 'Post');
}

export function platformOf(feed: FeedDefinition, connector: FeedConnector | undefined): string {
  const own = typeof feed.params.platform === 'string' ? feed.params.platform.trim() : '';
  return own || connector?.platformFor?.(feed) || connector?.platform || connector?.defaults?.platform || feed.connector;
}

function collect<T>(units: KeptUnit[], pick: (o: TransformOutput) => T[] | undefined): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const k of units) {
    for (const v of pick(k.output) ?? []) {
      const key = JSON.stringify(v);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(v);
      }
    }
  }
  return out;
}

function frontmatter(feed: FeedDefinition, connector: FeedConnector | undefined, units: KeptUnit[], title: string, period: Period, part: number): Record<string, unknown> {
  const tz = feedTimezone(feed.render);
  const items = units.flatMap((k) => k.unit.items);
  const platform = platformOf(feed, connector);
  const channels = [...new Map(items.filter((i) => i.channel).map((i) => [i.channel!.id, i.channel!])).values()];
  const first = units[0]?.unit;
  const last = units[units.length - 1]?.unit;
  const isItem = feed.render.period === 'item';
  const tags = new Set([`feed/${feed.id}`, `platform/${platform}`]);
  if (isItem) for (const t of [...(units[0]?.tags ?? []), ...(first?.items[0].tags ?? [])]) tags.add(t.replace(/\s+/g, '-'));
  const data: Record<string, unknown> = {
    type: docType(feed, !isItem),
    title: part > 1 ? `${title} · p${part}` : title,
    date: isItem && first ? zonedDate(first.publishedAt, tz) : period.date,
    platform,
    feed: feed.id,
  };
  if (channels.length === 1) data.channel = { id: channels[0].id, name: channels[0].name, ...(channels[0].kind ? { kind: channels[0].kind } : {}) };
  if (isItem && first) {
    const item = first.items[0];
    if (item.author?.name) data.author = item.author.name;
    if (item.url) data.source_url = item.url;
    if (item.updatedAt && item.updatedAt !== item.publishedAt) data.as_of = zonedIso(item.updatedAt, tz);
    data.published = zonedIso(item.publishedAt, tz);
    if (item.origin) data.origin = item.origin;
    if (units[0]?.output.summary) data.summary = units[0].output.summary;
  } else {
    data.items = items.length;
    data.units = units.length;
  }
  if (first && last) data.span = [zonedIso(first.publishedAt, tz), zonedIso(last.endedAt, tz)];
  data.timezone = tz;
  data.tags = [...tags];
  if (isItem && first?.items[0].url) data.sources = [{ id: 'origin', resource: first.items[0].url, title: title }];
  const entities = collect(units, (o) => o.entities);
  if (entities.length) data.entities = entities;
  const claims = collect(units, (o) => o.claims);
  if (claims.length) data.claims = claims;
  data.generated = { by: `knode-os/feeds/${feed.connector}` };
  return JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
}

/* -------------------------------- documents ------------------------------ */

/**
 * The documents one period (in one author/channel group) renders to: one,
 * or several parts when its sections pass `render.maxChars`. Empty when no
 * unit of it is kept.
 */
export function renderPeriod(feed: FeedDefinition, connector: FeedConnector | undefined, group: string, period: Period, units: KeptUnit[], post?: BodyFilter): RenderedDocument[] {
  if (units.length === 0) return [];
  const sorted = [...units].sort((a, b) => Date.parse(a.unit.publishedAt) - Date.parse(b.unit.publishedAt) || (a.unit.id < b.unit.id ? -1 : 1));
  const tz = feedTimezone(feed.render);
  if (feed.render.period === 'item') {
    const kept = sorted[0];
    const title = unitTitle(kept.unit, kept.output);
    const docPath = documentPath(feed, group, period, title);
    const intro: string[] = [`# ${title}`];
    if (kept.output.context?.trim()) intro.push(`_${kept.output.context.trim()}_`);
    const item = kept.unit.items[0];
    const by = [item.author?.name, `${zonedDate(item.publishedAt, tz)} ${zonedTime(item.publishedAt, tz)}`, item.url ? `[source](${item.url})` : ''].filter(Boolean).join(' · ');
    intro.push(`> ${by}`);
    const body = unitBody(kept, feed, connector, docPath, post);
    return [{ path: docPath, content: writeMatter(`${intro.join('\n\n')}\n\n${body}\n`, frontmatter(feed, connector, [kept], title, period, 1)), units: 1 }];
  }
  const label = feed.render.by && group ? `${feed.title} · ${group}` : feed.title;
  const title = `${label} · ${period.key}`;
  const basePath = documentPath(feed, group, period, title);
  const max = feed.render.maxChars ?? 12_000;
  const parts: KeptUnit[][] = [[]];
  const texts: string[][] = [[]];
  let size = 0;
  for (const kept of sorted) {
    const text = section(kept, feed, connector, basePath, post);
    if (parts[parts.length - 1].length > 0 && size + text.length > max) {
      parts.push([]);
      texts.push([]);
      size = 0;
    }
    parts[parts.length - 1].push(kept);
    texts[texts.length - 1].push(text);
    size += text.length + 2;
  }
  return parts.map((partUnits, i) => {
    const part = i + 1;
    const docPath = part === 1 ? basePath : basePath.replace(/\.md$/, `.p${part}.md`);
    const heading = part > 1 ? `${title} · p${part}` : title;
    // a part's sections were rendered against part 1's folder, which is the same folder
    const body = `# ${heading}\n\n${texts[i].join('\n\n')}\n`;
    return { path: docPath, content: writeMatter(body, frontmatter(feed, connector, partUnits, title, period, part)), units: partUnits.length };
  });
}
