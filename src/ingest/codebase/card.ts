import fs from 'node:fs';
import path from 'node:path';
import { RAW_CODEBASE } from '../../fs/layout.js';
import { codeLanguageOf } from './files.js';
import { extractSymbols, hasSymbolRules } from './symbols.js';

/**
 * The repository card (docs/design/25): one Markdown file per repository,
 * written under raw/docs/codebase/, that the whole document pipeline reads —
 * extraction names the project, its parts and what it uses; the summary page
 * becomes the repository's page in the wiki.
 *
 * It is rendered from the commit alone (no model call, no clock), so the
 * same commit renders the same bytes and an update that changed nothing a
 * reader would see costs nothing downstream. What it holds is what a person
 * opening an unfamiliar repository looks at first: the README, what the
 * manifests say it is and depends on, the layout, where the documentation
 * is, and a map of the definitions in the files the rest of the code imports
 * most — the "repo map" coding agents build for the same reason.
 */

export interface CardFile {
  /** Path inside the repository. */
  rel: string;
  abs: string;
  bytes: number;
}

export interface CardInput {
  name: string;
  title: string;
  url: string;
  web: string | null;
  ref: string | null;
  commit: string;
  committedAt: string;
  subject: string;
  files: CardFile[];
  /** Files the rules left behind, by reason. */
  skipped: Record<string, number>;
  include: string[];
  exclude: string[];
}

/** Bounds on each part, in characters: the card stays a document, not a dump. */
const README_CHARS = 12_000;
const TREE_LINES = 90;
const DOC_LINES = 120;
const SYMBOL_CHARS = 18_000;
const MANIFEST_DEPS = 40;
/** Source text the code map ranks and reads at most. */
const CODE_MAP_INPUT_CHARS = 80 * 1024 * 1024;

function readText(abs: string, max = 2 * 1024 * 1024): string {
  try {
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, max));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const at = text.lastIndexOf('\n', max);
  return `${text.slice(0, at > max * 0.6 ? at : max).trimEnd()}\n\n…`;
}

/** Headings inside a README become one level deeper, under the card's own. */
function demoteHeadings(markdown: string): string {
  let fence = false;
  return markdown.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return line;
    const m = /^(#{1,5})\s/.exec(line);
    return m ? `##${line}` : line;
  }).join('\n');
}

