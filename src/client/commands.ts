import os from 'node:os';
import readline from 'node:readline/promises';
import type { Command } from 'commander';
import { readSecret } from '../auth/cli.js';
import type { PublicSession } from '../auth/sessions.js';
import type { TasksSnapshot } from '../server/tasks.js';
import { AccountView, Fetch, KnodeClient, Method, Query, ServerError } from './client.js';
import { normalizeServerUrl, SavedServer, SavedWorkspace, SignInStore } from './signins.js';

/**
 * `knode-os login`, `logout`, `whoami`, `workspaces` and `use`: signing this
 * machine in to a knode-os server, so the reading commands — search, ask,
 * graph, claims, ls, read, grep — answer from that server's workspace instead
 * of a data directory here. Everything else stays on this machine.
 */

export interface WorkspaceChoice extends SavedWorkspace {
  /** How a person names it to `use`: personal/<id> or team/<slug>. */
  ref: string;
}

const fold = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '-');

/** The account's personal workspaces, then its Teams. */
export async function listWorkspaces(client: KnodeClient, me?: AccountView): Promise<WorkspaceChoice[]> {
  const [personal, view] = await Promise.all([client.personalWorkspaces(), me ? Promise.resolve(me) : client.me()]);
  return [
    ...personal.map((w) => ({ kind: 'personal' as const, id: w.id, name: w.name, ref: `personal/${w.id}` })),
    ...view.teams.map((t) => ({ kind: 'team' as const, id: t.id, name: t.name, ref: `team/${t.slug}` })),
  ];
}

/**
 * `finance`, `team/finance`, `personal/default` or a workspace's own name →
 * one of the choices. A bare name is looked for among the personal
 * workspaces first, then the Teams. Nothing named: the one used before, the
 * personal Default, or whatever there is.
 */
export function pickWorkspace(choices: WorkspaceChoice[], wanted?: string, previous?: SavedWorkspace): WorkspaceChoice {
  if (wanted) {
    const match = /^(personal|team)\/(.+)$/i.exec(wanted.trim());
    const kind = match ? (match[1].toLowerCase() as 'personal' | 'team') : undefined;
    const key = fold(match ? match[2] : wanted);
    const named = (c: WorkspaceChoice) => fold(c.ref.split('/')[1]) === key || fold(c.name) === key || fold(c.id) === key;
    const found = (['personal', 'team'] as const).filter((k) => !kind || k === kind).map((k) => choices.find((c) => c.kind === k && named(c))).find(Boolean);
    if (found) return found;
    throw new Error(`no workspace "${wanted}" for this account — it has ${choices.map((c) => c.ref).join(', ') || 'none'}`);
  }
  const before = previous && choices.find((c) => c.kind === previous.kind && c.id === previous.id);
  const chosen = before ?? choices.find((c) => c.kind === 'personal' && c.id === 'default') ?? choices[0];
  if (!chosen) throw new Error('this account has no workspace on the server');
  return chosen;
}

export const describeWorkspace = (w: SavedWorkspace) => (w.kind === 'team' ? `Team ${w.name}` : `personal workspace ${w.name}`);

/**
 * Sign in to a server and keep the session: with a password, or with a
 * script token from `knode-os user token`. A session already kept for the
 * same account is reused when it still works.
 */
export async function signIn(opts: {
  server: string;
  store: SignInStore;
  username?: string;
  password?: () => Promise<string>;
  token?: string;
  workspace?: string;
  label?: string;
  fetch?: Fetch;
}): Promise<{ saved: SavedServer; me: AccountView; workspaces: WorkspaceChoice[]; reused: boolean }> {
  const url = normalizeServerUrl(opts.server);
  const bare = new KnodeClient(url, { fetch: opts.fetch });
  const kept = opts.store.get(url);

  let token: string | undefined;
  let me: AccountView | undefined;
  let reused = false;
  if (opts.token) {
    token = opts.token.trim();
    me = await bare.withToken(token).me();
  } else if (kept && (!opts.username || fold(opts.username) === kept.username)) {
    try {
      me = await bare.withToken(kept.token).me();
      token = kept.token;
      reused = true;
    } catch (e) {
      if (!(e instanceof ServerError && e.status === 401)) throw e;
    }
  }
  if (!token || !me) {
    const state = await bare.state();
    if (!state.auth) throw new Error(`${url} has sign-in turned off — it answers only its own machine`);
    if (state.setupRequired) throw new Error(`${url} has no accounts yet — its administrator creates the first one on that machine`);
    if (!opts.username) throw new Error('name the account: knode-os login <server> --user <name>');
    if (!opts.password) throw new Error('a password is needed');
    const issued = await bare.login(opts.username, await opts.password(), opts.label ?? `knode-os CLI on ${os.hostname()}`);
    token = issued.token;
    me = issued;
  }

  const client = bare.withToken(token);
  const workspaces = await listWorkspaces(client, me);
  const workspace = pickWorkspace(workspaces, opts.workspace, kept?.workspace);
  const saved: SavedServer = {
    url,
    username: me.account.username,
    token,
    sessionId: me.session?.id ?? kept?.sessionId,
    workspace: { kind: workspace.kind, id: workspace.id, name: workspace.name },
    signedInAt: reused && kept ? kept.signedInAt : new Date().toISOString(),
  };
  opts.store.save(saved);
  return { saved, me, workspaces, reused };
}

