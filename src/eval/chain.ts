import fs from 'node:fs';
import path from 'node:path';
import { isCliProvider, KnodeConfig, resolveSecret } from '../config.js';
import { ChatMessage, CompletionOptions, jsonFromReply, LlmClient } from '../llm/client.js';
import type { CallUsage } from '../llm/usage.js';
import { priceUsage } from './meter.js';
import { EVAL_HOME } from './pack.js';
import type { ChatBackend, ChatRequest, ChatResult } from './shim.js';

/**
 * Model chains with budgets (docs/design/23 §1 D18): an ordered list of
 * models — workspace connections that bill an API key, then CLIs on a plan —
 * where a call goes to the first link with budget left. A paid link's spend is
 * priced from the usage the provider reports and appended to one ledger
 * (`~/knode-eval/spend.jsonl`) that every eval process shares, so a pack build,
 * a run and its judge draw on the same balance. A link is passed over once its
 * spend reaches 95% of its budget (calls in flight still land), or at once
 * when the provider says the account has no credit left.
 *
 *   openai-api:200,codex-cli      the run's model: the API key, then Codex
 *   anthropic-api:100,codex-cli   the author and the judge
 *
 * A budget comes inline (`name:usd`) or from `~/knode-eval/budgets.json`
 * (`{"openai-api":{"usd":200,"since":"2026-11-07"}}`, counting spend since
 * `since`); a paid link with neither is refused.
 */

export const SPEND_RESERVE = 0.95;

/** The provider says there is no money left on the account (not a rate limit: those pass). */
const SPENT = /insufficient_quota|exceeded your current quota|credit balance is too low|billing|payment required|\b402\b|out of credits/i;
export const isSpentError = (err: unknown) => SPENT.test(err instanceof Error ? err.message : String(err));

export interface Budget {
  usd: number;
  since?: string;
  note?: string;
}

export class SpendLedger {
  private totals = new Map<string, number>();
  private readAt = 0;

  constructor(readonly file = path.join(EVAL_HOME, 'spend.jsonl'), readonly budgetsFile = path.join(EVAL_HOME, 'budgets.json'), private readonly refreshMs = 30_000) {}

  budgets(): Record<string, Budget> {
    try {
      return JSON.parse(fs.readFileSync(this.budgetsFile, 'utf8')) as Record<string, Budget>;
    } catch {
      return {};
    }
  }

  /** What an account has spent since its budget's start, from the shared ledger (re-read every 30 s). */
  spent(account: string): number {
    if (Date.now() - this.readAt > this.refreshMs) this.reload();
    return this.totals.get(account) ?? 0;
  }

  add(account: string, usd: number, what: Record<string, unknown> = {}): void {
    if (!(usd > 0)) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify({ at: new Date().toISOString(), account, usd, ...what }) + '\n');
    this.totals.set(account, (this.totals.get(account) ?? 0) + usd);
  }

  private reload(): void {
    const since = Object.fromEntries(Object.entries(this.budgets()).map(([k, b]) => [k, b.since ?? '']));
    const totals = new Map<string, number>();
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as { at: string; account: string; usd: number };
          if (since[r.account] && r.at < since[r.account]) continue;
          totals.set(r.account, (totals.get(r.account) ?? 0) + r.usd);
        } catch {
          /* torn line */
        }
      }
    }
    this.totals = totals;
    this.readAt = Date.now();
  }
}

export interface ChainLink {
  /** The connection id or CLI name, also the ledger's account. */
  name: string;
  client: LlmClient;
  /** USD this link may spend; null for a CLI on a plan. */
  budget: number | null;
  /** For agents: the API endpoint a Codex session can bill instead of the login. */
  api?: { baseUrl: string; apiKey: string; model: string };
}

/**
 * `openai-api:200,anthropic-api,codex-cli` against a workspace's connections.
 * `model` overrides a link's model (the run's --model) where it is the same family's.
 */
