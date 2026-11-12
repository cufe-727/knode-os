import { agentGrep } from './agents.js';
import { externalSystem, EXTERNAL_SYSTEMS } from './external.js';
import { agentKnode, agentKnodeWiki, agentKnodeWikiSources, knodeAsk, knodeSag } from './knode.js';
import { llmWiki, llmWikiSources } from './llm-wiki.js';
import { ragBm25, ragHybrid, ragVector } from './rag.js';
import { closedBook, longContext } from './refs.js';
import type { SystemUnderTest } from './types.js';

/** Every system the suite knows, in the order a run takes them (knowledge bases first, references last). */
export const SYSTEMS: Record<string, () => SystemUnderTest> = {
  'knode-ask': knodeAsk,
  'knode-sag': knodeSag,
  'agent-knode': agentKnode,
  'agent-knode-wiki': agentKnodeWiki,
  'agent-knode-wiki-sources': agentKnodeWikiSources,
  'agent-wiki': llmWiki,
  'agent-wiki-sources': llmWikiSources,
  'agent-grep': agentGrep,
  'rag-hybrid': ragHybrid,
  'rag-bm25': ragBm25,
  'rag-vector': ragVector,
  'closed-book': closedBook,
  'long-context': longContext,
  ...Object.fromEntries(EXTERNAL_SYSTEMS.map((id) => [id, () => externalSystem(id)])),
};

export const DEFAULT_SYSTEMS = Object.keys(SYSTEMS).filter((id) => !EXTERNAL_SYSTEMS.includes(id as (typeof EXTERNAL_SYSTEMS)[number]));

export function makeSystems(ids: string[]): SystemUnderTest[] {
  return ids.map((id) => {
    const f = SYSTEMS[id];
    if (!f) throw new Error(`unknown system "${id}" (known: ${Object.keys(SYSTEMS).join(', ')})`);
    return f();
  });
}
