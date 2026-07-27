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
import {
  clearStorage,
  downloadPatch,
  loadFromStorage,
  parsePatch,
  saveToStorage,
  serializePatch,
  type ParsedPatch,
} from "./persistence";

export interface PatchNodeData extends Record<string, unknown> {
  defType: string;
  params: Record<string, unknown>;
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

  onNodesChange: (changes: NodeChange<PatchNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  addNode: (defType: string, position: { x: number; y: number }) => void;
  removeNode: (id: string) => void;
  setParam: (id: string, key: string, value: unknown) => void;
  select: (id: string | null) => void;
  setStatuses: (statuses: Record<string, NodeStatus>) => void;
  setResolution: (width: number, height: number) => void;
  loadPatch: (patch: ParsedPatch) => void;
  exportPatch: () => void;
  importPatch: (file: File) => Promise<string | null>;
  resetPatch: () => void;
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

/** Camera → Pose → Draw → Feedback → Output: a patch that shows something immediately. */
function starterPatch(): { nodes: PatchNode[]; edges: Edge[] } {
  const nodes: PatchNode[] = [
    {
      id: "camera-1",
      type: "patch",
      position: { x: 0, y: 120 },
      data: { defType: "source.camera", params: defaultParams("source.camera") },
    },
    {
      id: "pose-1",
      type: "patch",
      position: { x: 300, y: 40 },
      data: { defType: "tracking.pose", params: defaultParams("tracking.pose") },
    },
    {
      id: "landmarks-1",
      type: "patch",
      position: { x: 620, y: 120 },
      data: { defType: "draw.landmarks", params: defaultParams("draw.landmarks") },
    },
    {
      id: "feedback-1",
      type: "patch",
      position: { x: 940, y: 160 },
      data: { defType: "fx.feedback", params: defaultParams("fx.feedback") },
    },
    {
      id: "screen-1",
      type: "patch",
      position: { x: 1240, y: 200 },
      data: { defType: "output.screen", params: defaultParams("output.screen") },
    },
  ];

  const edges: Edge[] = [
    { id: "e1", source: "camera-1", sourceHandle: "frame", target: "pose-1", targetHandle: "frame" },
    { id: "e2", source: "camera-1", sourceHandle: "out", target: "landmarks-1", targetHandle: "bg" },
    {
      id: "e3",
      source: "pose-1",
      sourceHandle: "out",
      target: "landmarks-1",
      targetHandle: "landmarks",
    },
    { id: "e4", source: "landmarks-1", sourceHandle: "out", target: "feedback-1", targetHandle: "src" },
    { id: "e5", source: "feedback-1", sourceHandle: "out", target: "screen-1", targetHandle: "src" },
  ];

  nodeCounter = 5;
  return { nodes, edges };
}

const restored = loadFromStorage();
const initial = restored ?? { ...starterPatch(), width: 1280, height: 720 };

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: initial.nodes,
  edges: initial.edges,
  selectedId: null,
  statuses: {},
  width: initial.width,
  height: initial.height,

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
    if (!sourcePort || !targetPort || sourcePort.type !== targetPort.type) return;

    // An input takes a single link; reconnecting replaces the old one.
    const cleaned = edges.filter(
      (edge) =>
        !(edge.target === connection.target && edge.targetHandle === connection.targetHandle),
    );
    set({ edges: addEdge({ ...connection, id: `e-${crypto.randomUUID()}` }, cleaned) });
  },
  addNode(defType, position) {
    const id = nextId(defType, new Set(get().nodes.map((node) => node.id)));
    set({
      nodes: [
        ...get().nodes,
        { id, type: "patch", position, data: { defType, params: defaultParams(defType) } },
      ],
      selectedId: id,
    });
  },
  removeNode(id) {
    set({
      nodes: get().nodes.filter((node) => node.id !== id),
      edges: get().edges.filter((edge) => edge.source !== id && edge.target !== id),
      selectedId: get().selectedId === id ? null : get().selectedId,
    });
  },
  setParam(id, key, value) {
    set({
      nodes: get().nodes.map((node) =>
        node.id === id
          ? { ...node, data: { ...node.data, params: { ...node.data.params, [key]: value } } }
          : node,
      ),
    });
  },
  select(id) {
    set({ selectedId: id });
  },
  setStatuses(statuses) {
    set({ statuses });
  },
  setResolution(width, height) {
    set({ width, height });
  },
  loadPatch(patch) {
    nodeCounter = patch.nodes.length;
    set({
      nodes: patch.nodes,
      edges: patch.edges,
      width: patch.width,
      height: patch.height,
      selectedId: null,
      statuses: {},
    });
  },
  exportPatch() {
    const { nodes, edges, width, height } = get();
    downloadPatch(serializePatch(nodes, edges, width, height));
  },
  async importPatch(file) {
    try {
      const parsed = parsePatch(JSON.parse(await file.text()));
      if (!parsed) return "файл не похож на патч visio";
      get().loadPatch(parsed);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "не удалось прочитать файл";
    }
  },
  resetPatch() {
    clearStorage();
    const fresh = starterPatch();
    nodeCounter = fresh.nodes.length;
    set({
      nodes: fresh.nodes,
      edges: fresh.edges,
      selectedId: null,
      statuses: {},
    });
  },
}));

// Autosave: coalesce bursts (node dragging fires a change per mouse move) and
// ignore status-only updates, which the engine pushes several times a second.
let saveTimer: number | undefined;
let savedNodes = initial.nodes;
let savedEdges = initial.edges;
useGraphStore.subscribe((state) => {
  if (state.nodes === savedNodes && state.edges === savedEdges) return;
  savedNodes = state.nodes;
  savedEdges = state.edges;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveToStorage(serializePatch(state.nodes, state.edges, state.width, state.height));
  }, 400);
});
