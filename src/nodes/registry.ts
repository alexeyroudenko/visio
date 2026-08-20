import type { NodeDefinition } from "../engine/types";
import { mediaNode, LEGACY_SOURCE_TYPES } from "./source/media";
import { textNode } from "./source/text";
import { poseNode } from "./tracking/pose";
import { handsNode } from "./tracking/hands";
import { faceNode } from "./tracking/face";
import { objectsNode } from "./tracking/objects";
import { segmentationNode } from "./tracking/segmentation";
import { featuresNode } from "./tracking/features";
import { featuresTrackNode } from "./tracking/featuresTrack";
import { houghCirclesNode } from "./tracking/houghCircles";
import { houghLinesNode } from "./tracking/houghLines";
import { landmarksToPointsNode } from "./convert/landmarksToPoints";
import { pointsNoiseNode } from "./generate/pointsNoise";
import { noiseNode } from "./generate/noise";
import { drawLandmarksNode } from "./draw/landmarks";
import { drawPointsNode } from "./draw/points";
import { drawBoxesNode } from "./draw/boxes";
import { drawRectsNode } from "./draw/rects";
import { drawCirclesNode } from "./draw/circles";
import { drawLinesNode } from "./draw/lines";
import { featuresGridNode } from "./draw/featuresGrid";
import { connectorsNode } from "./draw/connectors";
import { voronoiNode } from "./draw/voronoi";
import { delaunayNode } from "./draw/delaunay";
import { mstNode } from "./draw/mst";
import { radialNode } from "./draw/radial";
import { quadtreeNode } from "./draw/quadtree";
import { particlesNode } from "./draw/particles";
import { feedbackNode } from "./fx/feedback";
import { displaceFeedbackNode } from "./fx/displaceFeedback";
import { blendNode } from "./fx/blend";
import { motionNode } from "./fx/motion";
import { genMotionNode } from "./fx/genMotion";
import { datamoshNode } from "./fx/datamosh";
import { colorNode } from "./fx/color";
import { colorCorrectionNode } from "./fx/colorCorrection";
import { thresholdNode } from "./fx/threshold";
import { pixelSortNode } from "./fx/pixelSort";
import { sliceShiftNode } from "./fx/sliceShift";
import { blockScatterNode } from "./fx/blockScatter";
import { zoomNode } from "./fx/zoom";
import { shaderNode } from "./fx/shader";
import { analyzerNode } from "./audio/analyzer";
import { granularNode } from "./audio/granular";
import { modulatorDriveNode } from "./modulator/drive";
import { outputNode } from "./output/output";

declare global {
  interface Window {
    /** Survives Vite HMR so graphStore.onConnect always sees the latest defs. */
    __visioNodeDefs?: Record<string, NodeDefinition<never>>;
  }
}

export const NODE_LIST: NodeDefinition<never>[] = [
  mediaNode,
  noiseNode,
  textNode,
  poseNode,
  handsNode,
  faceNode,
  objectsNode,
  segmentationNode,
  featuresNode,
  featuresTrackNode,
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
  voronoiNode,
  delaunayNode,
  mstNode,
  radialNode,
  quadtreeNode,
  particlesNode,
  feedbackNode,
  displaceFeedbackNode,
  blendNode,
  motionNode,
  genMotionNode,
  datamoshNode,
  colorNode,
  colorCorrectionNode,
  thresholdNode,
  pixelSortNode,
  sliceShiftNode,
  blockScatterNode,
  zoomNode,
  shaderNode,
  analyzerNode,
  modulatorDriveNode,
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
  source: "#2a2a2a",
  tracking: "#3a3a3a",
  draw: "#4a4a4a",
  fx: "#5a5a5a",
  audio: "#333333",
  output: "#111111",
};

export const PORT_COLORS: Record<string, string> = {
  texture: "#ffffff",
  frame: "#e0e0e0",
  landmarks: "#c8c8c8",
  points: "#b0b0b0",
  boxes: "#989898",
  circles: "#ffffff",
  lines: "#808080",
  number: "#666666",
  audio: "#d0d0d0",
};
