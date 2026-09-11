import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { importArchive } from '../src/importers/archive.js';
import { parseFrontmatter } from '../src/markdown.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-import-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
function makeArchive(envelopesByFile: Record<string, object[]>): string {
  const root = path.join(tmp, `archive-${seq++}`);
  for (const [rel, envelopes] of Object.entries(envelopesByFile)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, envelopes.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  return root;
}

function env(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    record_type: 'post',
    platform: 'fenchuan',
    target: { id: '94032', name: '肖大的快乐星球' },
    month: '2026-05',
    post_id: `${1000 + seq}`,
    sort_key: '2026-05-05 11:45',
    investment_relevant: true,
    post_markdown: '## Ian · 2026-05-05\n\n铜价因逼空持续上涨。',
    comments_markdown: '',
    ...over,
  };
}

describe('archive importer', () => {
  it('imports envelopes into month volumes with frontmatter', () => {
    const dataDir = path.join(tmp, 'data-basic');
    const archive = makeArchive({
      'fenchuan/94032/2026-05.ndjson': [
        env({ post_id: 'a', sort_key: '2026-05-02 09:00', post_markdown: '## post-two\n\nsecond' }),
        env({ post_id: 'b', sort_key: '2026-05-01 08:00', post_markdown: '## post-one\n\nfirst', comments_markdown: '### 评论\n\n- 有道理' }),
      ],
    });
    const stats = importArchive(dataDir, archive);
    expect(stats).toMatchObject({ ndjsonFiles: 1, posts: 2, volumes: 1, parseErrors: 0, skippedIrrelevant: 0 });
    expect(stats.perPlatform.fenchuan).toBe(2);

    const out = path.join(dataDir, 'raw/docs/finance/fenchuan/94032/2026-05-p01.md');
    const raw = fs.readFileSync(out, 'utf8');
    const parsed = parseFrontmatter(raw);
    expect(parsed.frontmatter).toMatchObject({
      platform: 'fenchuan',
      target: '94032',
      target_name: '肖大的快乐星球',
      month: '2026-05',
      part: 1,
      posts: 2,
    });
    // sorted by sort_key: post-one before post-two, comments appended to their post
    expect(raw.indexOf('post-one')).toBeLessThan(raw.indexOf('post-two'));
    expect(raw.indexOf('有道理')).toBeLessThan(raw.indexOf('post-two'));
  });

  it('splits a month into multiple volumes at the char cap', () => {
    const dataDir = path.join(tmp, 'data-split');
    const big = '字'.repeat(500);
    const archive = makeArchive({
      'fenchuan/94032/2026-05.ndjson': Array.from({ length: 6 }, (_, i) =>
        env({ post_id: `p${i}`, sort_key: `2026-05-0${i + 1}`, post_markdown: `## p${i}\n\n${big}` })),
    });
    const stats = importArchive(dataDir, archive, { volumeChars: 1200 });
    expect(stats.volumes).toBe(3);
    const dir = path.join(dataDir, 'raw/docs/finance/fenchuan/94032');
    expect(fs.readdirSync(dir).sort()).toEqual(['2026-05-p01.md', '2026-05-p02.md', '2026-05-p03.md']);
  });

  it('filters by month range, platform and relevance; counts parse errors', () => {
    const dataDir = path.join(tmp, 'data-filter');
    const archive = makeArchive({
      'fenchuan/94032/2026-03.ndjson': [env({ month: '2026-03' })],
      'fenchuan/94032/2026-05.ndjson': [
        env({ post_id: 'keep' }),
        env({ post_id: 'drop', investment_relevant: false }),
      ],
      'weibo/123/2026-05.ndjson': [env({ platform: 'weibo', target: { id: '123', name: 'w' } })],
    });
    fs.appendFileSync(path.join(archive, 'fenchuan/94032/2026-05.ndjson'), 'not-json\n');

    const stats = importArchive(dataDir, archive, { since: '2026-04', platforms: ['fenchuan'], relevantOnly: true });
    expect(stats).toMatchObject({ ndjsonFiles: 1, posts: 1, skippedIrrelevant: 1, parseErrors: 1 });
    expect(fs.existsSync(path.join(dataDir, 'raw/docs/finance/fenchuan/94032/2026-03-p01.md'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'raw/docs/finance/weibo'))).toBe(false);
  });

  it('is deterministic and removes stale volumes on re-import', () => {
    const dataDir = path.join(tmp, 'data-idem');
    const big = '字'.repeat(500);
    const files = {
      'fenchuan/94032/2026-05.ndjson': Array.from({ length: 4 }, (_, i) =>
        env({ post_id: `p${i}`, sort_key: `2026-05-0${i + 1}`, post_markdown: `## p${i}\n\n${big}` })),
    };
    const archive = makeArchive(files);
    importArchive(dataDir, archive, { volumeChars: 1200 });
    const dir = path.join(dataDir, 'raw/docs/finance/fenchuan/94032');
    const first = Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
    expect(Object.keys(first)).toHaveLength(2);

    // same import → byte-identical
    importArchive(dataDir, archive, { volumeChars: 1200 });
    for (const [f, content] of Object.entries(first)) {
      expect(fs.readFileSync(path.join(dir, f), 'utf8')).toBe(content);
    }

    // bigger cap → fewer volumes, stale part files removed
    importArchive(dataDir, archive, { volumeChars: 10_000 });
    expect(fs.readdirSync(dir).sort()).toEqual(['2026-05-p01.md']);
  });

  it('normalizes numeric epoch sort keys for ordering', () => {
    const dataDir = path.join(tmp, 'data-sort');
    const archive = makeArchive({
      'weibo/1/2026-05.ndjson': [
        env({ platform: 'weibo', target: { id: '1', name: 'w' }, post_id: 'late', sort_key: 1778000000000, post_markdown: '## late\n\nx' }),
        env({ platform: 'weibo', target: { id: '1', name: 'w' }, post_id: 'early', sort_key: 1777000000000, post_markdown: '## early\n\nx' }),
      ],
    });
    importArchive(dataDir, archive);
    const raw = fs.readFileSync(path.join(dataDir, 'raw/docs/finance/weibo/1/2026-05-p01.md'), 'utf8');
    expect(raw.indexOf('early')).toBeLessThan(raw.indexOf('late'));
  });
});
