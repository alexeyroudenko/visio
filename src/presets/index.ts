import { SHADER_PRESETS } from "../nodes/fx/shaderPresets";
import {
  DEFAULT_AUDIO_FILE,
  DEFAULT_IMAGE_FILE,
  FACE_IMAGE_FILE,
  POSE_IMAGE_FILE,
  type FileParam,
} from "../nodes/shared/fileParam";
import type { SerializedPatch } from "../store/persistence";
import { trackNoiseGlitch } from "./trackNoiseGlitch";
import { particlesFeedback } from "./particlesFeedback";
import { particlesFeedbackCloseup } from "./particlesFeedbackCloseup";
import { noiseElementGrid } from "./noiseElementGrid";
import { pixelSortStart } from "./pixelSortStart";
import { datamosh } from "./datamosh";
import { genMotionMosh } from "./genMotionMosh";
import { skeletonGrid } from "./skeletonGrid";
import { isOmitted } from "./ship";
import { builtinOverride } from "./saveBuiltin";

export interface PatchPreset {
  id: string;
  label: string;
  description: string;
  /** Built-in presets cannot be removed from the list. */
  builtin?: boolean;
  /** Thumbnail under `public/presets/` (shown in the presets picker). */
  preview?: string;
  build: () => SerializedPatch;
}

