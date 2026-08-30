type Window = {
  count: number;
  startedAt: number;
};

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  consume(key: string, now = Date.now()): boolean {
    const current = this.windows.get(key);
    if (!current || now - current.startedAt >= this.windowMs) {
      this.windows.set(key, { count: 1, startedAt: now });
      this.prune(now);
      return true;
    }

    if (current.count >= this.limit) return false;
    current.count += 1;
    return true;
  }

  private prune(now: number) {
    if (this.windows.size < 1_000) return;
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) this.windows.delete(key);
    }
  }
}
