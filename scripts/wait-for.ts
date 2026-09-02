/** Poll a predicate until it is truthy or the deadline passes. */
export async function waitFor<T>(predicate: () => Promise<T> | T, timeoutMs = 120_000, intervalMs = 1_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}