/** Default preview path for a builtin preset id. */
export function builtinPreviewUrl(id: string): string {
  return `presets/${id}.jpg`;
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
  /** Still to load in image mode; defaults to the bundled starter frame. */
  sourceFile?: FileParam;
  trackType: string;
  trackId: string;
  /** Tracker params that differ from the node defaults. */
  trackParams?: Record<string, unknown>;
  drawType: string;
  drawId: string;
  /** Draw input handle that receives the tracker output. */
  drawHandle: string;
  /** Draw params that differ from the node defaults. */
  drawParams?: Record<string, unknown>;
}): SerializedPatch {
  const sourceId = opts.source === "camera" ? "camera-1" : "image-1";
  const sourceParams =
    opts.source === "image"
      ? { mode: "image", file: opts.sourceFile ?? DEFAULT_IMAGE_FILE, mirror: false, fit: "cover" }
      : { mode: "camera", facing: "environment", mirror: false, fit: "cover" };

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
        params: { ...opts.trackParams },
      },
      {
        id: opts.drawId,
        type: opts.drawType,
        position: { x: 640, y: 140 },
        params: { ...opts.drawParams },
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

/**
 * Still → Image Segmenter → output: the mask itself is the picture, white on
 * the picked class. Nothing is composited over it on purpose — this is the
 * shape other nodes want as an input.
 */
function segmentationMask(): SerializedPatch {
  return {
    format: 1,
    width: W,
    height: H,
    nodes: [
      {
        id: "image-1",
        type: "source.media",
        position: { x: 0, y: 140 },
        params: { mode: "image", file: POSE_IMAGE_FILE, mirror: false, fit: "cover", zoom: 1 },
      },
      {
        id: "segment-1",
        type: "tracking.segment",
        position: { x: 360, y: 120 },
        params: {
          model: "selfie",
          category: "person",
          size: "256",
          threshold: 0.5,
          soft: 0.05,
          invert: false,
          interval: 2,
        },
      },
      {
        id: "screen-1",
        type: "output.screen",
        position: { x: 720, y: 160 },
        params: { background: "#000000" },
      },
    ],
    edges: [
      {
        id: "e-frame",
        source: "image-1",
        sourceHandle: "frame",
        target: "segment-1",
        targetHandle: "frame",
      },
      {
        id: "e-out",
        source: "segment-1",
        sourceHandle: "out",
        target: "screen-1",
        targetHandle: "src",
      },
    ],
  };
}

const IMAGE_SOURCE = {
  id: "image-1",
  type: "source.media",
  position: { x: 0, y: 140 },
  params: { mode: "image", file: DEFAULT_IMAGE_FILE, mirror: false, fit: "cover", zoom: 1 },
};

const SCREEN = {
  id: "screen-1",
  type: "output.screen",
  position: { x: 960, y: 160 },
  params: { background: "#000000" },
};

/**
 * Image → a straight run of texture nodes → output. Covers every effect whose
 * only input is the frame before it, which is most of them.
 */
function imageChain(
  stages: {
    id: string;
    type: string;
    params: Record<string, unknown>;
    /** Texture input name — fx nodes call it `src`, draw nodes call it `bg`. */
    input?: string;
  }[],
  extra?: Partial<SerializedPatch>,
): SerializedPatch {
  const nodes = [
    IMAGE_SOURCE,
    ...stages.map((stage, i) => ({
      id: stage.id,
      type: stage.type,
      position: { x: 320 + i * 300, y: 140 },
      params: stage.params,
    })),
    { ...SCREEN, position: { x: 320 + stages.length * 300, y: 160 } },
  ];

  const chain = ["image-1", ...stages.map((s) => s.id), "screen-1"];
  const inputOf = new Map(stages.map((s) => [s.id, s.input ?? "src"]));
  const edges = chain.slice(0, -1).map((source, i) => {
    const target = chain[i + 1]!;
    return {
      id: `e${i}`,
      source,
      sourceHandle: "out",
      target,
      targetHandle: inputOf.get(target) ?? "src",
    };
  });

  return { format: 1, width: W, height: H, nodes, edges, ...extra };
}

/** Image → Corners → a draw node that eats points. */
function pointsChain(
  drawId: string,
  drawType: string,
  drawParams: Record<string, unknown>,
): SerializedPatch {
  return {
    format: 1,
    width: W,
    height: H,
    nodes: [
      IMAGE_SOURCE,
      {
        id: "features-1",
        type: "tracking.features",
        position: { x: 320, y: 20 },
        params: {},
      },
      { id: drawId, type: drawType, position: { x: 640, y: 140 }, params: drawParams },
      SCREEN,
    ],
    edges: [
      { id: "e-frame", source: "image-1", sourceHandle: "frame", target: "features-1", targetHandle: "frame" },
      { id: "e-bg", source: "image-1", sourceHandle: "out", target: drawId, targetHandle: "bg" },
      { id: "e-pts", source: "features-1", sourceHandle: "out", target: drawId, targetHandle: "points" },
      { id: "e-out", source: drawId, sourceHandle: "out", target: "screen-1", targetHandle: "src" },
    ],
  };
}

/**
 * Corners → Features Grid, tuned rather than left on defaults: the grid splits
 * on the corner cloud, small cells get the smear, and the frame is wired in so
 * `Use content edge` has a mask to trim against.
 */
function cornersFeaturesGrid(): SerializedPatch {
  return {
    format: 1,
    width: W,
    height: H,
    nodes: [
      IMAGE_SOURCE,
      {
        id: "features-1",
        type: "tracking.features",
        position: { x: 320, y: 20 },
        params: { downscale: 3, block: 7, maxCorners: 180, quality: 0.03, minDistance: 18 },
      },
      {
        id: "featuresGrid-1",
        type: "draw.featuresGrid",
        position: { x: 660, y: 140 },
        params: {
          color: "#f5f0e6",
          maxDepth: 7,
          minSize: 56,
          stroke: 1,
          opacity: 1,
          labels: false,
          labelSize: 11,
          labelText: "Element",
          effectChance: 1,
          effectMinArea: 0,
          effectMaxArea: 0.18,
          effectSeed: 3,
          useContentEdge: true,
          edgeInterval: 3,
        },
      },
      { ...SCREEN, position: { x: 1000, y: 160 } },
    ],
    edges: [
      { id: "e-frame", source: "image-1", sourceHandle: "frame", target: "features-1", targetHandle: "frame" },
      { id: "e-bg", source: "image-1", sourceHandle: "out", target: "featuresGrid-1", targetHandle: "bg" },
      { id: "e-pts", source: "features-1", sourceHandle: "out", target: "featuresGrid-1", targetHandle: "points" },
      // The mask path: without a frame the content edge falls back to a readback.
      { id: "e-mask", source: "image-1", sourceHandle: "frame", target: "featuresGrid-1", targetHandle: "frame" },
      { id: "e-out", source: "featuresGrid-1", sourceHandle: "out", target: "screen-1", targetHandle: "src" },
    ],
  };
}

/**
 * Features Tracking — Shi–Tomasi + PyrLK motion lines
 * (https://alexeyroudenko.net/ru/projects/features-tracking/).
 * Image starter; switch Media to camera/video for live motion trails.
 */
function featuresTracking(): SerializedPatch {
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
        id: "featuresTrack-1",
        type: "tracking.featuresTrack",
        position: { x: 320, y: 40 },
        params: {
          downscale: 4,
          maxCorners: 120,
          quality: 0.08,
          minDistance: 14,
          winSize: 15,
          maxLevel: 2,
          minAge: 50,
          maxTrail: 64,
          maxTracks: 150,
          detectInterval: 5,
          fbError: 2,
        },
      },
      {
        id: "drawLines-1",
        type: "draw.lines",
        position: { x: 640, y: 140 },
        params: {
          color: "#f5f0e6",
          width: 1.5,
          extend: 1,
          opacity: 0.95,
          scoreFade: true,
          endpoints: false,
          blend: "normal",
        },
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
        source: "camera-1",
        sourceHandle: "frame",
        target: "featuresTrack-1",
        targetHandle: "frame",
      },
      {
        id: "e-bg",
        source: "camera-1",
        sourceHandle: "out",
        target: "drawLines-1",
        targetHandle: "bg",
      },
      {
        id: "e-lines",
        source: "featuresTrack-1",
        sourceHandle: "out",
        target: "drawLines-1",
        targetHandle: "lines",
      },
      {
        id: "e-out",
        source: "drawLines-1",
        sourceHandle: "out",
        target: "screen-1",
        targetHandle: "src",
      },
    ],
  };
}

/** Points Noise → Features Grid: a moving grid with no tracker in the patch. */
function noiseGrid(): SerializedPatch {
  return {
    format: 1,
    width: W,
    height: H,
    nodes: [
      IMAGE_SOURCE,
      {
        id: "pointsNoise-1",
        type: "generate.pointsNoise",
        position: { x: 320, y: 20 },
        params: {
          count: 120,
          layout: "random",
          frequency: 2.5,
          octaves: 2,
          amount: 0.25,
          animate: true,
          speed: 0.35,
          driftX: 0.02,
          driftY: 0,
          edges: "wrap",
          size: 0.7,
          sizeNoise: 0.4,
          seed: 11,
        },
      },
      {
        id: "featuresGrid-1",
        type: "draw.featuresGrid",
        position: { x: 660, y: 140 },
        params: {
          color: "#f5f0e6",
          maxDepth: 6,
          minSize: 72,
          stroke: 1,
          opacity: 1,
          labels: true,
          labelSize: 11,
          labelText: "Element",
          effectChance: 1,
          effectMinArea: 0,
          effectMaxArea: 0.2,
          effectSeed: 5,
        },
      },
      { ...SCREEN, position: { x: 1000, y: 160 } },
    ],
    edges: [
      { id: "e-bg", source: "image-1", sourceHandle: "out", target: "featuresGrid-1", targetHandle: "bg" },
      { id: "e-pts", source: "pointsNoise-1", sourceHandle: "out", target: "featuresGrid-1", targetHandle: "points" },
      { id: "e-out", source: "featuresGrid-1", sourceHandle: "out", target: "screen-1", targetHandle: "src" },
    ],
  };
}

