import type { KnodeConfig } from '../../config.js';

/**
 * Feeds — sources that keep producing items (docs/design/25): a group chat, a
 * mailbox, an account's posts, a search on arXiv, a repository's releases, a
 * web page that changes. A feed pulls new items through a **connector**,
 * decides which belong in the workspace (the **filter** layer), turns them
 * into the Markdown they are kept as (the **transform** layer), groups them
 * into documents by period and writes those under raw/docs, where the
 * ordinary pipeline indexes them.
 *
 * Everything a connector produced is kept in the feed's ledger
 * (ledger/feeds/<id>/), with what each stage decided, so a filter can be
 * audited and run again over history without fetching anything twice.
 *
 * This module holds the types only.
 */

/* --------------------------------- items --------------------------------- */

export interface FeedAuthor {
  /** Stable id at the origin (open_id, user id, address); absent when only a name is known. */
  id?: string;
  name: string;
  url?: string;
}

export interface FeedChannel {
  /** Stable id at the origin: chat id, mailbox folder, repository, category. */
  id: string;
  name: string;
  /** 'group', 'p2p', 'mailbox', 'repo', 'category', 'list', … */
  kind?: string;
}

export interface FeedAttachment {
  kind: 'image' | 'file' | 'audio' | 'video' | 'link';
  /** Where the connector found it (http(s), or a connector-specific reference such as a Feishu image key). */
  url?: string;
  /** Once downloaded: its path relative to the data directory. */
  path?: string;
  name?: string;
  mime?: string;
  bytes?: number;
  /** What a person or a model already said it holds (OCR, a description, a transcript). */
  text?: string;
}

/** Content relayed from somewhere else: a weibo post forwarded into a group chat, a retweet. */
export interface FeedOrigin {
  platform: string;
  account?: string;
  id?: string;
  url?: string;
}

/**
 * One thing a connector produced: a message, a post, a mail, a paper, a
 * release. Identified by `id` within its feed; the same id arriving again with
 * different content is a new revision of it (an edited message, a paper's v2,
 * an issue with new comments), which replaces the old one in its document.
 */
export interface FeedItem {
  /** Stable within the feed: message id, guid, arXiv id, tweet id, Message-ID. */
  id: string;
  url?: string;
  title?: string;
  author?: FeedAuthor;
  channel?: FeedChannel;
  /** When it happened at the origin (ISO 8601 with offset). Its document's date comes from it. */
  publishedAt: string;
  updatedAt?: string;
  /** When this feed first saw it; set by the pipeline. */
  observedAt?: string;
  /** The body: Markdown or plain text (see `format`). */
  text?: string;
  /** An HTML body, converted to Markdown by the pipeline when `text` is absent. */
  html?: string;
  format?: 'markdown' | 'text';
  /** Items sharing a thread id form one unit when the feed groups by thread. */
  threadId?: string;
  replyTo?: string;
  attachments?: FeedAttachment[];
  tags?: string[];
  lang?: string;
  /** Identity across feeds (a DOI, an arXiv id, a canonical URL, a relayed post's origin id), for the `dedupe` filter. */
  dedupeKey?: string;
  origin?: FeedOrigin;
  /** Connector-specific extras: stars, labels, reactions, categories. Shown to stages, kept in the ledger. */
  meta?: Record<string, unknown>;
  /** Recalled or deleted at the origin: dropped from its document on the next render. */
  deleted?: boolean;
}

/* --------------------------------- units --------------------------------- */

/**
 * What the filter and transform layers decide on: one item, a thread, or a
 * window of a conversation (consecutive messages with no long gap) — a single
 * line of chat cannot be judged on its own (docs/design/08 §2).
 */
export interface FeedUnit {
  /** The first item's id (a window, a thread's root). */
  id: string;
  kind: 'item' | 'thread' | 'window';
  items: FeedItem[];
  /** Over the members' ids and contents: what a cached decision is keyed by. */
  hash: string;
  /** The first member's time. */
  publishedAt: string;
  /** The last member's time. */
  endedAt: string;
}

