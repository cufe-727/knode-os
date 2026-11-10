import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from '../../compiler/intents.js';
import { resolveSecret } from '../../config.js';
import { sanitizeRelativePath } from '../../fs/files.js';
import { CONFIG_DIR, RAW_DOCS } from '../../fs/layout.js';
import { writeMatter } from '../../markdown.js';
import { pluginRegistry } from '../../plugins/registry.js';
import type { FeedConnector, FeedDefinition, RenderSpec, Rule, RuleCondition, ScheduleSpec, StageSpec, UnitSpec } from './types.js';

/**
 * Feed definitions: one YAML file each under playbooks/feeds/<id>.yaml,
 * like research sources and agents — edited in Settings, by `knode-os feeds`,
 * or in the file. playbooks/ is outside every file API's writable roots, so
 * only an administrator (or someone with the data directory) can make a feed
 * run a command or name a model.
 */

export const FEEDS_DIR = `${CONFIG_DIR}/feeds`;
/** Where a feed writes unless its render.dest says otherwise. */
export const FEEDS_ROOT = `${RAW_DOCS}/feeds`;

const STAGE_KINDS: StageSpec['kind'][] = ['rules', 'dedupe', 'udf', 'command', 'llm', 'agent', 'template', 'redact', 'fetch'];
const FILTER_KINDS = new Set<StageSpec['kind']>(['rules', 'dedupe', 'udf', 'command', 'llm', 'agent']);
const TRANSFORM_KINDS = new Set<StageSpec['kind']>(['udf', 'command', 'llm', 'agent', 'template', 'redact', 'fetch']);

/** Words the API's routes use beside feed ids. */
const RESERVED_IDS = new Set(['connectors', 'preview', 'check', 'stages']);

export function isValidFeedId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) && !RESERVED_IDS.has(id);
}

/** "90s", "15m", "2h", "1d" → milliseconds; null when it is none of those. */
export function parseDuration(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value * 60_000;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|min|h|d)?\s*$/i.exec(String(value ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  const ms = unit === 's' ? n * 1000 : unit === 'h' ? n * 3_600_000 : unit === 'd' ? n * 86_400_000 : n * 60_000;
  return ms > 0 ? ms : null;
}

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : fallback);
const strings = (v: unknown): string[] => (typeof v === 'string' ? (v.trim() ? [v.trim()] : []) : Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? n : undefined;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const stringMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj(v))) if (k.trim() && val !== undefined && val !== null && typeof val !== 'object') out[k.trim()] = String(val);
  return out;
};

function condition(raw: Record<string, unknown>): RuleCondition {
  const c: RuleCondition = {};
  for (const key of ['any', 'all', 'none', 'regex', 'authors', 'channels', 'tags'] as const) {
    const list = strings(raw[key]);
    if (list.length) c[key] = list;
  }
  const shorter = num(raw.shorterThan ?? raw.shorter_than);
  if (shorter !== undefined) c.shorterThan = shorter;
  const longer = num(raw.longerThan ?? raw.longer_than);
  if (longer !== undefined) c.longerThan = longer;
  if (typeof raw.hasMedia === 'boolean') c.hasMedia = raw.hasMedia;
  if (raw.language === 'zh' || raw.language === 'en') c.language = raw.language;
  const fields = obj(raw.fields);
  if (Object.keys(fields).length) {
    c.fields = {};
    for (const [k, v] of Object.entries(fields)) c.fields[k] = (Array.isArray(v) ? v : [v]).filter((x): x is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof x));
  }
  return c;
}

function rule(raw: unknown): Rule | null {
  const o = obj(raw);
  // { keep: {…conditions} } / { drop: {…} } reads better in YAML than { action: keep, … }
  if (o.keep && typeof o.keep === 'object') return { action: 'keep', ...condition(obj(o.keep)), ...(o.note ? { note: str(o.note) } : {}) };
  if (o.drop && typeof o.drop === 'object') return { action: 'drop', ...condition(obj(o.drop)), ...(o.note ? { note: str(o.note) } : {}) };
  if (o.action === 'keep' || o.action === 'drop') return { action: o.action, ...condition(o), ...(o.note ? { note: str(o.note) } : {}) };
  return null;
}

