import { armBrief, GREP_HAS } from './agents.js';
import { AGENT_KNODE_FULL_HAS, KNODE_WIKI_SOURCES_HAS, knodeFullGuide } from './knode.js';
import { AGENT_RAG_HAS } from './rag.js';

/**
 * The ladder's four agent arms (docs/design/33 §2), each a superset of the one
 * before it: A the sources, B A plus a RAG search tool, C A plus the knode
 * wiki, D C plus knode's retrieval tools.
 */
export const LADDER_ARMS = ['agent-grep', 'agent-rag', 'agent-knode-wiki-sources', 'agent-knode-full'] as const;
export type LadderArm = (typeof LADDER_ARMS)[number];

export interface LadderBrief {
  /** The arm's letter in design 33. */
  arm: 'A' | 'B' | 'C' | 'D';
  /** The sentence of the shared skeleton saying what the arm has. */
  has: string;
  /** The guide to its knode tools, after the skeleton (arm D only). */
  guide?: string;
  /** The brief as the arm's sessions get it, before the question. */
  text: string;
}

/** Each arm's brief, built from the same parts the arms build theirs from. */
export function ladderBriefs(): Record<LadderArm, LadderBrief> {
  const brief = (arm: LadderBrief['arm'], has: string, guide?: string): LadderBrief => ({ arm, has, ...(guide ? { guide } : {}), text: armBrief(has, guide) });
  return {
    'agent-grep': brief('A', GREP_HAS),
    'agent-rag': brief('B', AGENT_RAG_HAS),
    'agent-knode-wiki-sources': brief('C', KNODE_WIKI_SOURCES_HAS),
    'agent-knode-full': brief('D', AGENT_KNODE_FULL_HAS, knodeFullGuide()),
  };
}