/** What a filter stage says about a unit: keep, drop, or no opinion (null: the next stage decides). */
export interface FilterVerdict {
  keep: boolean | null;
  /** 0–1, when the stage scores. */
  score?: number;
  reason?: string;
  tags?: string[];
}

/** What a transform stage hands back; merged in order over what the earlier stages made. */
export interface TransformOutput {
  title?: string;
  /** The unit's Markdown body in its document. */
  markdown?: string;
  /** One line under the unit's heading: who, where, about what (contextual retrieval, docs/design/08 §5). */
  context?: string;
  summary?: string;
  tags?: string[];
  /** Declared entities and claims, written to the document's frontmatter (src/graph/frontmatter.ts reads them). */
  entities?: Array<{ name: string; type?: string; aliases?: string[] }>;
  claims?: Array<Record<string, unknown>>;
  /** Anything else a template or a later stage reads. */
  fields?: Record<string, unknown>;
}

/** A unit's state in the feed's ledger. */
export interface UnitDecision {
  unit: string;
  hash: string;
  /** keep / drop; pending: a stage could not decide yet (an error, the quota floor) and will be asked again. */
  status: 'keep' | 'drop' | 'pending';
  /** The stage that decided, by its label (`rules#1`, `llm:connection-3`, `udf:my-filter`), or 'default'. */
  by: string;
  score?: number;
  reason?: string;
  tags?: string[];
  output?: TransformOutput;
  /** The filter and transform configuration this was decided under (a change re-decides on the next render that touches it). */
  pipeline: string;
  /** The unit's time and author/channel group, so a pending unit's document can be found again. */
  publishedAt: string;
  group?: string;
  at: string;
}

/* ------------------------------ definitions ------------------------------ */

/** A filter or transform stage (docs/design/25 §4). */
export interface StageSpec {
  kind: 'rules' | 'dedupe' | 'udf' | 'command' | 'llm' | 'agent' | 'template' | 'redact' | 'fetch';
  /** Shown in decisions and logs; default derived from the kind. */
  label?: string;
  /** false keeps the stage in the file without running it. */
  enabled?: boolean;
  /** Run only on units this rule matches (same conditions as a `rules` stage's rule). */
  when?: RuleCondition;
  /** What an error does (model, command and udf stages): leave the unit pending and ask again (default), keep it, or drop it. */
  onError?: 'hold' | 'keep' | 'drop';

  /* rules */
  rules?: Rule[];
  /* dedupe */
  across?: 'feed' | 'workspace';

  /* udf: a function a plugin registered by this name */
  name?: string;
  options?: Record<string, unknown>;

  /* command: an executable speaking knode-feed-stage/1 (docs/design/25 §6) */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;

  /* llm / agent: a model endpoint or an agent, by its id (a connection or an agent in playbooks/agents) */
  use?: string;
  model?: string;
  /** Instructions: the criteria a filter applies, or the format a transform writes. */
  prompt?: string;
  /** Read the prompt from this file under playbooks/feeds/ instead. */
  promptFile?: string;
  /** Units per call (filters default 8, transforms 1). */
  batch?: number;
  /** What the model is shown besides the units: the workspace's purpose.md, and the k most similar passages already indexed. */
  context?: { purpose?: boolean; similar?: number };
  /** A filter keeps a unit whose score reaches this, when the model scores (default: its keep). */
  threshold?: number;
  /** A transform's answer: a JSON object of fields (default) or the Markdown body itself. */
  output?: 'json' | 'markdown';
  /** Largest characters of one unit shown to a model (default 4000). */
  maxChars?: number;

  /* template: Markdown with {{field}} placeholders and {{#list}}…{{/list}} sections */
  template?: string;
  templateFile?: string;

  /* fetch: read the page a unit links to and use its main text as the body */
  minChars?: number;
}

