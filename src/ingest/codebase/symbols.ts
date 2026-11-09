/**
 * The definitions a source file declares at its top level (and, for classes,
 * one level in) — the "repo map" coding agents hand a model so it knows what
 * exists where before it reads anything (docs/design/25).
 *
 * Line patterns, not a parser: a definition is a line that starts, at the
 * file's own indentation, with the keyword its language declares things with.
 * That misses what a macro or a decorator factory builds and never reports a
 * local helper, which is the trade wanted here: no native dependency, the same
 * answer on every machine, and a map that names what a reader would look for.
 */

export interface CodeSymbol {
  /** 1-based line. */
  line: number;
  kind: 'function' | 'class' | 'type' | 'module' | 'constant' | 'method';
  name: string;
  /** The declaring line, trimmed and shortened. */
  signature: string;
}

interface Rule {
  re: RegExp;
  kind: CodeSymbol['kind'];
}

const NAME = '([A-Za-z_$][\\w$]*)';

const TS_RULES: Rule[] = [
  { re: new RegExp(`^export\\s+(?:default\\s+)?(?:async\\s+)?function\\*?\\s+${NAME}`), kind: 'function' },
  { re: new RegExp(`^(?:async\\s+)?function\\*?\\s+${NAME}`), kind: 'function' },
  { re: new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${NAME}`), kind: 'class' },
  { re: new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:interface|type|enum)\\s+${NAME}`), kind: 'type' },
  { re: new RegExp(`^(?:export\\s+)?(?:declare\\s+)?namespace\\s+${NAME}`), kind: 'module' },
  { re: new RegExp(`^export\\s+const\\s+${NAME}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:\\([^)]*\\)|${NAME})\\s*(?::[^=]+)?=>`), kind: 'function' },
  { re: new RegExp(`^export\\s+const\\s+${NAME}`), kind: 'constant' },
];

