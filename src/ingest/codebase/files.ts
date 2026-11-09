import fs from 'node:fs';
import path from 'node:path';
import { RAW_CODEBASE } from '../../fs/layout.js';

/**
 * Which files of a repository travel into `raw/codebase/<name>/`, and what
 * language each one is written in (docs/design/25).
 *
 * The rule is the one the coding agents converged on: keep what a person
 * would read to understand the project — source, its configuration and its
 * prose — and leave behind what tools wrote or fetched (dependencies, build
 * output, lockfiles, minified bundles, generated stubs) and anything binary.
 * A file a person did not write would cost chunks and vectors and answer no
 * question better than its generator does.
 */

/** How a file is read: its display name and the separator set the chunker cuts it along. */
export interface CodeLanguage {
  name: string;
  /** Kind of text: program source, configuration / data, or prose. */
  kind: 'code' | 'config' | 'prose';
  /**
   * Separators, coarsest first, for the recursive splitter: top-level
   * definitions before blank lines before lines. Undefined: the splitter's
   * defaults (paragraphs, lines, words).
   */
  separators?: string[];
}

const C_LIKE = ['\nclass ', '\nstruct ', '\nenum ', '\nunion ', '\ntypedef ', '\nstatic ', '\nvoid ', '\nint ', '\nnamespace ', '\ntemplate', '\n#if', '\n#define ', '\n\n', '\n', ' ', ''];
const JS_LIKE = ['\nexport ', '\nfunction ', '\nasync function ', '\nclass ', '\nconst ', '\nlet ', '\ninterface ', '\ntype ', '\nenum ', '\ndescribe(', '\nit(', '\ntest(', '\n\n', '\n', ' ', ''];
const PY = ['\nclass ', '\ndef ', '\nasync def ', '\n\tdef ', '\n    def ', '\n    async def ', '\n\n', '\n', ' ', ''];
const RUST = ['\npub fn ', '\nfn ', '\npub(crate) fn ', '\nasync fn ', '\npub async fn ', '\nimpl ', '\nimpl<', '\npub struct ', '\nstruct ', '\npub enum ', '\nenum ', '\npub trait ', '\ntrait ', '\nmod ', '\npub mod ', '\nconst ', '\nstatic ', '\nmacro_rules!', '\n#[cfg(test)]', '\n\n', '\n', ' ', ''];
const GO = ['\nfunc ', '\ntype ', '\nvar ', '\nconst ', '\n\n', '\n', ' ', ''];
const JAVA_LIKE = ['\npublic ', '\nprivate ', '\nprotected ', '\nclass ', '\ninterface ', '\nenum ', '\nobject ', '\nfun ', '\ndata class ', '\nsealed ', '\nabstract ', '\n    public ', '\n    private ', '\n    protected ', '\n    fun ', '\n    override ', '\n\n', '\n', ' ', ''];
const SWIFT = ['\nfunc ', '\nclass ', '\nstruct ', '\nenum ', '\nprotocol ', '\nextension ', '\nactor ', '\n    func ', '\n    public func ', '\n    private func ', '\n\n', '\n', ' ', ''];
const RUBY = ['\nmodule ', '\nclass ', '\ndef ', '\n  def ', '\n\n', '\n', ' ', ''];
const PHP = ['\nnamespace ', '\nclass ', '\ninterface ', '\ntrait ', '\nfunction ', '\n    public function ', '\n    private function ', '\n    protected function ', '\n\n', '\n', ' ', ''];
const SHELL = ['\nfunction ', '\n\n', '\n', ' ', ''];
const SQL = ['\nCREATE ', '\ncreate ', '\nALTER ', '\nalter ', '\nINSERT ', '\nSELECT ', '\n\n', '\n', ' ', ''];
const ELIXIR = ['\ndefmodule ', '\n  def ', '\n  defp ', '\n  defmacro ', '\n\n', '\n', ' ', ''];
const LUA = ['\nlocal function ', '\nfunction ', '\n\n', '\n', ' ', ''];
const MARKDOWN = ['\n# ', '\n## ', '\n### ', '\n#### ', '\n```\n', '\n\n', '\n', ' ', ''];
// separators are literal strings to the splitter: an RST heading's underline cannot be named, so paragraphs it is
const RST = ['\n\n', '\n', ' ', ''];
const PROTO = ['\nmessage ', '\nservice ', '\nenum ', '\noption ', '\nimport ', '\nsyntax ', '\n\n', '\n', ' ', ''];
const YAML_LIKE = ['\n\n', '\n', ' ', ''];

