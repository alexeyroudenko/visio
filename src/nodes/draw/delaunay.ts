import { hexToRgb } from "../../engine/gl/program";
import { isRenderTarget } from "../../engine/gl/rt";
import { BatchBuilder, drawSegments, type BlendMode } from "../../engine/gl/vector";
import type { EngineContext, PointsValue } from "../../engine/types";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import { beginDraw, BLEND_PARAM } from "../shared/drawTarget";
import { PixelBuffer } from "../shared/pixelBuffer";
import {
  delaunayTriangles,
  sampleRgb,
  triangleEdges,
  type MeshPoint,
} from "./pointMesh";

interface DelaunayState {
  batch: BatchBuilder;
  buffer: PixelBuffer;
  lastFrame: number;
}

/**
 * Delaunay triangulation from tracked points — mesh edges or low-poly mosaic.
 */
export const delaunayNode = defineNode<DelaunayState>({
  type: "draw.delaunay",
  label: "Delaunay",
  category: "draw",
  description: "Delaunay mesh from points: edges or low-poly filled triangles.",
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
        { value: "edges", label: "edges" },
        { value: "fill", label: "low-poly" },
        { value: "both", label: "both" },
      ],
      default: "fill",
    },
    { key: "color", label: "Edge color", type: "color", default: "#f5f0e6" },
    { key: "width", label: "Stroke", type: "range", min: 0.5, max: 12, step: 0.5, default: 1 },
    { key: "opacity", label: "Edge opacity", type: "range", min: 0, max: 1, step: 0.05, default: 0.7 },
    { key: "fillOpacity", label: "Fill opacity", type: "range", min: 0, max: 1, step: 0.05, default: 1 },
    { key: "replace", label: "Replace bg", type: "toggle", default: true },
    { key: "bgColor", label: "Background", type: "color", default: "#0a0a0a" },
    { key: "interval", label: "Every N frames", type: "range", min: 1, max: 8, step: 1, default: 1 },
    BLEND_PARAM,
  ],
  createState() {
    return { batch: new BatchBuilder(), buffer: new PixelBuffer(), lastFrame: -1 };
  },
  disposeState(state) {
    state.buffer.dispose();
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const interval = Math.max(1, Math.round(paramNumber(params, "interval", 1)));
    const mode = paramString(params, "mode", "fill");
    const needsCpu = mode === "fill" || mode === "both";
    if (needsCpu && runtime.state.lastFrame >= 0 && ctx.frameCount % interval !== 0) {
      return { out: ctx.target(nodeId, "out") };
    }

    const target = beginDraw(ctx, nodeId, inputs.bg ?? null);
    const data = inputs.points as PointsValue | null;
    if (!data || data.points.length < 3) return { out: target };

    const width = target.width;
    const height = target.height;
    const sites: MeshPoint[] = data.points.map((p) => ({
      x: p.x * width,
      y: p.y * height,
    }));
    const { points, triangles } = delaunayTriangles(sites);
    if (triangles.length === 0) return { out: target };

    const opacity = paramNumber(params, "opacity", 0.7);
    const fillOpacity = paramNumber(params, "fillOpacity", 1);
    const stroke = paramNumber(params, "width", 1);
    const color = hexToRgb(paramString(params, "color", "#f5f0e6"));
    const blend = paramString(params, "blend", "normal") as BlendMode;

    if (needsCpu && isRenderTarget(inputs.bg)) {
      runtime.state.lastFrame = ctx.frameCount;
      const { buffer } = runtime.state;
      const image = buffer.read(ctx.gl, inputs.bg);
      const ctx2d = buffer.context;
      if (paramBool(params, "replace", true)) {
        ctx2d.globalAlpha = 1;
        ctx2d.fillStyle = paramString(params, "bgColor", "#0a0a0a");
        ctx2d.fillRect(0, 0, width, height);
      } else {
        ctx2d.putImageData(image, 0, 0);
      }
      ctx2d.save();
      ctx2d.globalAlpha = fillOpacity;
      for (const t of triangles) {
        const a = points[t[0]]!;
        const b = points[t[1]]!;
        const c = points[t[2]]!;
        const cx = (a.x + b.x + c.x) / 3;
        const cy = (a.y + b.y + c.y) / 3;
        const rgb = sampleRgb(image.data, width, height, cx, cy);
        ctx2d.fillStyle = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
        ctx2d.beginPath();
        ctx2d.moveTo(a.x, a.y);
        ctx2d.lineTo(b.x, b.y);
        ctx2d.lineTo(c.x, c.y);
        ctx2d.closePath();
        ctx2d.fill();
      }
      ctx2d.restore();
      buffer.write(ctx as EngineContext, target);
      if (mode === "fill") return { out: target };
    }

    if (mode === "edges" || mode === "both") {
      const { batch } = runtime.state;
      batch.reset();
      for (const [u, v] of triangleEdges(triangles)) {
        const a = points[u]!;
        const b = points[v]!;
        batch.addSegment(a.x, a.y, b.x, b.y, stroke, opacity);
      }
      drawSegments(ctx.gl, batch.segmentBatch(), { color, blend });
    }

    return { out: target };
  },
});