function firstHeading(text: string): string | null {
  const fm = /^---\n[\s\S]*?\ntitle:\s*["']?([^"'\n]+)["']?\s*\n[\s\S]*?\n---/.exec(text);
  if (fm) return fm[1].trim();
  const h = /^#{1,3}\s+(.+)$/m.exec(text);
  if (h) return h[1].replace(/[`*_]/g, '').trim();
  const rst = /^([^\n]{3,100})\n[=\-~^]{3,}\s*$/m.exec(text);
  return rst ? rst[1].trim() : null;
}

/* -------------------------------- README -------------------------------- */

function pickReadme(files: CardFile[]): CardFile | null {
  const top = files.filter((f) => !f.rel.includes('/') && /^readme(\.(md|markdown|mdx|rst|txt))?$/i.test(f.rel));
  return top.sort((a, b) => a.rel.length - b.rel.length)[0] ?? null;
}

/** Badges, HTML blocks and image-only lines say nothing a reader of text needs. */
function cleanReadme(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*<(p|div|picture|img|a|h\d|br|source)\b[^\n]*$/gim, '')
    .replace(/^\s*(\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)\s*)+$/gm, '')
    .replace(/^\s*(!\[[^\]]*\]\([^)]*\)\s*)+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------ manifests ------------------------------- */

function tomlField(text: string, section: string, key: string): string | null {
  const block = new RegExp(`^\\[${section.replace(/\./g, '\\.')}\\]\\s*$([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, 'm').exec(text);
  if (!block) return null;
  const m = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(block[1]);
  return m ? m[1] : null;
}

function tomlArray(text: string, section: string, key: string): string[] {
  const block = new RegExp(`^\\[${section.replace(/\./g, '\\.')}\\]\\s*$([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, 'm').exec(text);
  if (!block) return [];
  const m = new RegExp(`^${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm').exec(block[1]);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}

function tomlTableKeys(text: string, section: string): string[] {
  const block = new RegExp(`^\\[${section.replace(/\./g, '\\.')}\\]\\s*$([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, 'm').exec(text);
  if (!block) return [];
  return [...block[1].matchAll(/^([A-Za-z0-9_.-]+)\s*=/gm)].map((x) => x[1]);
}

function list(values: string[], max = MANIFEST_DEPS): string {
  const shown = values.slice(0, max).map((v) => `\`${v}\``).join(', ');
  return values.length > max ? `${shown} and ${values.length - max} more` : shown;
}

/** What the top-level manifests (and those of a workspace's members) say: name, purpose, entry points, dependencies. */
function manifests(files: CardFile[]): string[] {
  const out: string[] = [];
  const shallow = files.filter((f) => f.rel.split('/').length <= 3);
  const named = (n: string) => shallow.filter((f) => path.posix.basename(f.rel) === n).sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel)).slice(0, 8);
  for (const f of named('package.json')) {
    try {
      const pkg = JSON.parse(readText(f.abs)) as Record<string, unknown>;
      const parts: string[] = [];
      if (pkg.name) parts.push(`name \`${String(pkg.name)}\``);
      if (pkg.version) parts.push(`version ${String(pkg.version)}`);
      const lines = [`- **${f.rel}**: ${parts.join(', ') || 'no name'}${pkg.description ? ` — ${String(pkg.description)}` : ''}`];
      const bin = typeof pkg.bin === 'string' ? [String(pkg.name ?? 'bin')] : pkg.bin && typeof pkg.bin === 'object' ? Object.keys(pkg.bin) : [];
      if (bin.length) lines.push(`  - commands: ${list(bin)}`);
      const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces as string[] : (pkg.workspaces as { packages?: string[] } | undefined)?.packages;
      if (ws?.length) lines.push(`  - workspaces: ${list(ws.map(String))}`);
      const deps = Object.keys((pkg.dependencies as object) ?? {});
      if (deps.length) lines.push(`  - dependencies: ${list(deps)}`);
      const peer = Object.keys((pkg.peerDependencies as object) ?? {});
      if (peer.length) lines.push(`  - peer dependencies: ${list(peer)}`);
      out.push(...lines);
    } catch {
      // a package.json that is not JSON (a template) says nothing reliable
    }
  }
  for (const f of named('Cargo.toml')) {
    const t = readText(f.abs);
    const name = tomlField(t, 'package', 'name');
    const desc = tomlField(t, 'package', 'description');
    const members = tomlArray(t, 'workspace', 'members');
    const deps = [...new Set([...tomlTableKeys(t, 'dependencies'), ...tomlTableKeys(t, 'workspace.dependencies')])];
    const head = name ? `crate \`${name}\`${desc ? ` — ${desc}` : ''}` : members.length ? 'workspace' : 'manifest';
    out.push(`- **${f.rel}**: ${head}`);
    if (members.length) out.push(`  - members: ${list(members)}`);
    if (deps.length) out.push(`  - dependencies: ${list(deps)}`);
  }
  for (const f of named('pyproject.toml')) {
    const t = readText(f.abs);
    const name = tomlField(t, 'project', 'name') ?? tomlField(t, 'tool.poetry', 'name');
    const desc = tomlField(t, 'project', 'description') ?? tomlField(t, 'tool.poetry', 'description');
    const deps = tomlArray(t, 'project', 'dependencies').map((d) => d.split(/[<>=!~;\s[]/)[0]).filter(Boolean);
    const scripts = tomlTableKeys(t, 'project.scripts');
    out.push(`- **${f.rel}**: ${name ? `package \`${name}\`` : 'project'}${desc ? ` — ${desc}` : ''}`);
    if (scripts.length) out.push(`  - commands: ${list(scripts)}`);
    if (deps.length) out.push(`  - dependencies: ${list(deps)}`);
  }
  for (const f of named('go.mod')) {
    const t = readText(f.abs);
    const mod = /^module\s+(\S+)/m.exec(t)?.[1];
    const reqs = [...t.matchAll(/^\s+([\w.-]+\.[\w./-]+)\s+v[\d.]+[^\n]*$/gm)].filter((m) => !m[0].includes('// indirect')).map((m) => m[1]);
    out.push(`- **${f.rel}**: module \`${mod ?? '?'}\``);
    if (reqs.length) out.push(`  - requires: ${list(reqs)}`);
  }
  return out;
}

/* -------------------------------- layout -------------------------------- */

function layout(files: CardFile[]): string[] {
  const counts = new Map<string, number>();
  const depth = files.length > 400 ? 2 : 3;
  for (const f of files) {
    const parts = f.rel.split('/');
    for (let d = 1; d < parts.length && d <= depth; d++) {
      const dir = parts.slice(0, d).join('/');
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  }
  const rootFiles = files.filter((f) => !f.rel.includes('/')).map((f) => f.rel).sort();
  const dirs = [...counts.keys()].sort();
  const lines: string[] = [];
  for (const dir of dirs) {
    if (lines.length >= TREE_LINES) {
      lines.push(`- … ${dirs.length - TREE_LINES} more folders`);
      break;
    }
    const level = dir.split('/').length - 1;
    lines.push(`${'  '.repeat(level)}- \`${dir.split('/').pop()}/\` (${counts.get(dir)} files)`);
  }
  if (rootFiles.length) lines.push(`- top-level files: ${rootFiles.slice(0, 40).map((f) => `\`${f}\``).join(', ')}${rootFiles.length > 40 ? ' …' : ''}`);
  return lines;
}

/* ---------------------------- symbol map ---------------------------- */

const TEST_PATH = /(^|\/)(tests?|spec|specs|__tests__|testdata|fixtures?|examples?|e2e|benches|benchmarks?)(\/|$)|[._-](test|spec)\.[a-z]+$|_test\.go$/i;
const ENTRY_STEM = /^(main|index|lib|mod|app|cli|server|agent|core|client|api|init|__init__|session|runtime)$/i;
/** Helpers everything imports: referenced most, explaining least. */
const GENERIC_STEM = /^(utils?|util_?\w*|helpers?|text|strings?|types?|constants?|consts|common|shared|misc|format(ting)?|logg?(er|ing)?|errors?|config|env|i18n|locale)$/i;
const IMPORT_LINE = /^\s*(import|from|use|mod|require|#include|export\s+\*\s+from|export\s+\{[^}]*\}\s+from|const\s+\w+\s*=\s*require)\b.*$/gm;

/**
 * Rank code files by how much of the rest refers to them — the stem of each
 * file counted in every import line of every other file, a cheap stand-in for
 * the PageRank over references Aider's repo map runs — with tests and
 * examples weighed down and entry points up.
 */
function rankFiles<T extends { file: CardFile; text: string }>(code: T[]): (T & { score: number })[] {
  const refs = new Map<string, number>();
  for (const { text } of code) {
    const seen = new Set<string>();
    for (const m of text.matchAll(IMPORT_LINE)) {
      for (const token of m[0].split(/[^A-Za-z0-9_]+/)) if (token.length > 2) seen.add(token.toLowerCase());
    }
    for (const t of seen) refs.set(t, (refs.get(t) ?? 0) + 1);
  }
  return code.map((c) => {
    const stem = path.posix.basename(c.file.rel).replace(/\.[^.]+$/, '');
    const dir = path.posix.basename(path.posix.dirname(c.file.rel));
    // a module named by its folder (mod.rs, index.ts, __init__.py) is imported by the folder's name
    const name = ENTRY_STEM.test(stem) && dir !== '.' ? dir : stem;
    let score = 1 + (refs.get(name.toLowerCase()) ?? 0);
    if (ENTRY_STEM.test(stem)) score *= 1.5;
    if (GENERIC_STEM.test(stem)) score *= 0.3;
    if (TEST_PATH.test(c.file.rel)) score *= 0.2;
    score /= 1 + 0.1 * c.file.rel.split('/').length;
    return { ...c, score };
  }).sort((a, b) => b.score - a.score || a.file.rel.localeCompare(b.file.rel));
}

function symbolMap(code: { file: CardFile; text: string; language: string }[]): { lines: string[]; files: number; shown: number } {
  const ranked = rankFiles(code);
  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  for (const r of ranked) {
    const symbols = extractSymbols(r.text, r.language, 60).filter((s) => s.kind !== 'constant' || symbolsAreFew(r.text));
    if (symbols.length === 0) continue;
    const block = [`- \`${r.file.rel}\``, ...symbols.slice(0, 25).map((s) => `  - ${s.kind} \`${s.signature.replace(/`/g, "'")}\` (line ${s.line})`)];
    if (symbols.length > 25) block.push(`  - … ${symbols.length - 25} more`);
    const size = block.join('\n').length + 1;
    if (used + size > SYMBOL_CHARS) {
      if (used > SYMBOL_CHARS * 0.8) break;
      continue;
    }
    lines.push(...block);
    used += size;
    shown++;
  }
  return { lines, files: ranked.length, shown };
}

