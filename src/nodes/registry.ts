import type { NodeDefinition } from "../engine/types";
import { mediaNode, LEGACY_SOURCE_TYPES } from "./source/media";
import { poseNode } from "./tracking/pose";
import { handsNode } from "./tracking/hands";
import { faceNode } from "./tracking/face";
import { objectsNode } from "./tracking/objects";
import { featuresNode } from "./tracking/features";
import { houghCirclesNode } from "./tracking/houghCircles";
import { houghLinesNode } from "./tracking/houghLines";
import { landmarksToPointsNode } from "./convert/landmarksToPoints";
import { pointsNoiseNode } from "./generate/pointsNoise";
import { drawLandmarksNode } from "./draw/landmarks";
import { drawPointsNode } from "./draw/points";
import { drawBoxesNode } from "./draw/boxes";
import { drawRectsNode } from "./draw/rects";
import { drawCirclesNode } from "./draw/circles";
import { drawLinesNode } from "./draw/lines";
import { featuresGridNode } from "./draw/featuresGrid";
import { connectorsNode } from "./draw/connectors";
import { quadtreeNode } from "./draw/quadtree";
import { particlesNode } from "./draw/particles";
import { feedbackNode } from "./fx/feedback";
import { blendNode } from "./fx/blend";
import { colorNode } from "./fx/color";
import { colorCorrectionNode } from "./fx/colorCorrection";
import { pixelSortNode } from "./fx/pixelSort";
import { sliceShiftNode } from "./fx/sliceShift";
import { blockScatterNode } from "./fx/blockScatter";
import { zoomNode } from "./fx/zoom";
import { shaderNode } from "./fx/shader";
import { granularNode } from "./audio/granular";
import { outputNode } from "./output/output";

declare global {
  interface Window {
    /** Survives Vite HMR so graphStore.onConnect always sees the latest defs. */
    __visioNodeDefs?: Record<string, NodeDefinition<never>>;
  }
}

export const NODE_LIST: NodeDefinition<never>[] = [
  mediaNode,
  poseNode,
  handsNode,
  faceNode,
  objectsNode,
  featuresNode,
  houghCirclesNode,
  houghLinesNode,
  landmarksToPointsNode,
  pointsNoiseNode,
  drawLandmarksNode,
  drawPointsNode,
  drawBoxesNode,
  drawRectsNode,
  drawCirclesNode,
  drawLinesNode,
  featuresGridNode,
  connectorsNode,
  quadtreeNode,
  particlesNode,
  feedbackNode,
  blendNode,
  colorNode,
  colorCorrectionNode,
  pixelSortNode,
  sliceShiftNode,
  blockScatterNode,
  zoomNode,
  shaderNode,
  granularNode,
  outputNode,
];

/** Mutated in place across HMR — do not replace the object reference. */
export const NODE_DEFS: Record<string, NodeDefinition<never>> =
  typeof window !== "undefined" && window.__visioNodeDefs
    ? window.__visioNodeDefs
    : {};

for (const key of Object.keys(NODE_DEFS)) delete NODE_DEFS[key];
for (const definition of NODE_LIST) NODE_DEFS[definition.type] = definition;
// Old patches / drops still resolve camera|image|video to the unified Media node.
for (const legacy of Object.keys(LEGACY_SOURCE_TYPES)) {
  NODE_DEFS[legacy] = mediaNode;
}

if (typeof window !== "undefined") {
  window.__visioNodeDefs = NODE_DEFS;
}

export function defaultParams(type: string): Record<string, unknown> {
  const definition = NODE_DEFS[type];
  if (!definition) return {};
  const params: Record<string, unknown> = {};
  for (const spec of definition.params) params[spec.key] = spec.default;
  const mode = LEGACY_SOURCE_TYPES[type];
  if (mode) params.mode = mode;
  return params;
}

export const CATEGORY_LABELS: Record<string, string> = {
  source: "Sources",
  tracking: "Tracking",
  draw: "Draw",
  fx: "FX",
  audio: "Audio",
  output: "Output",
};

export const CATEGORY_COLORS: Record<string, string> = {
  source: "#6b8afd",
  tracking: "#3d8f6e",
  draw: "#d9822b",
  fx: "#8b74e8",
  audio: "#2fa4a0",
  output: "#d64545",
};

export const PORT_COLORS: Record<string, string> = {
  texture: "#6b8afd",
  frame: "#7d9aff",
  landmarks: "#2d6a4f",
  points: "#e67e22",
  boxes: "#e74c3c",
  circles: "#6b8afd",
  lines: "#9a9cab",
  number: "#6b6d7a",
  audio: "#2fa4a0",
};
