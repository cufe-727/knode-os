/**
 * What a translation must not touch, kept out of the model's hands
 * (docs/design/17 §4).
 *
 * Code, HTML tags (the `<a id="e-…">` anchors wiki pages cite), URLs, link
 * targets, wikilinks and footnote marks are swapped for short tokens — ⟦1⟧,
 * ⟦2⟧ … — before a segment goes out, and swapped back in the answer. The
 * model translates the prose around them and copies the tokens; so a link
 * keeps working and a citation's anchor is still there in the translation,
 * and a post with a 150-character image URL per entry costs a few
 * characters per entry instead. An answer that lost a token is a bad answer.
 */

const OPEN = '⟦';
const CLOSE = '⟧';

// Fences inside list items may be indented, and a closing fence may be
// longer than the opener. Keep this matcher shared with language detection
// and translation segmentation, so each sees the same protected code.
const BACKTICK_FENCE = /(?:^|(?<=\n))[ \t]*(?<translationBackticks>`{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\k<translationBackticks>`*[ \t]*(?=\r?\n|$)|$)/;
const TILDE_FENCE = /(?:^|(?<=\n))[ \t]*(?<translationTildes>~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\k<translationTildes>~*[ \t]*(?=\r?\n|$)|$)/;
export const FENCED_CODE = new RegExp(`${BACKTICK_FENCE.source}|${TILDE_FENCE.source}`, 'g');

/** Bare source citations and file paths are identifiers, like link targets. */
export const DOCUMENT_PATH = /(?<![\w/])(?:(?:\.{1,2}\/|\/)(?:[\w.@+%~-]+\/)*[\w.@+%~-]+|(?:raw|wiki|playbooks)\/(?:[\w.@+%~-]+\/)*[\w.@+%~-]+|(?:[\w.@+%~-]+\/)+[\w.@+%~-]+\.(?:mdx?|txt|rst|pyc?|ipynb|tsx?|jsx?|[cm]js|json[lc]?|ya?ml|toml|ini|cfg|csv|tsv|xml|html?|pdf|png|jpe?g|svg|webp|gif|sql|sh|bash|zsh|go|rs|java|cpp|h|cs|swift|rb|php|vue|svelte|css|scss|lock|proto|thrift|graphql)(?=$|[^\w-]))(?:#[\w:.-]+)?/g;

/** First match wins: the longer spans first, so a URL inside a code block goes out with the block. */
const PROTECTED = new RegExp(
  [
    FENCED_CODE.source,
    /<!--[\s\S]*?-->/.source,
    /`[^`\n]+`/.source, // inline code
    /\[\[[^\]\n]+\]\]/.source, // wikilinks: the target must stay, and so the label with it
    /(?<=\])\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"\n]*")?\)/.source, // a Markdown link's or image's target; the [label] is translated
    /(?:^|(?<=\n))[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S+[^\n]*/.source, // reference definitions
    /\[\^[^\]\n]+\]:?/.source, // footnote marks
    /<[^>\n]{1,400}>/.source, // HTML tags
    /(?:https?|ftp):\/\/[^\s<>()\]]+/.source,
    /\bwww\.[^\s<>()\]]+/.source,
    DOCUMENT_PATH.source,
    /\{#[^}\n]*\}/.source, // heading ids
    `${OPEN}[^${CLOSE}\\n]*${CLOSE}`, // a token-like text of the document's own
  ].join('|'),
  'g',
);

export interface ProtectedText {
  /** The text with every protected span a token. */
  text: string;
  /** What token n (1-based) stands for: `spans[n - 1]`. */
  spans: string[];
}

export const token = (n: number): string => `${OPEN}${n}${CLOSE}`;

export function protectSpans(text: string): ProtectedText {
  const spans: string[] = [];
  const out = text.replace(PROTECTED, (span) => {
    spans.push(span);
    return token(spans.length);
  });
  return { text: out, spans };
}

export interface RestoredText {
  text: string;
  /** Tokens the answer lost, 1-based. */
  missing: number[];
}

/** Put the spans back. A token the text never had is dropped; one used twice is restored twice. */
export function restoreSpans(answer: string, spans: string[]): RestoredText {
  const seen = new Set<number>();
  const text = answer.replace(new RegExp(`${OPEN}\\s*(\\d+)\\s*${CLOSE}`, 'g'), (_, digits: string) => {
    const n = Number(digits);
    if (!(n >= 1 && n <= spans.length)) return '';
    seen.add(n);
    return spans[n - 1];
  });
  const missing: number[] = [];
  for (let n = 1; n <= spans.length; n++) if (!seen.has(n)) missing.push(n);
  return { text, missing };
}