const PY_RULES: Rule[] = [
  { re: new RegExp(`^(?:async\\s+)?def\\s+${NAME}`), kind: 'function' },
  { re: new RegExp(`^class\\s+${NAME}`), kind: 'class' },
  { re: new RegExp(`^ {4}(?:async\\s+)?def\\s+(?!_)${NAME}`), kind: 'method' },
  { re: /^([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=/, kind: 'constant' },
];

const RUST_RULES: Rule[] = [
  { re: new RegExp(`^(?:pub(?:\\([^)]*\\))?\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+"[^"]*"\\s+)?fn\\s+${NAME}`), kind: 'function' },
  { re: new RegExp(`^(?:pub(?:\\([^)]*\\))?\\s+)?(?:struct|enum|union)\\s+${NAME}`), kind: 'class' },
  { re: new RegExp(`^(?:pub(?:\\([^)]*\\))?\\s+)?(?:unsafe\\s+)?trait\\s+${NAME}`), kind: 'type' },
  { re: new RegExp(`^(?:pub(?:\\([^)]*\\))?\\s+)?type\\s+${NAME}`), kind: 'type' },
  { re: new RegExp(`^(?:pub(?:\\([^)]*\\))?\\s+)?mod\\s+${NAME}\\s*\\{`), kind: 'module' },
  { re: /^impl(?:<[^>]*>)?\s+(?:([\w:]+(?:<[^>]*>)?)\s+for\s+)?([\w:]+)/, kind: 'class' },
  { re: new RegExp(`^ {4}(?:pub(?:\\([^)]*\\))?\\s+)?(?:const\\s+)?(?:async\\s+)?fn\\s+${NAME}`), kind: 'method' },
  { re: new RegExp(`^(?:pub(?:\\([^)]*\\))?\\s+)?(?:const|static)\\s+${NAME}`), kind: 'constant' },
];

const GO_RULES: Rule[] = [
  { re: new RegExp(`^func\\s+(?:\\([^)]*\\)\\s*)?${NAME}`), kind: 'function' },
  { re: new RegExp(`^type\\s+${NAME}\\s+(?:struct|interface)`), kind: 'class' },
  { re: new RegExp(`^type\\s+${NAME}`), kind: 'type' },
];

const JAVA_RULES: Rule[] = [
  { re: new RegExp(`^(?:public\\s+|private\\s+|protected\\s+|internal\\s+)?(?:abstract\\s+|final\\s+|sealed\\s+|open\\s+|data\\s+|static\\s+)*(?:class|interface|enum|record|object)\\s+${NAME}`), kind: 'class' },
  { re: new RegExp(`^(?:public\\s+|private\\s+|internal\\s+)?(?:suspend\\s+)?fun\\s+(?:<[^>]*>\\s*)?(?:[\\w.]+\\.)?${NAME}`), kind: 'function' },
  { re: new RegExp(`^ {2,4}(?:public|protected)\\s+(?:static\\s+)?(?:final\\s+)?(?:synchronized\\s+)?(?:<[^>]*>\\s+)?[\\w<>\\[\\],.? ]+\\s+${NAME}\\s*\\(`), kind: 'method' },
];

const SWIFT_RULES: Rule[] = [
  { re: new RegExp(`^(?:public\\s+|open\\s+|internal\\s+|private\\s+|fileprivate\\s+)?(?:final\\s+)?(?:class|struct|enum|protocol|actor|extension)\\s+${NAME}`), kind: 'class' },
  { re: new RegExp(`^(?:public\\s+|internal\\s+|private\\s+)?func\\s+${NAME}`), kind: 'function' },
  { re: new RegExp(`^ {4}(?:public\\s+|open\\s+)?(?:static\\s+)?(?:override\\s+)?func\\s+${NAME}`), kind: 'method' },
];

const C_RULES: Rule[] = [
  { re: new RegExp(`^(?:typedef\\s+)?(?:struct|class|union|enum(?:\\s+class)?)\\s+${NAME}\\s*(?:[:{]|$)`), kind: 'class' },
  { re: new RegExp(`^namespace\\s+${NAME}`), kind: 'module' },
  { re: new RegExp(`^(?:static\\s+|inline\\s+|extern\\s+|virtual\\s+|constexpr\\s+)*[A-Za-z_][\\w:<>,*& ]*[\\s*&]+${NAME}\\s*\\([^;]*$`), kind: 'function' },
];

const RUBY_RULES: Rule[] = [
  { re: /^(?:module|class)\s+([A-Z][\w:]*)/, kind: 'class' },
  { re: /^\s{0,2}def\s+((?:self\.)?[\w?!=]+)/, kind: 'function' },
];

const PHP_RULES: Rule[] = [
  { re: new RegExp(`^(?:abstract\\s+|final\\s+)?(?:class|interface|trait|enum)\\s+${NAME}`), kind: 'class' },
  { re: new RegExp(`^function\\s+${NAME}`), kind: 'function' },
  { re: new RegExp(`^ {4}(?:public\\s+)?(?:static\\s+)?function\\s+${NAME}`), kind: 'method' },
];

const SHELL_RULES: Rule[] = [
  { re: /^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/, kind: 'function' },
];

const ELIXIR_RULES: Rule[] = [
  { re: /^defmodule\s+([\w.]+)/, kind: 'module' },
  { re: /^ {2}def(?:macro)?\s+([\w?!]+)/, kind: 'function' },
];

const PROTO_RULES: Rule[] = [
  { re: new RegExp(`^(?:message|service|enum)\\s+${NAME}`), kind: 'type' },
  { re: new RegExp(`^ {2}rpc\\s+${NAME}`), kind: 'method' },
];

const SQL_RULES: Rule[] = [
  { re: /^create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?(table|view|function|procedure|index|type|trigger|materialized view)\s+(?:if\s+not\s+exists\s+)?([\w."]+)/i, kind: 'type' },
];

const RULES_BY_LANGUAGE: Record<string, Rule[]> = {
  TypeScript: TS_RULES, JavaScript: TS_RULES, Vue: TS_RULES, Svelte: TS_RULES, Astro: TS_RULES,
  Python: PY_RULES, Starlark: PY_RULES, Nim: PY_RULES,
  Rust: RUST_RULES, Zig: RUST_RULES,
  Go: GO_RULES,
  Java: JAVA_RULES, Kotlin: JAVA_RULES, Scala: JAVA_RULES, 'C#': JAVA_RULES, Dart: JAVA_RULES, Groovy: JAVA_RULES,
  Swift: SWIFT_RULES,
  C: C_RULES, 'C++': C_RULES, 'Objective-C': C_RULES, 'Objective-C++': C_RULES,
  Ruby: RUBY_RULES, PHP: PHP_RULES, Shell: SHELL_RULES, Elixir: ELIXIR_RULES,
  'Protocol Buffers': PROTO_RULES, GraphQL: PROTO_RULES, SQL: SQL_RULES,
};

const SKIP_WORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'else', 'catch', 'sizeof']);
const SIGNATURE_CHARS = 140;

/** True when the language has a symbol map. */
export function hasSymbolRules(language: string): boolean {
  return language in RULES_BY_LANGUAGE;
}

/** The declarations of one file, in order. At most `limit` of them. */
export function extractSymbols(text: string, language: string, limit = 400): CodeSymbol[] {
  const rules = RULES_BY_LANGUAGE[language];
  if (!rules) return [];
  const out: CodeSymbol[] = [];
  const lines = text.split('\n');
  let inBlockComment = false;
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const line = lines[i].replace(/\r$/, '');
    const trimmed = line.trim();
    // skip /* … */ blocks and Python docstrings' interiors well enough for a map
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/*') && !trimmed.includes('*/')) {
      inBlockComment = true;
      continue;
    }
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;
    for (const rule of rules) {
      const m = rule.re.exec(line);
      if (!m) continue;
      // impl Trait for Type → the type; otherwise the first group that matched
      const name = (rule.kind === 'class' && m[2] ? m[2] : m.slice(1).find(Boolean) ?? '').replace(/<.*$/, '');
      if (!name || SKIP_WORDS.has(name)) break;
      const signature = trimmed.replace(/\s*\{\s*$/, '').replace(/\s+/g, ' ');
      out.push({ line: i + 1, kind: rule.kind, name, signature: signature.length > SIGNATURE_CHARS ? `${signature.slice(0, SIGNATURE_CHARS - 1)}…` : signature });
      break;
    }
  }
  return out;
}
