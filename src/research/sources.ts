import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { parseYaml } from '../compiler/intents.js';
import { HttpEndpointConfig, KnodeConfig, resolveSecret } from '../config.js';
import { RESEARCH_DIR } from '../fs/layout.js';
import { extractRecords } from '../datasource/http.js';
import { guardedFetch } from './fetch.js';

/**
 * Research sources — where a study may look besides the knowledge base and
 * the open web, configured by a person, one YAML file each under
 * `playbooks/research/sources/<id>.yaml` (edited in the Research section or
 * in the file, like agents and profiles).
 *
 *   mcp         another MCP server (a filings database, a market-data vendor,
 *               the company wiki): attached to every session of a study that
 *               selects it, next to knode's own — over HTTP (`url`, `headers`)
 *               or as a local process (`command`, `args`, `env`)
 *   api         a JSON-over-HTTP API with declared endpoints, called through
 *               `knode_api`. The declaration is an allowlist: an endpoint or a
 *               parameter it does not name is refused, so a configured API
 *               cannot be turned into a proxy to anywhere
 *   site        trusted sites: their domains steer web searches, their seed
 *               URLs are captured before the agents start
 *   datasource  a live source from `datasources` (SQL, Prometheus, …), read
 *               with `knode_query`
 *
 * The knowledge base itself and the web are not files here: every study reads
 * the knowledge base, and the web is a switch on the study (within the
 * workspace's `review.external`).
 */

export type ResearchSourceKind = 'mcp' | 'api' | 'site' | 'datasource';
export const RESEARCH_SOURCE_KINDS: ResearchSourceKind[] = ['mcp', 'api', 'site', 'datasource'];

export interface ResearchSource {
  /** File stem; also the MCP server name the agent sees (mcp__<id>__…). */
  id: string;
  title: string;
  kind: ResearchSourceKind;
  /** What it holds and when to use it — the agent reads this. */
  description: string;
  /** Selected for a new study unless the person unticks it. */
  enabled: boolean;
  /** mcp (HTTP) / api: endpoint. */
  url: string;
  /** mcp (HTTP) / api: request headers; values may be "env:VAR". */
  headers: Record<string, string>;
  /** mcp (local process). */
  command: string;
  args: string[];
  /** mcp (local process): environment; values may be "env:VAR". */
  env: Record<string, string>;
  /** mcp: tools the agent may call (empty = all). */
  tools: string[];
  /** api: the endpoints, an allowlist. */
  endpoints: HttpEndpointConfig[];
  /** site: domains searches are steered to. */
  domains: string[];
  /** site: pages captured before a study's agents start. */
  urls: string[];
  /** datasource: the `datasources[]` id. */
  datasource: string;
  path: string;
}

export const SOURCES_DIR = `${RESEARCH_DIR}/sources`;

export function isValidSourceId(id: string): boolean {
  // the id becomes an MCP server name and a TOML key: keep it plain
  return /^[a-z0-9][a-z0-9_-]{0,47}$/.test(id) && id !== 'knode-os';
}

function strings(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

function record(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k.trim() && (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean')) out[k.trim()] = String(val);
  }
  return out;
}

function endpoints(v: unknown): HttpEndpointConfig[] {
  if (!Array.isArray(v)) return [];
  const out: HttpEndpointConfig[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) continue;
    const params = Array.isArray(o.params)
      ? (o.params as unknown[]).flatMap((p) => {
        if (!p || typeof p !== 'object') return [];
        const q = p as Record<string, unknown>;
        const pname = typeof q.name === 'string' ? q.name.trim() : '';
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(pname)) return [];
        return [{ name: pname, in: q.in === 'path' ? 'path' as const : 'query' as const, type: typeof q.type === 'string' ? q.type : 'string', required: q.required === true }];
      })
      : [];
    out.push({
      name,
      path: typeof o.path === 'string' ? o.path.trim() : '',
      description: typeof o.description === 'string' ? o.description.trim() : '',
      params,
      resultPath: typeof o.resultPath === 'string' ? o.resultPath.trim() : undefined,
    });
  }
  return out;
}

