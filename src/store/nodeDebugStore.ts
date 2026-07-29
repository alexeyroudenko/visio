import { create } from "zustand";
import type { DebugRow } from "../engine/types";

/**
 * Live debug lines per node, filled by the engine while a node's debug toggle
 * is on. Same shape as the Media probe: the engine pushes, the node body reads.
 */
interface NodeDebugState {
  byId: Record<string, DebugRow[]>;
  setRows: (nodeId: string, rows: DebugRow[] | null) => void;
}

function fingerprint(rows: DebugRow[] | null): string {
  if (!rows) return "";
  return rows.map((row) => `${row.label}=${row.value}`).join("|");
}

declare global {
  interface Window {
    __visioNodeDebugStore?: ReturnType<typeof createNodeDebugStore>;
  }
}

function createNodeDebugStore() {
  const fingerprints = new Map<string, string>();
  return create<NodeDebugState>((set, get) => ({
    byId: {},
    setRows(nodeId, rows) {
      // Most rows hold steady between frames; only a real change costs a render.
      const next = fingerprint(rows);
      if (fingerprints.get(nodeId) === next) return;
      fingerprints.set(nodeId, next);
      if (!rows) {
        if (!(nodeId in get().byId)) return;
        const { [nodeId]: _removed, ...rest } = get().byId;
        set({ byId: rest });
        return;
      }
      set({ byId: { ...get().byId, [nodeId]: rows } });
    },
  }));
}

export const useNodeDebugStore =
  typeof window !== "undefined" && window.__visioNodeDebugStore
    ? window.__visioNodeDebugStore
    : createNodeDebugStore();

if (typeof window !== "undefined") {
  window.__visioNodeDebugStore = useNodeDebugStore;
}

export function publishNodeDebug(nodeId: string, rows: DebugRow[] | null): void {
  useNodeDebugStore.getState().setRows(nodeId, rows);
}
