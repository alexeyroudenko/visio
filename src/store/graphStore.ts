import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import { create } from "zustand";
import type { NodeRuntime } from "../engine/types";
import { defaultParams, NODE_DEFS } from "../nodes/registry";
import { DEFAULT_PRESET_ID, getPreset } from "../presets";
import { appLog } from "./consoleStore";
import {
  clearStorage,
  downloadPatch,
  loadFromStorage,
  parsePatch,
  saveToStorage,
  serializePatch,
  type ParsedPatch,
} from "./persistence";
import { useTimelineStore } from "./timelineStore";

export interface PatchNodeData extends Record<string, unknown> {
  defType: string;
  params: Record<string, unknown>;
  bypass?: boolean;
}

export type PatchNode = Node<PatchNodeData>;

export interface NodeStatus {
  status: NodeRuntime["status"];
  message: string | null;
}

interface GraphState {
  nodes: PatchNode[];
  edges: Edge[];
  selectedId: string | null;
  statuses: Record<string, NodeStatus>;
  width: number;
  height: number;
  /** Last preset loaded via Presets / Reset; used to highlight in the modal. */
  activePresetId: string | null;

  onNodesChange: (changes: NodeChange<PatchNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  addNode: (
    defType: string,
    position: { x: number; y: number },
    params?: Record<string, unknown>,
  ) => string;
  removeNode: (id: string) => void;
  setParam: (id: string, key: string, value: unknown) => void;
  setBypass: (id: string, bypass: boolean) => void;
  select: (id: string | null) => void;
  setStatuses: (statuses: Record<string, NodeStatus>) => void;
  setResolution: (width: number, height: number) => void;
  loadPatch: (patch: ParsedPatch, note?: string) => void;
  loadPreset: (id: string) => boolean;
  exportPatch: () => void;
  importPatch: (file: File) => Promise<string | null>;
  resetPatch: () => void;
  clearActivePreset: () => void;
}

const ACTIVE_PRESET_KEY = "visio.activePreset.v1";

function readActivePresetId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PRESET_KEY);
  } catch {
    return null;
  }
}

function writeActivePresetId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_PRESET_KEY, id);
    else localStorage.removeItem(ACTIVE_PRESET_KEY);
  } catch {
    /* ignore quota / private mode */
  }
}

let nodeCounter = 0;
function nextId(defType: string, taken: Set<string>): string {
  const base = defType.split(".")[1] ?? defType;
  let id: string;
  do {
    nodeCounter += 1;
    id = `${base}-${nodeCounter}`;
  } while (taken.has(id));
  return id;
}

function patchFromPreset(id: string): ParsedPatch | null {
  const preset = getPreset(id) ?? getPreset(DEFAULT_PRESET_ID);
  if (!preset) return null;
  return parsePatch(preset.build());
}

type GraphStore = ReturnType<typeof createGraphStore>;

declare global {
  interface Window {
    /** Survives Vite HMR so UI + engine never bind to a fresh empty store. */
    __visioGraphStore?: GraphStore;
  }
}