export function normalizeSource(raw: Record<string, unknown>, id: string, file: string): ResearchSource {
  const kind = RESEARCH_SOURCE_KINDS.includes(raw.kind as ResearchSourceKind) ? (raw.kind as ResearchSourceKind) : 'site';
  return {
    id,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : id,
    kind,
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    enabled: raw.enabled !== false,
    url: typeof raw.url === 'string' ? raw.url.trim() : typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '',
    headers: record(raw.headers),
    command: typeof raw.command === 'string' ? raw.command.trim() : '',
    args: strings(raw.args),
    env: record(raw.env),
    tools: strings(raw.tools),
    endpoints: endpoints(raw.endpoints),
    domains: strings(raw.domains).map((d) => d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()),
    urls: strings(raw.urls).filter((u) => /^https?:\/\//i.test(u)),
    datasource: typeof raw.datasource === 'string' ? raw.datasource.trim() : '',
    path: file,
  };
}

/** What is wrong with a source as configured, or null. */
export function sourceProblem(source: ResearchSource, config?: KnodeConfig): string | null {
  if (source.kind === 'mcp' && !source.url && !source.command) return 'an MCP source needs a url (HTTP) or a command (local process)';
  if (source.kind === 'mcp' && source.url && !/^https?:\/\//i.test(source.url)) return 'url must be http(s)';
  if (source.kind === 'api' && !/^https?:\/\//i.test(source.url)) return 'an API source needs an http(s) url';
  if (source.kind === 'api' && source.endpoints.length === 0) return 'an API source declares at least one endpoint';
  if (source.kind === 'site' && source.domains.length === 0 && source.urls.length === 0) return 'a site source names domains or seed urls';
  if (source.kind === 'datasource' && !source.datasource) return 'a datasource source names a datasources[] id';
  if (source.kind === 'datasource' && config && !config.datasources.some((d) => d.id === source.datasource)) return `no datasource "${source.datasource}" in knode.config.json`;
  return null;
}

export function sourceFile(dataDir: string, id: string): string {
  return path.join(dataDir, SOURCES_DIR, `${id}.yaml`);
}

export function loadResearchSources(dataDir: string): ResearchSource[] {
  const dir = path.join(dataDir, SOURCES_DIR);
  if (!fs.existsSync(dir)) return [];
  const out: ResearchSource[] = [];
  for (const entry of fs.readdirSync(dir).sort()) {
    const m = /^(.+)\.ya?ml$/i.exec(entry);
    if (!m || !isValidSourceId(m[1])) continue;
    out.push(normalizeSource(parseYaml(fs.readFileSync(path.join(dir, entry), 'utf8')), m[1], `${SOURCES_DIR}/${entry}`));
  }
  return out;
}

export function loadResearchSource(dataDir: string, id: string): ResearchSource | null {
  return loadResearchSources(dataDir).find((s) => s.id === id) ?? null;
}

/** The YAML a source is stored as: only the keys its kind uses, so the file reads like what it is. */
export function sourceYaml(source: ResearchSource): string {
  const data: Record<string, unknown> = { title: source.title, kind: source.kind, description: source.description, enabled: source.enabled };
  if (source.kind === 'mcp') {
    if (source.url) Object.assign(data, { url: source.url, ...(Object.keys(source.headers).length ? { headers: source.headers } : {}) });
    else Object.assign(data, { command: source.command, args: source.args, ...(Object.keys(source.env).length ? { env: source.env } : {}) });
    if (source.tools.length) data.tools = source.tools;
  } else if (source.kind === 'api') {
    Object.assign(data, { url: source.url, ...(Object.keys(source.headers).length ? { headers: source.headers } : {}), endpoints: source.endpoints });
  } else if (source.kind === 'site') {
    Object.assign(data, { domains: source.domains, urls: source.urls });
  } else {
    data.datasource = source.datasource;
  }
  return matter.stringify('', JSON.parse(JSON.stringify(data))).replace(/^---\n/, '').replace(/---\n*$/, '');
}

export function saveResearchSource(dataDir: string, input: Record<string, unknown> & { id: string }, config?: KnodeConfig): ResearchSource {
  const id = input.id.trim();
  if (!isValidSourceId(id)) throw new Error(`invalid source id "${id}" (lower-case letters, digits, - and _; not "knode-os")`);
  const file = sourceFile(dataDir, id);
  // a redacted secret ('***') keeps the stored one, as the config form does for keys
  const previous = loadResearchSource(dataDir, id);
  const source = normalizeSource(input, id, `${SOURCES_DIR}/${id}.yaml`);
  for (const key of ['headers', 'env'] as const) {
    for (const [k, v] of Object.entries(source[key])) if (v === '***' && previous?.[key][k] !== undefined) source[key][k] = previous[key][k];
  }
  const problem = sourceProblem(source, config);
  if (problem) throw new Error(`${id}: ${problem}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, sourceYaml(source));
  return source;
}

export function deleteResearchSource(dataDir: string, id: string): boolean {
  if (!isValidSourceId(id)) return false;
  let removed = false;
  for (const ext of ['yaml', 'yml']) {
    const file = path.join(dataDir, SOURCES_DIR, `${id}.${ext}`);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      removed = true;
    }
  }
  return removed;
}

/** A source as an API answer: literal secrets masked ("env:VAR" references shown, they are no secret). */
export function redactSource(source: ResearchSource): ResearchSource {
  const mask = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.startsWith('env:') || v === '' ? v : '***']));
  return { ...source, headers: mask(source.headers), env: mask(source.env) };
}

/* ------------------------------------------------------- session wiring */

/** One extra MCP server for a session: the shape each CLI's config takes. */
export interface ExtraMcpServer {
  id: string;
  /** HTTP transport. */
  url?: string;
  headers?: Record<string, string>;
  /** Local process. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Tools the agent may call; empty = all of the server's. */
  tools: string[];
}

/** The MCP servers a study's sessions attach, secrets resolved (they travel in config files and the environment, never in argv). */
export function mcpServersFor(sources: ResearchSource[]): ExtraMcpServer[] {
  return sources.filter((s) => s.kind === 'mcp' && !sourceProblem(s)).map((s) => {
    const resolve = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, resolveSecret(v)]));
    return s.url
      ? { id: s.id, url: s.url, headers: resolve(s.headers), tools: s.tools }
      : { id: s.id, command: s.command, args: s.args, env: resolve(s.env), tools: s.tools };
  });
}

/** The brief's block on the sources a study selected, written as instructions (Chinese, like the rest of the brief). */
export function sourcesBrief(sources: ResearchSource[], opts: { web: boolean; webSearchTool: boolean }): string[] {
  const lines = ['## 资料来源（本研究可用）', ''];
  lines.push('- **知识库**（默认，先查）：knode_resolve / knode_search（mode=sag）/ knode_claims / knode_graph_search / knode_read。知识库里已有的资料优先于网上的转述。');
  if (opts.web) {
    lines.push(`- **网络**：${opts.webSearchTool ? '用你自己的搜索工具，或 knode_web_search' : '用你自己的搜索 / 抓取工具'}检索；knode_web_fetch 可先读一页再决定是否保存。凡是要引用的网页 / PDF / 数据文件，用 **knode_capture** 保存进知识库（得到 raw/docs/research/… 路径，引用那个路径）。`);
  } else {
    lines.push('- **网络**：本研究不联网，只用知识库与下列来源。');
  }
  for (const s of sources) {
    const desc = s.description ? `：${s.description}` : '';
    if (s.kind === 'mcp') {
      lines.push(`- **${s.title}**（MCP 服务器 \`${s.id}\`，工具名 mcp__${s.id}__*${s.tools.length ? `，可用：${s.tools.join('、')}` : ''}）${desc}`);
    } else if (s.kind === 'api') {
      const eps = s.endpoints.map((e) => `\`${e.name}\`(${(e.params ?? []).map((p) => `${p.name}${p.required ? '*' : ''}`).join(', ')})${e.description ? ` ${e.description}` : ''}`).join('；');
      lines.push(`- **${s.title}**（API，用 knode_api source=\`${s.id}\`，endpoint + params；capture=true 把结果存成数据文件以便引用）${desc}。端点：${eps}`);
    } else if (s.kind === 'site') {
      lines.push(`- **${s.title}**（可信站点${s.domains.length ? `：${s.domains.join('、')}` : ''}）${desc}。${opts.web ? '搜索时优先这些站点（site: 限定）；' : ''}${s.urls.length ? `已预先保存：${s.urls.join('、')}` : ''}`);
    } else {
      lines.push(`- **${s.title}**（实时数据源，用 knode_query source=\`${s.datasource}\` 写只读查询；knode_datasources 看表结构）${desc}`);
    }
  }
  return [...lines, ''];
}

/* ------------------------------------------------------------- api calls */

export interface ApiCallResult {
  source: string;
  endpoint: string;
  url: string;
  status: number;
  contentType: string;
  /** Records at the endpoint's resultPath, when it declares one and the answer is JSON. */
  records: Record<string, unknown>[] | null;
  /** The answer as text, cut at `maxChars`. */
  text: string;
  truncated: boolean;
  /** The raw bytes, for a capture. */
  body: Buffer;
  finalUrl: string;
  charset: string | null;
}

/**
 * Call one declared endpoint of an API source. Only declared parameters pass;
 * path parameters are URL-encoded into the path. The URL is configuration a
 * person wrote, so it may be a local service.
 */
export async function callApiSource(config: KnodeConfig, source: ResearchSource, endpoint: string, params: Record<string, unknown>, opts: { maxChars?: number } = {}): Promise<ApiCallResult> {
  if (source.kind !== 'api') throw new Error(`${source.id} is a ${source.kind} source, not an API`);
  const decl = source.endpoints.find((e) => e.name === endpoint);
  if (!decl) throw new Error(`${source.id}: unknown endpoint "${endpoint}" — declared: ${source.endpoints.map((e) => e.name).join(', ')}`);
  const declared = new Map((decl.params ?? []).map((p) => [p.name, p]));
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (!declared.has(k)) throw new Error(`${source.id}.${endpoint} does not take "${k}" (declared: ${[...declared.keys()].join(', ') || 'none'})`);
    if (v !== undefined && v !== null) values[k] = String(v);
  }
  for (const p of decl.params ?? []) if (p.required && values[p.name] === undefined) throw new Error(`${source.id}.${endpoint} needs "${p.name}"`);
  let rel = decl.path;
  const query = new URLSearchParams();
  for (const p of decl.params ?? []) {
    const v = values[p.name];
    if (v === undefined) continue;
    if (p.in === 'path') rel = rel.replace(new RegExp(`\\{${p.name}\\}`, 'g'), encodeURIComponent(v));
    else query.set(p.name, v);
  }
  if (/\{[A-Za-z0-9_.-]+\}/.test(rel)) throw new Error(`${source.id}.${endpoint}: a path parameter is missing (${rel})`);
  const qs = query.toString();
  const url = `${source.url.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}${qs ? `?${qs}` : ''}`;
  const headers = Object.fromEntries(Object.entries(source.headers).map(([k, v]) => [k, resolveSecret(v)]));
  const res = await guardedFetch(url, config.research.web, { trusted: true, headers, accept: 'application/json, text/*;q=0.5', maxBytes: 8 * 1024 * 1024, allowErrorStatus: true });
  const text = res.body.toString('utf8');
  let records: Record<string, unknown>[] | null = null;
  if (/json/.test(res.contentType) || /^\s*[[{]/.test(text)) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (decl.resultPath) records = extractRecords(parsed, decl.resultPath);
    } catch {
      /* not JSON after all: the text stands */
    }
  }
  const maxChars = opts.maxChars ?? 40_000;
  return {
    source: source.id, endpoint, url, status: res.status, contentType: res.contentType, records,
    text: text.slice(0, maxChars), truncated: text.length > maxChars || res.truncated, body: res.body, finalUrl: res.finalUrl, charset: res.charset,
  };
}
