const MAX_CONCURRENT = Number(process.env.DEPLOY_CONCURRENCY ?? "1");
const waiting: string[] = [];
const running = new Set<string>();

export function enqueue(id: string): number {
  waiting.push(id);
  return waiting.length;
}

export function queuePosition(id: string): number | null {
  const idx = waiting.indexOf(id);
  if (idx >= 0) return idx + 1;
  if (running.has(id)) return 0;
  return null;
}

export function admitNext(): string | null {
  while (running.size < MAX_CONCURRENT && waiting.length > 0) {
    const id = waiting.shift();
    if (!id) return null;
    running.add(id);
    return id;
  }
  return null;
}

export function complete(id: string): void {
  running.delete(id);
  const idx = waiting.indexOf(id);
  if (idx >= 0) waiting.splice(idx, 1);
}