const code = (name: string, separators?: string[]): CodeLanguage => ({ name, kind: 'code', separators });
const config = (name: string): CodeLanguage => ({ name, kind: 'config', separators: YAML_LIKE });
const prose = (name: string, separators?: string[]): CodeLanguage => ({ name, kind: 'prose', separators });

const BY_EXTENSION: Record<string, CodeLanguage> = {
  '.ts': code('TypeScript', JS_LIKE), '.tsx': code('TypeScript', JS_LIKE), '.mts': code('TypeScript', JS_LIKE), '.cts': code('TypeScript', JS_LIKE),
  '.js': code('JavaScript', JS_LIKE), '.jsx': code('JavaScript', JS_LIKE), '.mjs': code('JavaScript', JS_LIKE), '.cjs': code('JavaScript', JS_LIKE),
  '.vue': code('Vue', JS_LIKE), '.svelte': code('Svelte', JS_LIKE), '.astro': code('Astro', JS_LIKE),
  '.py': code('Python', PY), '.pyi': code('Python', PY),
  '.rs': code('Rust', RUST),
  '.go': code('Go', GO),
  '.java': code('Java', JAVA_LIKE), '.kt': code('Kotlin', JAVA_LIKE), '.kts': code('Kotlin', JAVA_LIKE), '.scala': code('Scala', JAVA_LIKE), '.groovy': code('Groovy', JAVA_LIKE), '.gradle': code('Gradle', JAVA_LIKE),
  '.cs': code('C#', JAVA_LIKE), '.fs': code('F#'), '.dart': code('Dart', JAVA_LIKE),
  '.swift': code('Swift', SWIFT), '.m': code('Objective-C', C_LIKE), '.mm': code('Objective-C++', C_LIKE),
  '.c': code('C', C_LIKE), '.h': code('C', C_LIKE),
  '.cc': code('C++', C_LIKE), '.cpp': code('C++', C_LIKE), '.cxx': code('C++', C_LIKE), '.hpp': code('C++', C_LIKE), '.hh': code('C++', C_LIKE), '.hxx': code('C++', C_LIKE),
  '.zig': code('Zig', RUST), '.nim': code('Nim', PY), '.v': code('V', GO), '.odin': code('Odin', GO),
  '.rb': code('Ruby', RUBY), '.php': code('PHP', PHP), '.pl': code('Perl', SHELL), '.pm': code('Perl', SHELL),
  '.lua': code('Lua', LUA), '.r': code('R'), '.jl': code('Julia', RUBY),
  '.ex': code('Elixir', ELIXIR), '.exs': code('Elixir', ELIXIR), '.erl': code('Erlang'), '.hrl': code('Erlang'),
  '.hs': code('Haskell'), '.ml': code('OCaml'), '.mli': code('OCaml'), '.clj': code('Clojure'), '.cljs': code('Clojure'), '.elm': code('Elm'),
  '.sh': code('Shell', SHELL), '.bash': code('Shell', SHELL), '.zsh': code('Shell', SHELL), '.fish': code('Shell', SHELL), '.ps1': code('PowerShell', SHELL),
  '.sql': code('SQL', SQL), '.sol': code('Solidity', JS_LIKE),
  '.proto': code('Protocol Buffers', PROTO), '.graphql': code('GraphQL', PROTO), '.gql': code('GraphQL', PROTO), '.thrift': code('Thrift', PROTO),
  '.tf': code('Terraform', YAML_LIKE), '.hcl': code('HCL', YAML_LIKE), '.nix': code('Nix', YAML_LIKE), '.cmake': code('CMake', SHELL),
  '.json': config('JSON'), '.jsonc': config('JSON'), '.json5': config('JSON'),
  '.yaml': config('YAML'), '.yml': config('YAML'), '.toml': config('TOML'), '.ini': config('INI'), '.cfg': config('INI'), '.conf': config('Config'),
  '.xml': config('XML'), '.properties': config('Properties'), '.env': config('Env'),
  '.md': prose('Markdown', MARKDOWN), '.markdown': prose('Markdown', MARKDOWN), '.mdx': prose('MDX', MARKDOWN),
  '.rst': prose('reStructuredText', RST), '.txt': prose('Text'), '.adoc': prose('AsciiDoc', MARKDOWN), '.org': prose('Org', MARKDOWN), '.tex': prose('LaTeX'),
  '.ipynb': config('Jupyter'),
};

