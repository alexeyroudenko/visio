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
import { scrub, setLaunchContext, track, trackParam } from "../lib/analytics";
import { fitAppWindowToPatch } from "../lib/appWindow";
import { DEFAULT_DURATION_FRAMES, DEFAULT_FPS, paramPath, parseParamPath } from "../lib/keyframes";
import { loadResetOnVisit } from "../lib/resetOnVisit";
import { defaultParams, NODE_DEFS } from "../nodes/registry";
import { fileParamFromFile, mediaKind } from "../nodes/shared/fileParam";
import { DEFAULT_PRESET_ID, getPreset } from "../presets";
import { appLog } from "./consoleStore";
import { publishMediaInfo } from "./mediaInfoStore";
import {
  forgetAllMedia,
  recallMediaParams,
  rememberedFile,
  rememberMedia,
} from "./mediaMemory";
import { useModulatorStore } from "./modulatorStore";
import {
  clearStorage,
  downloadPatch,
  loadFromStorage,
  parsePatch,
  saveToStorage,
  serializePatch,
  type ParsedPatch,
  type SerializedTimeline,
} from "./persistence";
import { useTimelineStore } from "./timelineStore";

export interface PatchNodeData extends Record<string, unknown> {
  defType: string;
  params: Record<string, unknown>;
  bypass?: boolean;
  /** Show the live port/timing panel in the node body. */
  debug?: boolean;
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
  /** Range-param paths (`nodeId:key`) shown on the performance mixer. */
  published: string[];
  /** Bumped on loadPreset so the graph can Fit View like the controls button. */
  fitViewNonce: number;

  onNodesChange: (changes: NodeChange<PatchNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  addNode: (
    defType: string,
    position: { x: number; y: number },
    params?: Record<string, unknown>,
  ) => string;
  removeNode: (id: string) => void;
  dropMediaFiles: (files: File[]) => void;
  setParam: (id: string, key: string, value: unknown) => void;
  setBypass: (id: string, bypass: boolean) => void;
  setDebug: (id: string, debug: boolean) => void;
  select: (id: string | null) => void;
  setStatuses: (statuses: Record<string, NodeStatus>) => void;
  setResolution: (width: number, height: number) => void;
  loadPatch: (patch: ParsedPatch, note?: string) => void;
  loadPreset: (id: string) => boolean;
  exportPatch: () => void;
  importPatch: (file: File) => Promise<string | null>;
  resetPatch: () => void;
  reapplyRememberedMedia: () => void;
  clearActivePreset: () => void;
  togglePublished: (path: string) => void;
}

const ACTIVE_PRESET_KEY = "visio.activePreset.v1";

function writeActivePresetId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_PRESET_KEY, id);
    else localStorage.removeItem(ACTIVE_PRESET_KEY);
  } catch {
    /* ignore quota / private mode */
  }
}

function readActivePresetId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PRESET_KEY);
  } catch {
    return null;
  }
}

let nodeCounter = 0;
/** `first_source_ready` is a once-per-session milestone, not a status echo. */
let reportedFirstSource = false;
function nextId(defType: string, taken: Set<string>): string {
  const base = defType.split(".")[1] ?? defType;
  let id: string;
  do {
    nodeCounter += 1;
    id = `${base}-${nodeCounter}`;
  } while (taken.has(id));
  return id;
}

/** The parts of the timeline that belong to the document, not the session. */
export function currentTimeline(): SerializedTimeline {
  const {
    fps,
    durationInFrames,
    paramKeyframes,
    reelZones,
    cueZoneTick,
    cueDevMetronome,
    cueDrone,
    developmentBpm,
    droneByZone,
  } = useTimelineStore.getState();
  return {
    fps,
    durationInFrames,
    keyframes: paramKeyframes,
    reelZones: {
      cutsSec: [
        reelZones.cutsSec[0],
        reelZones.cutsSec[1],
        reelZones.cutsSec[2],
        reelZones.cutsSec[3],
      ],
      dirty: reelZones.dirty,
    },
    cueZoneTick,
    cueDevMetronome,
    cueDrone,
    developmentBpm,
    droneByZone,
  };
}