function createGraphStore() {
  const restored = loadFromStorage();
  const initial = restored ?? patchFromPreset(DEFAULT_PRESET_ID)!;
  const initialPresetId = restored ? readActivePresetId() : DEFAULT_PRESET_ID;
  if (!restored) writeActivePresetId(DEFAULT_PRESET_ID);

  const store = create<GraphState>((set, get) => ({
    nodes: initial.nodes,
    edges: initial.edges,
    selectedId: null,
    statuses: {},
    width: initial.width,
    height: initial.height,
    activePresetId: initialPresetId && getPreset(initialPresetId) ? initialPresetId : null,

    onNodesChange(changes) {
      set({ nodes: applyNodeChanges(changes, get().nodes) });
    },
    onEdgesChange(changes) {
      set({ edges: applyEdgeChanges(changes, get().edges) });
    },
    onConnect(connection) {
      const { nodes, edges } = get();
      const sourceNode = nodes.find((n) => n.id === connection.source);
      const targetNode = nodes.find((n) => n.id === connection.target);
      if (!sourceNode || !targetNode) return;

      const sourcePort = NODE_DEFS[sourceNode.data.defType]?.outputs.find(
        (p) => p.id === connection.sourceHandle,
      );
      const targetPort = NODE_DEFS[targetNode.data.defType]?.inputs.find(
        (p) => p.id === connection.targetHandle,
      );
      // Ports carry different payloads entirely — refuse mismatched wiring.
      if (!sourcePort || !targetPort || sourcePort.type !== targetPort.type) {
        appLog(
          "warn",
          "graph",
          `refused ${connection.source}.${connection.sourceHandle} → ${connection.target}.${connection.targetHandle} (type mismatch)`,
        );
        return;
      }

      // An input takes a single link; reconnecting replaces the old one.
      const cleaned = edges.filter(
        (edge) =>
          !(edge.target === connection.target && edge.targetHandle === connection.targetHandle),
      );
      set({ edges: addEdge({ ...connection, id: `e-${crypto.randomUUID()}` }, cleaned) });
      appLog(
        "info",
        "graph",
        `linked ${connection.source}.${connection.sourceHandle} → ${connection.target}.${connection.targetHandle}`,
      );
    },
    addNode(defType, position, params) {
      const id = nextId(defType, new Set(get().nodes.map((node) => node.id)));
      set({
        nodes: [
          ...get().nodes,
          {
            id,
            type: "patch",
            position,
            data: { defType, params: { ...defaultParams(defType), ...params } },
          },
        ],
        selectedId: id,
      });
      appLog("ok", "graph", `added ${defType} (${id})`);
      return id;
    },
    removeNode(id) {
      const node = get().nodes.find((n) => n.id === id);
      set({
        nodes: get().nodes.filter((n) => n.id !== id),
        edges: get().edges.filter((edge) => edge.source !== id && edge.target !== id),
        selectedId: get().selectedId === id ? null : get().selectedId,
      });
      appLog("info", "graph", `removed ${node?.data.defType ?? "node"} (${id})`);
    },
    setParam(id, key, value) {
      set({
        nodes: get().nodes.map((node) =>
          node.id === id
            ? { ...node, data: { ...node.data, params: { ...node.data.params, [key]: value } } }
            : node,
        ),
      });
      // Record-keys mode (cv-reels): every Inspector change lands a key at the playhead.
      const timeline = useTimelineStore.getState();
      if (timeline.isRecording) {
        timeline.recordParam(id, key, value);
      }
      if (key === "file") {
        const name =
          value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string"
            ? (value as { name: string }).name
            : "file";
        appLog("info", id, `file → ${name}`);
      }
    },
    setBypass(id, bypass) {
      set({
        nodes: get().nodes.map((node) =>
          node.id === id ? { ...node, data: { ...node.data, bypass } } : node,
        ),
      });
      appLog("info", id, bypass ? "bypass on" : "bypass off");
    },
    select(id) {
      set({ selectedId: id });
    },
    setStatuses(statuses) {
      const prev = get().statuses;
      set({ statuses });
      for (const [id, next] of Object.entries(statuses)) {
        const before = prev[id];
        if (before && before.status === next.status && before.message === next.message) continue;
        const level =
          next.status === "error"
            ? "error"
            : next.status === "ready"
              ? "ok"
              : next.status === "loading"
                ? "info"
                : "info";
        const detail = next.message ? `${next.status}: ${next.message}` : next.status;
        appLog(level, id, detail);
      }
    },
    setResolution(width, height) {
      set({ width, height });
      appLog("info", "app", `resolution ${width}×${height}`);
    },
    loadPatch(patch, note) {
      nodeCounter = patch.nodes.length;
      set({
        nodes: patch.nodes,
        edges: patch.edges,
        width: patch.width,
        height: patch.height,
        selectedId: null,
        statuses: {},
      });
      appLog(
        "ok",
        "patch",
        note ??
          `loaded ${patch.nodes.length} nodes · ${patch.edges.length} edges · ${patch.width}×${patch.height}`,
      );
    },
    loadPreset(id) {
      const preset = getPreset(id);
      const parsed = patchFromPreset(id);
      if (!parsed) {
        appLog("error", "preset", `failed to load ${id}`);
        return false;
      }
      get().loadPatch(parsed, `preset “${preset?.label ?? id}”`);
      writeActivePresetId(id);
      set({ activePresetId: id });
      return true;
    },
    exportPatch() {
      const { nodes, edges, width, height } = get();
      downloadPatch(serializePatch(nodes, edges, width, height));
      appLog("ok", "patch", "exported JSON");
    },
    async importPatch(file) {
      try {
        const parsed = parsePatch(JSON.parse(await file.text()));
        if (!parsed) {
          appLog("error", "patch", "import failed — not a visio patch");
          return "file does not look like a visio patch";
        }
        get().loadPatch(parsed, `imported ${file.name}`);
        writeActivePresetId(null);
        set({ activePresetId: null });
        return null;
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed to read file";
        appLog("error", "patch", `import failed — ${message}`);
        return message;
      }
    },
    resetPatch() {
      clearStorage();
      const fresh = patchFromPreset(DEFAULT_PRESET_ID);
      if (!fresh) return;
      get().loadPatch(fresh, "reset to default preset");
      writeActivePresetId(DEFAULT_PRESET_ID);
      set({ activePresetId: DEFAULT_PRESET_ID });
    },
    clearActivePreset() {
      writeActivePresetId(null);
      set({ activePresetId: null });
    },
  }));

  // Autosave: coalesce bursts (node dragging fires a change per mouse move) and
  // ignore status-only updates, which the engine pushes several times a second.
  let saveTimer: number | undefined;
  let savedNodes = initial.nodes;
  let savedEdges = initial.edges;
  store.subscribe((state) => {
    if (state.nodes === savedNodes && state.edges === savedEdges) return;
    savedNodes = state.nodes;
    savedEdges = state.edges;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveToStorage(serializePatch(state.nodes, state.edges, state.width, state.height));
    }, 400);
  });

  return store;
}

export const useGraphStore: GraphStore =
  typeof window !== "undefined" && window.__visioGraphStore
    ? window.__visioGraphStore
    : createGraphStore();

if (typeof window !== "undefined") {
  window.__visioGraphStore = useGraphStore;
}