/** Files known by their whole name, extension or not. */
const BY_NAME: Record<string, CodeLanguage> = {
  dockerfile: code('Dockerfile', SHELL), containerfile: code('Dockerfile', SHELL),
  makefile: code('Makefile', SHELL), gnumakefile: code('Makefile', SHELL), justfile: code('Justfile', SHELL),
  rakefile: code('Ruby', RUBY), gemfile: code('Ruby', RUBY), podfile: code('Ruby', RUBY), brewfile: code('Ruby', RUBY), vagrantfile: code('Ruby', RUBY),
  procfile: config('Procfile'), 'cmakelists.txt': code('CMake', SHELL), build: code('Starlark', PY), 'build.bazel': code('Starlark', PY), workspace: code('Starlark', PY),
  license: prose('Text'), licence: prose('Text'), copying: prose('Text'), notice: prose('Text'), authors: prose('Text'), readme: prose('Text'), changelog: prose('Text'),
};

/** Folders tools fill: dependencies, build output, caches, virtual environments, snapshots. */
const SKIPPED_DIRS = new Set([
  'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'vendors', 'third_party', 'third-party', 'thirdparty', '3rdparty',
  'dist', 'build', 'out', 'target', 'obj', 'coverage', 'htmlcov', 'site-packages', '__pycache__', 'venv', 'virtualenv',
  'pods', 'deriveddata', 'carthage', '__snapshots__', 'storybook-static',
]);

/** Lockfiles and other files a package manager writes. */
const SKIPPED_NAMES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'deno.lock',
  'cargo.lock', 'poetry.lock', 'uv.lock', 'pipfile.lock', 'pdm.lock', 'go.sum', 'go.work.sum', 'gemfile.lock', 'composer.lock',
  'flake.lock', 'package.resolved', 'pubspec.lock', 'mix.lock', 'podfile.lock', 'cartfile.resolved', 'packages.lock.json',
]);

/** Minified bundles, source maps, generated stubs and snapshots. */
const SKIPPED_SUFFIXES = [
  '.min.js', '.min.css', '.min.mjs', '.bundle.js', '.chunk.js', '.map', '.lock', '.snap',
  '.pb.go', '_pb2.py', '_pb2_grpc.py', '_pb2.pyi', '.pb.cc', '.pb.h', '.pb.swift', '_pb.js', '_pb.d.ts', '_grpc_pb.js',
  '.g.dart', '.freezed.dart', '.designer.cs', '.generated.ts', '.generated.go', '.generated.cs', '_generated.go', '.gen.go', '.gen.ts',
];

/** A source file above this is almost always generated (a table, a vendored single-file library). */
export const DEFAULT_CODE_FILE_BYTES = 512 * 1024;
/** A repository carrying more than this many files must be narrowed with --include. */
export const DEFAULT_CODEBASE_FILES = 25_000;
/** …or more than this many bytes. */
export const DEFAULT_CODEBASE_BYTES = 300 * 1024 * 1024;

/** The language a repository file is written in, or null when it is not one knode-os reads as text. */
export function codeLanguageOf(rel: string): CodeLanguage | null {
  const base = path.posix.basename(rel.replace(/\\/g, '/')).toLowerCase();
  const named = BY_NAME[base];
  if (named) return named;
  // README.md is prose by its extension; `README`, `LICENSE-MIT` and the like by their stem
  const ext = path.posix.extname(base);
  const byExt = ext ? BY_EXTENSION[ext] : undefined;
  if (byExt) return byExt;
  const stem = base.replace(/[-_.].*$/, '');
  if (!ext || /^[-_.](mit|apache|bsd|gpl|txt)/.test(base.slice(stem.length))) {
    const proseByStem = BY_NAME[stem];
    if (proseByStem?.kind === 'prose') return proseByStem;
  }
  return null;
}