function symbolsAreFew(text: string): boolean {
  return text.length < 20_000;
}

/* --------------------------------- card --------------------------------- */

export function renderCard(input: CardInput): string {
  const files = [...input.files].sort((a, b) => a.rel.localeCompare(b.rel));
  const byLanguage = new Map<string, { files: number; lines: number; kind: string }>();
  const code: { file: CardFile; text: string; language: string }[] = [];
  const docs: { rel: string; title: string | null }[] = [];
  let codeChars = 0;
  for (const f of files) {
    const lang = codeLanguageOf(f.rel);
    if (!lang) continue;
    const text = readText(f.abs);
    const entry = byLanguage.get(lang.name) ?? { files: 0, lines: 0, kind: lang.kind };
    entry.files++;
    entry.lines += text ? text.split('\n').length : 0;
    byLanguage.set(lang.name, entry);
    // the map reads what fits in memory comfortably; a monorepo past that maps its first files
    if (lang.kind === 'code' && hasSymbolRules(lang.name) && codeChars + text.length <= CODE_MAP_INPUT_CHARS) {
      code.push({ file: f, text, language: lang.name });
      codeChars += text.length;
    }
    if (lang.kind === 'prose' && /\.(md|markdown|mdx|rst|adoc|txt)$/i.test(f.rel) && !/^(license|licence|copying|notice)/i.test(path.posix.basename(f.rel))) {
      docs.push({ rel: f.rel, title: firstHeading(text) });
    }
  }
  const languages = [...byLanguage.entries()].sort((a, b) => b[1].lines - a[1].lines);
  const mainLanguages = languages.filter(([, v]) => v.kind === 'code').slice(0, 5).map(([k]) => k);
  const readme = pickReadme(files);
  const where = `${RAW_CODEBASE}/${input.name}`;
  const date = input.committedAt.slice(0, 10);

  const fm = [
    '---',
    `title: ${yamlString(input.title)}`,
    'type: repository',
    `date: ${date}`,
    `source: ${yamlString(input.web ?? input.url)}`,
    `codebase: ${where}`,
    ...(input.ref ? [`ref: ${yamlString(input.ref)}`] : []),
    `commit: ${input.commit}`,
    `committed: ${input.committedAt}`,
    ...(mainLanguages.length ? [`languages: [${mainLanguages.map(yamlString).join(', ')}]`] : []),
    'tags: [codebase]',
    '---',
  ];

  const out: string[] = [...fm, '', `# ${input.title}`, ''];
  out.push(`Code repository ${input.web ? `[${input.title}](${input.web})` : `\`${input.url}\``}, at commit \`${input.commit.slice(0, 12)}\` of ${date}${input.ref ? ` (${input.ref})` : ''}${input.subject ? ` — “${input.subject.slice(0, 120)}”` : ''}. Its files are under \`${where}/\`: ${files.length} files carried${skippedNote(input.skipped)}.`);
  if (input.include.length || input.exclude.length) {
    out.push('', `Narrowed to ${input.include.length ? `${input.include.map((g) => `\`${g}\``).join(', ')}` : 'everything'}${input.exclude.length ? `, without ${input.exclude.map((g) => `\`${g}\``).join(', ')}` : ''}.`);
  }

  if (languages.length) {
    out.push('', '## Languages', '', '| Language | Files | Lines |', '| --- | ---: | ---: |');
    for (const [name, v] of languages.slice(0, 15)) out.push(`| ${name} | ${v.files} | ${v.lines} |`);
  }

  const manifestLines = manifests(files);
  if (manifestLines.length) out.push('', '## Packages and dependencies', '', ...manifestLines);

  out.push('', '## Layout', '', ...layout(files));

  if (docs.length) {
    out.push('', '## Documentation', '');
    for (const d of docs.slice(0, DOC_LINES)) out.push(`- [${(d.title ?? d.rel).replace(/[[\]]/g, '')}](${where}/${encodeURI(d.rel)})`);
    if (docs.length > DOC_LINES) out.push(`- … ${docs.length - DOC_LINES} more under \`${where}/\``);
  }

  const map = symbolMap(code);
  if (map.lines.length) {
    out.push('', '## Code map', '', `Definitions in the ${map.shown} of ${map.files} source files the rest of the code refers to most (tests and examples last).`, '', ...map.lines);
  }

  if (readme) {
    const text = cleanReadme(readText(readme.abs));
    if (text) out.push('', `## README (\`${readme.rel}\`)`, '', cut(demoteHeadings(text), README_CHARS));
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function skippedNote(skipped: Record<string, number>): string {
  const parts = Object.entries(skipped).filter(([, n]) => n > 0).map(([why, n]) => `${n} ${SKIP_LABEL[why] ?? why}`);
  return parts.length ? `; left behind: ${parts.join(', ')}` : '';
}

const SKIP_LABEL: Record<string, string> = {
  hidden: 'hidden', dependencies: 'in dependency or build folders', lockfile: 'lockfiles', generated: 'generated or minified',
  type: 'binary or other types', tooLarge: 'above the size limit', filtered: 'outside the include/exclude globs',
};
