import { hexToRgb } from "../../engine/gl/program";
import { BatchBuilder, drawPoints, drawSegments, type BlendMode } from "../../engine/gl/vector";
import type { PointsValue } from "../../engine/types";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import { beginDraw, BLEND_PARAM } from "../shared/drawTarget";

interface PointsState {
  /** Ring outlines — drawn with a stroke width, so they need their own batch. */
  rings: BatchBuilder;
  /** Filled dots and every line: crosses, links. */
  marks: BatchBuilder;
}

export const drawPointsNode = defineNode<PointsState>({
  type: "draw.points",
  label: "Draw Points",
  category: "draw",
  description: "Point cloud: dot, detection-style ring, or cross; plus a link web.",
  inputs: [
    { id: "bg", label: "bg", type: "texture" },
    { id: "points", label: "points", type: "points" },
  ],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    {
      key: "style",
      label: "Style",
      type: "select",
      options: [
        { value: "point", label: "point" },
        { value: "circle", label: "ring (detection)" },
        { value: "cross", label: "cross" },
      ],
      default: "point",
    },
    { key: "color", label: "Color", type: "color", default: "#ffd166" },
    { key: "size", label: "Point size", type: "range", min: 0.5, max: 30, step: 0.5, default: 4 },
    { key: "sizeByScore", label: "Size by score", type: "range", min: 0, max: 3, step: 0.1, default: 1 },
    { key: "minRadius", label: "Min radius", type: "range", min: 2, max: 100, step: 1, default: 8 },
    { key: "maxRadius", label: "Max radius", type: "range", min: 4, max: 200, step: 1, default: 34 },
    { key: "stroke", label: "Stroke width", type: "range", min: 0.5, max: 10, step: 0.5, default: 1.5 },
    { key: "centerDot", label: "Center point", type: "toggle", default: true },
    { key: "opacity", label: "Opacity", type: "range", min: 0, max: 1, step: 0.05, default: 0.9 },
    { key: "linkRadius", label: "Link radius", type: "range", min: 0, max: 300, step: 5, default: 0 },
    { key: "linkWidth", label: "Link width", type: "range", min: 0.5, max: 8, step: 0.5, default: 1 },
    BLEND_PARAM,
  ],
  createState() {
    return { rings: new BatchBuilder(), marks: new BatchBuilder() };
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const target = beginDraw(ctx, nodeId, inputs.bg ?? null);
    const data = inputs.points as PointsValue | null;
    if (!data || data.points.length === 0) return { out: target };

    const { rings, marks } = runtime.state;
    rings.reset();
    marks.reset();

    const width = target.width;
    const height = target.height;
    const opacity = paramNumber(params, "opacity", 0.9);
    const style = paramString(params, "style", "point");
    const blend = paramString(params, "blend", "normal") as BlendMode;

    const pixels = data.points.map((point) => ({
      x: point.x * width,
      y: point.y * height,
      score: point.score,
    }));

    const linkRadius = paramNumber(params, "linkRadius", 0);
    if (linkRadius > 0) {
      const linkWidth = paramNumber(params, "linkWidth", 1);
      const radiusSq = linkRadius * linkRadius;
      for (let i = 0; i < pixels.length; i += 1) {
        for (let j = i + 1; j < pixels.length; j += 1) {
          const dx = pixels[i].x - pixels[j].x;
          const dy = pixels[i].y - pixels[j].y;
          const distSq = dx * dx + dy * dy;
          if (distSq > radiusSq) continue;
          // Links fade out as they approach the radius limit.
          const alpha = (1 - Math.sqrt(distSq) / linkRadius) * opacity;
          marks.addSegment(pixels[i].x, pixels[i].y, pixels[j].x, pixels[j].y, linkWidth, alpha);
        }
      }
    }

    const minRadius = paramNumber(params, "minRadius", 8);
    const maxRadius = paramNumber(params, "maxRadius", 34);
    const centerDot = paramBool(params, "centerDot", true);

    for (const point of pixels) {
      if (style === "point") {
        const size = paramNumber(params, "size", 4);
        const sizeByScore = paramNumber(params, "sizeByScore", 1);
        marks.addPoint(point.x, point.y, size * (1 + sizeByScore * point.score), opacity);
        continue;
      }

      // Detection look: radius interpolated by score, like placeCircles.
      const radius = minRadius + (maxRadius - minRadius) * point.score;

      if (style === "circle") {
        rings.addPoint(point.x, point.y, radius, (0.3 + 0.4 * point.score) * opacity);
      } else {
        const half = Math.max(radius, 8);
        const width2 = paramNumber(params, "stroke", 1.5);
        const alpha = (0.5 + 0.5 * point.score) * opacity;
        marks.addSegment(point.x - half, point.y, point.x + half, point.y, width2, alpha);
        marks.addSegment(point.x, point.y - half, point.x, point.y + half, width2, alpha);
      }

      if (centerDot && style === "circle") {
        marks.addPoint(point.x, point.y, 2.5, (0.7 + 0.3 * point.score) * opacity);
      }
    }

    const color = hexToRgb(paramString(params, "color", "#ffd166"));
    drawSegments(ctx.gl, marks.segmentBatch(), { color, blend });
    drawPoints(ctx.gl, rings.pointBatch(), {
      color,
      blend,
      thickness: paramNumber(params, "stroke", 1.5),
      softness: 0.4,
    });
    drawPoints(ctx.gl, marks.pointBatch(), { color, blend });

    return { out: target };
  },
});