/** Why a path inside a repository stays behind, or null when it travels. Looks at the path only. */
export function skipReason(rel: string): 'hidden' | 'dependencies' | 'lockfile' | 'generated' | 'type' | null {
  const segments = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length === 0) return 'type';
  // dot-entries (.git, .github, .venv, .next) stay behind, as for every import
  if (segments.some((s) => s.startsWith('.'))) return 'hidden';
  const dirs = segments.slice(0, -1).map((s) => s.toLowerCase());
  if (dirs.some((d) => SKIPPED_DIRS.has(d) || d.endsWith('.egg-info'))) return 'dependencies';
  const base = segments[segments.length - 1].toLowerCase();
  if (SKIPPED_NAMES.has(base)) return 'lockfile';
  if (SKIPPED_SUFFIXES.some((s) => base.endsWith(s))) return 'generated';
  return codeLanguageOf(base) ? null : 'type';
}

/** True for a key under raw/codebase/<name>/ that the index reads (path rules only; size is checked by the walker). */
export function isCodebaseFile(rel: string): boolean {
  const clean = rel.replace(/\\/g, '/');
  if (!clean.startsWith(`${RAW_CODEBASE}/`)) return false;
  const inside = clean.slice(RAW_CODEBASE.length + 1).split('/');
  // a file directly under raw/codebase belongs to no repository
  if (inside.length < 2) return false;
  return skipReason(inside.slice(1).join('/')) === null;
}

/** The repository a raw/codebase key belongs to and its path inside it; null outside raw/codebase. */
export function splitCodebaseKey(rel: string): { name: string; path: string } | null {
  const clean = rel.replace(/\\/g, '/');
  if (!clean.startsWith(`${RAW_CODEBASE}/`)) return null;
  const [name, ...rest] = clean.slice(RAW_CODEBASE.length + 1).split('/');
  if (!name || rest.length === 0) return null;
  return { name, path: rest.join('/') };
}

/**
 * True when a file's bytes say a machine wrote it: a NUL byte (binary), or
 * lines so long on average that it is minified. Reads at most 64 KB; small
 * files are taken on their path alone.
 */
export function looksGenerated(abs: string, bytes: number): boolean {
  if (bytes < 4096) return false;
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(bytes, 64 * 1024));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, n);
    if (head.includes(0)) return true;
    let lines = 1;
    for (const b of head) if (b === 10) lines++;
    return n / lines > 400;
  } finally {
    fs.closeSync(fd);
  }
}

/* --------------------------------- globs --------------------------------- */

/**
 * A gitignore-flavoured glob as a RegExp over repository paths: `*` and `?`
 * stay inside one segment, `**` crosses them, a pattern without a slash
 * matches at any depth, and a leading slash anchors it to the root.
 */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.trim().replace(/\\/g, '/');
  const anchored = p.startsWith('/');
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!anchored && !p.includes('/')) p = `**/${p}`;
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**/` is zero or more whole segments; a trailing `**` is anything
        if (p[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/** True when the path, or a folder it sits in, matches one of the globs. */
export function matchesAnyGlob(rel: string, globs: RegExp[]): boolean {
  if (globs.length === 0) return false;
  const segments = rel.split('/');
  for (let i = segments.length; i >= 1; i--) {
    const candidate = segments.slice(0, i).join('/');
    if (globs.some((g) => g.test(candidate))) return true;
  }
  return false;
}

/* ------------------------------ documentation ------------------------------ */

const DOC_FOLDERS = new Set(['docs', 'doc', 'documentation', 'design', 'designs', 'adr', 'adrs', 'rfc', 'rfcs', 'guides', 'guide', 'wiki', 'architecture']);
const DOC_EXT = /\.(md|markdown|mdx|rst)$/i;
/** Prose a project keeps that is about its process, not its design. */
const NOT_DOCS = /^(license|licence|copying|notice|changelog|changes|history|news|releases|code_of_conduct|code-of-conduct|security|authors|contributors|maintainers|funding|support|third_party_notices|pull_request_template|issue_template)(\.|$)/i;
/** At most this many documentation files of one repository go through the document pipeline. */
export const MAX_REPO_DOCS = 300;

/**
 * True for a repository file that is its documentation: Markdown or
 * reStructuredText at the top level (README, AGENTS.md, ARCHITECTURE.md…) or
 * anywhere under a docs-like folder — never a license, changelog or template.
 */
export function isRepoDoc(rel: string): boolean {
  const segments = rel.split('/');
  const base = segments[segments.length - 1];
  if (!DOC_EXT.test(base) || NOT_DOCS.test(base)) return false;
  if (segments.length === 1) return true;
  return segments.slice(0, -1).some((s) => DOC_FOLDERS.has(s.toLowerCase()));
}
