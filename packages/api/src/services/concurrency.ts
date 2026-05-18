/**
 * Tiny bounded concurrency helper. Avoids the p-limit dependency.
 *
 * Usage:
 *   const limit = createLimit(3);
 *   await Promise.all(items.map((it) => limit(() => doWork(it))));
 */
export type LimitFn = <T>(fn: () => Promise<T>) => Promise<T>;

export function createLimit(maxConcurrency: number): LimitFn {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error(`maxConcurrency must be a positive integer; got ${maxConcurrency}`);
  }
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= maxConcurrency) return;
    const task = queue.shift();
    if (!task) return;
    active++;
    task();
  };

  return <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        fn()
          .then((value) => {
            active--;
            resolve(value);
            next();
          })
          .catch((err) => {
            active--;
            reject(err);
            next();
          });
      };
      queue.push(run);
      next();
    });
  };
}
