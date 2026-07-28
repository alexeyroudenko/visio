import { hexToRgb } from "../../engine/gl/program";
import {
  BatchBuilder,
  drawPoints,
  drawSegments,
  type BlendMode,
} from "../../engine/gl/vector";
import type { LandmarksValue } from "../../engine/types";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import { beginDraw, BLEND_PARAM } from "../shared/drawTarget";

interface DrawState {
  batch: BatchBuilder;
}

export const drawLandmarksNode = defineNode<DrawState>({
  type: "draw.landmarks",
  label: "Draw Skeleton",
  category: "draw",
  description: "Draws landmark points and bones over the input texture.",
  inputs: [
    { id: "bg", label: "bg", type: "texture" },
    { id: "landmarks", label: "landmarks", type: "landmarks" },
  ],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "pointColor", label: "Point color", type: "color", default: "#f5f0e6" },
    { key: "boneColor", label: "Bone color", type: "color", default: "#7fe3c0" },
    { key: "pointSize", label: "Point size", type: "range", min: 0, max: 24, step: 0.5, default: 5 },
    { key: "boneWidth", label: "Bone width", type: "range", min: 0, max: 20, step: 0.5, default: 3 },
    { key: "opacity", label: "Opacity", type: "range", min: 0, max: 1, step: 0.05, default: 1 },
    { key: "scoreFade", label: "Fade by score", type: "toggle", default: true },
    BLEND_PARAM,
  ],
  createState() {
    return { batch: new BatchBuilder() };
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const target = beginDraw(ctx, nodeId, inputs.bg ?? null);
    const data = inputs.landmarks as LandmarksValue | null;
    if (!data || data.sets.length === 0) return { out: target };

    const { batch } = runtime.state;
    batch.reset();

    const width = target.width;
    const height = target.height;
    const opacity = paramNumber(params, "opacity", 1);
    const pointSize = paramNumber(params, "pointSize", 5);
    const boneWidth = paramNumber(params, "boneWidth", 3);
    const fade = paramBool(params, "scoreFade", true);
    const blend = paramString(params, "blend", "normal") as BlendMode;

    for (const set of data.sets) {
      if (boneWidth > 0) {
        for (const [from, to] of data.connections) {
          const a = set[from];
          const b = set[to];
          if (!a || !b) continue;
          const alpha = fade ? Math.min(a.score, b.score) * opacity : opacity;
          if (alpha <= 0.01) continue;
          batch.addSegment(a.x * width, a.y * height, b.x * width, b.y * height, boneWidth, alpha);
        }
      }
      if (pointSize > 0) {
        for (const point of set) {
          const alpha = fade ? point.score * opacity : opacity;
          if (alpha <= 0.01) continue;
          batch.addPoint(point.x * width, point.y * height, pointSize, alpha);
        }
      }
    }

    drawSegments(ctx.gl, batch.segmentBatch(), {
      color: hexToRgb(paramString(params, "boneColor", "#7fe3c0")),
      blend,
    });
    drawPoints(ctx.gl, batch.pointBatch(), {
      color: hexToRgb(paramString(params, "pointColor", "#f5f0e6")),
      blend,
    });

    return { out: target };
  },
});
