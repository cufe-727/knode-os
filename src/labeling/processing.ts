import { FollowUp } from './followup.js';
import { LocalLabelingWorkers } from './local.js';

/**
 * A workspace's processing: the work that spends model calls once documents
 * are in — this machine's extraction slots (src/labeling/local.ts) and, after
 * them, the duplicate reviews and summary pages (src/labeling/followup.ts).
 *
 * `serve` never starts it on its own, not at startup and not after a restart:
 * someone starts it (the app, the web UI, POST /api/labeling/start) and it
 * runs until someone stops it or the service stops. Importing, watching and
 * embedding documents go on regardless, and remote workers may still lease
 * segments: they are started by hand on their own machines.
 */

export interface ProcessingState {
  running: boolean;
  /** When it was last started or stopped, and by whom. */
  since: string | null;
  by: string | null;
}

export class LabelingProcessing {
  private since: string | null = null;
  private by: string | null = null;

  constructor(
    private readonly workers: LocalLabelingWorkers,
    private readonly followUp: FollowUp,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  get running(): boolean {
    return this.workers.running;
  }

  /** Start the slots, reviews and summaries. False when they were running already. */
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
    return { running: this.workers.running, since: this.since, by: this.by };
  }

  private mark(by: string): void {
    this.since = new Date().toISOString();
    this.by = by;
  }
}
