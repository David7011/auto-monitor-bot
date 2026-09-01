/**
 * Starts the whole batch immediately, preserves target order in the final
 * result, and exposes each completed item without waiting for its siblings.
 */
export async function collectProgressively<TTarget, TResult>(
  targets: readonly TTarget[],
  fetchTarget: (target: TTarget, index: number) => Promise<TResult>,
  onResult: (result: TResult, index: number) => Promise<void>,
): Promise<TResult[]> {
  const results = new Array<TResult>(targets.length);
  await Promise.all(targets.map(async (target, index) => {
    const result = await fetchTarget(target, index);
    results[index] = result;
    await onResult(result, index);
  }));
  return results;
}
