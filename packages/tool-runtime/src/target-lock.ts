/**
 * Keyed per-target async semaphore preventing parallel agents from overloading
 * the same loopback service port, dev server, or build artifact concurrently.
 */
export class TargetConcurrencyLimiter {
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(private readonly defaultLimit = 2) {}

  async acquire(targetKey: string, limit = this.defaultLimit): Promise<() => void> {
    const cap = Math.max(1, limit);
    const current = this.active.get(targetKey) ?? 0;

    if (current < cap) {
      this.active.set(targetKey, current + 1);
      return this.releaseFn(targetKey);
    }

    await new Promise<void>((resolve) => {
      const queue = this.waiters.get(targetKey) ?? [];
      queue.push(resolve);
      this.waiters.set(targetKey, queue);
    });

    this.active.set(targetKey, (this.active.get(targetKey) ?? 0) + 1);
    return this.releaseFn(targetKey);
  }

  private releaseFn(targetKey: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const nextCount = Math.max(0, (this.active.get(targetKey) ?? 1) - 1);
      if (nextCount === 0) this.active.delete(targetKey);
      else this.active.set(targetKey, nextCount);

      const queue = this.waiters.get(targetKey);
      const wake = queue?.shift();
      if (queue && queue.length === 0) this.waiters.delete(targetKey);
      wake?.();
    };
  }

  async run<T>(targetKey: string, fn: () => Promise<T>, limit = this.defaultLimit): Promise<T> {
    const release = await this.acquire(targetKey, limit);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  activeCount(targetKey: string): number {
    return this.active.get(targetKey) ?? 0;
  }
}

export const sharedTargetLimiter = new TargetConcurrencyLimiter(2);