/** End the session on the server, then forget it here. A server that cannot be reached is still forgotten. */
export async function signOut(store: SignInStore, server?: string, fetchImpl?: Fetch): Promise<{ url: string; ended: boolean; warning?: string } | null> {
  const url = server ? normalizeServerUrl(server) : store.current()?.url;
  const saved = url ? store.get(url) : null;
  if (!url || !saved) return null;
  let warning: string | undefined;
  try {
    await KnodeClient.forSaved(saved, fetchImpl).logout();
  } catch (e) {
    warning = `${e instanceof Error ? e.message : e} — the session stays valid on the server until it expires; an administrator can end it (knode-os user sessions ${saved.username} --revoke <id>)`;
  }
  store.remove(url);
  return { url, ended: !warning, warning };
}

/** The server the reading commands go to, or null for this machine's data directory. */
export function serverClient(store = new SignInStore(), fetchImpl?: Fetch): KnodeClient | null {
  const saved = store.current();
  return saved ? KnodeClient.forSaved(saved, fetchImpl) : null;
}

function accountLine(url: string, me: AccountView): string {
  const a = me.account;
  return `signed in to ${url} as ${a.username}${a.name && a.name !== a.username ? ` (${a.name})` : ''} — ${a.role}${a.readOnly ? ', read-only' : ''}`;
}

function allowedLine(me: AccountView): string {
  const allowed = Object.entries(me.groups).filter(([, ok]) => ok).map(([g]) => g);
  return `${me.local ? 'on the server\'s machine' : 'from this machine'} it may use: ${allowed.join(', ') || 'nothing'}`;
}

function otherWorkspaces(workspaces: WorkspaceChoice[], current?: SavedWorkspace): string | null {
  const others = workspaces.filter((w) => !(current && w.kind === current.kind && w.id === current.id));
  return others.length ? `also: ${others.map((w) => w.ref).join(', ')} — \`knode-os use <name>\` switches` : null;
}

