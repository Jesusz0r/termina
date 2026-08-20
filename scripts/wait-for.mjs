/** Poll a predicate until it is truthy or the deadline passes. */
export async function waitFor(predicate, timeoutMs = 120000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}
