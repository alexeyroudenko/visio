import { DEFAULT_IMAGE_FILE } from "../nodes/shared/fileParam";
import type { SerializedPatch } from "../store/persistence";

export interface PatchPreset {
  id: string;
  label: string;
  description: string;
  /** Built-in presets cannot be removed from the list. */
  builtin?: boolean;
  build: () => SerializedPatch;
}

const USER_PRESETS_KEY = "visio.userPresets.v1";
const W = 1080;
const H = 1920;

interface StoredUserPreset {
  id: string;
  label: string;
  description: string;
  patch: SerializedPatch;
}

type SourceKind = "camera" | "image";

/** Camera/image → tracker → draw overlay → output. */
function trackingViz(opts: {
  source: SourceKind;
  trackType: string;
  trackId: string;
  drawType: string;
  drawId: string;
  /** Draw input handle that receives the tracker output. */
  drawHandle: string;
}): SerializedPatch {
  const sourceId = opts.source === "camera" ? "camera-1" : "image-1";
  const sourceParams =
    opts.source === "image"
      ? { mode: "image", file: DEFAULT_IMAGE_FILE, mirror: false, fit: "cover" }
      : { mode: "camera", mirror: true, fit: "cover" };

  return {
    format: 1,
    width: W,
    height: H,
    nodes: [
      {
        id: sourceId,
        type: "source.media",
        position: { x: 0, y: 140 },
        params: sourceParams,
      },
      {
        id: opts.trackId,
        type: opts.trackType,
        position: { x: 320, y: 40 },
        params: {},
      },
      {
        id: opts.drawId,
        type: opts.drawType,
        position: { x: 640, y: 140 },
        params: {},
      },
      {
        id: "screen-1",
        type: "output.screen",
        position: { x: 960, y: 180 },
        params: { background: "#000000" },
      },
    ],
    edges: [
      {
        id: "e-frame",
        source: sourceId,
        sourceHandle: "frame",
        target: opts.trackId,
        targetHandle: "frame",
      },
      {
        id: "e-bg",
        source: sourceId,
        sourceHandle: "out",
        target: opts.drawId,
        targetHandle: "bg",
      },
      {
        id: "e-data",
        source: opts.trackId,
        sourceHandle: "out",
        target: opts.drawId,
        targetHandle: opts.drawHandle,
      },
      {
        id: "e-out",
        source: opts.drawId,
        sourceHandle: "out",
        target: "screen-1",
        targetHandle: "src",
      },
    ],
  };
}

/** Image → Slice Shift → Output (from exported patch 2026-07-29). */
function imageSliceShift(): SerializedPatch {
  return {
    format: 1,
    width: W,
    height: H,
    nodes: [
      {
        id: "image-1",
        type: "source.media",
        position: { x: 246.78, y: 120 },
        params: { mode: "image", file: DEFAULT_IMAGE_FILE, mirror: false, fit: "cover" },
      },
      {
        id: "sliceShift-6",
        type: "fx.sliceShift",
        position: { x: 537.29, y: 118.74 },
        params: { count: 113, maxH: 70, amount: 9, animate: true, seed: 0 },
      },
      {
        id: "screen-1",
        type: "output.screen",
        position: { x: 934.83, y: 117.37 },
        params: { background: "#000000" },
      },
    ],
    edges: [
      {
        id: "e1",
        source: "image-1",
        sourceHandle: "out",
        target: "sliceShift-6",
        targetHandle: "src",
      },
      {
        id: "e2",
        source: "sliceShift-6",
        sourceHandle: "out",
        target: "screen-1",
        targetHandle: "src",
      },
    ],
  };
}

function objectsFeedback(): SerializedPatch {
  return {
    format: 1,
    width: W,
    height: H,
    nodes: [
      {
        id: "image-1",
        type: "source.media",
        position: { x: 0, y: 120 },
        params: { mode: "image", file: DEFAULT_IMAGE_FILE, mirror: false, fit: "cover" },
      },
      {
        id: "objects-1",
        type: "tracking.objects",
        position: { x: 300, y: 40 },
        params: {},
      },
      {
        id: "boxes-1",
        type: "draw.boxes",
        position: { x: 620, y: 120 },
        params: {},
      },
      {
        id: "feedback-1",
        type: "fx.feedback",
        position: { x: 940, y: 160 },
        params: {},
      },
      {
        id: "screen-1",
        type: "output.screen",
        position: { x: 1240, y: 200 },
        params: {},
      },
    ],
    edges: [
      {
        id: "e1",
        source: "image-1",
        sourceHandle: "frame",
        target: "objects-1",
        targetHandle: "frame",
      },
      {
        id: "e2",
        source: "image-1",
        sourceHandle: "out",
        target: "boxes-1",
        targetHandle: "bg",
      },
      {
        id: "e3",
        source: "objects-1",
        sourceHandle: "out",
        target: "boxes-1",
        targetHandle: "boxes",
      },
      {
        id: "e4",
        source: "boxes-1",
        sourceHandle: "out",
        target: "feedback-1",
        targetHandle: "src",
      },
      {
        id: "e5",
        source: "feedback-1",
        sourceHandle: "out",
        target: "screen-1",
        targetHandle: "src",
      },
    ],
  };
}

