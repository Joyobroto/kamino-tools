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
  const waiting: Array<() => Promise<void>> = [];
  const drain = () => {
    while (active < capacity && waiting.length) {
      const task = waiting.shift()!;
      active++;
      void Promise.resolve().then(task).catch(onError).finally(() => {
        active--;
        drain();
      });
    }
  };
  return (task: () => Promise<void>) => { waiting.push(task); drain(); };
}