function stage(raw: unknown): StageSpec | null {
  const o = obj(raw);
  const kind = str(o.kind) as StageSpec['kind'];
  if (!STAGE_KINDS.includes(kind)) return null;
  const s: StageSpec = { kind };
  if (o.label) s.label = str(o.label);
  if (o.enabled === false) s.enabled = false;
  if (o.when && typeof o.when === 'object') s.when = condition(obj(o.when));
  if (o.onError === 'hold' || o.onError === 'keep' || o.onError === 'drop') s.onError = o.onError;
  if (kind === 'rules') s.rules = (Array.isArray(o.rules) ? o.rules : []).map(rule).filter((r): r is Rule => r !== null);
  if (kind === 'dedupe') s.across = o.across === 'feed' ? 'feed' : 'workspace';
  if (o.name) s.name = str(o.name);
  if (o.options && typeof o.options === 'object') s.options = obj(o.options);
  if (o.command) s.command = str(o.command);
  if (o.args) s.args = strings(o.args);
  if (o.env) s.env = stringMap(o.env);
  for (const key of ['timeoutMs', 'batch', 'threshold', 'maxChars', 'minChars'] as const) {
    const n = num(o[key]);
    if (n !== undefined) s[key] = n;
  }
  for (const key of ['use', 'model', 'prompt', 'promptFile', 'template', 'templateFile'] as const) if (typeof o[key] === 'string') s[key] = String(o[key]);
  if (o.context && typeof o.context === 'object') {
    const c = obj(o.context);
    s.context = { purpose: c.purpose !== false, ...(num(c.similar) !== undefined ? { similar: Math.max(0, Math.min(10, num(c.similar)!)) } : {}) };
  }
  if (o.output === 'json' || o.output === 'markdown') s.output = o.output;
  return s;
}

function schedule(raw: unknown, fallback: ScheduleSpec): ScheduleSpec {
  if (raw === 'manual' || raw === 'off' || raw === false) return {};
  if (typeof raw === 'string') return parseDuration(raw) ? { every: raw.trim() } : fallback;
  const o = obj(raw);
  if (!Object.keys(o).length) return fallback;
  const out: ScheduleSpec = {};
  if (o.every !== undefined && parseDuration(o.every)) out.every = str(o.every);
  const at = strings(o.at).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
  if (at.length) out.at = at;
  return out;
}

function units(raw: unknown, fallback: UnitSpec): UnitSpec {
  const o = typeof raw === 'string' ? { by: raw } : obj(raw);
  const by = o.by === 'item' || o.by === 'thread' || o.by === 'window' ? o.by : fallback.by;
  const out: UnitSpec = { by };
  for (const key of ['gapMinutes', 'maxItems', 'maxChars'] as const) {
    const n = num(o[key]) ?? fallback[key];
    if (n !== undefined && n > 0) out[key] = n;
  }
  return out;
}

function render(raw: unknown, fallback: RenderSpec): RenderSpec {
  const o = obj(raw);
  const period = ['item', 'day', 'week', 'month'].includes(String(o.period)) ? (o.period as RenderSpec['period']) : fallback.period;
  const out: RenderSpec = { period };
  const dest = str(o.dest) || fallback.dest;
  if (dest) out.dest = dest;
  const by = o.by === 'author' || o.by === 'channel' ? o.by : o.by === null || o.by === 'none' ? null : fallback.by;
  if (by) out.by = by;
  const tz = str(o.timezone) || fallback.timezone;
  if (tz) out.timezone = tz;
  const max = num(o.maxChars) ?? fallback.maxChars;
  if (max) out.maxChars = max;
  const type = str(o.type) || fallback.type;
  if (type) out.type = type;
  return out;
}