const EMPTY_TIMELINE: SerializedTimeline = {
  fps: DEFAULT_FPS,
  durationInFrames: DEFAULT_DURATION_FRAMES,
  keyframes: {},
};

const EMPTY_WIDTH = 1080;
const EMPTY_HEIGHT = 1920;

/** First launch and Reset: no nodes, black output, drop / template overlay. */
function emptyPatch(): ParsedPatch {
  return {
    nodes: [],
    edges: [],
    width: EMPTY_WIDTH,
    height: EMPTY_HEIGHT,
    timeline: { ...EMPTY_TIMELINE },
    modulators: {},
    published: [],
  };
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
  const resetOnVisit = loadResetOnVisit();
  const saved = resetOnVisit ? null : loadFromStorage();
  if (resetOnVisit) {
    // Same as the Reset button: last session's patch does not come back.
    clearStorage();
    writeActivePresetId(null);
  }
  const initial = saved ?? emptyPatch();
  const activePresetId = saved ? readActivePresetId() : null;
  if (!saved) writeActivePresetId(null);
  setLaunchContext({
    restored: saved != null,
    nodes: initial.nodes.length,
    edges: initial.edges.length,
  });
  // Startup seeds the store directly instead of going through loadPatch, so the
  // timeline has to be adopted here too or a reload drops every key.
  if (initial.timeline) useTimelineStore.getState().loadTimeline(initial.timeline);
  useModulatorStore.getState().load(initial.modulators);

  const store = create<GraphState>((set, get) => ({
    nodes: initial.nodes,
    edges: initial.edges,
    selectedId: null,
    statuses: {},
    width: initial.width,
    height: initial.height,
    published: initial.published,
    activePresetId,
    fitViewNonce: 0,

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
        // A refused wire is someone's mental model of the graph being wrong —
        // the clearest "затык" signal the editor produces.
        track("edge_refused", {
          from_type: sourceNode.data.defType,
          from_port: connection.sourceHandle,
          to_type: targetNode.data.defType,
          to_port: connection.targetHandle,
        });
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
      // Which chains people actually build — the payoff event of the whole setup.
      track("edge_connected", {
        from_type: sourceNode.data.defType,
        from_port: connection.sourceHandle,
        to_type: targetNode.data.defType,
        to_port: connection.targetHandle,
        port_type: sourcePort.type,
        replaced: cleaned.length !== edges.length,
      });
    },
    addNode(defType, position, params) {
      const id = nextId(defType, new Set(get().nodes.map((node) => node.id)));
      const merged = { ...defaultParams(defType), ...params };
      // A file dropped on the canvas arrives here, not through setParam.
      if (defType === "source.media") rememberMedia(merged);
      set({
        nodes: [
          ...get().nodes,
          { id, type: "patch", position, data: { defType, params: merged } },
        ],
        selectedId: id,
      });
      appLog("ok", "graph", `added ${defType} (${id})`);
      track("node_added", {
        node_type: defType,
        category: NODE_DEFS[defType]?.category ?? null,
        graph_size: get().nodes.length,
      });
      if (defType === "source.media") {
        // Only the kind travels — never the name, size or blob URL of the file.
        track("media_added", {
          kind: typeof merged.mode === "string" ? merged.mode : null,
          via: merged.file ? "drop" : "toolbar",
        });
      }
      return id;
    },
    dropMediaFiles(files) {
      // One file only: the memory keeps a single blob URL per kind and revokes
      // the one it replaces, so two images in one drop would leave the first
      // node pointing at a dead URL.
      const usable = files.flatMap((candidate) => {
        const kind = mediaKind(candidate);
        return kind ? [{ file: candidate, kind }] : [];
      });
      if (usable.length === 0) {
        appLog("warn", "media", "dropped file is not an image, video or audio");
        return;
      }
      const { file, kind } = usable[0];
      if (usable.length > 1) {
        appLog("info", "media", `using ${file.name}, ignored ${usable.length - 1} more`);
      }

      const media = get().nodes.filter((node) => node.data.defType === "source.media");
      // The node you are looking at wins; failing that, one already on the
      // dropped kind — an mp3 on an audio + image patch means the audio node.
      const target =
        media.find((node) => node.id === get().selectedId) ??
        media.find((node) => node.data.params.mode === kind) ??
        media[0];

      if (!target) {
        const mediaId = get().addNode(
          "source.media",
          { x: 120, y: 180 },
          { mode: kind, file: fileParamFromFile(file), mirror: false },
        );
        const screen =
          get().nodes.find((node) => node.data.defType === "output.screen")?.id ??
          get().addNode("output.screen", { x: 480, y: 180 });
        get().onConnect({
          source: mediaId,
          sourceHandle: "out",
          target: screen,
          targetHandle: "src",
        });
        // Empty-graph drop opens the presets picker next — don't leave Output
        // selected or its settings panel sits on top of that modal.
        get().select(null);
        return;
      }

      const params = { ...target.data.params, mode: kind, file: fileParamFromFile(file) };
      rememberMedia(params, file);
      set({
        nodes: get().nodes.map((node) =>
          node.id === target.id ? { ...node, data: { ...node.data, params } } : node,
        ),
        selectedId: target.id,
      });
      appLog("ok", "media", `${file.name} → ${target.id} (${kind})`);
      // Only the kind travels — never the name, size or blob URL of the file.
      track("media_dropped", { kind });
    },
    removeNode(id) {
      const node = get().nodes.find((n) => n.id === id);
      set({
        nodes: get().nodes.filter((n) => n.id !== id),
        edges: get().edges.filter((edge) => edge.source !== id && edge.target !== id),
        selectedId: get().selectedId === id ? null : get().selectedId,
        published: get().published.filter((path) => parseParamPath(path)?.nodeId !== id),
      });
      appLog("info", "graph", `removed ${node?.data.defType ?? "node"} (${id})`);
      track("node_removed", { node_type: node?.data.defType ?? null });
      publishMediaInfo(id, null);
    },
    setParam(id, key, value) {
      const target = get().nodes.find((node) => node.id === id);
      set({
        nodes: get().nodes.map((node) => {
          if (node.id !== id) return node;
          const params = { ...node.data.params, [key]: value };
          if (node.data.defType === "source.media") {
            // Changing the source type swaps in whatever was last open for it,
            // so image → video → image gets both files back rather than
            // stranding one of them.
            if (key === "mode") params.file = rememberedFile(value);
            rememberMedia(params);
          }
          return { ...node, data: { ...node.data, params } };
        }),
      });
      // Record-keys mode (cv-reels): every Inspector change lands a key at the
      // playhead. An already-animated param does so regardless — its base value
      // is overridden by the curve, so editing it would look like nothing happened.
      const timeline = useTimelineStore.getState();
      if (timeline.isRecording || timeline.hasKeyframes(paramPath(id, key))) {
        timeline.recordParam(id, key, value);
      }
      if (key === "file") {
        const name =
          value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string"
            ? (value as { name: string }).name
            : "file";
        appLog("info", id, `file → ${name}`);
      }
      if (target) {
        // Debounced inside trackParam: a knob drag is one event, not one per pixel.
        trackParam(
          target.data.defType,
          key,
          value,
          NODE_DEFS[target.data.defType]?.params.find((spec) => spec.key === key),
        );
      }
    },
    setBypass(id, bypass) {
      set({
        nodes: get().nodes.map((node) =>
          node.id === id ? { ...node, data: { ...node.data, bypass } } : node,
        ),
      });
      appLog("info", id, bypass ? "bypass on" : "bypass off");
      track("node_bypass", {
        node_type: get().nodes.find((node) => node.id === id)?.data.defType ?? null,
        bypass,
      });
    },
    setDebug(id, debug) {
      set({
        nodes: get().nodes.map((node) =>
          node.id === id ? { ...node, data: { ...node.data, debug } } : node,
        ),
      });
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
        if (next.status === "error") {
          // Denied camera, a model that never downloaded, an unplayable file —
          // the затыки that leave the user staring at an empty output.
          track("node_error", {
            node_type: get().nodes.find((node) => node.id === id)?.data.defType ?? null,
            message: next.message ? scrub(next.message) : null,
          });
        }
      }
      if (!reportedFirstSource) {
        // Output and draw nodes never report `ready` — they own no async
        // resource and sit at `idle` for the whole session. The source going
        // ready is the moment a picture actually exists: image decoded, video
        // loaded, or camera permission granted (usually the slow one).
        const source = get().nodes.find(
          (node) =>
            NODE_DEFS[node.data.defType]?.category === "source" &&
            statuses[node.id]?.status === "ready",
        );
        if (source) {
          reportedFirstSource = true;
          track("first_source_ready", {
            node_type: source.data.defType,
            mode: typeof source.data.params.mode === "string" ? source.data.params.mode : null,
            ms_since_load: Math.round(performance.now()),
          });
        }
      }
    },
    setResolution(width, height) {
      set({ width, height });
      appLog("info", "app", `resolution ${width}×${height}`);
      track("resolution_changed", { w: width, h: height, ratio: `${width}:${height}` });
    },
    loadPatch(patch, note) {
      nodeCounter = patch.nodes.length;
      // Single-Media patches: session source type/file outranks the preset so
      // swapping demos does not drop the user's camera/footage. Multi-Media
      // patches (audio + image) keep each node's authored mode — otherwise the
      // last session mode (e.g. camera) rewrites the audio source and kills
      // analyzer / granular wires.
      const mediaCount = patch.nodes.filter((node) => node.data.defType === "source.media").length;
      const allowModeOverride = mediaCount <= 1;
      const nodes = patch.nodes.map((node) =>
        node.data.defType === "source.media"
          ? {
              ...node,
              data: {
                ...node.data,
                params: recallMediaParams(node.data.params, { allowModeOverride }),
              },
            }
          : node,
      );
      set({
        nodes,
        edges: patch.edges,
        width: patch.width,
        height: patch.height,
        published: patch.published,
        selectedId: null,
        statuses: {},
      });
      // A patch load replaces the timeline outright. Carrying keys over from the
      // previous document would bind them to whichever new node happened to reuse
      // the id — presets number their nodes the same way every time.
      useTimelineStore.getState().loadTimeline(patch.timeline ?? EMPTY_TIMELINE);
      useModulatorStore.getState().load(patch.modulators);
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
      set({ activePresetId: id, fitViewNonce: get().fitViewNonce + 1 });
      track("preset_applied", { preset: id, nodes: parsed.nodes.length });
      return true;
    },
    exportPatch() {
      const patch = serializeCurrentPatch();
      const { nodes, edges } = get();
      downloadPatch(patch);
      appLog("ok", "patch", patch.source ? `exported JSON · ${patch.source}` : "exported JSON");
      track("patch_exported", { nodes: nodes.length, edges: edges.length });
    },
    async importPatch(file) {
      try {
        const parsed = parsePatch(JSON.parse(await file.text()));
        if (!parsed) {
          appLog("error", "patch", "import failed — not a visio patch");
          track("patch_import_failed", { reason: "not a visio patch" });
          return "file does not look like a visio patch";
        }
        get().loadPatch(parsed, `imported ${file.name}`);
        writeActivePresetId(null);
        set({ activePresetId: null });
        track("patch_imported", { nodes: parsed.nodes.length, edges: parsed.edges.length });
        return null;
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed to read file";
        appLog("error", "patch", `import failed — ${message}`);
        track("patch_import_failed", { reason: scrub(message) });
        return message;
      }
    },
    resetPatch() {
      clearStorage();
      // Empty, not the template: last footage would otherwise outrank a drop,
      // and Reset is how you get back to first launch.
      forgetAllMedia();
      const fresh = emptyPatch();
      get().loadPatch(fresh, "reset to empty");
      // Installed app only — a tab cannot resize itself.
      fitAppWindowToPatch(fresh.width, fresh.height);
      track("patch_reset");
      writeActivePresetId(null);
      set({ activePresetId: null });
    },
    clearActivePreset() {
      writeActivePresetId(null);
      set({ activePresetId: null });
    },
    reapplyRememberedMedia() {
      // After IndexedDB hydrate, blob files that were stripped from the saved
      // patch need to be written back onto Media nodes.
      const mediaCount = get().nodes.filter((node) => node.data.defType === "source.media").length;
      const allowModeOverride = mediaCount <= 1;
      let changed = false;
      const nodes = get().nodes.map((node) => {
        if (node.data.defType !== "source.media") return node;
        const params = recallMediaParams(node.data.params, { allowModeOverride });
        if (params === node.data.params) return node;
        changed = true;
        return { ...node, data: { ...node.data, params } };
      });
      if (!changed) return;
      set({ nodes });
      appLog("ok", "media", "restored last opened media from disk cache");
    },
    togglePublished(path) {
      const parsed = parseParamPath(path);
      if (!parsed) return;
      const node = get().nodes.find((entry) => entry.id === parsed.nodeId);
      if (!node) return;
      const spec = NODE_DEFS[node.data.defType]?.params.find((param) => param.key === parsed.key);
      if (!spec || spec.type !== "range") return;
      const published = get().published;
      const on = published.includes(path);
      set({ published: on ? published.filter((entry) => entry !== path) : [...published, path] });
    },
  }));

  // Autosave: coalesce bursts (node dragging fires a change per mouse move) and
  // ignore status-only updates, which the engine pushes several times a second.
  let saveTimer: number | undefined;
  const scheduleSave = () => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveToStorage(serializeCurrentPatch());
    }, 400);
  };

  let savedNodes = initial.nodes;
  let savedEdges = initial.edges;
  let savedPublished = initial.published;
  store.subscribe((state) => {
    if (
      state.nodes === savedNodes &&
      state.edges === savedEdges &&
      state.published === savedPublished
    ) {
      return;
    }
    savedNodes = state.nodes;
    savedEdges = state.edges;
    savedPublished = state.published;
    scheduleSave();
  });

  // Keys and duration belong to the document too. The playhead does not — it
  // moves every frame during playback and would turn autosave into a per-frame
  // JSON stringify of the whole patch.
  let savedKeys = useTimelineStore.getState().paramKeyframes;
  let savedDuration = useTimelineStore.getState().durationInFrames;
  let savedFps = useTimelineStore.getState().fps;
  let savedReel = useTimelineStore.getState().reelZones;
  let savedCueTick = useTimelineStore.getState().cueZoneTick;
  let savedCueMetro = useTimelineStore.getState().cueDevMetronome;
  let savedCueDrone = useTimelineStore.getState().cueDrone;
  let savedBpm = useTimelineStore.getState().developmentBpm;
  let savedDroneParams = useTimelineStore.getState().droneByZone;
  useTimelineStore.subscribe((state) => {
    if (
      state.paramKeyframes === savedKeys &&
      state.durationInFrames === savedDuration &&
      state.fps === savedFps &&
      state.reelZones === savedReel &&
      state.cueZoneTick === savedCueTick &&
      state.cueDevMetronome === savedCueMetro &&
      state.cueDrone === savedCueDrone &&
      state.developmentBpm === savedBpm &&
      state.droneByZone === savedDroneParams
    ) {
      return;
    }
    savedKeys = state.paramKeyframes;
    savedDuration = state.durationInFrames;
    savedFps = state.fps;
    savedReel = state.reelZones;
    savedCueTick = state.cueZoneTick;
    savedCueMetro = state.cueDevMetronome;
    savedCueDrone = state.cueDrone;
    savedBpm = state.developmentBpm;
    savedDroneParams = state.droneByZone;
    scheduleSave();
  });

  let savedModulators = useModulatorStore.getState().byPath;
  useModulatorStore.subscribe((state) => {
    if (state.byPath === savedModulators) return;
    savedModulators = state.byPath;
    scheduleSave();
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

/** Snapshot of the open document — export, autosave, presets, render sidecar. */
export function serializeCurrentPatch() {
  const { nodes, edges, width, height, published } = useGraphStore.getState();
  return serializePatch(
    nodes,
    edges,
    width,
    height,
    currentTimeline(),
    useModulatorStore.getState().byPath,
    published,
  );
}

