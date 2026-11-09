import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The git side of a codebase (docs/design/25): one shallow working clone per
 * repository under `<workspace>/.knode/codebases/<name>/`, outside every tree
 * knode-os indexes. Each update fetches the one commit the tracked ref points
 * at (depth 1) and checks it out, so git rewrites only the files that changed
 * and the mirror into raw/codebase copies only those.
 *
 * git runs non-interactively: no credential prompt (a private repository
 * needs credentials git already has), no pager, a timeout per command.
 */

export const CLONES_DIR = '.knode/codebases';
const GIT_TIMEOUT_MS = 15 * 60_000;

export interface RepoSpec {
  /** What git fetches from: an https / ssh URL or an absolute local path. */
  url: string;
  /** The folder name it gets under raw/codebase unless one is given. */
  name: string;
  /** The page a person opens for it, when there is one (a GitHub repository's). */
  web: string | null;
}

export interface CommitInfo {
  commit: string;
  /** Committer date, ISO 8601. */
  committedAt: string;
  subject: string;
}

function slug(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64);
}

/** A repository name for raw/codebase/<name>: lower-case, path-safe, never `.` or `..`. */
export function codebaseName(value: string): string {
  const name = slug(value);
  if (!name || name === '.' || name === '..') throw new Error(`"${value}" makes no usable repository name — pass --name`);
  return name;
}

/**
 * Read what a person typed: `owner/repo` (GitHub), an https or ssh URL, or a
 * path on this machine to a git working copy.
 */
export function parseRepoSpec(spec: string, cwd = process.cwd()): RepoSpec {
  const s = spec.trim();
  if (!s) throw new Error('name a repository: owner/repo, a git URL, or a local path');
  const short = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(s);
  if (short && !fs.existsSync(path.resolve(cwd, s))) {
    const [, owner, repo] = short;
    return { url: `https://github.com/${owner}/${repo}.git`, name: codebaseName(`${owner}-${repo}`), web: `https://github.com/${owner}/${repo}` };
  }
  const https = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(s);
  if (https) {
    const [, host, repoPath] = https;
    const parts = repoPath.split('/').filter(Boolean);
    // github.com/owner/repo/tree/branch/... → the repository itself
    const base = host.endsWith('github.com') || host.endsWith('gitlab.com') ? parts.slice(0, 2) : parts;
    if (base.length === 0) throw new Error(`${s} names no repository`);
    const web = `https://${host}/${base.join('/')}`;
    return { url: `${web}.git`, name: codebaseName(base.slice(-2).join('-')), web: host.endsWith('github.com') || host.endsWith('gitlab.com') ? web : null };
  }
  const ssh = /^(?:ssh:\/\/)?[\w.-]+@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(s);
  if (ssh) {
    const parts = ssh[2].split('/').filter(Boolean);
    const web = ssh[1].endsWith('github.com') || ssh[1].endsWith('gitlab.com') ? `https://${ssh[1]}/${parts.join('/')}` : null;
    return { url: s, name: codebaseName(parts.slice(-2).join('-')), web };
  }
  const local = path.resolve(cwd, s.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
  if (fs.existsSync(local) && fs.statSync(local).isDirectory()) {
    return { url: local, name: codebaseName(path.basename(local)), web: null };
  }
  throw new Error(`${s} is neither owner/repo, a git URL, nor a folder on this machine`);
}

/** Run git; resolves to stdout, rejects with git's own message. */
export function git(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_ASKPASS: 'true', LC_ALL: 'C' },
    }, (error, stdout, stderr) => {
      if (error) {
        const said = String(stderr || '').trim().split('\n').filter((l) => !/^hint:/.test(l)).slice(-3).join(' ');
        reject(new Error(`git ${args[0]} failed: ${said || error.message}`));
        return;
      }
      resolve(String(stdout));
    });
  });
}

/** The working clone of repository `name` in a workspace. */
export function cloneDir(dataDir: string, name: string): string {
  return path.join(dataDir, CLONES_DIR, name);
}

/**
 * Bring the clone to the newest commit of `ref` (a branch, a tag or a commit;
 * the remote's default branch when empty). Creates the clone on first use.
 * Returns the commit checked out.
 */
export async function fetchCommit(dir: string, url: string, ref: string | undefined): Promise<CommitInfo> {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(dir, { recursive: true });
    await git(['init', '--quiet'], { cwd: dir });
    await git(['remote', 'add', 'origin', url], { cwd: dir });
  } else {
    // the URL a person gave may have changed (a moved repository)
    await git(['remote', 'set-url', 'origin', url], { cwd: dir });
  }
  const want = ref?.trim() || 'HEAD';
  if (want.startsWith('-')) throw new Error(`"${want}" is not a ref`);
  // `ext::` and friends run commands: only the transports a repository is fetched over
  await git(['-c', 'protocol.version=2', '-c', 'protocol.ext.allow=never', 'fetch', '--quiet', '--depth', '1', '--no-tags', '--prune', 'origin', want], { cwd: dir });
  await git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--force', '--detach', 'FETCH_HEAD'], { cwd: dir });
  // anything git did not check out (a file left from a failed run) is no part of the commit
  await git(['clean', '--quiet', '-ffdx'], { cwd: dir });
  return currentCommit(dir);
}

/** The commit the clone holds. */
export async function currentCommit(dir: string): Promise<CommitInfo> {
  const out = await git(['log', '-1', '--format=%H%x00%cI%x00%s'], { cwd: dir });
  const [commit, committedAt, subject] = out.trim().split('\0');
  return { commit, committedAt, subject: subject ?? '' };
}
