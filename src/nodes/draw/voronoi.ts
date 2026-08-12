import { hexToRgb } from "../../engine/gl/program";
import { isRenderTarget } from "../../engine/gl/rt";
import { BatchBuilder, drawSegments, type BlendMode } from "../../engine/gl/vector";
import type { EngineContext, PointsValue } from "../../engine/types";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import { beginDraw, BLEND_PARAM } from "../shared/drawTarget";
import { PixelBuffer } from "../shared/pixelBuffer";
import {
  dedupePoints,
  delaunayTriangles,
  sampleRgb,
  voronoiCells,
  voronoiSegments,
  type MeshPoint,
} from "./pointMesh";

interface VoronoiState {
  batch: BatchBuilder;
  buffer: PixelBuffer;
  lastFrame: number;
}

/**
 * Voronoi diagram from tracked points — cell edges or image-sampled mosaic.
 */
export const voronoiNode = defineNode<VoronoiState>({
  type: "draw.voronoi",
  label: "Voronoi",
  category: "draw",
  description: "Voronoi cells from points: edges or stained-glass mosaic.",
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
        { value: "mosaic", label: "mosaic" },
        { value: "both", label: "both" },
      ],
      default: "edges",
    },
    { key: "color", label: "Edge color", type: "color", default: "#f5f0e6" },
    { key: "width", label: "Stroke", type: "range", min: 0.5, max: 12, step: 0.5, default: 1.5 },
    { key: "opacity", label: "Opacity", type: "range", min: 0, max: 1, step: 0.05, default: 0.9 },
    { key: "fillOpacity", label: "Fill opacity", type: "range", min: 0, max: 1, step: 0.05, default: 1 },
    { key: "replace", label: "Replace bg", type: "toggle", default: false },
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
    const mode = paramString(params, "mode", "edges");
    const needsCpu = mode === "mosaic" || mode === "both";
    if (needsCpu && runtime.state.lastFrame >= 0 && ctx.frameCount % interval !== 0) {
      return { out: ctx.target(nodeId, "out") };
    }

    const target = beginDraw(ctx, nodeId, inputs.bg ?? null);
    const data = inputs.points as PointsValue | null;
    if (!data || data.points.length === 0) return { out: target };

    const width = target.width;
    const height = target.height;
    const sites: MeshPoint[] = data.points.map((p) => ({
      x: p.x * width,
      y: p.y * height,
    }));

    const mesh =
      sites.length >= 3
        ? delaunayTriangles(sites)
        : { points: dedupePoints(sites), triangles: [] as Array<readonly [number, number, number]> };
    const { points, triangles } = mesh;
    if (mode === "edges" && triangles.length === 0) return { out: target };

    const opacity = paramNumber(params, "opacity", 0.9);
    const fillOpacity = paramNumber(params, "fillOpacity", 1);
    const stroke = paramNumber(params, "width", 1.5);
    const color = hexToRgb(paramString(params, "color", "#f5f0e6"));
    const blend = paramString(params, "blend", "normal") as BlendMode;

    if (needsCpu && isRenderTarget(inputs.bg)) {
      runtime.state.lastFrame = ctx.frameCount;
      const { buffer } = runtime.state;
      const image = buffer.read(ctx.gl, inputs.bg);
      const cells = voronoiCells(points, triangles, width, height);
      const ctx2d = buffer.context;
      if (paramBool(params, "replace", false)) {
        ctx2d.globalAlpha = 1;
        ctx2d.fillStyle = paramString(params, "bgColor", "#0a0a0a");
        ctx2d.fillRect(0, 0, width, height);
      } else {
        ctx2d.putImageData(image, 0, 0);
      }
      ctx2d.save();
      ctx2d.globalAlpha = fillOpacity;
      for (let i = 0; i < cells.length; i += 1) {
        const cell = cells[i]!;
        if (cell.length < 3) continue;
        const site = points[i]!;
        const rgb = sampleRgb(image.data, width, height, site.x, site.y);
        ctx2d.fillStyle = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
        ctx2d.beginPath();
        ctx2d.moveTo(cell[0]!.x, cell[0]!.y);
        for (let j = 1; j < cell.length; j += 1) ctx2d.lineTo(cell[j]!.x, cell[j]!.y);
        ctx2d.closePath();
        ctx2d.fill();
      }
      ctx2d.restore();
      buffer.write(ctx as EngineContext, target);
      if (mode === "mosaic") return { out: target };
    }

    if ((mode === "edges" || mode === "both") && triangles.length > 0) {
      const { batch } = runtime.state;
      batch.reset();
      const segs = voronoiSegments(points, triangles, width, height);
      for (const [a, b] of segs) {
        batch.addSegment(a.x, a.y, b.x, b.y, stroke, opacity);
      }
      drawSegments(ctx.gl, batch.segmentBatch(), { color, blend });
    }

    return { out: target };
  },
});
