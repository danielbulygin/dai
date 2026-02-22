import { logger } from "../utils/logger.js";

interface QueueEntry<T> {
  channelId: string;
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * Promise-based concurrency queue with per-channel FIFO ordering
 * and a global concurrency limit.
 *
 * Usage:
 * ```ts
 * const result = await agentQueue.enqueue(channelId, () => runAgent(...));
 * ```
 */
export class AgentQueue {
  private readonly maxConcurrent: number;
  private active = 0;
  private readonly pending: QueueEntry<unknown>[] = [];

  constructor(maxConcurrent = 5) {
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Enqueue an async task.  The returned promise resolves when the task
   * completes.  Tasks for the same `channelId` execute in FIFO order;
   * the global concurrency cap limits how many tasks run at once.
   */
  async enqueue<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        channelId,
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.drain();
    });
  }

  /** Number of tasks waiting to be executed. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Number of tasks currently executing. */
  get activeCount(): number {
    return this.active;
  }

  /**
   * Pull entries from the pending queue and execute them while we are
   * below the concurrency limit.
   *
   * Per-channel ordering: we pick the first entry whose channelId does
   * not already have an active task running (so tasks in the same channel
   * are sequential).  If all pending channels already have an active task,
   * we wait for one to finish.
   */
  private drain(): void {
    while (this.active < this.maxConcurrent && this.pending.length > 0) {
      const index = this.findNextIndex();
      if (index === -1) {
        // All pending entries have an active task in their channel; wait.
        break;
      }

      const entry = this.pending.splice(index, 1)[0]!;
      this.run(entry);
    }
  }

  /**
   * Track which channels currently have an active task so we can enforce
   * per-channel FIFO.
   */
  private readonly activeChannels = new Set<string>();

  private findNextIndex(): number {
    for (let i = 0; i < this.pending.length; i++) {
      const entry = this.pending[i]!;
      if (!this.activeChannels.has(entry.channelId)) {
        return i;
      }
    }
    return -1;
  }

  private run(entry: QueueEntry<unknown>): void {
    this.active++;
    this.activeChannels.add(entry.channelId);

    logger.debug(
      {
        channelId: entry.channelId,
        active: this.active,
        pending: this.pending.length,
      },
      "AgentQueue: starting task",
    );

    entry
      .fn()
      .then((value) => entry.resolve(value))
      .catch((err: unknown) => entry.reject(err))
      .finally(() => {
        this.active--;
        this.activeChannels.delete(entry.channelId);

        logger.debug(
          {
            channelId: entry.channelId,
            active: this.active,
            pending: this.pending.length,
          },
          "AgentQueue: task finished",
        );

        // Continue draining now that a slot is free
        this.drain();
      });
  }
}

/** Default singleton queue with 5 concurrent slots. */
export const agentQueue = new AgentQueue(5);
