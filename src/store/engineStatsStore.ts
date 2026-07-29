import { create } from "zustand";
import type { EngineStats } from "../engine/runtime";

interface EngineStatsState extends EngineStats {
  setStats: (stats: EngineStats) => void;
}

export const useEngineStatsStore = create<EngineStatsState>((set) => ({
  fps: 0,
  frameMs: 0,
  nodeCount: 0,
  setStats(stats) {
    set(stats);
  },
}));
