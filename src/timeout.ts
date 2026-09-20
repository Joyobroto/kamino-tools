/** Enforce a deadline even when a transport ignores its abort signal. */
export async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, label: string): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${ms}ms`));
          controller.abort();
        }, ms);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
