import { execFile } from 'node:child_process';
import type { ConnectorContext, FeedConnector, FeedItem, PullResult } from '../types.js';

/**
 * What happens in GitHub repositories, through the REST API: releases,
 * commits on a branch, and issues and pull requests (opened, edited, closed —
 * an issue is one item whose revisions follow it). Several repositories may
 * share a feed; each item says which (its channel).
 *
 * Signs in with params.token ("env:GITHUB_TOKEN" by default), else the token
 * `gh auth token` prints, else anonymously (60 requests an hour — enough for
 * releases of a few repositories). Commits and issues resume from the time
 * of the newest one seen, with GitHub's `since`; releases are re-listed (the
 * newest 30) and the ledger skips those already kept.
 */

const API = 'https://api.github.com';
type Kind = 'releases' | 'commits' | 'issues' | 'pulls';
const KINDS: Kind[] = ['releases', 'commits', 'issues', 'pulls'];

interface RepoState {
  commitsSince?: string;
  issuesSince?: string;
}
interface GithubState {
  repos?: Record<string, RepoState>;
}

export function repoList(params: Record<string, unknown>): string[] {
  const list = [params.repo, ...(Array.isArray(params.repos) ? params.repos : [])]
    .map((r) => (typeof r === 'string' ? r.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '') : ''))
    .filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r));
  return [...new Set(list)];
}

function kindsOf(params: Record<string, unknown>): Kind[] {
  const raw = Array.isArray(params.events) ? params.events.map(String) : typeof params.events === 'string' ? params.events.split(/[\s,]+/) : ['releases'];
  const kinds = raw.map((k) => k.trim().toLowerCase()).filter((k): k is Kind => (KINDS as string[]).includes(k));
  return kinds.length ? kinds : ['releases'];
}

let ghToken: Promise<string> | null = null;
function tokenFromGh(): Promise<string> {
  ghToken ??= new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { timeout: 10_000 }, (err, stdout) => resolve(err ? '' : stdout.trim()));
  });
  return ghToken;
}

async function token(ctx: ConnectorContext): Promise<string> {
  const given = ctx.secret(ctx.feed.params.token ?? 'env:GITHUB_TOKEN');
  if (given) return given;
  return ctx.feed.params.useGh === false ? '' : tokenFromGh();
}

async function api<T>(ctx: ConnectorContext, auth: string, path: string): Promise<T> {
  const res = await ctx.fetch(`${API}${path}`, {
    headers: { 'x-github-api-version': '2022-11-28', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    accept: 'application/vnd.github+json',
    allowErrorStatus: true,
  });
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers['x-ratelimit-reset']);
    const when = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString()}` : '';
    throw new Error(`GitHub refused ${path} (${res.status}${res.headers['x-ratelimit-remaining'] === '0' ? `: rate limit${when}` : ''})${auth ? '' : ' — set params.token or sign in with gh for 5000 requests an hour'}`);
  }
  if (res.status >= 400) throw new Error(`GitHub answered ${res.status} for ${path}: ${res.text.slice(0, 200)}`);
  return JSON.parse(res.text) as T;
}

interface GhUser {
  login: string;
  html_url?: string;
}

function releaseItem(repo: string, r: Record<string, unknown>): FeedItem {
  const tag = String(r.tag_name ?? '');
  const name = String(r.name ?? '') || tag;
  const author = r.author as GhUser | null;
  return {
    id: `release:${r.id}`,
    url: String(r.html_url ?? ''),
    title: `${repo} ${tag}${name && name !== tag ? ` — ${name}` : ''}`,
    ...(author ? { author: { name: author.login, id: author.login, url: author.html_url } } : {}),
    channel: { id: repo, name: repo, kind: 'repo' },
    publishedAt: String(r.published_at ?? r.created_at ?? ''),
    text: String(r.body ?? '').trim() || `Release ${tag}.`,
    format: 'markdown',
    tags: ['release', ...(r.prerelease ? ['prerelease'] : [])],
    dedupeKey: `github:${repo}:release:${tag}`,
    meta: { kind: 'release', repo, tag, prerelease: Boolean(r.prerelease) },
  };
}

function commitItem(repo: string, c: Record<string, unknown>): FeedItem {
  const commit = c.commit as { message?: string; author?: { name?: string; date?: string }; committer?: { date?: string } };
  const message = String(commit?.message ?? '').trim();
  const [subject, ...rest] = message.split('\n');
  const sha = String(c.sha ?? '');
  const login = (c.author as GhUser | null)?.login;
  return {
    id: `commit:${sha}`,
    url: String(c.html_url ?? ''),
    title: subject.slice(0, 200),
    author: { name: commit?.author?.name ?? login ?? 'unknown', ...(login ? { id: login } : {}) },
    channel: { id: repo, name: repo, kind: 'repo' },
    publishedAt: String(commit?.committer?.date ?? commit?.author?.date ?? ''),
    text: [`\`${sha.slice(0, 7)}\` ${subject}`, rest.join('\n').trim()].filter(Boolean).join('\n\n'),
    format: 'markdown',
    tags: ['commit'],
    meta: { kind: 'commit', repo, sha },
  };
}

