/**
 * Ranked-retrieval metrics over documents, with any number of gold documents
 * per question (the multi-hop sets have two to four).
 */

export interface RetrievalScores {
  recall: Record<number, number>;
  /** 1 when every gold document is in the top k. */
  all: Record<number, number>;
  mrr10: number;
  ndcg10: number;
}

export function retrievalScores(ranked: string[], gold: string[], ks: number[] = [1, 2, 5, 10]): RetrievalScores {
  const docs = [...new Set(ranked)];
  const g = new Set(gold);
  const recall: Record<number, number> = {};
  const all: Record<number, number> = {};
  for (const k of ks) {
    const hit = docs.slice(0, k).filter((d) => g.has(d)).length;
    recall[k] = g.size ? hit / g.size : 0;
    all[k] = g.size && hit === g.size ? 1 : 0;
  }
  const first = docs.findIndex((d) => g.has(d));
  const mrr10 = first >= 0 && first < 10 ? 1 / (first + 1) : 0;
  let dcg = 0;
  docs.slice(0, 10).forEach((d, i) => {
    if (g.has(d)) dcg += 1 / Math.log2(i + 2);
  });
  let idcg = 0;
  for (let i = 0; i < Math.min(10, g.size); i++) idcg += 1 / Math.log2(i + 2);
  return { recall, all, mrr10, ndcg10: idcg ? dcg / idcg : 0 };
}

/** Citation precision and recall against gold evidence documents; null when the system cited nothing it could. */
export function citationScores(cited: string[], gold: string[]): { precision: number | null; recall: number | null } {
  const c = [...new Set(cited)];
  const g = new Set(gold);
  return {
    precision: c.length ? c.filter((d) => g.has(d)).length / c.length : null,
    recall: g.size ? c.filter((d) => g.has(d)).length / g.size : null,
  };
}