async function askLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export function registerClientCommands(program: Command, localDataDir: () => string): void {
  const store = () => new SignInStore();

  program
    .command('login [server]')
    .description('sign this machine in to a knode-os server: search, ask, graph, claims, ls, read and grep then answer from it (--data keeps them here)')
    .option('-u, --user <name>', 'the account (asked for when left out)')
    .option('-w, --workspace <name>', 'the workspace commands use: a Team (finance, team/finance) or a personal one (personal/default)')
    .option('--password-stdin', 'read the password from stdin (one line) instead of a hidden prompt')
    .option('--token-stdin', 'sign in with a script token from `knode-os user token`, read from stdin')
    .option('--label <label>', 'what the server lists this session as (default: knode-os CLI on <hostname>)')
    .action(async (server: string | undefined, opts: { user?: string; workspace?: string; passwordStdin?: boolean; tokenStdin?: boolean; label?: string }) => {
      const signIns = store();
      const target = server ?? signIns.current()?.url;
      if (!target) throw new Error('name the server: knode-os login https://knode.example.com');
      let username = opts.user;
      if (!username && !opts.tokenStdin && !signIns.get(normalizeServerUrl(target))) {
        if (!process.stdin.isTTY) throw new Error('name the account: knode-os login <server> --user <name>');
        username = await askLine('username: ');
      }
      const result = await signIn({
        server: target,
        store: signIns,
        username,
        token: opts.tokenStdin ? await readSecret('') : undefined,
        password: () => readSecret(opts.passwordStdin || !process.stdin.isTTY ? '' : 'password: '),
        workspace: opts.workspace,
        label: opts.label,
      });
      console.log(`${accountLine(result.saved.url, result.me)}${result.reused ? ' (the session kept here still works)' : ''}`);
      console.log(`workspace: ${describeWorkspace(result.saved.workspace!)}`);
      const others = otherWorkspaces(result.workspaces, result.saved.workspace);
      if (others) console.log(others);
      console.log(allowedLine(result.me));
      if (result.me.account.readOnly) console.log('read-only: this account may look, not change anything');
      console.log(`kept in ${signIns.file}`);
    });

  program
    .command('logout [server]')
    .description('end this machine\'s session on a server (default: the current one) and forget it; commands work on this machine again')
    .action(async (server?: string) => {
      const out = await signOut(store(), server);
      if (!out) {
        console.log(server ? `not signed in to ${normalizeServerUrl(server)}` : 'not signed in to a server');
        return;
      }
      console.log(`signed out of ${out.url}`);
      if (out.warning) console.error(`note: ${out.warning}`);
    });

  program
    .command('whoami')
    .description('which server and workspace the reading commands use, as whom — or the data directory here')
    .option('--json', 'raw JSON output')
    .action(async (opts: { json?: boolean }) => {
      const signIns = store();
      const saved = signIns.current();
      const forcedLocal = Boolean(program.opts().data || process.env.KNODE_OS_DATA);
      if (!saved || forcedLocal) {
        const dir = localDataDir();
        if (opts.json) return console.log(JSON.stringify({ server: null, dataDir: dir, signedIn: saved?.url ?? null }, null, 2));
        console.log(`commands work on the data directory ${dir}`);
        if (saved) console.log(`(signed in to ${saved.url} too; --data / KNODE_OS_DATA keeps commands here)`);
        else console.log('`knode-os login <server>` signs in to a knode-os server instead');
        return;
      }
      const me = await KnodeClient.forSaved(saved).me();
      if (opts.json) return console.log(JSON.stringify({ server: saved.url, workspace: saved.workspace ?? null, ...me }, null, 2));
      console.log(accountLine(saved.url, me));
      console.log(`workspace: ${saved.workspace ? describeWorkspace(saved.workspace) : 'none — `knode-os use <name>`'}`);
      console.log(allowedLine(me));
      if (me.account.readOnly) console.log('read-only: this account may look, not change anything');
      if (me.session) console.log(`session: ${me.session.label}, until ${me.session.expiresAt} unless used again`);
    });

  program
    .command('workspaces')
    .description('the workspaces the signed-in account may open on the server; * marks the one commands use')
    .option('--json', 'raw JSON output')
    .action(async (opts: { json?: boolean }) => {
      const saved = store().current();
      if (!saved) throw new Error('not signed in to a server — `knode-os login <server>` first');
      const workspaces = await listWorkspaces(KnodeClient.forSaved(saved));
      if (opts.json) return console.log(JSON.stringify(workspaces, null, 2));
      for (const w of workspaces) {
        const mark = saved.workspace && saved.workspace.kind === w.kind && saved.workspace.id === w.id ? '*' : ' ';
        console.log(`${mark} ${w.ref.padEnd(28)} ${describeWorkspace(w)}`);
      }
    });

  program
    .command('use <workspace>')
    .description('the workspace on the server commands use from now on: finance, team/finance, personal/default')
    .action(async (wanted: string) => {
      const signIns = store();
      const saved = signIns.current();
      if (!saved) throw new Error('not signed in to a server — `knode-os login <server>` first');
      const chosen = pickWorkspace(await listWorkspaces(KnodeClient.forSaved(saved)), wanted);
      signIns.setWorkspace(saved.url, { kind: chosen.kind, id: chosen.id, name: chosen.name });
      console.log(`commands on ${saved.url} now use the ${describeWorkspace(chosen)}`);
    });

  const signedIn = (what: string) => {
    const saved = store().current();
    if (!saved) throw new Error(`\`knode-os ${what}\` talks to a server — \`knode-os login <server>\` first`);
    return saved;
  };

  program
    .command('sessions')
    .description('your sessions on the server: browsers, apps, this CLI, scripts; --revoke ends one')
    .option('--revoke <id>', 'end this session')
    .option('--json', 'raw JSON output')
    .action(async (opts: { revoke?: string; json?: boolean }) => {
      const client = KnodeClient.forSaved(signedIn('sessions'));
      if (opts.revoke) {
        await client.call('DELETE', `/api/auth/sessions/${encodeURIComponent(opts.revoke)}`);
        console.log(`ended session ${opts.revoke}`);
        return;
      }
      const sessions = await client.call<(PublicSession & { current?: boolean })[]>('GET', '/api/auth/sessions');
      if (opts.json) return console.log(JSON.stringify(sessions, null, 2));
      for (const s of sessions) {
        console.log(`${s.current ? '*' : ' '} ${s.id}  ${s.kind.padEnd(7)} ${s.label.slice(0, 40).padEnd(40)} last used ${s.lastSeenAt.slice(0, 16).replace('T', ' ')}${s.ip ? ` from ${s.ip}` : ''}`);
      }
    });

  program
    .command('password')
    .description('change your password on the server; your other sessions end, this one carries on')
    .option('--password-stdin', 'read the current and the new password from stdin, one per line')
    .action(async (opts: { passwordStdin?: boolean }) => {
      const signIns = store();
      const saved = signedIn('password');
      let current: string;
      let next: string;
      if (opts.passwordStdin || !process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
        [current = '', next = ''] = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
      } else {
        current = await readSecret('current password: ');
        next = await readSecret('new password: ');
        if ((await readSecret('again: ')) !== next) throw new Error('the passwords do not match');
      }
      const res = await KnodeClient.forSaved(saved).call<{ token?: string; session?: PublicSession }>('POST', '/api/auth/password', { body: { current, password: next } });
      // the old token ended with every other session: keep the one the server issued for this one
      if (res.token) signIns.save({ ...saved, token: res.token, sessionId: res.session?.id ?? saved.sessionId });
      console.log('password changed; your other sessions have ended');
    });

  program
    .command('tasks')
    .description('what the server is working on: processing, the pipeline stage by stage, calls out, research and Ask jobs, the schedule')
    .option('--json', 'raw JSON output')
    .action(async (opts: { json?: boolean }) => {
      const snap = await KnodeClient.forSaved(signedIn('tasks')).get<TasksSnapshot>('/api/tasks');
      console.log(opts.json ? JSON.stringify(snap, null, 2) : formatTasks(snap));
    });

  program
    .command('api <route>')
    .description('call any route of the server\'s REST API as the signed-in account — what the app does that no command covers (docs: README "REST API")')
    .option('-X, --method <method>', 'GET, POST, PUT, PATCH or DELETE (default GET, or POST with fields or --input)')
    .option('-f, --field <key=value...>', 'a JSON body field (a query parameter with GET); a value that parses as JSON is sent as such', (v: string, all: string[] = []) => [...all, v])
    .option('-q, --query <key=value...>', 'a query parameter', (v: string, all: string[] = []) => [...all, v])
    .option('--input <file>', 'the JSON body, from a file or - for stdin')
    .option('--no-workspace', 'leave out the workspace headers')
    .option('-o, --out <file>', 'save the response body to a file')
    .action(async (route: string, opts: { method?: string; field?: string[]; query?: string[]; input?: string; workspace: boolean; out?: string }) => {
      const saved = signedIn('api');
      const pairs = (items: string[] = []) => items.map((item) => {
        const at = item.indexOf('=');
        if (at < 1) throw new Error(`expected key=value, got ${item}`);
        return [item.slice(0, at), item.slice(at + 1)] as const;
      });
      const asJson = (v: string): unknown => {
        try {
          return JSON.parse(v);
        } catch {
          return v;
        }
      };
      const fields = pairs(opts.field);
      let body: unknown;
      if (opts.input) {
        const raw = opts.input === '-' ? await readAll(process.stdin) : (await import('node:fs')).readFileSync(opts.input, 'utf8');
        body = JSON.parse(raw);
      }
      const method = (opts.method ?? (body !== undefined || fields.length ? 'POST' : 'GET')).toUpperCase() as Method;
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error(`no such method: ${method}`);
      const query: Query = Object.fromEntries(pairs(opts.query));
      if (method === 'GET' || method === 'DELETE') for (const [k, v] of fields) query[k] = v;
      else if (fields.length) body = { ...(body && typeof body === 'object' ? body : {}), ...Object.fromEntries(fields.map(([k, v]) => [k, asJson(v)])) };
      const path = route.startsWith('/') ? route : `/api/${route.replace(/^api\//, '')}`;
      const client = KnodeClient.forSaved(saved);
      const res = await client.send(method, path, { query, body, workspace: opts.workspace && Boolean(saved.workspace), accept: '*/*' });
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (opts.out) {
        (await import('node:fs')).writeFileSync(opts.out, bytes);
        console.log(`saved ${bytes.length} bytes to ${opts.out}`);
        return;
      }
      const type = res.headers.get('content-type') ?? '';
      const text = Buffer.from(bytes).toString('utf8');
      if (type.includes('json')) {
        try {
          return console.log(JSON.stringify(JSON.parse(text), null, 2));
        } catch {
          // not JSON after all: as it came
        }
      }
      if (/^(text\/|application\/(xml|javascript))/.test(type) || !type) process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
      else if (!process.stdout.isTTY) process.stdout.write(bytes);
      else throw new Error(`the answer is ${type} (${bytes.length} bytes): -o <file> saves it`);
    });
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

export function formatTasks(t: TasksSnapshot): string {
  const lines: string[] = [];
  const at = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');
  lines.push(t.processing ? `processing: ${t.processing.running ? `running since ${at(t.processing.since)}${t.processing.by ? ` (started by ${t.processing.by})` : ''}` : 'stopped'}` : 'processing: not available (the server is not serving)');
  lines.push('', 'stage        waiting   out  done/h');
  for (const s of t.stages) lines.push(`${s.id.padEnd(12)} ${String(s.waiting).padStart(7)} ${String(s.inFlight).padStart(5)} ${String(s.doneLastHour ?? '—').padStart(7)}  ${s.unit}${s.enabled ? '' : '  (off)'}`);
  if (t.inFlight.length) {
    lines.push('', `calls out (${t.inFlight.length}):`);
    for (const f of t.inFlight.slice(0, 15)) lines.push(`  ${f.kind.padEnd(10)} ${f.subject.slice(0, 60)}  — ${f.worker}${f.remote ? ' (remote)' : ''}, ${f.ageSeconds}s`);
  }
  const live = t.jobs.filter((j) => !j.finishedAt);
  if (live.length) {
    lines.push('', 'jobs:');
    for (const j of live) lines.push(`  ${j.id}  ${j.kind.padEnd(8)} ${j.status.padEnd(9)} ${j.stage ?? ''}  ${j.title.slice(0, 60)}`);
  }
  if (t.activity.running.length) {
    lines.push('', 'running:');
    for (const a of t.activity.running) lines.push(`  ${a.label}${a.progress ? ` — ${a.progress}` : ''} (since ${at(a.startedAt)})`);
  }
  if (t.scheduled.length) {
    lines.push('', 'schedule:');
    for (const s of t.scheduled) lines.push(`  ${s.id.padEnd(12)} ${s.enabled ? `next ${at(s.next)}, last ${at(s.last)}${s.running ? ', running now' : ''}` : 'off'}`);
  }
  if (t.documentErrors.length) {
    lines.push('', 'documents that failed:');
    for (const d of t.documentErrors) lines.push(`  ${d.path}: ${(d.error ?? '').slice(0, 100)}`);
  }
  return lines.join('\n');
}

/** The commands that answer from the current server when this machine is signed in to one (or talk to it). */
export const SERVER_COMMANDS = new Set([
  'login', 'logout', 'whoami', 'workspaces', 'use', 'sessions', 'password', 'tasks', 'api',
  'ls', 'tree', 'read', 'stat', 'grep', 'get', 'put', 'write', 'mkdir', 'mv', 'rm',
  'search', 'ask', 'graph', 'claims', 'stats', 'survey', 'sync', 'ingest',
  'entities list', 'entities show', 'suggestions list',
  'research study list', 'research study show', 'research study new', 'research study refine', 'research study start',
  'research study cancel', 'research study retry', 'research study remove', 'research study report',
  'chat send', 'chat list',
  'conversations list', 'conversations show', 'conversations import', 'conversations followed', 'conversations sync', 'conversations unfollow',
]);

/** "research study list" for the command an action belongs to. */
export function commandPath(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c && c.parent; c = c.parent) names.unshift(c.name());
  return names.join(' ');
}

/**
 * Signed in to a server, a command that has no server side still works on
 * this machine's data directory: say so once, on stderr, so nobody takes an
 * empty local answer for the server's.
 */
export function noteLocalCommands(program: Command, localDataDir: () => string): void {
  program.hook('preAction', (_root, action) => {
    const name = commandPath(action);
    if (SERVER_COMMANDS.has(name) || program.opts().data || process.env.KNODE_OS_DATA) return;
    const saved = new SignInStore().current();
    if (saved) console.error(`note: \`knode-os ${name}\` works on the data directory here (${localDataDir()}), not on ${saved.url}`);
  });
}
