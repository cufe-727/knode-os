import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { INTENTS_DIR } from '../fs/layout.js';

/**
 * Intent specs — the configurable half of the Context Compiler.
 *
 * An intent names the *slots* an answer needs before it is worth giving: for
 * "analyze this stock" those are the company's canonical identity, its latest
 * quote, its recent filings. Naming them is what lets `resolve` report an
 * honest gap ("I have no quote") instead of returning six documents and
 * letting the agent discover the hole itself.
 *
 * Specs live in `<data>/playbooks/intents/*.yaml`. The learnable half (which capability
 * actually fills a slot best) comes from receipts, not from here.
 */

export type SlotFill = 'local' | 'live' | 'either';

export interface SlotSpec {
  id: string;
  /** A missing required slot is a gap; a missing optional one is a suggestion. */
  required: boolean;
  /** Where the slot may be filled from. `local` never emits a plan node. */
  fill: SlotFill;
  description?: string;
  /** Local evidence kinds worth pulling for this slot. */
  from: ('entity' | 'claims' | 'documents' | 'graph' | 'datasets')[];
  /** Claim types that satisfy the slot, when it is a claim slot. */
  claimTypes?: string[];
  /** Capability kinds that can fill it live. */
  capabilityKinds?: ('table' | 'endpoint' | 'metric' | 'tool')[];
  /** Substrings that make a capability a likely fit (`quote`, `bars`, `price`). */
  capabilityHints?: string[];
  /** Max age acceptable for this slot's live answer, in seconds. */
  freshnessSeconds?: number | null;
}

export interface Budget {
  maxToolCalls: number;
  maxLatencyMs: number;
  maxTokens: number;
}

export interface IntentSpec {
  id: string;
  title: string;
  /** Path relative to the data dir, or `builtin` for the shipped default. */
  path: string;
  match: {
    keywords: string[];
    patterns: string[];
    entityTypes: string[];
  };
  slots: SlotSpec[];
  budget: Budget;
  guidance: string;
}

export const DEFAULT_BUDGET: Budget = { maxToolCalls: 8, maxLatencyMs: 5000, maxTokens: 12000 };

/**
 * The fallback intent. Every knowledge base can answer "tell me about X"
 * without configuration, so `resolve` is useful before anyone writes a spec.
 */
export const DEFAULT_INTENT: IntentSpec = {
  id: 'default',
  title: 'General question about an entity',
  path: 'builtin',
  match: { keywords: [], patterns: [], entityTypes: [] },
  slots: [
    { id: 'identity', required: true, fill: 'local', from: ['entity', 'graph'], description: 'who or what the question is about' },
    { id: 'background', required: true, fill: 'local', from: ['documents', 'claims'], description: 'what the knowledge base already holds' },
    { id: 'current_state', required: false, fill: 'live', from: ['datasets'], capabilityKinds: ['table', 'endpoint', 'metric'], description: 'values that change faster than the index' },
  ],
  budget: DEFAULT_BUDGET,
  guidance: '',
};

/** Parse a standalone YAML document by reusing the frontmatter parser. */
export function parseYaml(text: string): Record<string, unknown> {
  const body = text.replace(/^﻿/, '').replace(/^---\s*\n/, '');
  try {
    return matter(`---\n${body}\n---\n`).data as Record<string, unknown>;
  } catch {
    return {};
  }
}

function strings(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (!Array.isArray(v)) return [];
  return v.map(String).map((s) => s.trim()).filter(Boolean);
}

function parseSlot(raw: unknown): SlotSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!id) return null;
  const fill = o.fill === 'local' || o.fill === 'live' || o.fill === 'either' ? o.fill : 'either';
  const from = strings(o.from).filter((f): f is SlotSpec['from'][number] =>
    ['entity', 'claims', 'documents', 'graph', 'datasets'].includes(f));
  const freshness = Number(o.freshnessSeconds ?? o.freshness_seconds);
  return {
    id,
    required: o.required !== false,
    fill,
    description: typeof o.description === 'string' ? o.description : undefined,
    from: from.length > 0 ? from : ['documents'],
    claimTypes: strings(o.claimTypes ?? o.claim_types),
    capabilityKinds: strings(o.capabilityKinds ?? o.capability_kinds)
      .filter((k): k is NonNullable<SlotSpec['capabilityKinds']>[number] => ['table', 'endpoint', 'metric', 'tool'].includes(k)),
    capabilityHints: strings(o.capabilityHints ?? o.capability_hints),
    freshnessSeconds: Number.isFinite(freshness) && freshness > 0 ? freshness : null,
  };
}

