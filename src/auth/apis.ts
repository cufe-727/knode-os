/**
 * API groups — the units in which an account is given knode-os's own API.
 *
 * Every /api route belongs to one group (or to none: signing in, the
 * account's own workspaces, reading settings). An admin may use every group;
 * a member every group but `settings`, which can point a connection at a new
 * endpoint while keeping its stored key, and which holds user and gateway
 * management. From outside this machine an account may use only the groups
 * in its `remoteApis` (src/auth/accounts.ts).
 *
 * A route not listed here falls into `settings`: a new route is locked down
 * until someone decides who it is for.
 */

export const API_GROUPS = {
  files: 'browse, read, edit, upload and move files; sync and unlink linked folders and Feishu documents',
  search: 'search, graph, entities, documents, claims, stats, notices, lineage and history',
  ask: 'Ask, chat and context packs',
  knowledge: 'wiki, research, dream, suggestions, merges and reviews',
  ingest: 'sync, ingest, forget, purge, rebuild, labeling status and the task queue',
  traces: 'agent traces',
  datasources: 'configured live datasources and their read-only queries',
  settings: 'workspace settings — models, connections, agents, profiles, playbooks — clearing a workspace, importing or linking a folder from this machine, and signing in to Feishu and importing its documents',
  gateway: 'local services published through /gw/<id>',
} as const;

export type ApiGroup = keyof typeof API_GROUPS;
export const API_GROUP_NAMES = Object.keys(API_GROUPS) as ApiGroup[];

/** What a new member may use from outside this machine unless told otherwise. */
export const DEFAULT_MEMBER_REMOTE_APIS: ApiGroup[] = ['files', 'search', 'ask', 'knowledge', 'ingest', 'traces'];

type Rule = { prefix: string; group: ApiGroup | null; methods?: string[] };

const READ = ['GET', 'HEAD'];

