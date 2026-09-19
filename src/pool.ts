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