/** A feed from its file's data, with the connector's defaults under what the file says. */
export function normalizeFeed(raw: Record<string, unknown>, id: string, filePath = ''): FeedDefinition {
  const connectorId = str(raw.connector);
  const connector = connectorId ? pluginRegistry().feedConnector(connectorId) : undefined;
  const d = connector?.defaults ?? {};
  const attachments = obj(raw.attachments);
  return {
    id,
    title: str(raw.title) || id,
    description: str(raw.description),
    connector: connectorId,
    params: obj(raw.params),
    enabled: raw.enabled !== false,
    schedule: raw.schedule === undefined ? { ...(d.schedule ?? {}) } : schedule(raw.schedule, d.schedule ?? {}),
    ...(num(raw.backfillDays) !== undefined ? { backfillDays: num(raw.backfillDays) } : d.backfillDays !== undefined ? { backfillDays: d.backfillDays } : {}),
    units: units(raw.units, d.units ?? { by: 'item' }),
    filter: (Array.isArray(raw.filter) ? raw.filter : []).map(stage).filter((s): s is StageSpec => s !== null),
    filterDefault: raw.filterDefault === 'drop' ? 'drop' : 'keep',
    transform: (Array.isArray(raw.transform) ? raw.transform : []).map(stage).filter((s): s is StageSpec => s !== null),
    render: render(raw.render, { period: 'item', ...(d.render ?? {}) }),
    maxModelCalls: Math.max(0, Math.floor(num(raw.maxModelCalls) ?? 200)),
    attachments: { download: attachments.download === true, maxBytes: num(attachments.maxBytes) ?? 20 * 1024 * 1024 },
    trust: raw.trust === 'quarantine' ? 'quarantine' : 'trusted',
    path: filePath,
  };
}

function feedFile(dataDir: string, id: string): string | null {
  for (const ext of ['yaml', 'yml']) {
    const file = path.join(dataDir, FEEDS_DIR, `${id}.${ext}`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export function loadFeed(dataDir: string, id: string): FeedDefinition | null {
  if (!isValidFeedId(id)) return null;
  const file = feedFile(dataDir, id);
  if (!file) return null;
  return normalizeFeed(parseYaml(fs.readFileSync(file, 'utf8')), id, path.relative(dataDir, file).split(path.sep).join('/'));
}

export function loadFeeds(dataDir: string): FeedDefinition[] {
  const dir = path.join(dataDir, FEEDS_DIR);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n));
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: FeedDefinition[] = [];
  for (const name of names.sort()) {
    const id = name.replace(/\.ya?ml$/, '');
    if (!isValidFeedId(id) || seen.has(id)) continue;
    seen.add(id);
    const feed = loadFeed(dataDir, id);
    if (feed) out.push(feed);
  }
  return out;
}

/** What is wrong with a feed, for a person; null when it can run. */
export function feedProblem(feed: FeedDefinition): string | null {
  const connector = pluginRegistry().feedConnector(feed.connector);
  if (!feed.connector) return 'no connector named';
  if (!connector) return `unknown connector "${feed.connector}" (known: ${pluginRegistry().feedConnectors().map((c) => c.id).join(', ')}) — a plugin that provides it must be listed under "plugins"`;
  for (const p of connector.params) {
    const v = feed.params[p.name];
    if (p.required && (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0))) return `${connector.label} needs params.${p.name} (${p.label})`;
  }
  for (const [layer, stages, allowed] of [['filter', feed.filter, FILTER_KINDS], ['transform', feed.transform, TRANSFORM_KINDS]] as const) {
    for (const [i, s] of stages.entries()) {
      const where = `${layer}[${i}] (${s.kind})`;
      if (!allowed.has(s.kind)) return `${where}: a ${s.kind} stage cannot be a ${layer}`;
      if (s.kind === 'udf') {
        const udf = s.name ? pluginRegistry().feedStage(s.name) : undefined;
        if (!udf) return `${where}: no feed stage "${s.name ?? ''}" is registered — a plugin must register it`;
        if (udf.kind !== layer) return `${where}: "${s.name}" is a ${udf.kind}, not a ${layer}`;
      }
      if (s.kind === 'command' && !s.command) return `${where}: command is required`;
      if ((s.kind === 'llm' || s.kind === 'agent') && !s.use) return `${where}: use (a connection or agent id) is required`;
      if ((s.kind === 'llm' || s.kind === 'agent') && layer === 'transform' && !s.prompt && !s.promptFile) return `${where}: a transform needs a prompt (the format to write)`;
      if (s.kind === 'template' && !s.template && !s.templateFile) return `${where}: template or templateFile is required`;
      for (const re of [...(s.rules ?? []).flatMap((r) => r.regex ?? []), ...(s.when?.regex ?? [])]) {
        try {
          new RegExp(re, 'iu');
        } catch {
          return `${where}: not a regular expression: ${re}`;
        }
      }
    }
  }
  if (feed.render.timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: feed.render.timezone });
    } catch {
      return `render.timezone: unknown time zone ${feed.render.timezone}`;
    }
  }
  try {
    feedDest(feed);
  } catch (err) {
    return `render.dest: ${err instanceof Error ? err.message : err}`;
  }
  return null;
}

