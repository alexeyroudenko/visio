import { hexToRgb } from "../../engine/gl/program";
import { BatchBuilder, drawPoints, drawSegments, type BlendMode } from "../../engine/gl/vector";
import type { PointsValue } from "../../engine/types";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import { beginDraw, BLEND_PARAM } from "../shared/drawTarget";
import { dedupePoints, mstSegments, type MeshPoint } from "./pointMesh";

interface MstState {
  batch: BatchBuilder;
  dots: BatchBuilder;
}

/**
 * Minimum spanning tree over points — constellation / star-sign web.
 */
export const mstNode = defineNode<MstState>({
  type: "draw.mst",
  label: "MST",
  category: "draw",
  description: "Minimum spanning tree constellation over points.",
  inputs: [
    { id: "bg", label: "bg", type: "texture" },
    { id: "points", label: "points", type: "points" },
  ],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "color", label: "Color", type: "color", default: "#7fe3c0" },
    { key: "width", label: "Stroke", type: "range", min: 0.5, max: 12, step: 0.5, default: 1.5 },
    { key: "opacity", label: "Opacity", type: "range", min: 0, max: 1, step: 0.05, default: 0.9 },
    { key: "showPoints", label: "Show points", type: "toggle", default: true },
    { key: "pointSize", label: "Point size", type: "range", min: 0, max: 16, step: 0.5, default: 3 },
    BLEND_PARAM,
  ],
  createState() {
    return { batch: new BatchBuilder(), dots: new BatchBuilder() };
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const target = beginDraw(ctx, nodeId, inputs.bg ?? null);
    const data = inputs.points as PointsValue | null;
    if (!data || data.points.length < 2) return { out: target };

    const width = target.width;
    const height = target.height;
    const sites: MeshPoint[] = dedupePoints(
      data.points.map((p) => ({ x: p.x * width, y: p.y * height })),
    );
    if (sites.length < 2) return { out: target };

    const opacity = paramNumber(params, "opacity", 0.9);
    const stroke = paramNumber(params, "width", 1.5);
    const color = hexToRgb(paramString(params, "color", "#7fe3c0"));
    const blend = paramString(params, "blend", "normal") as BlendMode;

    const { batch, dots } = runtime.state;
    batch.reset();
    for (const [u, v] of mstSegments(sites)) {
      const a = sites[u]!;
      const b = sites[v]!;
      batch.addSegment(a.x, a.y, b.x, b.y, stroke, opacity);
    }
    drawSegments(ctx.gl, batch.segmentBatch(), { color, blend });

    if (paramBool(params, "showPoints", true)) {
      const size = paramNumber(params, "pointSize", 3);
      if (size > 0) {
        dots.reset();
        for (const p of sites) dots.addPoint(p.x, p.y, size, opacity);
        drawPoints(ctx.gl, dots.pointBatch(), { color, blend, softness: 0.4 });
      }
    }

    return { out: target };
  },
});
