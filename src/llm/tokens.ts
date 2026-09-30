/**
 * Rough token estimate shared by chunking and the tier-1 spend report:
 * ≈4 chars/token for latin text, ~1.6 for CJK (han + kana + hangul).
 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;

export function estimateTokens(text: string): number {
  const cjk = (text.match(CJK_RE) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(rest / 4 + cjk / 1.6);
}