/** Conditions of a rule; a rule matches when every condition it names holds. */
export interface RuleCondition {
  /** Any of these words or phrases appears (case-insensitive) in the title or text. */
  any?: string[];
  /** All of them appear. */
  all?: string[];
  /** None of them appears. */
  none?: string[];
  /** One of these regular expressions matches the title or text. */
  regex?: string[];
  /** The author's name or id is one of these. */
  authors?: string[];
  /** The channel's name or id is one of these. */
  channels?: string[];
  /** The item carries one of these tags. */
  tags?: string[];
  /** Fewer / more characters of text than this. */
  shorterThan?: number;
  longerThan?: number;
  /** Has a picture, file or video. */
  hasMedia?: boolean;
  /** Mostly Chinese (zh) or mostly Latin script (en). */
  language?: 'zh' | 'en';
  /** A connector field equals one of these values: `{ "meta.msgType": ["system"] }`. */
  fields?: Record<string, Array<string | number | boolean>>;
}

export interface Rule extends RuleCondition {
  /** What a match decides. */
  action: 'keep' | 'drop';
  /** Shown as the reason. */
  note?: string;
}

/** How units are grouped into documents and where they are written. */
export interface RenderSpec {
  /** One document per unit, or per day / ISO week / month of units. */
  period: 'item' | 'day' | 'week' | 'month';
  /** Folder under raw/docs the feed writes in; default raw/docs/feeds/<id>. */
  dest?: string;
  /** A folder level per author or per channel under dest. */
  by?: 'author' | 'channel' | null;
  /** IANA zone for day boundaries and the times in headings; default the machine's. */
  timezone?: string;
  /** A period document longer than this continues in `<name>.p2.md`, … (at a unit boundary). Default 12000. */
  maxChars?: number;
  /** The frontmatter `type`; default by connector (ChatArchive, Post, Paper, Email, …). */
  type?: string;
}

/** How items become units. */
export interface UnitSpec {
  /** item: each item alone; thread: items sharing threadId; window: a conversation cut where it went quiet. */
  by: 'item' | 'thread' | 'window';
  /** window: a gap longer than this starts a new window (default 30). */
  gapMinutes?: number;
  /** window: a window is closed after this many messages… (default 40) */
  maxItems?: number;
  /** …or this many characters (default 3000). */
  maxChars?: number;
}

export interface ScheduleSpec {
  /** Pull every so often: "15m", "2h", "1d". */
  every?: string;
  /** Pull at these local times ("HH:MM"), and at startup when one passed while knode-os was down. */
  at?: string[];
}

/**
 * A feed, one YAML file under playbooks/feeds/<id>.yaml — written in Settings,
 * by `knode-os feeds add`, or by hand. Secrets may be written as "env:VAR".
 */
export interface FeedDefinition {
  /** File stem; lower-case letters, digits, '-' and '_'. */
  id: string;
  title: string;
  description: string;
  /** The connector id (rss, arxiv, github, feishu-chat, email, x, opencli, web, push, command, or a plugin's). */
  connector: string;
  /** Connector parameters: what to follow and how to reach it. */
  params: Record<string, unknown>;
  enabled: boolean;
  /** Absent or empty: only pushes and Run now. */
  schedule: ScheduleSpec;
  /** On the first run, how far back to go (connectors that can: days). Default per connector. */
  backfillDays?: number;
  units: UnitSpec;
  filter: StageSpec[];
  /** What a unit no stage decided on becomes (default keep). */
  filterDefault: 'keep' | 'drop';
  transform: StageSpec[];
  render: RenderSpec;
  /** Model calls one run may make across its stages (default 200); what is left waits for the next run. */
  maxModelCalls: number;
  /** Download pictures and files the items carry, so the Convert stage reads them (default false). */
  attachments: { download: boolean; maxBytes: number };
  /** Index what the feed writes as trusted (default) or quarantined (docs/design/06, src/lineage/trust.ts). */
  trust: 'trusted' | 'quarantine';
  /** Where the file is. */
  path: string;
}

/* ------------------------------- connectors ------------------------------ */