/** The folder a feed writes in: render.dest under raw/docs, or raw/docs/feeds/<id>. */
export function feedDest(feed: Pick<FeedDefinition, 'id' | 'render'>): string {
  const dest = feed.render.dest?.trim();
  if (!dest) return `${FEEDS_ROOT}/${feed.id}`;
  const clean = sanitizeRelativePath(dest);
  const rel = clean === RAW_DOCS || clean.startsWith(`${RAW_DOCS}/`) ? clean : `${RAW_DOCS}/${clean}`;
  if (rel === RAW_DOCS || !rel.startsWith(`${RAW_DOCS}/`)) throw new Error(`a feed writes in a folder under ${RAW_DOCS}/, not ${dest}`);
  return rel;
}

/**
 * The key a unit's cached decision is checked against: everything that
 * changes what the filter and transform layers would say. A feed whose stages
 * changed decides again on the next render that touches a unit, never on its
 * own — re-deciding history is `knode-os feeds rerender --redecide`.
 */
export function pipelineKey(dataDir: string, feed: FeedDefinition): string {
  const registry = pluginRegistry();
  const stages = [...feed.filter, ...feed.transform].filter((s) => s.enabled !== false);
  const files = stages.flatMap((s) => [s.promptFile, s.templateFile]).filter((f): f is string => Boolean(f)).map((f) => {
    try {
      return fs.readFileSync(path.join(dataDir, FEEDS_DIR, sanitizeRelativePath(f)), 'utf8');
    } catch {
      return '';
    }
  });
  const versions = stages.filter((s) => s.kind === 'udf' && s.name).map((s) => `${s.name}@${registry.feedStage(s.name!)?.version ?? ''}`);
  const material = JSON.stringify({ u: feed.units, f: feed.filter, d: feed.filterDefault, t: feed.transform, files, versions });
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/** The text a stage's promptFile / templateFile names, from playbooks/feeds/. */
export function readFeedFile(dataDir: string, rel: string): string {
  const clean = sanitizeRelativePath(rel);
  const abs = path.join(dataDir, FEEDS_DIR, clean);
  if (!abs.startsWith(path.join(dataDir, FEEDS_DIR) + path.sep)) throw new Error(`${rel} is not under ${FEEDS_DIR}/`);
  return fs.readFileSync(abs, 'utf8');
}

/** Values a listing shows as "set" rather than verbatim. */
function secretParamNames(connector: FeedConnector | undefined): Set<string> {
  return new Set((connector?.params ?? []).filter((p) => p.type === 'secret').map((p) => p.name));
}

const mask = (v: unknown): string => (typeof v === 'string' && v.startsWith('env:') ? v : v === undefined || v === null || v === '' ? '' : '••••••');

/** A feed as an API may show it: secret params and stage environments masked unless they are env: references. */
export function redactFeed(feed: FeedDefinition): FeedDefinition {
  const secrets = secretParamNames(pluginRegistry().feedConnector(feed.connector));
  const params = Object.fromEntries(Object.entries(feed.params).map(([k, v]) => [k, secrets.has(k) || /token|secret|password|cookie|apikey|api_key/i.test(k) ? mask(v) : v]));
  const scrub = (stages: StageSpec[]) => stages.map((s) => (s.env ? { ...s, env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, mask(v)])) } : s));
  return { ...feed, params, filter: scrub(feed.filter), transform: scrub(feed.transform) };
}

