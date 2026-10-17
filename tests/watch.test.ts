import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { watchTree } from '../src/fs/watch.js';
import { coveringPrefixes, isWatchedSource } from '../src/server/serve.js';

/**
 * Tree watching (src/fs/watch.ts): one handle per watched tree. chokidar held
 * a file descriptor per watched file on macOS; with a linked export of ~13k
 * files plus its mirror the process passed OPEN_MAX (10240), and every spawn —
 * each Codex / Claude Code call of the document pass — failed with EBADF.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-watch-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

async function until(check: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const openFds = () => fs.readdirSync('/dev/fd').length;

describe('watchTree', () => {
  it('holds a handle per tree, not a descriptor per file, and child processes still spawn', () => {
    const root = path.join(tmp, 'many');
    for (let i = 0; i < 3000; i++) write(root, `p${i % 30}/${i}.md`, `# ${i}\n`);
    const before = openFds();
    const watcher = watchTree(root, () => {});
    try {
      expect(openFds() - before).toBeLessThan(50);
      expect(spawnSync('true').error).toBeUndefined();
    } finally {
      watcher.close();
    }
  });

  it('reports changes anywhere below the root and drops what the caller ignores', async () => {
    const root = path.join(tmp, 'tree');
    fs.mkdirSync(root, { recursive: true });
    const seen: string[] = [];
    const watcher = watchTree(root, (_abs, rel) => seen.push(rel), {
      ignore: (rel) => rel.split('/').some((s) => s.startsWith('.')),
    });
    try {
      await sleep(300); // FSEvents starts delivering a moment after the stream opens
      write(root, '.state/cache.json', '{}');
      write(root, 'xueqiu/作者__abc/2026/2026-10-14.md', '# 新帖\n');
      await until(() => seen.some((r) => r.endsWith('2026-10-14.md')), 10_000, 'the new file to be reported');
      expect(seen.some((r) => r.startsWith('.state'))).toBe(false);
    } finally {
      watcher.close();
    }
  });

  it('throws for a root that is not there, so the caller can retry later', () => {
    expect(() => watchTree(path.join(tmp, 'missing'), () => {})).toThrow();
  });
});

describe('what the data-dir watcher syncs', () => {
  it('follows raw/docs, raw/skills, wiki and the anchors, and nothing hidden or outside them', () => {
    for (const rel of ['raw/docs/a.md', 'raw/docs/content-markdown/xueqiu/x/2026/2026-W42.md', 'raw/docs', 'raw/skills/s/SKILL.md', 'wiki/sources/p.md', 'purpose.md', 'schema.md']) {
      expect(isWatchedSource(rel), rel).toBe(true);
    }
    for (const rel of [
      'raw/docs/.a.md.123.tmp', 'wiki/.obsidian/workspace.json', 'wiki/.archive/p.md', '.sidecar/raw/docs/a.md/meta.json',
      'raw/docs/x/.sidecar/meta.json', 'ledger/events.jsonl', 'knode.config.json', 'raw/traces/claude/t.jsonl', 'raw/docsx/a.md', '.knode/db/x',
    ]) {
      expect(isWatchedSource(rel), rel).toBe(false);
    }
  });
});

describe('folding a burst of watcher paths into sync prefixes', () => {
  it('keeps a few paths as they are, minus the ones another path covers', () => {
    expect(coveringPrefixes(['wiki/x.md', 'raw/docs/a/1.md', 'raw/docs/a', 'purpose.md'], 200)).toEqual(['purpose.md', 'raw/docs/a', 'wiki/x.md']);
  });

  it('syncs the folder a mirror was copied into or removed from, never the whole data dir', () => {
    // 1,899 files of one account across seven years, the way unlinking the tgb mirror reported them
    const files = Array.from({ length: 1899 }, (_, i) => `raw/docs/content-markdown/tgb/股海贼王__16cb02614da0/${2020 + (i % 7)}/${i}.md`);
    expect(coveringPrefixes(files, 200)).toEqual(Array.from({ length: 7 }, (_, i) => `raw/docs/content-markdown/tgb/股海贼王__16cb02614da0/${2020 + i}`));
    expect(coveringPrefixes(files, 1)).toEqual(['raw/docs/content-markdown/tgb/股海贼王__16cb02614da0']);
  });

  it('lifts nothing above its tree, and leaves the anchor files alone', () => {
    const spread = [...Array.from({ length: 300 }, (_, i) => `raw/docs/d${i}.md`), ...Array.from({ length: 300 }, (_, i) => `wiki/p${i}.md`), 'schema.md'];
    expect(coveringPrefixes(spread, 10)).toEqual(['raw/docs', 'schema.md', 'wiki']);
    expect(coveringPrefixes(spread, 1)).toEqual(['raw/docs', 'schema.md', 'wiki']);
  });
});
