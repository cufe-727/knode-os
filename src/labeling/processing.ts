import { FollowUp } from './followup.js';
import { LocalLabelingWorkers } from './local.js';

/**
 * A workspace's processing: the work that spends this machine's model calls
 * once documents are in — its extraction and summary slots
 * (src/labeling/local.ts) and the duplicate reviews after them
 * (src/labeling/followup.ts).
 *
 * `serve` starts it on its own only where the workspace says so
 * (`processing.autoStart`); otherwise someone starts it (the app, the web UI,
 * POST /api/labeling/start). Either way it runs until someone stops it or the
 * service stops, within the workspace's limits: at most
 * `processing.maxLocalCalls` calls at once, and none on a Codex or Claude plan
 * under `processing.minQuotaPercent` left (src/labeling/local.ts). Importing,
 * watching and embedding documents go on regardless, and remote workers may
 * still lease segments and summaries: they are started by hand on their own
 * machines.
 */

export interface ProcessingState {
  running: boolean;
  /** When it was last started or stopped, and by whom. */
  since: string | null;
  by: string | null;
  /** Calls this machine's slots run now, and the most they may at once (0: no cap beyond each stage's slots). */
  calls: { inFlight: number; max: number };
  /** The quota floor in percent (0: off), and the backends it holds now. */
  minQuotaPercent: number;
  quotaHolds: { id: string; label: string; reason: string; until: string | null }[];
}

export class LabelingProcessing {
  private since: string | null = null;
  private by: string | null = null;

  constructor(
    private readonly workers: LocalLabelingWorkers,
    private readonly followUp: FollowUp,
    private readonly log: (msg: string) => void = () => {},
    private readonly minQuotaPercent: () => number = () => 0,
  ) {}

  get running(): boolean {
    return this.workers.running;
  }

  /** Start the slots (extraction and summaries) and the reviews. False when they were running already. */
  start(by: string): boolean {
    if (this.workers.running) return false;
    this.workers.start();
    this.followUp.setActive(true);
    this.mark(by);
    this.log(`processing started by ${by}: extraction, reviews and summaries`);
    return true;
  }

  /** Stop taking new work; calls in flight finish. False when nothing was running. */
  stop(by: string): boolean {
    if (!this.workers.running) return false;
    this.workers.stop();
    this.followUp.setActive(false);
    this.mark(by);
    this.log(`processing stopped by ${by}: calls in flight finish, nothing new starts`);
    return true;
  }

  state(): ProcessingState {
    return {
      running: this.workers.running,
      since: this.since,
      by: this.by,
      calls: this.workers.calls(),
      minQuotaPercent: this.minQuotaPercent(),
      quotaHolds: this.workers.running ? this.workers.quotaHolds() : [],
    };
  }

  private mark(by: string): void {
    this.since = new Date().toISOString();
    this.by = by;
  }
}