/**
 * Default audio → Analyzer (RMS) soft-bound to Points Noise displacement →
 * Features Grid. Audio plays free-running; analyzer binding follows the playhead.
 */
function audioAnalyzerNoise(): SerializedPatch {
  return {
    format: 1,
    width: W,
    height: H,
    nodes: [
      {
        id: "audio-1",
        type: "source.media",
        position: { x: 0, y: 40 },
        params: {
          mode: "audio",
          file: DEFAULT_AUDIO_FILE,
          playing: true,
          muted: true,
          volume: 1,
          speed: 1,
          syncTimeline: false,
          mirror: false,
          fit: "cover",
        },
      },
      {
        id: "analyzer-1",
        type: "audio.analyzer",
        position: { x: 300, y: 20 },
        params: {
          outLow: 0,
          outMid: 0,
          outHigh: 0,
          lowLoHz: 20,
          lowHiHz: 200,
          midLoHz: 200,
          midHiHz: 2000,
          highLoHz: 2000,
          highHiHz: 8000,
          gain: 2.5,
          smoothing: 0.35,
          binds: [
            {
              id: "b-bass-disp",
              band: "low",
              targetNode: "pointsNoise-1",
              targetParam: "amount",
              depth: 1,
            },
          ],
        },
      },
      {
        id: "image-1",
        type: "source.media",
        position: { x: 0, y: 280 },
        params: { mode: "image", file: DEFAULT_IMAGE_FILE, mirror: false, fit: "cover", zoom: 1 },
      },
      {
        id: "pointsNoise-1",
        type: "generate.pointsNoise",
        position: { x: 300, y: 280 },
        params: {
          count: 140,
          layout: "random",
          frequency: 2.8,
          octaves: 2,
          amount: 0.05,
          animate: true,
          speed: 0.3,
          driftX: 0.015,
          driftY: 0,
          edges: "wrap",
          size: 0.75,
          sizeNoise: 0.35,
          seed: 7,
        },
      },
      {
        id: "featuresGrid-1",
        type: "draw.featuresGrid",
        position: { x: 640, y: 260 },
        params: {
          color: "#f5f0e6",
          maxDepth: 6,
          minSize: 64,
          stroke: 1,
          opacity: 1,
          labels: true,
          labelSize: 11,
          labelText: "Element",
          effectChance: 1,
          effectMinArea: 0,
          effectMaxArea: 0.22,
          effectSeed: 5,
        },
      },
      { ...SCREEN, position: { x: 980, y: 280 } },
    ],
    edges: [
      {
        id: "e-audio",
        source: "audio-1",
        sourceHandle: "audio",
        target: "analyzer-1",
        targetHandle: "audio",
      },
      {
        id: "e-bg",
        source: "image-1",
        sourceHandle: "out",
        target: "featuresGrid-1",
        targetHandle: "bg",
      },
      {
        id: "e-pts",
        source: "pointsNoise-1",
        sourceHandle: "out",
        target: "featuresGrid-1",
        targetHandle: "points",
      },
      {
        id: "e-out",
        source: "featuresGrid-1",
        sourceHandle: "out",
        target: "screen-1",
        targetHandle: "src",
      },
    ],
  };
}

/**
 * Corners → Points Noise (displacement from Analyzer RMS) → Features Grid.
 * Default still + default track; analyzer soft-binds to Noise Displacement.
 */
