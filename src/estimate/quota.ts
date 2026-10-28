import { KnodeConfig, routeTargets } from '../config.js';
import { cliCommand, runProcess } from '../llm/cli.js';
import { calibrateCodex, CodexAccount, CodexCalibration, readCodexAccount, readLiveSnapshots, readRememberedAccount, RunTotals, scanCodexSessions, SessionScan } from './codex.js';

/**
 * Where an estimate reads the plans its calls are paid from (docs/design/18):
 * the Codex account through its CLI, Cursor's plan tier through its CLI. Both
 * are reads that spend no model call, cached so that opening an estimate twice
 * does not ask twice. Tests hand an estimate their own.
 */

export interface CodexQuota {
  /** The account as Codex reported it just now; null when it could not be asked. */
  account: CodexAccount | null;
  calibration: CodexCalibration | null;
  /** This machine's Codex sessions by working directory, for what past research runs used. */
  runs: Map<string, RunTotals>;
  error: string | null;
}

export interface QuotaSources {
  /** Null when no Codex is configured here at all. */
  codex(): Promise<CodexQuota | null>;
  /** The Cursor plan's tier ("Ultra", "Pro", …), or null when it cannot be read. */
  cursorPlan(): Promise<string | null>;
}

/** A month of sessions covers several weekly windows' lives; older ones say little about today's rate. */
const LOOKBACK_MS = 35 * 86_400_000;
const PLAN_TTL_MS = 3_600_000;
/** How old a remembered account read may be and still stand in for a failed one. */
const REMEMBERED_MS = 3 * 86_400_000;

let cursorCache: { command: string; at: number; value: Promise<string | null> } | null = null;

/**
 * The quota sources for a workspace: Codex through the executable its Codex
 * agents run (their `cliPath`, else `codex` on PATH), its sessions where
 * trace sync reads them; Cursor through `cursor-agent about`, likewise.
 */
export function quotaSources(config: KnodeConfig, opts: { codexCommand?: string; cursorCommand?: string } = {}): QuotaSources {
  const targets = routeTargets(config);
  const pathOf = (provider: 'codex-cli' | 'cursor-cli') => cliCommand(provider, targets.find((t) => t.provider === provider && t.cliPath?.trim())?.cliPath ?? '');
  const codexCommand = opts.codexCommand ?? pathOf('codex-cli');
  const cursorCommand = opts.cursorCommand ?? pathOf('cursor-cli');
  return {
    codex: async () => {
      let account: CodexAccount | null = null;
      let error: string | null = null;
      if (config.usage?.codexLimits !== false) {
        try {
          account = await readCodexAccount(codexCommand);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          // a dropped connection should not swing the estimate: the last read, dated, until a new one succeeds
          const last = readRememberedAccount();
          if (last && Date.now() - Date.parse(last.readAt) < REMEMBERED_MS) account = last;
        }
      }
      let scan: SessionScan | null = null;
      try {
        scan = await scanCodexSessions(config.trace.codexSessionsDir, { sinceMs: Date.now() - LOOKBACK_MS });
      } catch {
        // no sessions folder: the live read alone
      }
      const snapshots = [...(scan?.snapshots ?? []), ...readLiveSnapshots()];
      const calibration = scan
        ? calibrateCodex({ snapshots, pairs: scan.pairs, accountDaily: account?.daily, localDaily: scan.daily, mix: scan.mix })
        : null;
      if (!account && !scan?.files) return error ? { account: null, calibration: null, runs: new Map(), error } : null;
      return { account, calibration, runs: scan?.byCwd ?? new Map(), error };
    },
    cursorPlan: () => {
      if (cursorCache && cursorCache.command === cursorCommand && Date.now() - cursorCache.at < PLAN_TTL_MS) return cursorCache.value;
      const value = readCursorPlan(cursorCommand);
      cursorCache = { command: cursorCommand, at: Date.now(), value };
      return value;
    },
  };
}

/** `cursor-agent about --format json`: its `subscriptionTier`, and nothing else of the account. */
async function readCursorPlan(command: string): Promise<string | null> {
  try {
    const r = await runProcess(command, ['about', '--format', 'json'], '', 20_000);
    if (r.code !== 0) return null;
    const tier = (JSON.parse(r.stdout) as { subscriptionTier?: unknown }).subscriptionTier;
    return typeof tier === 'string' && tier.trim() ? tier.trim() : null;
  } catch {
    return null;
  }
}
