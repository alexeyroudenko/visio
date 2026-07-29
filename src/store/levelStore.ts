/**
 * Live source/grains peak levels per Granular node.
 *
 * Same deal as grainStore: updates every engine tick, so the meter columns read
 * it from their own rAF instead of pushing through React.
 */

export interface LevelPair {
  /** Dry / source bus peak, 0..1. */
  source: number;
  /** Grains bus peak, 0..1. */
  grains: number;
}

interface Entry {
  levels: LevelPair;
  at: number;
}

const STALE_MS = 400;

declare global {
  interface Window {
    __visioLevels?: Map<string, Entry>;
  }
}

const byId: Map<string, Entry> =
  (typeof window !== "undefined" ? window.__visioLevels : undefined) ?? new Map();

if (typeof window !== "undefined") window.__visioLevels = byId;

export function publishLevels(nodeId: string, levels: LevelPair): void {
  byId.set(nodeId, { levels, at: performance.now() });
}

export function clearLevels(nodeId: string): void {
  byId.delete(nodeId);
}

/** Latest levels, or zeros once the node goes stale / is gone. */
export function levelsFor(nodeId: string): LevelPair {
  const entry = byId.get(nodeId);
  if (!entry) return { source: 0, grains: 0 };
  if (performance.now() - entry.at > STALE_MS) return { source: 0, grains: 0 };
  return entry.levels;
}