/** Pose → skeleton + landmarks→points → Features Grid (saved from live session). */
function poseFeaturesGrid(): SerializedPatch {
  return {
    format: 1,
    width: W,
    height: H,
    nodes: [
      {
        id: "camera-1",
        type: "source.media",
        position: { x: 0, y: 140 },
        params: {
          mode: "image",
          file: DEFAULT_IMAGE_FILE,
          mirror: false,
          fit: "cover",
        },
      },
      {
        id: "pose-1",
        type: "tracking.pose",
        position: { x: 320, y: -10 },
        params: { confidence: 0.5, interval: 1, model: "lite", numPoses: 1 },
      },
      {
        id: "landmarks-1",
        type: "draw.landmarks",
        position: { x: 640, y: 140 },
        params: {
          blend: "normal",
          boneColor: "#7fe3c0",
          boneWidth: 1,
          opacity: 0.2,
          pointColor: "#f5f0e6",
          pointSize: 0,
          scoreFade: true,
        },
      },
      {
        id: "landmarksToPoints-5",
        type: "convert.landmarksToPoints",
        position: { x: 630, y: -52 },
        params: { minScore: 0.2, subject: -1 },
      },
      {
        id: "featuresGrid-6",
        type: "draw.featuresGrid",
        position: { x: 878, y: 57 },
        params: {
          color: "#f5f0e6",
          maxDepth: 8,
          minSize: 52,
          stroke: 1,
          opacity: 1,
          labels: false,
          labelSize: 11,
          labelText: "Element",
          effectChance: 1,
          effectMinArea: 0,
          effectMaxArea: 0.15,
          effectSeed: 0,
        },
      },
      {
        id: "screen-1",
        type: "output.screen",
        position: { x: 1147, y: 78 },
        params: { background: "#000000" },
      },
    ],
    edges: [
      {
        id: "e-frame",
        source: "camera-1",
        sourceHandle: "frame",
        target: "pose-1",
        targetHandle: "frame",
      },
      {
        id: "e-bg",
        source: "camera-1",
        sourceHandle: "out",
        target: "landmarks-1",
        targetHandle: "bg",
      },
      {
        id: "e-data",
        source: "pose-1",
        sourceHandle: "out",
        target: "landmarks-1",
        targetHandle: "landmarks",
      },
      {
        id: "e-l2p",
        source: "pose-1",
        sourceHandle: "out",
        target: "landmarksToPoints-5",
        targetHandle: "landmarks",
      },
      {
        id: "e-points",
        source: "landmarksToPoints-5",
        sourceHandle: "points",
        target: "featuresGrid-6",
        targetHandle: "points",
      },
      {
        id: "e-grid-bg",
        source: "landmarks-1",
        sourceHandle: "out",
        target: "featuresGrid-6",
        targetHandle: "bg",
      },
      {
        id: "e-out",
        source: "featuresGrid-6",
        sourceHandle: "out",
        target: "screen-1",
        targetHandle: "src",
      },
    ],
  };
}

export const DEFAULT_PRESET_ID = "image-slice-shift";