/** A masked value sent back unchanged keeps what the file holds. */
function unmask(input: Record<string, unknown>, previous: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!previous) return input;
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v === '••••••' && k in previous ? previous[k] : v]));
}

/** The file's data for a feed, in a stable key order. */
function feedData(feed: FeedDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {
    title: feed.title,
    ...(feed.description ? { description: feed.description } : {}),
    connector: feed.connector,
    params: feed.params,
    enabled: feed.enabled,
    schedule: feed.schedule.every || feed.schedule.at?.length ? feed.schedule : 'manual',
    ...(feed.backfillDays !== undefined ? { backfillDays: feed.backfillDays } : {}),
    units: feed.units,
    ...(feed.filter.length ? { filter: feed.filter } : {}),
    ...(feed.filterDefault === 'drop' ? { filterDefault: 'drop' } : {}),
    ...(feed.transform.length ? { transform: feed.transform } : {}),
    render: feed.render,
    ...(feed.maxModelCalls !== 200 ? { maxModelCalls: feed.maxModelCalls } : {}),
    ...(feed.attachments.download ? { attachments: feed.attachments } : {}),
    ...(feed.trust === 'quarantine' ? { trust: 'quarantine' } : {}),
  };
  return JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
}

/**
 * Write a feed's file from what a client sent (the whole definition, as
 * GET shows it): masked secrets keep their stored values. Validated first;
 * a feed that could not run is refused with the reason.
 */
export function saveFeed(dataDir: string, id: string, input: Record<string, unknown>): FeedDefinition {
  if (!isValidFeedId(id)) throw new Error(`feed id "${id}" must be lower-case letters, digits, '-' or '_' (at most 64)`);
  const previous = loadFeed(dataDir, id);
  const raw = { ...input, params: unmask(obj(input.params), previous?.params) };
  const feed = normalizeFeed(raw, id);
  if (previous) {
    // stage environments come back masked too
    const restore = (next: StageSpec[], old: StageSpec[]) => next.map((s, i) => (s.env && old[i]?.env ? { ...s, env: unmask(s.env, old[i].env) as Record<string, string> } : s));
    feed.filter = restore(feed.filter, previous.filter);
    feed.transform = restore(feed.transform, previous.transform);
  }
  const problem = feedProblem(feed);
  if (problem) throw new Error(problem);
  const file = feedFile(dataDir, id) ?? path.join(dataDir, FEEDS_DIR, `${id}.yaml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const yaml = writeMatter('', feedData(feed)).replace(/^---\n/, '').replace(/---\n*$/, '');
  fs.writeFileSync(file, `# Feed "${feed.title}" — docs/design/26. Secrets may be written as env:VAR.\n${yaml}`, { mode: 0o600 });
  return { ...feed, path: path.relative(dataDir, file).split(path.sep).join('/') };
}

export function deleteFeedFile(dataDir: string, id: string): boolean {
  const file = feedFile(dataDir, id);
  if (!file) return false;
  fs.rmSync(file, { force: true });
  return true;
}

/** "env:VAR" → its value; anything else as written. */
export function feedSecret(value: unknown): string {
  return typeof value === 'string' ? resolveSecret(value) : value === undefined || value === null ? '' : String(value);
}
