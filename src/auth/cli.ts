import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { AccountStore, AccountUpdate, MIN_PASSWORD_LENGTH, PublicAccount } from './accounts.js';
import { API_GROUP_NAMES, DEFAULT_MEMBER_REMOTE_APIS } from './apis.js';
import { GatewayStore } from './gateways.js';
import { SessionStore } from './sessions.js';

/**
 * `knode-os user …`, `knode-os gateway …` and `knode-os tls init`: the
 * accounts, gateways and certificate of `serve`, kept in files under the data
 * root that a running server re-reads as they change.
 *
 * Passwords are typed at a hidden prompt, or read from stdin with
 * `--password-stdin` (one line) — never taken as an argument, where the shell
 * history and the process list would keep them.
 */

const collect = (value: string, previous: string[] = []) => [...previous, ...value.split(',').map((v) => v.trim()).filter(Boolean)];

/** "none" empties a list; nothing given leaves it to the default. */
const listOption = (values: string[] | undefined) => (values === undefined ? undefined : values.some((v) => v.toLowerCase() === 'none') ? [] : values);

/** One line from a hidden prompt (a terminal) or from stdin (a pipe). */
export async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
  }
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
    };
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (ch === '\u0003' || ch === '\u0004') {
          cleanup();
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function newPassword(fromStdin: boolean): Promise<string> {
  if (fromStdin || !process.stdin.isTTY) return readSecret('');
  const first = await readSecret(`password (at least ${MIN_PASSWORD_LENGTH} characters): `);
  if (first.length < MIN_PASSWORD_LENGTH) throw new Error(`passwords need at least ${MIN_PASSWORD_LENGTH} characters`);
  const again = await readSecret('again: ');
  if (again !== first) throw new Error('the passwords do not match');
  return first;
}

/** A timestamp in this machine's time zone, to the minute. */
function localTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function describe(u: PublicAccount, sessions: SessionStore): string {
  const live = sessions.list(u.username);
  const last = live.map((s) => s.lastSeenAt).sort().pop();
  return [
    `${u.username}${u.name && u.name !== u.username ? ` (${u.name})` : ''}  ${u.role}${u.readOnly ? ', read-only' : ''}${u.disabled ? '  DISABLED' : ''}`,
    `    teams: ${u.role === 'admin' ? 'all' : u.teams.join(', ') || '—'}`,
    `    from other machines: ${u.remoteApis.includes('*') ? 'every group' : u.remoteApis.join(', ') || 'nothing'}`,
    `    gateways: ${u.role === 'admin' ? 'all' : u.gateways.join(', ') || '—'}`,
    `    sessions: ${live.length}${last ? `, last used ${localTime(last)}` : ''}`,
  ].join('\n');
}

export function registerAuthCommands(program: Command, dataDir: () => string): void {
  const groupsHelp = `${API_GROUP_NAMES.join(', ')}, * or none (default for members: ${DEFAULT_MEMBER_REMOTE_APIS.join(',')})`;

  /* ------------------------------- users ------------------------------- */

  const user = program
    .command('user')
    .description('accounts that may sign in to `serve` — the web UI, the macOS app, /api and /gw (see src/auth)');

  user
    .command('add <username>')
    .description('create an account; you are asked for its password')
    .option('--admin', 'an administrator: every workspace and team, settings, users and gateways')
    .option('--name <name>', 'display name')
    .option('--team <team...>', 'team workspaces a member may open (repeat or comma-separate; * = all)', collect)
    .option('--remote-apis <group...>', `API groups usable from other machines: ${groupsHelp}`, collect)
    .option('--gateway <id...>', 'gateways (local services) a member may reach (* = all)', collect)
    .option('--read-only', 'a member who may look and not change anything')
    .option('--password-stdin', 'read the password from stdin (one line) instead of prompting')
    .action(async (username: string, opts: { admin?: boolean; name?: string; team?: string[]; remoteApis?: string[]; gateway?: string[]; readOnly?: boolean; passwordStdin?: boolean }) => {
      if (opts.admin && opts.readOnly) throw new Error('an administrator cannot be read-only — leave out --admin or --read-only');
      const accounts = new AccountStore(dataDir());
      if (accounts.get(username)) throw new Error(`user "${username}" exists — \`knode-os user passwd ${username}\` changes the password`);
      const password = await newPassword(Boolean(opts.passwordStdin));
      const account = await accounts.create({
        username, name: opts.name, password, role: opts.admin ? 'admin' : 'member',
        teams: opts.team, remoteApis: listOption(opts.remoteApis), gateways: opts.gateway, readOnly: opts.readOnly,
      });
      console.log(`created ${account.role} ${account.username}. A running \`serve\` accepts it at once.`);
      console.log(describe(account, new SessionStore(dataDir())));
      if (account.role === 'member' && !account.readOnly && (account.remoteApis.includes('ask') || account.remoteApis.includes('knowledge') || account.remoteApis.includes('*'))) {
        console.log('note: Ask and Research run coding agents on this machine, which can read files outside the workspace — give them only to people you trust with that.');
      }
    });

  user
    .command('list')
    .description('accounts with their role, teams, remote API groups and sessions')
    .option('--json', 'raw JSON output')
    .action((opts: { json?: boolean }) => {
      const accounts = new AccountStore(dataDir()).list();
      if (opts.json) return console.log(JSON.stringify(accounts, null, 2));
      if (accounts.length === 0) return console.log('no accounts — `knode-os user add <name> --admin` creates the administrator');
      const sessions = new SessionStore(dataDir());
      for (const a of accounts) console.log(describe(a, sessions));
    });

  user
    .command('set <username>')
    .description('change an account: role, name, teams, remote API groups, gateways, read-only, disabled')
    .option('--admin', 'make an administrator')
    .option('--member', 'make a member')
    .option('--name <name>', 'display name')
    .option('--team <team...>', 'replace the team list (* = all, none = no teams)', collect)
    .option('--remote-apis <group...>', `replace the groups usable from other machines: ${groupsHelp}`, collect)
    .option('--gateway <id...>', 'replace the gateway list (* = all, none)', collect)
    .option('--read-only', 'let a member look and not change anything')
    .option('--read-write', 'let a member change things again')
    .option('--disable', 'refuse sign-in and end the account\'s sessions')
    .option('--enable', 'allow sign-in again')
    .action(async (username: string, opts: { admin?: boolean; member?: boolean; name?: string; team?: string[]; remoteApis?: string[]; gateway?: string[]; readOnly?: boolean; readWrite?: boolean; disable?: boolean; enable?: boolean }) => {
      if (opts.admin && opts.member) throw new Error('--admin or --member, not both');
      if (opts.readOnly && opts.readWrite) throw new Error('--read-only or --read-write, not both');
      if (opts.disable && opts.enable) throw new Error('--disable or --enable, not both');
      const changes: AccountUpdate = {};
      if (opts.admin) changes.role = 'admin';
      if (opts.member) changes.role = 'member';
      if (opts.name !== undefined) changes.name = opts.name;
      if (opts.team) changes.teams = listOption(opts.team);
      if (opts.remoteApis) changes.remoteApis = listOption(opts.remoteApis);
      if (opts.gateway) changes.gateways = listOption(opts.gateway);
      if (opts.readOnly) changes.readOnly = true;
      if (opts.readWrite) changes.readOnly = false;
      if (opts.disable) changes.disabled = true;
      if (opts.enable) changes.disabled = false;
      if (Object.keys(changes).length === 0) throw new Error('nothing to change — see `knode-os user set --help`');
      const { account, credentialsChanged } = await new AccountStore(dataDir()).update(username, changes);
      const sessions = new SessionStore(dataDir());
      if (credentialsChanged) sessions.revokeUser(account.username);
      console.log(describe(account, sessions));
    });

  user
    .command('passwd <username>')
    .description('set a new password; every session of the account ends')
    .option('--password-stdin', 'read the password from stdin (one line) instead of prompting')
    .action(async (username: string, opts: { passwordStdin?: boolean }) => {
      const accounts = new AccountStore(dataDir());
      if (!accounts.get(username)) throw new Error(`no user "${username}"`);
      const password = await newPassword(Boolean(opts.passwordStdin));
      const { account } = await accounts.update(username, { password });
      const ended = new SessionStore(dataDir()).revokeUser(account.username);
      console.log(`password changed for ${account.username}${ended ? `; ${ended} session(s) ended` : ''}`);
    });

  user
    .command('signout <username>')
    .description('end every session of an account (browsers, apps and script tokens)')
    .action((username: string) => {
      const account = new AccountStore(dataDir()).revokeSessions(username);
      const ended = new SessionStore(dataDir()).revokeUser(account.username);
      console.log(`${account.username}: ${ended} session(s) ended`);
    });

  user
    .command('remove <username>')
    .description('delete an account (its workspaces stay on disk under users/<name>)')
    .action((username: string) => {
      new AccountStore(dataDir()).remove(username);
      new SessionStore(dataDir()).revokeUser(username.trim().toLowerCase());
      console.log(`removed ${username}; users/${username.trim().toLowerCase()} is left as it was`);
    });

  user
    .command('token <username>')
    .description('a bearer token for a script acting as this account on /api and /gw; printed once')
    .option('--label <label>', 'what uses it, e.g. homebook-sync')
    .option('--days <days>', 'days until it expires', '365')
    .action((username: string, opts: { label?: string; days: string }) => {
      const account = new AccountStore(dataDir()).get(username);
      if (!account) throw new Error(`no user "${username}"`);
      if (account.disabled) throw new Error(`${account.username} is disabled`);
      const days = Number(opts.days);
      if (!Number.isFinite(days) || days < 1) throw new Error('--days must be 1 or more');
      const { token, session } = new SessionStore(dataDir()).create({ username: account.username, kind: 'token', label: opts.label || 'script', expiresInDays: days });
      console.log(`token ${session.id} for ${account.username} (${session.label}), expires ${session.expiresAt.slice(0, 10)}`);
      console.log('');
      console.log(token);
      console.log('');
      console.log('Send it as `Authorization: Bearer <token>` (or `X-Knode-Token`). This is the only time it is shown;');
      console.log(`\`knode-os user sessions ${account.username} --revoke ${session.id}\` revokes it.`);
    });

  user
    .command('sessions [username]')
    .description('signed-in browsers, apps and script tokens (of one account, or all)')
    .option('--revoke <id>', 'end one session by its id')
    .option('--json', 'raw JSON output')
    .action((username: string | undefined, opts: { revoke?: string; json?: boolean }) => {
      const sessions = new SessionStore(dataDir());
      if (opts.revoke) {
        if (!sessions.revoke(opts.revoke, username?.trim().toLowerCase())) throw new Error(`no session ${opts.revoke}`);
        return console.log(`ended session ${opts.revoke}`);
      }
      const list = sessions.list(username?.trim().toLowerCase());
      if (opts.json) return console.log(JSON.stringify(list, null, 2));
      if (list.length === 0) return console.log('no live sessions');
      for (const s of list) {
        console.log(`${s.id}  ${s.username}  ${s.kind}  ${s.label}  since ${localTime(s.createdAt)}, last ${localTime(s.lastSeenAt)}${s.ip ? ` from ${s.ip}` : ''}, expires ${s.expiresAt.slice(0, 10)}`);
      }
    });

  /* ------------------------------ gateways ------------------------------ */

  const gateway = program
    .command('gateway')
    .description('publish a local service under /gw/<id> for signed-in accounts allowed it (see src/auth/gateways.ts)');

  gateway
    .command('add <id> <target>')
    .description('forward /gw/<id>/… to a URL on this machine, e.g. http://127.0.0.1:12300/api')
    .option('--description <text>', 'what it is, shown to the accounts that may use it')
    .option('--pass-authorization', 'pass the client\'s Authorization header through (a knode token never is)')
    .option('--no-sandbox', 'serve its pages unsandboxed — only for a web UI you trust as much as knode-os')
    .option('--timeout <seconds>', 'longest a request may take', '300')
    .option('--replace', 'replace a gateway of the same id')
    .action((id: string, target: string, opts: { description?: string; passAuthorization?: boolean; sandbox: boolean; timeout: string; replace?: boolean }) => {
      const record = new GatewayStore(dataDir()).add({
        id, target, description: opts.description, passAuthorization: opts.passAuthorization, sandbox: opts.sandbox, timeoutSeconds: Number(opts.timeout),
      }, { replace: opts.replace });
      console.log(`gateway ${record.id}: /gw/${record.id}/… → ${record.target}${record.sandbox === false ? ' (unsandboxed)' : ''}`);
      console.log(`administrators may use it now; give it to a member with \`knode-os user set <name> --gateway ${record.id}\`,`);
      console.log('and from other machines the account also needs the gateway API group (--remote-apis …,gateway).');
    });

  gateway
    .command('list')
    .description('published local services')
    .option('--json', 'raw JSON output')
    .action((opts: { json?: boolean }) => {
      const list = new GatewayStore(dataDir()).list();
      if (opts.json) return console.log(JSON.stringify(list, null, 2));
      if (list.length === 0) return console.log('no gateways — `knode-os gateway add <id> http://127.0.0.1:<port>`');
      for (const g of list) console.log(`${g.id}  /gw/${g.id}/ → ${g.target}${g.sandbox === false ? '  unsandboxed' : ''}${g.passAuthorization ? '  passes Authorization' : ''}${g.description ? `  — ${g.description}` : ''}`);
    });

  gateway
    .command('remove <id>')
    .description('stop publishing a local service')
    .action((id: string) => {
      new GatewayStore(dataDir()).remove(id);
      console.log(`removed gateway ${id}`);
    });

  /* -------------------------------- tls -------------------------------- */

  const tls = program.command('tls').description('the certificate of the HTTPS listener (server.tls) for reaching serve by IP or name');

  tls
    .command('init')
    .description('make a self-signed certificate for the names and addresses other machines use; prints its SHA-256 fingerprint')
    .option('--host <name...>', 'DNS names or IP addresses to cover (default: this machine\'s name and addresses)', collect)
    .option('--days <days>', 'validity', '825')
    .option('--force', 'replace an existing certificate')
    .action((opts: { host?: string[]; days: string; force?: boolean }) => {
      const dir = path.join(dataDir(), '.knode', 'tls');
      const cert = path.join(dir, 'cert.pem');
      const key = path.join(dir, 'key.pem');
      if (fs.existsSync(cert) && !opts.force) throw new Error(`${cert} exists — --force replaces it (clients that pinned the old one must trust the new one)`);
      const hosts = opts.host?.length ? opts.host : defaultHosts();
      const san = [...new Set([...hosts, 'localhost', '127.0.0.1'])].map((h) => (/^[\d.]+$/.test(h) || h.includes(':') ? `IP:${h}` : `DNS:${h}`)).join(',');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmpKey = `${key}.${crypto.randomUUID()}.tmp`;
      const tmpCert = `${cert}.${crypto.randomUUID()}.tmp`;
      try {
        execFileSync('openssl', [
          'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
          '-keyout', tmpKey, '-out', tmpCert, '-days', String(Math.max(1, Math.floor(Number(opts.days) || 825))),
          '-subj', '/CN=knode-os', '-addext', `subjectAltName=${san}`, '-addext', 'extendedKeyUsage=serverAuth',
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (err) {
        fs.rmSync(tmpKey, { force: true });
        fs.rmSync(tmpCert, { force: true });
        throw new Error(`openssl failed: ${err instanceof Error ? err.message : err}`);
      }
      fs.chmodSync(tmpKey, 0o600);
      fs.renameSync(tmpKey, key);
      fs.renameSync(tmpCert, cert);
      const x509 = new crypto.X509Certificate(fs.readFileSync(cert));
      console.log(`wrote ${cert} and ${key}`);
      console.log(`covers: ${x509.subjectAltName}`);
      console.log(`valid until: ${x509.validTo}`);
      console.log(`SHA-256 fingerprint: ${x509.fingerprint256}`);
      console.log('');
      console.log('Turn the listener on in knode.config.json and restart serve:');
      console.log('  "server": { …, "tls": { "port": <port>, "host": "0.0.0.0", "cert": ".knode/tls/cert.pem", "key": ".knode/tls/key.pem" } }');
      console.log('Browsers will warn about a self-signed certificate; compare the fingerprint above before you trust it.');
      console.log('The macOS app shows the fingerprint on first connect and remembers it.');
    });
}

/** This machine's name and its non-internal addresses. */
function defaultHosts(): string[] {
  const out = new Set<string>();
  const name = os.hostname();
  if (name) {
    out.add(name);
    if (!name.includes('.')) out.add(`${name}.local`);
  }
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (!a.internal && (a.family === 'IPv4' || a.family === 'IPv6') && !a.address.startsWith('fe80')) out.add(a.address);
  }
  return [...out];
}
