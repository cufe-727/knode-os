import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sqlStringLiteral } from '../datasource/guard.js';
import { PACKS_DIR } from '../fs/layout.js';
import { Locator } from '../capability/store.js';
import { readMatter, stringList } from '../markdown.js';
import { Playbook, entitySymbol, loadPlaybooks, renderProbeSql } from '../pack/playbook.js';
import { PlanNode } from './plan.js';

/**
 * Recipes: a plan template with slots, chosen before the planner runs.
 *
 * The planner is what happens when nobody has said how to answer a question;
 * a recipe is what happens when somebody has. Existing playbooks are upgraded
 * in place rather than deprecated — a `retrieval` block is a search node and
 * each `probe` is a live query node, which is what they always meant — so a
 * knowledge base that predates the compiler keeps working and gains plans for
 * free.
 */

export interface RecipeNode {
  id: string;
  fills: string;
  tool: { kind: 'mcp' | 'cli' | 'http'; server?: string; name: string };
  /** Args with `{name}` / `{symbol}` / `{alias}` placeholders, filled per entity. */
  args: Record<string, unknown>;
  capability?: string;
  after?: string[];
  freshness?: number | null;
}

export interface Recipe {
  path: string;
  /** `entity:<slug>`, an entity type, or `default`. */
  appliesTo: string;
  /** Intent this recipe answers; empty means any. */
  intent: string;
  slots: { required: string[]; optional: string[] };
  nodes: RecipeNode[];
  guidance: string;
  /** True when this came from an old-style playbook rather than a recipe file. */
  upgraded: boolean;
}

function parseNode(raw: unknown, index: number): RecipeNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : `node_${index}`;
  const fills = typeof o.fills === 'string' && o.fills.trim() ? o.fills.trim() : id;
  const toolRaw = (o.tool ?? {}) as Record<string, unknown>;
  const name = typeof toolRaw.name === 'string' ? toolRaw.name : 'knode_query';
  const kind = toolRaw.kind === 'cli' || toolRaw.kind === 'http' ? toolRaw.kind : 'mcp';
  const freshness = Number(o.freshness);
  return {
    id,
    fills,
    tool: { kind, server: typeof toolRaw.server === 'string' ? toolRaw.server : 'knode-os', name },
    args: (o.args ?? {}) as Record<string, unknown>,
    capability: typeof o.capability === 'string' ? o.capability : undefined,
    after: stringList(o.after),
    freshness: Number.isFinite(freshness) && freshness > 0 ? freshness : null,
  };
}

export function parseRecipe(raw: string, relPath: string): Recipe | null {
  let fm: Record<string, unknown>;
  let body: string;
  try {
    const parsed = readMatter(raw);
    fm = parsed.data as Record<string, unknown>;
    body = parsed.content;
  } catch {
    return null;
  }
  if (fm.type !== 'recipe') return null;
  const slots = (fm.slots ?? {}) as Record<string, unknown>;
  const nodes = (Array.isArray(fm.nodes) ? fm.nodes : []).map(parseNode).filter((n): n is RecipeNode => n !== null);
  return {
    path: relPath,
    appliesTo: typeof fm.appliesTo === 'string' && fm.appliesTo.trim() ? fm.appliesTo.trim() : 'default',
    intent: typeof fm.intent === 'string' ? fm.intent.trim() : '',
    slots: { required: stringList(slots.required), optional: stringList(slots.optional) },
    nodes,
    guidance: body.trim(),
    upgraded: false,
  };
}

/**
 * A playbook, read as the recipe it always was: `retrieval` is a search node
 * filling a `background` slot, each probe is a live query filling a slot named
 * after it.
 */