export const BUILTIN_PRESETS: PatchPreset[] = [
  {
    id: DEFAULT_PRESET_ID,
    label: "Image + Slice Shift",
    description: "Default image → slice shift → output (1080×1920)",
    builtin: true,
    build: imageSliceShift,
  },
  {
    id: "track-pose",
    label: "Pose + Skeleton",
    description: "Camera → Pose → Draw Skeleton → output",
    builtin: true,
    build: () =>
      trackingViz({
        source: "camera",
        trackType: "tracking.pose",
        trackId: "pose-1",
        drawType: "draw.landmarks",
        drawId: "landmarks-1",
        drawHandle: "landmarks",
      }),
  },
  {
    id: "track-hands",
    label: "Hands + Skeleton",
    description: "Camera → Hands → Draw Skeleton → output",
    builtin: true,
    build: () =>
      trackingViz({
        source: "camera",
        trackType: "tracking.hands",
        trackId: "hands-1",
        drawType: "draw.landmarks",
        drawId: "landmarks-1",
        drawHandle: "landmarks",
      }),
  },
  {
    id: "track-face",
    label: "Face Mesh + Skeleton",
    description: "Camera → Face Mesh → Draw Skeleton → output",
    builtin: true,
    build: () =>
      trackingViz({
        source: "camera",
        trackType: "tracking.face",
        trackId: "face-1",
        drawType: "draw.landmarks",
        drawId: "landmarks-1",
        drawHandle: "landmarks",
      }),
  },
  {
    id: "track-objects",
    label: "Objects + Boxes",
    description: "Image → Object detection → Draw Boxes → output",
    builtin: true,
    build: () =>
      trackingViz({
        source: "image",
        trackType: "tracking.objects",
        trackId: "objects-1",
        drawType: "draw.boxes",
        drawId: "boxes-1",
        drawHandle: "boxes",
      }),
  },
  {
    id: "objects-feedback",
    label: "Objects + Feedback",
    description: "Image → object boxes → feedback trail (1080×1920)",
    builtin: true,
    build: objectsFeedback,
  },
  {
    id: "track-features",
    label: "Features + Grid",
    description: "Image → Feature points → Features Grid → output",
    builtin: true,
    build: () =>
      trackingViz({
        source: "image",
        trackType: "tracking.features",
        trackId: "features-1",
        drawType: "draw.featuresGrid",
        drawId: "featuresGrid-1",
        drawHandle: "points",
      }),
  },
  {
    id: "pose-features-grid",
    label: "Pose + Features Grid",
    description:
      "Media → Pose → skeleton + Points → Features Grid (effect on small cells)",
    builtin: true,
    build: poseFeaturesGrid,
  },
  {
    id: "track-features-points",
    label: "Features + Points",
    description: "Image → Feature points → Draw Points → output",
    builtin: true,
    build: () =>
      trackingViz({
        source: "image",
        trackType: "tracking.features",
        trackId: "features-1",
        drawType: "draw.points",
        drawId: "points-1",
        drawHandle: "points",
      }),
  },
  {
    id: "track-hough-circles",
    label: "Hough Circles",
    description: "Image → Hough Circles → Draw Circles → output",
    builtin: true,
    build: () =>
      trackingViz({
        source: "image",
        trackType: "tracking.circles",
        trackId: "circles-1",
        drawType: "draw.circles",
        drawId: "drawCircles-1",
        drawHandle: "circles",
      }),
  },
  {
    id: "track-hough-lines",
    label: "Hough Lines",
    description: "Image → Hough Lines → Draw Lines → output",
    builtin: true,
    build: () =>
      trackingViz({
        source: "image",
        trackType: "tracking.lines",
        trackId: "lines-1",
        drawType: "draw.lines",
        drawId: "drawLines-1",
        drawHandle: "lines",
      }),
  },
];

/** @deprecated use listPresets() — kept for callers that expect a static list. */
export const PRESETS = BUILTIN_PRESETS;

function readStored(): StoredUserPreset[] {
  try {
    const raw = localStorage.getItem(USER_PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is StoredUserPreset =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as StoredUserPreset).id === "string" &&
        typeof (entry as StoredUserPreset).label === "string" &&
        !!(entry as StoredUserPreset).patch,
    );
  } catch {
    return [];
  }
}

function writeStored(entries: StoredUserPreset[]): void {
  localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(entries));
}

function toPreset(entry: StoredUserPreset): PatchPreset {
  return {
    id: entry.id,
    label: entry.label,
    description: entry.description,
    builtin: false,
    build: () => structuredClone(entry.patch),
  };
}

export function listPresets(): PatchPreset[] {
  return [...BUILTIN_PRESETS, ...readStored().map(toPreset)];
}

export function getPreset(id: string): PatchPreset | undefined {
  return listPresets().find((preset) => preset.id === id);
}

/** Persist the current graph as a user preset; returns the new preset id. */
export function addUserPreset(label: string, patch: SerializedPatch): string {
  const id = `user-${Date.now().toString(36)}`;
  const entry: StoredUserPreset = {
    id,
    label: label.trim() || "Untitled",
    description: `Saved ${new Date().toLocaleString()}`,
    patch: structuredClone(patch),
  };
  writeStored([...readStored(), entry]);
  return id;
}

export function removeUserPreset(id: string): boolean {
  const prev = readStored();
  const next = prev.filter((entry) => entry.id !== id);
  if (next.length === prev.length) return false;
  writeStored(next);
  return true;
}