function audioNoiseGrid(): SerializedPatch {
  return {
    format: 1,
    width: W,
    height: H,
    nodes: [
      {
        id: "audio-1",
        type: "source.media",
        position: { x: 0, y: 0 },
        params: {
          mode: "audio",
          file: DEFAULT_AUDIO_FILE,
          playing: true,
          muted: true,
          volume: 1,
          speed: 1,
          syncTimeline: false,
          mirror: false,
          fit: "cover",
        },
      },
      {
        id: "analyzer-1",
        type: "audio.analyzer",
        position: { x: 300, y: 0 },
        params: {
          outLow: 0,
          outMid: 0,
          outHigh: 0,
          lowLoHz: 20,
          lowHiHz: 200,
          midLoHz: 200,
          midHiHz: 2000,
          highLoHz: 2000,
          highHiHz: 8000,
          gain: 2.5,
          smoothing: 0.35,
          binds: [
            {
              id: "b-bass-disp",
              band: "low",
              targetNode: "pointsNoise-1",
              targetParam: "amount",
              depth: 1,
            },
          ],
        },
      },
      {
        id: "image-1",
        type: "source.media",
        position: { x: 0, y: 260 },
        params: { mode: "image", file: DEFAULT_IMAGE_FILE, mirror: false, fit: "cover", zoom: 1 },
      },
      {
        id: "features-1",
        type: "tracking.features",
        position: { x: 300, y: 260 },
        params: { downscale: 3, block: 7, maxCorners: 180, quality: 0.03, minDistance: 18 },
      },
      {
        id: "pointsNoise-1",
        type: "generate.pointsNoise",
        position: { x: 620, y: 240 },
        params: {
          count: 160,
          layout: "random",
          frequency: 2.8,
          octaves: 2,
          amount: 0.05,
          animate: true,
          speed: 0.3,
          driftX: 0.01,
          driftY: 0,
          edges: "clamp",
          size: 0.75,
          sizeNoise: 0.3,
          seed: 7,
        },
      },
      {
        id: "featuresGrid-1",
        type: "draw.featuresGrid",
        position: { x: 940, y: 260 },
        params: {
          color: "#f5f0e6",
          maxDepth: 7,
          minSize: 56,
          stroke: 1,
          opacity: 1,
          labels: false,
          labelSize: 11,
          labelText: "Element",
          effectChance: 1,
          effectMinArea: 0,
          effectMaxArea: 0.18,
          effectSeed: 3,
          useContentEdge: true,
          edgeInterval: 3,
        },
      },
      { ...SCREEN, position: { x: 1260, y: 280 } },
    ],
    edges: [
      {
        id: "e-audio",
        source: "audio-1",
        sourceHandle: "audio",
        target: "analyzer-1",
        targetHandle: "audio",
      },
      {
        id: "e-frame",
        source: "image-1",
        sourceHandle: "frame",
        target: "features-1",
        targetHandle: "frame",
      },
      {
        id: "e-corners",
        source: "features-1",
        sourceHandle: "out",
        target: "pointsNoise-1",
        targetHandle: "points",
      },
      {
        id: "e-bg",
        source: "image-1",
        sourceHandle: "out",
        target: "featuresGrid-1",
        targetHandle: "bg",
      },
      {
        id: "e-mask",
        source: "image-1",
        sourceHandle: "frame",
        target: "featuresGrid-1",
        targetHandle: "frame",
      },
      {
        id: "e-pts",
        source: "pointsNoise-1",
        sourceHandle: "out",
        target: "featuresGrid-1",
        targetHandle: "points",
      },
      {
        id: "e-out",
        source: "featuresGrid-1",
        sourceHandle: "out",
        target: "screen-1",
        targetHandle: "src",
      },
    ],
  };
}

/**
 * Features Grid (+ Granular): starts on the default still so the graph shows
 * something; drop a video with audio on Media when you want grains.
 */
function granularGrid(): SerializedPatch {
  return {
    format: 1,
    width: W,
    height: H,
    nodes: [
      {
        id: "video-1",
        type: "source.media",
        position: { x: 0, y: 140 },
        params: {
          mode: "image",
          file: DEFAULT_IMAGE_FILE,
          muted: true,
          mirror: false,
          fit: "cover",
        },
      },
      {
        id: "features-1",
        type: "tracking.features",
        position: { x: 320, y: 20 },
        params: { downscale: 3, block: 7, maxCorners: 140, quality: 0.04, minDistance: 22 },
      },
      {
        id: "featuresGrid-1",
        type: "draw.featuresGrid",
        position: { x: 660, y: 140 },
        params: {
          color: "#f5f0e6",
          maxDepth: 6,
          minSize: 80,
          stroke: 1,
          opacity: 1,
          labels: false,
          effectChance: 0,
          // Steadier cells mean steadier voices: a cell has to really go away
          // before its grain is released.
          rectMatch: 0.3,
          rectHold: 6,
        },
      },
      {
        id: "granular-1",
        type: "audio.granular",
        position: { x: 1000, y: 420 },
        params: {
          playing: true,
          grains: 0.7,
          source: 0,
          grainMs: 320,
          crossfadeMs: 40,
          maxVoices: 8,
          minScale: 0.04,
          posMode: "playhead",
          cutoffLow: 260,
          cutoffHigh: 9000,
          sizeMin: 0.06,
          sizeMax: 0.55,
          pan: 0.7,
          attackMs: 120,
          releaseMs: 400,
        },
      },
      { ...SCREEN, position: { x: 1000, y: 160 } },
    ],
    edges: [
      { id: "e-frame", source: "video-1", sourceHandle: "frame", target: "features-1", targetHandle: "frame" },
      { id: "e-bg", source: "video-1", sourceHandle: "out", target: "featuresGrid-1", targetHandle: "bg" },
      { id: "e-pts", source: "features-1", sourceHandle: "out", target: "featuresGrid-1", targetHandle: "points" },
      { id: "e-out", source: "featuresGrid-1", sourceHandle: "out", target: "screen-1", targetHandle: "src" },
      { id: "e-audio", source: "video-1", sourceHandle: "audio", target: "granular-1", targetHandle: "audio" },
      { id: "e-rects", source: "featuresGrid-1", sourceHandle: "rects", target: "granular-1", targetHandle: "rects" },
    ],
  };
}

