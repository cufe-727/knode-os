/**
 * Token estimate for the BGE-M3 vocabulary (XLM-R sentencepiece; `<s>` and `</s>` counted), for providers
 * whose embeddings response has no `usage`: Cloudflare Workers AI sends none, so its quota reservations
 * stay at this estimate. Not for LLM tokenizers: estimateTokens() in ../llm/tokens.ts is tuned for those
 * and comes out at 0.7–0.8 of BGE-M3.
 *
 *   tokens ≈ 1.1 × (0.7·Han + 0.7·digits + 0.3·Latin + 0.15·whitespace + 0.9·other) + 4,   at least bytes / 4
 *
 * per UTF-16 code unit. Han is U+3400–4DBF and U+4E00–9FFF, Latin the ASCII letters, whitespace the ASCII
 * spaces, no-break and ideographic space; "other" is everything else, punctuation included, which costs
 * about a token each. A space usually merges into the next piece, so whitespace costs little.
 *
 * Least-squares fit against the model's own tokenizer.json (BAAI/bge-m3) on 44.7k chunks, 206k claims and
 * 48.6k entities of a Chinese/English finance workspace, rounded up, with a 10 % margin. There the sum is
 * 1.17–1.19× the real count and at most 0.04 % of 16-input batches come out under it. Digits are weighted
 * above their fit (0.53) so number tables stay over. Hashes and base64 are under-counted by up to 2×;
 * scripts outside the classes are over-counted by 1.4–4×. Calibration, table and limits:
 * docs/embedding-pools.md.
 */
export function estimateEmbeddingTokens(text: string): number {
  let han = 0, digits = 0, latin = 0, space = 0, other = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) han++;
    else if (c >= 0x30 && c <= 0x39) digits++;
    else if ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a)) latin++;
    else if (c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || c === 0x3000) space++;
    else other++;
  }
  const fitted = Math.ceil(1.1 * (0.7 * han + 0.7 * digits + 0.3 * latin + 0.15 * space + 0.9 * other)) + 4;
  return Math.max(fitted, Math.ceil(Buffer.byteLength(text, 'utf8') / 4));
}
