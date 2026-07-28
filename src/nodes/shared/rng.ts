/** mulberry32 — the generator the glitcher effects are tuned against. */
export function mulberry32(seed: number): () => number {
  let a = Math.round(seed) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded LCG, the sequence the cv-reels generator uses. */
export function createLcg(seed: number): () => number {
  let state = Math.abs(Math.round(seed)) || 1;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}