export function upgradePlaybook(pb: Playbook): Recipe {
  const nodes: RecipeNode[] = [
    {
      id: 'kb_search',
      fills: 'background',
      tool: { kind: 'mcp', server: 'knode-os', name: 'knode_search' },
      args: { query: '{name}', k: pb.retrieval.k, mode: pb.retrieval.mode },
      capability: 'knode.search',
      after: [],
      freshness: null,
    },
    ...pb.probes.map((probe) => ({
      id: probe.id.replace(/[^A-Za-z0-9_]/g, '_'),
      fills: probe.id,
      tool: { kind: 'mcp' as const, server: 'knode-os', name: 'knode_query' },
      args: { source: probe.source, sql: probe.sql },
      capability: probe.table ? `${probe.source}.${probe.table}` : probe.source,
      after: [],
      freshness: null,
    })),
  ];
  return {
    path: pb.path,
    appliesTo: pb.appliesTo,
    intent: '',
    slots: { required: ['background'], optional: pb.probes.map((p) => p.id) },
    nodes,
    guidance: pb.guidance,
    upgraded: true,
  };
}

/** Recipes from `playbooks/packs/*.md`, including playbooks upgraded on the fly. */
export function loadRecipes(dataDir: string): Recipe[] {
  const dir = path.join(dataDir, PACKS_DIR);
  const out: Recipe[] = [];
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
      const parsed = parseRecipe(fs.readFileSync(path.join(dir, file), 'utf8'), `${PACKS_DIR}/${file}`);
      if (parsed) out.push(parsed);
    }
  }
  for (const pb of loadPlaybooks(dataDir)) out.push(upgradePlaybook(pb));
  return out;
}

/** Most specific wins: entity:<slug> > intent + entity type > intent > entity type > default. */
export function resolveRecipe(
  recipes: Recipe[],
  target: { intent: string; entityId?: string; entityType?: string },
): Recipe | null {
  const byIntent = (r: Recipe) => !r.intent || r.intent === target.intent;
  return (
    recipes.find((r) => target.entityId && r.appliesTo === `entity:${target.entityId}` && byIntent(r)) ??
    recipes.find((r) => r.intent === target.intent && target.entityType && r.appliesTo === target.entityType) ??
    recipes.find((r) => r.intent === target.intent && r.appliesTo === 'default') ??
    recipes.find((r) => target.entityType && r.appliesTo === target.entityType && byIntent(r)) ??
    recipes.find((r) => r.appliesTo === 'default' && byIntent(r)) ??
    null
  );
}

export interface RecipeEntity {
  id: string;
  name: string;
  aliases: string[];
}

/**
 * Bind a recipe's nodes to one entity. String args go through the same
 * placeholder rendering probes use, with SQL args escaped as literals and
 * everything else escaped for the dialect it lands in — a recipe is authored
 * text, but the entity name it interpolates is not.
 */
export function instantiate(recipe: Recipe, entity: RecipeEntity, locators: Locator[] = []): PlanNode[] {
  const locator = (capability?: string) => locators.find((l) => !capability || l.capabilityId === capability);
  // node ids have to survive being written into generated code, and entity ids
  // are frequently non-ASCII — so slugify, and fall back to a short hash rather
  // than collapsing every CJK name to the same string of underscores
  const ascii = entity.id.replace(/[^A-Za-z0-9_]/g, '');
  const suffix = ascii.length >= 3 ? ascii : crypto.createHash('sha256').update(entity.id).digest('hex').slice(0, 8);
  return recipe.nodes.map((n) => {
    const bound = locator(n.capability);
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(n.args)) {
      if (typeof value !== 'string') {
        args[key] = value;
        continue;
      }
      const escape = key === 'sql' && !value.includes('?') ? sqlStringLiteral : (v: string) => v;
      args[key] = renderProbeSql(value, entity, escape)
        .replace(/\{locator\}/g, bound?.value ?? entitySymbol(entity))
        .replace(/\{param\}/g, bound?.param ?? 'id');
    }
    return {
      id: `${n.id}_${suffix}`,
      fills: n.fills,
      tool: n.tool,
      args,
      capability: n.capability,
      after: (n.after ?? []).map((a) => `${a}_${suffix}`),
      freshness: n.freshness,
      why: {
        expectedGain: 0.9,
        estCost: 1,
        estLatencyMs: n.tool.name === 'knode_search' ? 50 : 400,
        reason: `recipe ${recipe.path}${recipe.upgraded ? ' (upgraded playbook)' : ''}`,
      },
    };
  });
}