/** What a connector hands back from one pull. */
export interface PullResult {
  items: FeedItem[];
  /** The cursor to resume from next time; committed only after the items are in the ledger. */
  state?: unknown;
  /** More is waiting (a page limit was hit): the runner pulls again soon instead of waiting for the schedule. */
  more?: boolean;
  /** Lines for the run's log. */
  notes?: string[];
  /**
   * The pull stopped part way: what it returned (up to `state`) is kept and
   * the cursor moves to `state`, and the run reports this error.
   */
  error?: string;
}

export interface ConnectorContext {
  dataDir: string;
  config: KnodeConfig;
  feed: FeedDefinition;
  /** The cursor the last successful pull left; undefined on the first. */
  state: unknown;
  /** The first pull's horizon: items older than this need not be fetched. */
  since: Date | null;
  /** HTTP(S) GET through knode's guarded fetch (proxies, size cap, user agent). `trusted` for URLs the feed's own configuration names. */
  fetch(url: string, opts?: { headers?: Record<string, string>; accept?: string; maxBytes?: number; timeoutMs?: number; trusted?: boolean; allowErrorStatus?: boolean }): Promise<{ status: number; url: string; headers: Record<string, string>; contentType: string; text: string; body: Buffer }>;
  /** Resolve "env:VAR" to its value; anything else as written. */
  secret(value: unknown): string;
  log(message: string): void;
  signal: AbortSignal;
}

/** A parameter a connector reads, so a form and `knode-os feeds connectors` can describe it. */
export interface ConnectorParam {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'string[]' | 'secret';
  required?: boolean;
  note?: string;
  example?: unknown;
}

/**
 * A kind of source. Built-ins are registered through the plugin API
 * (src/plugins/builtin.ts), so a plugin's connector is a peer of them.
 */
export interface FeedConnector {
  id: string;
  label: string;
  /** One or two sentences: what it reads and how it signs in. */
  note?: string;
  params: ConnectorParam[];
  /** What a new feed of this kind starts with. */
  defaults?: Partial<Pick<FeedDefinition, 'units' | 'render' | 'schedule' | 'backfillDays'>> & { platform?: string };
  /** The platform written into frontmatter and tags (feishu, twitter, arxiv, github, email, web, …). */
  platform?: string;
  /** The platform of one feed, when it depends on its params (OpenCLI: the site). */
  platformFor?(feed: FeedDefinition): string;
  /** Pulls closer together than this are refused (rate limits): minutes. */
  minIntervalMinutes?: number;
  /** A connector that never pulls (items only arrive by push). */
  pushOnly?: boolean;
  /** Can it reach the source with these params? A message for a person when not. */
  check?(ctx: ConnectorContext): Promise<{ ok: boolean; message: string }>;
  pull?(ctx: ConnectorContext): Promise<PullResult>;
  /** Fetch an attachment the generic downloader cannot (a Feishu image key): its bytes, or null to skip it. */
  download?(ctx: ConnectorContext, item: FeedItem, attachment: FeedAttachment, destAbs: string): Promise<{ path: string; mime?: string; bytes: number } | null>;
  /** A unit's default Markdown body, before any transform. */
  render?(unit: FeedUnit, feed: FeedDefinition): string;
}

/* -------------------------------- UDF stages ------------------------------ */

/** What a user-defined stage sees besides the units. */
export interface FeedStageContext {
  dataDir: string;
  feed: Pick<FeedDefinition, 'id' | 'title' | 'connector' | 'params'>;
  /** The stage's `options` from the feed file. */
  options: Record<string, unknown>;
  log(message: string): void;
}

/**
 * A user-defined filter or transform, registered by a plugin under a name a
 * feed's `udf` stage refers to. It sees a batch of units and answers one entry
 * per unit, in order: a filter a verdict (or null: no opinion), a transform
 * the fields it sets (or null: nothing).
 */
export interface FeedStagePlugin {
  id: string;
  label?: string;
  kind: 'filter' | 'transform';
  /** Bump to re-decide what this stage decided before (it is part of the pipeline key). */
  version?: string | number;
  run(units: FeedUnit[], ctx: FeedStageContext): Promise<Array<FilterVerdict | TransformOutput | null>> | Array<FilterVerdict | TransformOutput | null>;
}
