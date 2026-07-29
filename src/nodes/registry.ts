import type { NodeDefinition } from "../engine/types";
import { cameraNode } from "./source/camera";
import { videoNode } from "./source/video";
import { imageNode } from "./source/image";
import { poseNode } from "./tracking/pose";
import { handsNode } from "./tracking/hands";
import { faceNode } from "./tracking/face";
import { objectsNode } from "./tracking/objects";
import { featuresNode } from "./tracking/features";
import { houghCirclesNode } from "./tracking/houghCircles";
import { houghLinesNode } from "./tracking/houghLines";
import { drawLandmarksNode } from "./draw/landmarks";
import { drawPointsNode } from "./draw/points";
import { drawBoxesNode } from "./draw/boxes";
import { drawCirclesNode } from "./draw/circles";
import { drawLinesNode } from "./draw/lines";
import { featuresGridNode } from "./draw/featuresGrid";
import { feedbackNode } from "./fx/feedback";
import { blendNode } from "./fx/blend";
import { colorNode } from "./fx/color";
import { pixelSortNode } from "./fx/pixelSort";
import { sliceShiftNode } from "./fx/sliceShift";
import { blockScatterNode } from "./fx/blockScatter";
import { outputNode } from "./output/output";

export const NODE_LIST: NodeDefinition<never>[] = [
  cameraNode,
  imageNode,
  videoNode,
  poseNode,
  handsNode,
  faceNode,
  objectsNode,
  featuresNode,
  houghCirclesNode,
  houghLinesNode,
  drawLandmarksNode,
  drawPointsNode,
  drawBoxesNode,
  drawCirclesNode,
  drawLinesNode,
  featuresGridNode,
  feedbackNode,
  blendNode,
  colorNode,
  pixelSortNode,
  sliceShiftNode,
  blockScatterNode,
  outputNode,
];

export const NODE_DEFS: Record<string, NodeDefinition<never>> = Object.fromEntries(
  NODE_LIST.map((definition) => [definition.type, definition]),
);

export function defaultParams(type: string): Record<string, unknown> {
  const definition = NODE_DEFS[type];
  if (!definition) return {};
  const params: Record<string, unknown> = {};
  for (const spec of definition.params) params[spec.key] = spec.default;
  return params;
}

export const CATEGORY_LABELS: Record<string, string> = {
  source: "Sources",
  tracking: "Tracking",
  draw: "Draw",
  fx: "FX",
  output: "Output",
};

export const CATEGORY_COLORS: Record<string, string> = {
  source: "#6ea8fe",
  tracking: "#7fe3c0",
  draw: "#ffd166",
  fx: "#c39bff",
  output: "#ff8fa3",
};

export const PORT_COLORS: Record<string, string> = {
  texture: "#6ea8fe",
  frame: "#9aa4b2",
  landmarks: "#7fe3c0",
  points: "#ffd166",
  boxes: "#ff5c7a",
  circles: "#8fd6ff",
  lines: "#c39bff",
  number: "#b0b6c2",
};