function issueItem(repo: string, i: Record<string, unknown>): FeedItem {
  const pr = Boolean(i.pull_request);
  const number = Number(i.number);
  const user = i.user as GhUser | null;
  const labels = ((i.labels as Array<{ name?: string } | string> | undefined) ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean);
  const state = String(i.state ?? '');
  const merged = Boolean((i.pull_request as { merged_at?: string } | undefined)?.merged_at);
  const status = pr ? (merged ? 'merged' : state) : String(i.state_reason ?? '') || state;
  return {
    id: `${pr ? 'pull' : 'issue'}:${number}@${repo}`,
    url: String(i.html_url ?? ''),
    title: `${repo}#${number} ${String(i.title ?? '')}`,
    ...(user ? { author: { name: user.login, id: user.login, url: user.html_url } } : {}),
    channel: { id: repo, name: repo, kind: 'repo' },
    publishedAt: String(i.created_at ?? ''),
    updatedAt: String(i.updated_at ?? ''),
    text: [`**${pr ? 'Pull request' : 'Issue'}** · ${status}${labels.length ? ` · labels: ${labels.join(', ')}` : ''} · ${Number(i.comments ?? 0)} comment(s)`, String(i.body ?? '').trim()].filter(Boolean).join('\n\n'),
    format: 'markdown',
    tags: [pr ? 'pull-request' : 'issue', ...labels],
    dedupeKey: `github:${repo}:${number}`,
    meta: { kind: pr ? 'pull' : 'issue', repo, number, state: status, labels, comments: Number(i.comments ?? 0) },
  };
}

async function pullGithub(ctx: ConnectorContext): Promise<PullResult> {
  const repos = repoList(ctx.feed.params);
  if (!repos.length) throw new Error('params.repo ("owner/name") is required');
  const kinds = kindsOf(ctx.feed.params);
  const auth = await token(ctx);
  const prev = (ctx.state ?? {}) as GithubState;
  const next: GithubState = { repos: { ...(prev.repos ?? {}) } };
  const since = (ctx.since ?? new Date(Date.now() - 7 * 86_400_000)).toISOString();
  const branch = typeof ctx.feed.params.branch === 'string' && ctx.feed.params.branch.trim() ? ctx.feed.params.branch.trim() : '';
  const items: FeedItem[] = [];
  const notes: string[] = [];
  for (const repo of repos) {
    const st: RepoState = { ...(prev.repos?.[repo] ?? {}) };
    if (kinds.includes('releases')) {
      const list = await api<Array<Record<string, unknown>>>(ctx, auth, `/repos/${repo}/releases?per_page=30`);
      const fresh = list.filter((r) => !r.draft).map((r) => releaseItem(repo, r));
      items.push(...fresh);
      notes.push(`${repo}: ${fresh.length} release(s) listed`);
    }
    if (kinds.includes('commits')) {
      const from = st.commitsSince ?? since;
      const list = await api<Array<Record<string, unknown>>>(ctx, auth, `/repos/${repo}/commits?per_page=100&since=${encodeURIComponent(from)}${branch ? `&sha=${encodeURIComponent(branch)}` : ''}`);
      const got = list.map((c) => commitItem(repo, c));
      items.push(...got);
      const newest = got.map((c) => c.publishedAt).sort().pop();
      if (newest) st.commitsSince = newest;
      notes.push(`${repo}: ${got.length} commit(s)`);
    }
    if (kinds.includes('issues') || kinds.includes('pulls')) {
      const from = st.issuesSince ?? since;
      const list = await api<Array<Record<string, unknown>>>(ctx, auth, `/repos/${repo}/issues?state=all&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(from)}`);
      const got = list.filter((i) => (i.pull_request ? kinds.includes('pulls') : kinds.includes('issues'))).map((i) => issueItem(repo, i));
      items.push(...got);
      const newest = list.map((i) => String(i.updated_at ?? '')).filter(Boolean).sort().pop();
      if (newest) st.issuesSince = newest;
      notes.push(`${repo}: ${got.length} issue(s)/pull request(s) updated`);
    }
    next.repos![repo] = st;
  }
  return { items, state: next, notes };
}

export const githubConnector: FeedConnector = {
  id: 'github',
  label: 'GitHub repositories',
  note: 'Releases, commits, issues and pull requests of repositories, through the REST API. Signs in with params.token (default env:GITHUB_TOKEN) or the gh CLI\'s token.',
  platform: 'github',
  params: [
    { name: 'repo', label: 'Repository (owner/name)', type: 'string', required: true, example: 'garrytan/gbrain' },
    { name: 'repos', label: 'More repositories', type: 'string[]' },
    { name: 'events', label: 'What to follow: releases, commits, issues, pulls (default releases)', type: 'string[]', example: ['releases', 'issues'] },
    { name: 'branch', label: 'Branch for commits (default the repository\'s default)', type: 'string' },
    { name: 'token', label: 'Token (default env:GITHUB_TOKEN, then gh auth token)', type: 'secret' },
  ],
  defaults: { units: { by: 'item' }, render: { period: 'day', by: 'channel' }, schedule: { every: '3h' }, backfillDays: 14 },
  minIntervalMinutes: 10,
  async check(ctx) {
    const [repo] = repoList(ctx.feed.params);
    if (!repo) return { ok: false, message: 'params.repo ("owner/name") is required' };
    const info = await api<{ full_name: string; stargazers_count: number }>(ctx, await token(ctx), `/repos/${repo}`);
    return { ok: true, message: `${info.full_name} (${info.stargazers_count} stars)` };
  },
  pull: pullGithub,
};