export function parseChain(spec: string, config: KnodeConfig | null, opts: { ledger?: SpendLedger; model?: string; cliTimeoutMs?: number } = {}): ChainLink[] {
  const ledger = opts.ledger ?? new SpendLedger();
  const budgets = ledger.budgets();
  return spec.split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
    const [name, usd] = item.split(':');
    if (isCliProvider(name)) {
      return { name, budget: usd ? Number(usd) : null, client: new LlmClient({ provider: name, baseUrl: '', apiKey: '', model: name === 'codex-cli' ? opts.model ?? '' : '', cliPath: '', cliTimeoutMs: opts.cliTimeoutMs ?? 900_000 }) };
    }
    const connection = config?.connections.find((c) => c.id === name);
    if (!connection) throw new Error(`model chain: no connection "${name}" in the --config-from workspace${config ? ` (it has: ${config.connections.map((c) => c.id).join(', ')})` : ''}`);
    if (isCliProvider(connection.provider)) throw new Error(`model chain: connection "${name}" is a CLI; name the CLI itself`);
    const budget = usd ? Number(usd) : budgets[name]?.usd;
    if (!(budget !== undefined && budget >= 0)) throw new Error(`model chain: "${name}" bills an API key and has no budget: give one as ${name}:<usd> or in ${ledger.budgetsFile}`);
    const sameFamily = opts.model && /^gpt|^o\d/.test(opts.model) === /^gpt|^o\d/.test(connection.model);
    const model = sameFamily ? opts.model! : connection.model;
    return { name, budget, client: new LlmClient({ ...connection, model }), api: { baseUrl: connection.baseUrl, apiKey: resolveSecret(connection.apiKey), model } };
  });
}

/** Calls down a chain of links: the first with budget left, the next when one is spent. */
export class ModelChain {
  private readonly exhausted = new Set<string>();

  constructor(readonly links: ChainLink[], readonly ledger = new SpendLedger(), private readonly log: (m: string) => void = () => {}) {
    if (!links.length) throw new Error('model chain: no links');
  }

  get label(): string {
    return `chain(${this.links.map((l) => l.name).join('→')})`;
  }

  /** The first link with budget left, or null when every one is spent. */
  pick(): ChainLink | null {
    for (const l of this.links) {
      if (this.exhausted.has(l.name)) continue;
      if (l.budget !== null && this.ledger.spent(l.name) >= l.budget * SPEND_RESERVE) {
        this.exhaust(l, `spent $${this.ledger.spent(l.name).toFixed(2)} of $${l.budget}`);
        continue;
      }
      return l;
    }
    return null;
  }

  exhaust(l: ChainLink, why: string): void {
    if (this.exhausted.has(l.name)) return;
    this.exhausted.add(l.name);
    this.log(`model chain: ${l.name} passed over (${why})${this.links.find((x) => !this.exhausted.has(x.name)) ? `; next: ${this.links.find((x) => !this.exhausted.has(x.name))!.name}` : '; nothing left'}`);
  }

  /** Price a link's usage into the ledger (a CLI on a plan costs nothing here). */
  charge(l: ChainLink, model: string, usage: CallUsage | null, what: Record<string, unknown> = {}): number {
    if (l.budget === null || !usage) return 0;
    const usd = priceUsage(model, usage);
    this.ledger.add(l.name, usd, { model, ...what });
    return usd;
  }

  async call(messages: ChatMessage[], opts: CompletionOptions = {}, what: Record<string, unknown> = {}): Promise<{ text: string; usage: CallUsage | null; link: ChainLink }> {
    for (;;) {
      const link = this.pick();
      if (!link) throw new Error(`${this.label}: every model in the chain is spent`);
      let usage: CallUsage | null = null;
      try {
        const text = await link.client.complete(messages, { ...opts, onUsage: (u) => { usage = u; opts.onUsage?.(u); } });
        this.charge(link, link.client.model, usage, what);
        return { text, usage, link };
      } catch (err) {
        // a failed call that used tokens is paid for all the same
        this.charge(link, link.client.model, usage, what);
        if (isSpentError(err)) {
          this.exhaust(link, err instanceof Error ? err.message.slice(0, 120) : 'spent');
          continue;
        }
        throw err;
      }
    }
  }

  /** The chain as an LlmClient (an author, a judge): complete and completeJson. */
  asClient(): LlmClient {
    const chain = this;
    const client = {
      provider: 'chain',
      enabled: true,
      get label() {
        return chain.label;
      },
      get model() {
        return chain.pick()?.client.model ?? '';
      },
      complete: async (messages: ChatMessage[], opts: CompletionOptions = {}) => (await chain.call(messages, opts)).text,
      completeJson: async <T>(messages: ChatMessage[], opts: { maxTokens?: number; model?: string; onUsage?: (u: CallUsage) => void } = {}) => jsonFromReply<T>((await chain.call(messages, { json: true, ...opts })).text),
    };
    return client as unknown as LlmClient;
  }

  /** The chain as the shim's backend: each reply names the model that gave it, for the meter's price. */
  asBackend(): ChatBackend {
    return {
      label: this.label,
      complete: async (req: ChatRequest): Promise<ChatResult> => {
        const messages = req.schema ? [...req.messages, { role: 'user' as const, content: `Reply with JSON matching this schema:\n${JSON.stringify(req.schema)}` }] : req.messages;
        const r = await this.call(messages, { json: req.json || Boolean(req.schema), effort: req.effort });
        return { text: r.text, usage: r.usage, model: r.link.client.model || r.link.name };
      },
    };
  }
}