/** One image down two paths, recombined — the only shape that exercises Blend. */
function blendSplit(): SerializedPatch {
  return {
    format: 1,
    width: W,
    height: H,
    nodes: [
      IMAGE_SOURCE,
      {
        id: "color-1",
        type: "fx.color",
        position: { x: 320, y: 20 },
        params: { brightness: -0.1, contrast: 1.4, saturation: 0, hue: 0 },
      },
      {
        id: "blockScatter-1",
        type: "fx.blockScatter",
        position: { x: 320, y: 280 },
        params: { count: 140, size: 220, spread: 40, tint: 60, seed: 1234, drift: 4 },
      },
      {
        id: "blend-1",
        type: "fx.blend",
        position: { x: 640, y: 150 },
        params: { mode: "screen", opacity: 0.85 },
      },
      SCREEN,
    ],
    edges: [
      { id: "e-a", source: "image-1", sourceHandle: "out", target: "color-1", targetHandle: "src" },
      { id: "e-b", source: "image-1", sourceHandle: "out", target: "blockScatter-1", targetHandle: "src" },
      { id: "e-base", source: "color-1", sourceHandle: "out", target: "blend-1", targetHandle: "base" },
      { id: "e-top", source: "blockScatter-1", sourceHandle: "out", target: "blend-1", targetHandle: "top" },
      { id: "e-out", source: "blend-1", sourceHandle: "out", target: "screen-1", targetHandle: "src" },
    ],
  };
}

/** What “use template” on the empty screen loads. */
export const DEFAULT_PRESET_ID = "pixel-sort-start";

/** Noise TOP → Output — animated monochrome field. */
function noiseField(): SerializedPatch {
  return {
    format: 1,
    width: W,
    height: H,
    nodes: [
      {
        id: "noise-1",
        type: "source.noise",
        position: { x: 0, y: 140 },
        params: {
          seed: 1,
          period: 0.4,
          harmonics: 2,
          harmonicSpread: 2,
          harmonicGain: 0.7,
          exponent: 1.2,
          amplitude: 0.5,
          offset: 0.5,
          monochrome: true,
          translateX: 0,
          translateY: 0,
          translateZ: 0,
          speed: 0.2,
        },
      },
      { ...SCREEN, position: { x: 360, y: 160 } },
    ],
    edges: [
      { id: "e-out", source: "noise-1", sourceHandle: "out", target: "screen-1", targetHandle: "src" },
    ],
  };
}

/** Noise → Threshold → Output — keep only bright islands. */
function noiseThreshold(): SerializedPatch {
  return {
    format: 1,
    width: W,
    height: H,
    nodes: [
      {
        id: "noise-1",
        type: "source.noise",
        position: { x: 0, y: 140 },
        params: {
          seed: 3,
          period: 0.55,
          harmonics: 3,
          harmonicSpread: 2,
          harmonicGain: 0.65,
          exponent: 1,
          amplitude: 0.55,
          offset: 0.45,
          monochrome: true,
          translateX: 0,
          translateY: 0,
          translateZ: 0,
          speed: 0.12,
        },
      },
      {
        id: "threshold-1",
        type: "fx.threshold",
        position: { x: 340, y: 140 },
        params: { compare: "lt", threshold: 0.67, tolerance: 0.05 },
      },
      { ...SCREEN, position: { x: 680, y: 160 } },
    ],
    edges: [
      { id: "e-n", source: "noise-1", sourceHandle: "out", target: "threshold-1", targetHandle: "src" },
      { id: "e-out", source: "threshold-1", sourceHandle: "out", target: "screen-1", targetHandle: "src" },
    ],
  };
}

/**
 * Thresholded noise as content, a second noise as the displacement map —
 * Displace Feedback trails that flow with the field. Values are a session
 * export (2026-08-13): a fine content field, a coarse warped map, and a decay
 * short enough that the trail keeps drifting instead of caking up.
 */
function noiseDisplaceFeedback(): SerializedPatch {
  return {
    format: 1,
    width: W,
    height: H,
    nodes: [
      {
        id: "noise-content",
        type: "source.noise",
        position: { x: 0, y: 40 },
        params: {
          seed: 1,
          period: 0.21,
          harmonics: 2,
          harmonicSpread: 1.55,
          harmonicGain: 0.83,
          exponent: 1.1,
          amplitude: 0.5,
          offset: 0.51,
          monochrome: true,
          translateX: 0,
          translateY: 0,
          translateZ: 0,
          speed: 0.08,
        },
      },
      {
        id: "threshold-1",
        type: "fx.threshold",
        position: { x: 320, y: 40 },
        params: { compare: "lt", threshold: 0.73, tolerance: 0.05 },
      },
      {
        id: "noise-disp",
        type: "source.noise",
        position: { x: 0, y: 297.57 },
        params: {
          seed: 0,
          period: 2.53,
          harmonics: 6,
          harmonicSpread: 2.4,
          harmonicGain: 0.69,
          exponent: 1.95,
          amplitude: 0.9,
          offset: 0.48,
          monochrome: false,
          translateX: 0,
          translateY: 0,
          translateZ: 0,
          speed: 0.15,
        },
      },
      {
        id: "displaceFeedback-1",
        type: "fx.displaceFeedback",
        position: { x: 640, y: 160 },
        params: {
          decay: 0.815,
          zoom: 0.975,
          rotate: -1.75,
          offsetX: 0.0035,
          offsetY: 0.0145,
          mode: "over",
          amount: 0.025,
          dispSource: "rg",
          displace: "prev",
          clear: false,
        },
      },
      { ...SCREEN, position: { x: 980, y: 180 } },
    ],
    edges: [
      {
        id: "e-thresh",
        source: "noise-content",
        sourceHandle: "out",
        target: "threshold-1",
        targetHandle: "src",
      },
      {
        id: "e-src",
        source: "threshold-1",
        sourceHandle: "out",
        target: "displaceFeedback-1",
        targetHandle: "src",
      },
      {
        id: "e-disp",
        source: "noise-disp",
        sourceHandle: "out",
        target: "displaceFeedback-1",
        targetHandle: "disp",
      },
      {
        id: "e-out",
        source: "displaceFeedback-1",
        sourceHandle: "out",
        target: "screen-1",
        targetHandle: "src",
      },
    ],
    timeline: {
      fps: 30,
      durationInFrames: 450,
      keyframes: {},
      reelZones: { cutsSec: [1, 1.2, 9, 12], dirty: false },
      cueZoneTick: false,
      cueDevMetronome: false,
      cueDrone: false,
      developmentBpm: 120,
    },
  };
}

