/** Bound a backend without letting errors or an abandoned timeout stall execution. */
export async function withDeadline<T>(work: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Return the first usable result, not the first failure or the slowest backend. */
export async function firstUsable<T>(works: Array<Promise<T | null>>): Promise<T | null> {
  if (!works.length) return null;
  try {
    return await Promise.any(works.map(async (work) => {
      const value = await work;
      if (value === null) throw new Error("No route");
      return value;
    }));
  } catch { return null; }
}

/** Reserve capacity synchronously, including for synchronous enqueue bursts. */
export function createTaskQueue(capacity: number, onError: (error: unknown) => void) {
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid queue capacity");
  let active = 0;
  let sequence = 0;
  const waiting: Array<{ task: () => Promise<void>; priority: number; sequence: number }> = [];
  const drain = () => {
    while (active < capacity && waiting.length) {
      waiting.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
      const task = waiting.shift()!.task;
      active++;
      void Promise.resolve().then(task).catch(onError).finally(() => {
        active--;
        drain();
      });
    }
  };
  return (task: () => Promise<void>, priority = 0) => {
    waiting.push({ task, priority, sequence: sequence++ });
    drain();
  };
}

/** Validate candidates as they arrive; every fallback shares one wall-clock budget.
 * Timed-out work cannot return an accepted transaction to the caller. */
export async function validateRoutes<T, R>(input: {
  first: T;
  alternatives: () => Array<Promise<T | null>>;
  validate: (route: T) => Promise<{ value?: R; terminal?: boolean }>;
  budgetMs: number;
}): Promise<R | null> {
  const until = Date.now() + input.budgetMs;
  const seen = new Set<T>();
  let pending: Map<number, Promise<{ id: number; route: T | null }>> | undefined;
  let route: T | null = input.first;
  while (Date.now() < until) {
    if (route !== null && !seen.has(route)) {
      seen.add(route);
      const result = await withDeadline(input.validate(route), Math.max(1, until - Date.now()));
      if (!result) return null;
      if (result.value !== undefined) return result.value;
      if (result.terminal) return null;
    }
    pending ??= new Map(input.alternatives().map((p, id) => [id, p.then(
      (route) => ({ id, route }), () => ({ id, route: null }),
    )]));
    if (!pending.size) break;
    const next = await withDeadline(Promise.race(pending.values()), Math.max(1, until - Date.now()));
    if (!next) break;
    pending.delete(next.id);
    route = next.route;
  }
  return null;
}
