import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';
import { markdownMeta, parseFrontmatter, readMatter, writeMatter } from '../src/markdown.js';

/**
 * gray-matter, called without options, keeps every text it parses for the
 * life of the process: `serve`'s heap filled with the pages it read and wrote
 * until it died at the heap limit (src/markdown.ts). Every call goes through
 * readMatter and writeMatter, which skip that cache.
 */

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('frontmatter', () => {
  it('leaves nothing behind in gray-matter\'s cache, whether read or written', () => {
    matter.clearCache();
    const text = '---\ntitle: 甲公司\ntags: [半导体]\n---\n# 甲公司\n\n正文。\n';
    expect(readMatter(text).data).toEqual({ title: '甲公司', tags: ['半导体'] });
    expect(parseFrontmatter(text).frontmatter.title).toBe('甲公司');
    expect(markdownMeta(text)?.title).toBe('甲公司');
    expect(writeMatter('\n# 乙公司\n', { title: '乙公司' })).toBe('---\ntitle: 乙公司\n---\n\n# 乙公司\n');
    expect(Object.keys(matter.cache)).toEqual([]);
  });

  it('gives each read its own data, and refuses malformed frontmatter every time it is read', () => {
    const text = '---\ntags: [a]\n---\nbody\n';
    (readMatter(text).data.tags as string[]).push('b');
    expect(readMatter(text).data.tags).toEqual(['a']);
    const bad = '---\ntitle: [unclosed\n---\nbody\n';
    expect(() => readMatter(bad)).toThrow();
    expect(() => readMatter(bad)).toThrow();
    expect(parseFrontmatter(bad)).toEqual({ frontmatter: {}, body: bad });
  });

  it('is parsed through src/markdown.ts alone', () => {
    const importers = (fs.readdirSync(srcDir, { recursive: true }) as string[])
      .filter((rel) => rel.endsWith('.ts'))
      .filter((rel) => /from 'gray-matter'/.test(fs.readFileSync(path.join(srcDir, rel), 'utf8')))
      .map((rel) => rel.split(path.sep).join('/'));
    expect(importers).toEqual(['markdown.ts']);
  });
});