/** First match wins: specific prefixes before the general ones they share a start with. */
const RULES: Rule[] = [
  // no group: signing in, the account's own workspaces, reading settings to draw the UI
  { prefix: '/api/health', group: null },
  { prefix: '/api/auth/users', group: 'settings' },
  { prefix: '/api/auth/gateways', group: 'settings' },
  { prefix: '/api/auth/', group: null },
  { prefix: '/api/workspaces', group: null },
  { prefix: '/api/config', group: null, methods: READ },
  { prefix: '/api/plugins', group: null, methods: READ },
  { prefix: '/api/agents', group: null, methods: READ },
  { prefix: '/api/research/profiles', group: null, methods: READ },
  { prefix: '/api/research/sources', group: null, methods: READ },
  { prefix: '/api/chat/protocol', group: null, methods: READ },
  { prefix: '/api/playbooks', group: null, methods: READ },
  { prefix: '/api/chat/readiness', group: null },
  { prefix: '/api/languages', group: null, methods: READ },
  { prefix: '/api/labeling/status', group: 'ingest' },
  // what is under way and waiting — the same counts as the labeling status, and the jobs and syncs beside them
  { prefix: '/api/tasks', group: 'ingest' },
  // what starting it would spend is anyone's to see who may see its status (a balance only an administrator's)
  { prefix: '/api/labeling/estimate', group: 'ingest' },
  // starting the processing spends the machine's model quota: an administrator's call
  { prefix: '/api/labeling/start', group: 'settings' },
  { prefix: '/api/labeling/stop', group: 'settings' },
  // the machine's own Codex and Cursor accounts — plan, windows, credits — are the administrator's
  { prefix: '/api/usage', group: 'settings' },
  // so is reading a folder off this machine's disk, which holds far more than this workspace
  { prefix: '/api/folders/import', group: 'settings' },
  { prefix: '/api/folders/preview', group: 'settings' },
  // and reading Feishu as this machine's signed-in Feishu user: signing in, looking a document up, importing it
  { prefix: '/api/feishu/auth', group: 'settings' },
  { prefix: '/api/feishu/preview', group: 'settings' },
  { prefix: '/api/feishu/import', group: 'settings' },

  { prefix: '/api/config', group: 'settings' },
  { prefix: '/api/agents', group: 'settings' },
  { prefix: '/api/research/profiles', group: 'settings' },
  // a source can name a command for the server to run (an MCP server over stdio): an administrator's call
  { prefix: '/api/research/sources', group: 'settings' },
  { prefix: '/api/chat/protocol', group: 'settings' },
  { prefix: '/api/playbooks', group: 'settings' },
  { prefix: '/api/workspace', group: 'settings' },

  { prefix: '/api/tree', group: 'files' },
  { prefix: '/api/file', group: 'files' },
  { prefix: '/api/upload', group: 'files' },
  { prefix: '/api/mv', group: 'files' },
  { prefix: '/api/mkdir', group: 'files' },
  { prefix: '/api/grep', group: 'files' },
  { prefix: '/api/folders', group: 'files' },
  { prefix: '/api/feishu', group: 'files' },
  { prefix: '/api/link/', group: 'files' },
  { prefix: '/api/vfs', group: 'files' },
  { prefix: '/api/okf/', group: 'files' },

  { prefix: '/api/entities/merge', group: 'knowledge' },
  { prefix: '/api/entities/unmerge', group: 'knowledge' },
  { prefix: '/api/entities/dedupe', group: 'knowledge' },
  { prefix: '/api/claims/merge', group: 'knowledge' },
  { prefix: '/api/claims/unmerge', group: 'knowledge' },
  { prefix: '/api/disputes/', group: 'knowledge', methods: ['POST', 'PUT', 'DELETE', 'PATCH'] },
  { prefix: '/api/review/', group: 'knowledge' },
  { prefix: '/api/trust', group: 'knowledge' },
  { prefix: '/api/worksets', group: 'knowledge' },
  { prefix: '/api/wiki/', group: 'knowledge' },
  { prefix: '/api/research/', group: 'knowledge' },
  { prefix: '/api/dream', group: 'knowledge' },
  { prefix: '/api/suggestions', group: 'knowledge' },

  { prefix: '/api/search', group: 'search' },
  { prefix: '/api/graph', group: 'search' },
  { prefix: '/api/entities', group: 'search' },
  { prefix: '/api/documents', group: 'search' },
  { prefix: '/api/claims', group: 'search' },
  { prefix: '/api/disputes', group: 'search' },
  { prefix: '/api/stats', group: 'search' },
  { prefix: '/api/survey', group: 'search' },
  { prefix: '/api/notices', group: 'search' },
  { prefix: '/api/lineage', group: 'search' },
  { prefix: '/api/history', group: 'search' },
  { prefix: '/api/capabilities', group: 'search' },
  { prefix: '/api/absences', group: 'search' },
  { prefix: '/api/receipts', group: 'search' },
  { prefix: '/api/learning', group: 'search' },
  { prefix: '/api/subscriptions', group: 'search' },
  { prefix: '/api/resolve', group: 'search' },
  { prefix: '/api/plan', group: 'search' },
  { prefix: '/api/feedback', group: 'search' },

  { prefix: '/api/ask', group: 'ask' },
  { prefix: '/api/chat/', group: 'ask' },
  { prefix: '/api/pack', group: 'ask' },

  { prefix: '/api/ingest', group: 'ingest' },
  { prefix: '/api/sync', group: 'ingest' },
  { prefix: '/api/forget', group: 'ingest' },
  { prefix: '/api/purge', group: 'ingest' },
  { prefix: '/api/rebuild', group: 'ingest' },

  { prefix: '/api/traces', group: 'traces' },
  { prefix: '/api/datasources', group: 'datasources' },
];

/**
 * The POSTs that only read — a question or a text in the body, nothing kept —
 * and so are open to a read-only account. Every other POST, PUT, PATCH and
 * DELETE changes something, or starts an agent or a job that may.
 */
const READS_BY_POST: RegExp[] = [
  /^\/api\/entities\/mentions$/,
  /^\/api\/plan$/,
  /^\/api\/ask$/,
  /^\/api\/datasources\/[^/]+\/query$/,
];

/** GETs that change something when asked to. */
const WRITES_BY_GET: { path: string; param: string }[] = [
  // files fresh recommendations as suggestions
  { path: '/api/research/recommendations', param: 'refresh' },
];

/** Whether a request only reads: all a read-only account may send (src/auth/accounts.ts). */
export function onlyReads(method: string, path: string, query: URLSearchParams = new URLSearchParams()): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return !WRITES_BY_GET.some((w) => w.path === path && query.has(w.param));
  return m === 'POST' && READS_BY_POST.some((re) => re.test(path));
}

const matches = (path: string, prefix: string) =>
  prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);

/** The group a request belongs to: null for none, `gateway` for /gw, `settings` for anything unlisted. */
export function apiGroupOf(method: string, path: string): ApiGroup | null {
  if (path === '/gw' || path.startsWith('/gw/')) return 'gateway';
  const m = method.toUpperCase();
  for (const rule of RULES) {
    if (!matches(path, rule.prefix)) continue;
    if (rule.methods && !rule.methods.includes(m)) continue;
    return rule.group;
  }
  return 'settings';
}
