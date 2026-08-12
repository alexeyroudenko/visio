import { hexToRgb } from "../../engine/gl/program";
import { BatchBuilder, drawPoints, drawSegments, type BlendMode } from "../../engine/gl/vector";
import type { PointsValue } from "../../engine/types";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import { beginDraw, BLEND_PARAM } from "../shared/drawTarget";
import { dedupePoints, radialSegments, type MeshPoint } from "./pointMesh";

interface RadialState {
  batch: BatchBuilder;
  dots: BatchBuilder;
}

/**
 * Radial / hub-and-spoke links from a centroid or k-nearest neighbours.
 */
export const radialNode = defineNode<RadialState>({
  type: "draw.radial",
  label: "Radial",
  category: "draw",
  description: "Hub-and-spoke rays from centroid or k-nearest neighbours.",
  inputs: [
    { id: "bg", label: "bg", type: "texture" },
    { id: "points", label: "points", type: "points" },
  ],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    {
      key: "mode",
      label: "Mode",
      type: "select",
      options: [
        { value: "centroid", label: "centroid" },
        { value: "hub", label: "k-nearest" },
      ],
      default: "centroid",
    },
    { key: "k", label: "Neighbours", type: "range", min: 1, max: 8, step: 1, default: 2 },
    { key: "color", label: "Color", type: "color", default: "#f5f0e6" },
    { key: "width", label: "Stroke", type: "range", min: 0.5, max: 12, step: 0.5, default: 1.5 },
    { key: "opacity", label: "Opacity", type: "range", min: 0, max: 1, step: 0.05, default: 0.75 },
    { key: "fade", label: "Fade by length", type: "toggle", default: true },
    { key: "showHub", label: "Show hub", type: "toggle", default: true },
    { key: "hubSize", label: "Hub size", type: "range", min: 0, max: 24, step: 0.5, default: 5 },
    BLEND_PARAM,
  ],
  createState() {
    return { batch: new BatchBuilder(), dots: new BatchBuilder() };
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const target = beginDraw(ctx, nodeId, inputs.bg ?? null);
    const data = inputs.points as PointsValue | null;
    if (!data || data.points.length === 0) return { out: target };

    const width = target.width;
    const height = target.height;
    const sites: MeshPoint[] = dedupePoints(
      data.points.map((p) => ({ x: p.x * width, y: p.y * height })),
    );
    if (sites.length === 0) return { out: target };

    const mode = paramString(params, "mode", "centroid") === "hub" ? "hub" : "centroid";
    const k = Math.round(paramNumber(params, "k", 2));
    const { hubs, segments } = radialSegments(sites, mode, k);
    if (segments.length === 0) return { out: target };

    const opacity = paramNumber(params, "opacity", 0.75);
    const stroke = paramNumber(params, "width", 1.5);
    const doFade = paramBool(params, "fade", true);
    const color = hexToRgb(paramString(params, "color", "#f5f0e6"));
    const blend = paramString(params, "blend", "normal") as BlendMode;

    let maxLen = 1;
    if (doFade) {
      for (const [a, b] of segments) {
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len > maxLen) maxLen = len;
      }
    }

    const { batch, dots } = runtime.state;
    batch.reset();
    for (const [a, b] of segments) {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const alpha = doFade ? (1 - len / maxLen) * opacity : opacity;
      if (alpha <= 0.01) continue;
      batch.addSegment(a.x, a.y, b.x, b.y, stroke, alpha);
    }
    drawSegments(ctx.gl, batch.segmentBatch(), { color, blend });

    if (paramBool(params, "showHub", true) && hubs.length > 0) {
      const size = paramNumber(params, "hubSize", 5);
      if (size > 0) {
        dots.reset();
        for (const h of hubs) dots.addPoint(h.x, h.y, size, opacity);
        drawPoints(ctx.gl, dots.pointBatch(), { color, blend, softness: 0.35 });
      }
    }

    return { out: target };
  },
});