export const BUILTIN_PRESETS: PatchPreset[] = [
  {
    id: DEFAULT_PRESET_ID,
    label: "Pixel Sort Keyframed",
    description: "Still → Pixel Sort → Color Correction, keyframed threshold and direction",
    builtin: true,
    build: pixelSortStart,
  },
  {
    id: "particles-feedback",
    label: "Particles Feedback",
    description: "Corners → Particles → Feedback trails with breathing zoom (1080×1920)",
    builtin: true,
    build: particlesFeedback,
  },
  {
    id: "particles-feedback-closeup",
    label: "Particles Feedback Close-up",
    description: "Same particle feedback chain with a tighter zoom on the still",
    builtin: true,
    build: particlesFeedbackCloseup,
  },
  {
    id: "noise-element-grid",
    label: "Noise Element Grid",
    description: "Points Noise → Features Grid (Element labels) → Points → Connectors",
    builtin: true,
    build: noiseElementGrid,
  },
  {
    id: "noise-field",
    label: "Noise Field",
    description: "GPU Noise TOP → output — seed / period / harmonics like TouchDesigner",
    builtin: true,
    build: noiseField,
  },
  {
    id: "noise-threshold",
    label: "Noise + Threshold",
    description: "Noise → luma threshold (keep the dark side) → output",
    builtin: true,
    build: noiseThreshold,
  },
  {
    id: "noise-displace-feedback",
    label: "Noise Displace Feedback",
    description: "Thresholded noise as content, RGB noise as map → Displace Feedback trails",
    builtin: true,
    build: noiseDisplaceFeedback,
  },
  {
    id: "track-segmentation",
    label: "Segmentation",
    description: "Still → MediaPipe Image Segmenter → white mask of the picked class",
    builtin: true,
    build: segmentationMask,
  },
  {
    id: "image-datamosh",
    label: "Datamosh",
    description: "Keyframed push on a still → motion vectors → P-frame smear — press play",
    builtin: true,
    build: datamosh,
  },
  {
    id: "gen-motion-mosh",
    label: "Gen Motion Mosh",
    description: "Still → invented motion field (bands) → Datamosh — press play; switch mode for melt / blocks",
    builtin: true,
    build: genMotionMosh,
  },
  {
    id: "image-slice-shift",
    label: "Image + Slice Shift",
    description: "Default image → slice shift → output (1080×1920)",
    builtin: true,
    build: imageSliceShift,
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
        drawParams: { labels: true, centers: false },
      }),
  },
  {
    id: "track-face-mesh",
    label: "Face Mesh",
    description: "Face still → Face Mesh (full tesselation) → Draw Skeleton → output",
    builtin: true,
    build: () =>
      trackingViz({
        source: "image",
        sourceFile: FACE_IMAGE_FILE,
        trackType: "tracking.face",
        trackId: "face-1",
        trackParams: { mesh: "tesselation", numFaces: 1, confidence: 0.5 },
        drawType: "draw.landmarks",
        drawId: "landmarks-1",
        drawHandle: "landmarks",
        // Face landmarks carry no visibility, so score fade would blank the mesh.
        drawParams: {
          pointColor: "#f5f0e6",
          boneColor: "#7fe3c0",
          pointSize: 1.5,
          boneWidth: 1,
          opacity: 0.85,
          scoreFade: false,
        },
      }),
  },
  {
    id: "track-skeleton-grid",
    label: "Skeleton Grid",
    description: "Pose still → Draw Skeleton → landmarks as points → Features Grid → output",
    builtin: true,
    build: skeletonGrid,
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
    id: "noise-grid",
    label: "Points Noise + Grid",
    description: "Noise-driven point cloud → Features Grid — animates without a camera",
    builtin: true,
    build: noiseGrid,
  },
  {
    id: "audio-analyzer-noise",
    label: "Audio Analyzer → Noise",
    description:
      "Default track → Analyzer RMS bound to Points Noise displacement → Features Grid",
    builtin: true,
    build: audioAnalyzerNoise,
  },
  {
    id: "audio-noise-grid",
    label: "Audio Noise Grid",
    description:
      "Corners → Points Noise (RMS → Displacement) → Features Grid — default track + still",
    builtin: true,
    build: audioNoiseGrid,
  },
  {
    id: "granular-grid",
    label: "Granular Grid",
    description:
      "Still → Features Grid; drop a video for grain audio (size → cutoff)",
    builtin: true,
    build: granularGrid,
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
    id: "features-tracking",
    label: "Features Tracking",
    description:
      "Image → Shi–Tomasi + PyrLK → motion lines (switch to camera/video for live trails)",
    builtin: true,
    build: featuresTracking,
  },
  {
    id: "track-noise-glitch",
    label: "Track Noise Glitch",
    description:
      "Video → Pixel Sort / Slice + Features Track → Points Noise → Grid / Connectors (drop a video; timeline keyed)",
    builtin: true,
    build: trackNoiseGlitch,
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
  {
    id: "image-pixel-sort",
    label: "Pixel Sort",
    description: "Image → Pixel Sort at half scale → output",
    builtin: true,
    build: () =>
      imageChain([
        {
          id: "pixelSort-1",
          type: "fx.pixelSort",
          // Half scale keeps it live at 1080×1920 instead of freezing between runs.
          params: { thresh: 110, vert: false, scale: 0.5, interval: 1, asyncRead: false },
        },
      ]),
  },
  {
    id: "image-block-scatter",
    label: "Block Scatter",
    description: "Image → drifting scattered blocks → output",
    builtin: true,
    build: () =>
      imageChain([
        {
          id: "blockScatter-1",
          type: "fx.blockScatter",
          params: { count: 120, size: 260, spread: 45, tint: 35, seed: 1234, drift: 6 },
        },
      ]),
  },
  {
    id: "image-shader",
    label: "Shader (Kaleidoscope)",
    description: "Image → custom GLSL → output; edit the source in the Inspector",
    builtin: true,
    build: () =>
      imageChain([
        {
          id: "shader-1",
          type: "fx.shader",
          params: {
            source:
              SHADER_PRESETS.find((preset) => preset.id === "kaleidoscope")?.source ?? "",
            k1: 0.45,
            k2: 0.5,
            k3: 0.15,
            k4: 0,
            color: "#6b8afd",
          },
        },
      ]),
  },
  {
    id: "image-quadtree",
    label: "Quadtree",
    description: "Image → detail-adaptive subdivision → output",
    builtin: true,
    build: () =>
      imageChain([
        {
          id: "quadtree-1",
          type: "draw.quadtree",
          input: "bg",
          params: {
            shape: "square",
            threshold: 22,
            maxDepth: 9,
            minSize: 10,
            gap: 1,
            outline: false,
            useImageColor: true,
            color: "#f5f0e6",
            bgColor: "#0a0a0a",
            replace: true,
            opacity: 1,
            interval: 2,
          },
        },
      ]),
  },
  {
    id: "image-color-zoom",
    label: "Zoom + Color",
    description: "Image → punch-in zoom → colour grade → output",
    builtin: true,
    build: () =>
      imageChain([
        { id: "zoom-1", type: "fx.zoom", params: { amount: 1.6, centerX: 0.5, centerY: 0.42 } },
        {
          id: "color-1",
          type: "fx.color",
          params: { brightness: 0.05, contrast: 1.25, saturation: 1.4, hue: -12 },
        },
      ]),
  },
  {
    id: "features-connectors",
    label: "Corners + Connectors",
    description: "Image → corner points → link web → output",
    builtin: true,
    build: () =>
      pointsChain("connectors-1", "draw.connectors", {
        color: "#7fe3c0",
        maxDist: 260,
        width: 2,
        opacity: 0.85,
        fade: true,
      }),
  },
  {
    id: "features-voronoi",
    label: "Corners + Voronoi",
    description: "Image → corners → Voronoi mosaic (stained glass)",
    builtin: true,
    build: () =>
      pointsChain("voronoi-1", "draw.voronoi", {
        mode: "both",
        color: "#f5f0e6",
        width: 1,
        opacity: 0.85,
        fillOpacity: 1,
        replace: false,
        interval: 2,
      }),
  },
  {
    id: "features-delaunay",
    label: "Corners + Delaunay",
    description: "Image → corners → low-poly Delaunay fill",
    builtin: true,
    build: () =>
      pointsChain("delaunay-1", "draw.delaunay", {
        mode: "fill",
        color: "#f5f0e6",
        width: 1,
        opacity: 0.6,
        fillOpacity: 1,
        replace: true,
        interval: 2,
      }),
  },
  {
    id: "features-mst",
    label: "Corners + MST",
    description: "Image → corners → constellation spanning tree",
    builtin: true,
    build: () =>
      pointsChain("mst-1", "draw.mst", {
        color: "#7fe3c0",
        width: 1.5,
        opacity: 0.9,
        showPoints: true,
        pointSize: 3,
      }),
  },
  {
    id: "features-radial",
    label: "Corners + Radial",
    description: "Image → corners → hub-and-spoke rays from centroid",
    builtin: true,
    build: () =>
      pointsChain("radial-1", "draw.radial", {
        mode: "centroid",
        k: 2,
        color: "#f5f0e6",
        width: 1.5,
        opacity: 0.8,
        fade: true,
        showHub: true,
        hubSize: 6,
      }),
  },
  {
    id: "features-particles",
    label: "Corners + Particles",
    description: "Image → corner points → particles pulled toward them → output",
    builtin: true,
    build: () =>
      // Tuned for 1080×1920: at size 2 a full 1200 particles cover under a
      // percent of the frame and the effect is invisible at a glance.
      pointsChain("particles-1", "draw.particles", {
        count: 4000,
        rate: 2000,
        life: 2.5,
        speed: 140,
        gravity: 0,
        drag: 0.7,
        attract: 160,
        size: 7,
        trail: 0.7,
        color: "#7ee0b8",
        opacity: 1,
        seed: 7,
        blend: "add",
      }),
  },
  {
    id: "corners-features-grid",
    label: "Corners + Features Grid",
    description: "Image → corner points → Features Grid with smear and content edge",
    builtin: true,
    build: cornersFeaturesGrid,
  },
  {
    id: "blend-split",
    label: "Blend (two paths)",
    description: "One image down two chains, recombined with screen blend",
    builtin: true,
    build: blendSplit,
  },
  {
    id: "keyframed-zoom",
    label: "Keyframes: Zoom",
    description: "Zoom animated on the timeline — press play, or scrub",
    builtin: true,
    build: () =>
      imageChain(
        [{ id: "zoom-1", type: "fx.zoom", params: { amount: 1, centerX: 0.5, centerY: 0.5 } }],
        {
          timeline: {
            fps: 30,
            durationInFrames: 300,
            keyframes: {
              "zoom-1:amount": [
                { frame: 0, value: 1 },
                { frame: 150, value: 2.6 },
                { frame: 300, value: 1 },
              ],
            },
          },
        },
      ),
  },
  {
    id: "modulated-slice",
    label: "Modulator: Slice Shift",
    description: "Slice count driven by an LFO — follows the playhead, so press play",
    builtin: true,
    build: () =>
      imageChain(
        [
          {
            id: "sliceShift-1",
            type: "fx.sliceShift",
            params: { count: 60, maxH: 90, amount: 14, animate: true, seed: 0 },
          },
        ],
        {
          modulators: {
            "sliceShift-1:count": {
              source: "lfo",
              shape: "sine",
              rateHz: 0.25,
              depth: 0.8,
              bias: 0,
              phase: 0,
            },
            "sliceShift-1:amount": {
              source: "lfo",
              shape: "triangle",
              rateHz: 0.4,
              depth: 0.5,
              bias: 0,
              phase: 0.25,
            },
          },
        },
      ),
  },
  {
    id: "modulator-routing",
    label: "Modulator: Shared Drive",
    description: "One LFO on the graph drives slice count and amount together — press play",
    builtin: true,
    build: () => ({
      format: 1,
      width: W,
      height: H,
      nodes: [
        {
          id: "image-1",
          type: "source.media",
          position: { x: 0, y: 140 },
          params: { mode: "image", file: DEFAULT_IMAGE_FILE, mirror: false, fit: "cover", zoom: 1 },
        },
        {
          id: "sliceShift-1",
          type: "fx.sliceShift",
          position: { x: 320, y: 140 },
          params: { count: 60, maxH: 90, amount: 14, animate: true, seed: 0 },
        },
        {
          id: "mod-1",
          type: "modulator.drive",
          position: { x: 320, y: 360 },
          params: {
            source: "lfo",
            shape: "sine",
            rateHz: 0.3,
            phase: 0,
            bandLoHz: 20,
            bandHiHz: 200,
            binds: [
              {
                id: "b-count",
                targetNode: "sliceShift-1",
                targetParam: "count",
                depth: 0.7,
                bias: 0,
              },
              {
                id: "b-amount",
                targetNode: "sliceShift-1",
                targetParam: "amount",
                depth: 0.5,
                bias: 0,
              },
            ],
          },
        },
        { ...SCREEN, position: { x: 640, y: 160 } },
      ],
      edges: [
        {
          id: "e0",
          source: "image-1",
          sourceHandle: "out",
          target: "sliceShift-1",
          targetHandle: "src",
        },
        {
          id: "e1",
          source: "sliceShift-1",
          sourceHandle: "out",
          target: "screen-1",
          targetHandle: "src",
        },
      ],
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

function withOverride(preset: PatchPreset): PatchPreset {
  if (preset.builtin !== true) return preset;
  const original = preset.build;
  return {
    ...preset,
    build: () => builtinOverride(preset.id) ?? original(),
  };
}

/**
 * Saved (user) presets first, newest first; builtins after. The first-run
 * picker ranks "what you already made" ahead of the catalog.
 */
export function rankPresets<T extends { builtin?: boolean }>(presets: T[]): T[] {
  const saved: T[] = [];
  const builtins: T[] = [];
  for (const preset of presets) {
    if (preset.builtin === true) builtins.push(preset);
    else saved.push(preset);
  }
  return [...saved, ...builtins];
}

/**
 * What the picker shows. Production drops ids in `visio.ship.json`; dev keeps them
 * so the ship-checkbox can put them back. Saved presets are never omitted.
 */
export function listPresets(): PatchPreset[] {
  const builtins = import.meta.env.DEV
    ? BUILTIN_PRESETS
    : BUILTIN_PRESETS.filter((preset) => !isOmitted(preset.id));
  const saved = readStored()
    .slice()
    .reverse()
    .map(toPreset);
  return rankPresets([...saved, ...builtins.map(withOverride)]);
}

/** Resolves omitted builtins too — an old `activePresetId` must still load. */
export function getPreset(id: string): PatchPreset | undefined {
  const found =
    BUILTIN_PRESETS.find((preset) => preset.id === id) ??
    readStored().map(toPreset).find((preset) => preset.id === id);
  return found ? withOverride(found) : undefined;
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

/** Snapshot of every saved (non-builtin) preset for download / backup. */
export function exportUserPresets(): {
  format: "visio.userPresets.v1";
  exportedAt: string;
  presets: StoredUserPreset[];
} {
  return {
    format: "visio.userPresets.v1",
    exportedAt: new Date().toISOString(),
    presets: readStored().map((entry) => structuredClone(entry)),
  };
}

export function downloadUserPresets(): number {
  const bundle = exportUserPresets();
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  link.href = url;
  link.download = `visio-user-presets-${stamp}.json`;
  link.click();
  URL.revokeObjectURL(url);
  return bundle.presets.length;
}
