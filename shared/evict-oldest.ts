/**
 * Insertion-order Map cap used by electron, agent-core, and the renderer.
 *
 * JS Maps iterate in insertion order, so the first key is the oldest.
 * While `map.size > cap`, delete that entry. Callers keep their own caps.
 * Returns evicted `[key, value]` pairs so sibling bookkeeping (bytes,
 * secondary indexes) can stay in lockstep without copying the idiom.
 */

/** Delete insertion-order oldest entries until `map.size <= cap`. */
export function evictOldest<K, V>(map: Map<K, V>, cap: number): Array<[K, V]> {
  const evicted: Array<[K, V]> = [];
  while (map.size > cap) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    const value = map.get(oldest) as V;
    map.delete(oldest);
    evicted.push([oldest, value]);
  }
  return evicted;
}
