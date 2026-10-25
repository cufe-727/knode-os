/**
 * Run `fn` over `items` with at most `size` in flight, keeping results in the
 * order the items were given. Workers pull from a shared cursor rather than
 * being handed a slice each, so one slow item does not idle the others.
 *
 * `items` must be an array, not a generator: workers would race a shared
 * iterator.
 */
export async function pool<T, R>(items: T[], size: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/**
 * A pause for a long synchronous stretch of an async function (the nightly
 * audits walk hundreds of thousands of rows): `await pause()` between steps
 * gives the event loop a turn — timers, sockets, file events, so the server
 * keeps answering — once `sliceMs` of work has gone by since the last one, and
 * otherwise resolves at once.
 */
export function breather(sliceMs = 20): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < sliceMs) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    since = performance.now();
  };
}