export function parseIntent(text: string, relPath: string): IntentSpec | null {
  const fm = parseYaml(text);
  const id = typeof fm.id === 'string' && fm.id.trim() ? fm.id.trim() : path.basename(relPath).replace(/\.(ya?ml)$/i, '');
  const slots = (Array.isArray(fm.slots) ? fm.slots : []).map(parseSlot).filter((s): s is SlotSpec => s !== null);
  if (slots.length === 0) return null;
  const match = (fm.match ?? {}) as Record<string, unknown>;
  const budget = (fm.budget ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
  };
  return {
    id,
    title: typeof fm.title === 'string' ? fm.title : id,
    path: relPath,
    match: {
      keywords: strings(match.keywords),
      patterns: strings(match.patterns),
      entityTypes: strings(match.entityTypes ?? match.entity_types),
    },
    slots,
    budget: {
      maxToolCalls: num(budget.max_tool_calls ?? budget.maxToolCalls, DEFAULT_BUDGET.maxToolCalls),
      maxLatencyMs: num(budget.max_latency_ms ?? budget.maxLatencyMs, DEFAULT_BUDGET.maxLatencyMs),
      maxTokens: num(budget.max_tokens ?? budget.maxTokens, DEFAULT_BUDGET.maxTokens),
    },
    guidance: typeof fm.guidance === 'string' ? fm.guidance.trim() : '',
  };
}

export function loadIntents(dataDir: string): IntentSpec[] {
  const dir = path.join(dataDir, INTENTS_DIR);
  if (!fs.existsSync(dir)) return [];
  const out: IntentSpec[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort()) {
    const parsed = parseIntent(fs.readFileSync(path.join(dir, file), 'utf8'), `${INTENTS_DIR}/${file}`);
    if (parsed) out.push(parsed);
  }
  return out;
}

export interface IntentMatch {
  intent: IntentSpec;
  /** 0 when nothing matched and the default was used. */
  score: number;
  reasons: string[];
}

/**
 * Pick the intent for an utterance. Deliberately explainable — keyword,
 * pattern and entity-type hits, each contributing a visible amount — because
 * an agent that cannot see why it got these slots cannot tell you the plan is
 * wrong. The LLM classifier the design allows is a later refinement; it would
 * make this cheaper to author, not more correct.
 */
export function matchIntent(intents: IntentSpec[], utterance: string, entityTypes: string[] = []): IntentMatch {
  const text = utterance.toLowerCase();
  const types = new Set(entityTypes);
  let best: IntentMatch | null = null;

  for (const intent of intents) {
    const reasons: string[] = [];
    let score = 0;
    for (const kw of intent.match.keywords) {
      if (text.includes(kw.toLowerCase())) {
        score += 2;
        reasons.push(`keyword "${kw}"`);
      }
    }
    for (const pattern of intent.match.patterns) {
      try {
        if (new RegExp(pattern, 'i').test(utterance)) {
          score += 2;
          reasons.push(`pattern /${pattern}/`);
        }
      } catch {
        // an unparsable pattern is an authoring typo — ignore it, do not fail the resolve
      }
    }
    for (const t of intent.match.entityTypes) {
      if (types.has(t)) {
        score += 1;
        reasons.push(`entity type ${t}`);
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { intent, score, reasons };
  }
  return best ?? { intent: DEFAULT_INTENT, score: 0, reasons: ['no intent matched — using the default slots'] };
}

/** The starter intent seeded as `playbooks/intents/entity-overview.yaml`; Settings resets an edited copy to it. */
export const DEFAULT_INTENT_YAML = `# Intent spec: what an answer to this kind of question needs before it is worth giving.
# Copy this file and edit it — \`knode_resolve\` reports a gap for every required
# slot it could not fill, instead of returning documents and hoping.
id: entity_overview
title: Overview of an entity
match:
  keywords: ["介绍", "概况", "overview", "what is", "tell me about"]
  entityTypes: [organization, product, project]
slots:
  - id: identity
    required: true
    fill: local
    from: [entity, graph]
    description: canonical name, type, aliases and neighbours
  - id: background
    required: true
    fill: local
    from: [documents, claims]
    description: what the knowledge base already holds
  - id: current_state
    required: false
    fill: live
    from: [datasets]
    capabilityKinds: [table, endpoint, metric]
    capabilityHints: ["latest", "current", "quote", "status"]
    description: values that change faster than the index
budget:
  max_tool_calls: 6
  max_latency_ms: 5000
  max_tokens: 12000
guidance: |
  Prefer local claims over live queries when the question is historical.
  Anything filled live carries an asOf — quote it with the timestamp.
`;

/** Write the starter intent once (never overwrites user edits). */
export function ensureDefaultIntents(dataDir: string): string[] {
  const file = path.join(dataDir, INTENTS_DIR, 'entity-overview.yaml');
  if (fs.existsSync(file)) return [];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, DEFAULT_INTENT_YAML);
  return [`${INTENTS_DIR}/entity-overview.yaml`];
}
