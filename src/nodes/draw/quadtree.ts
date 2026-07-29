import { isRenderTarget } from "../../engine/gl/rt";
import type { EngineContext } from "../../engine/types";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import { beginDraw } from "../shared/drawTarget";
import { PixelBuffer } from "../shared/pixelBuffer";

interface QuadCell {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  g: number;
  b: number;
}

interface RegionStats {
  r: number;
  g: number;
  b: number;
  error: number;
}

interface QuadtreeState {
  buffer: PixelBuffer;
}

function sampleRegion(
  data: Uint8ClampedArray,
  imageWidth: number,
  x: number,
  y: number,
  w: number,
  h: number,
): RegionStats {
  const step = Math.max(1, Math.floor(Math.min(w, h) / 16));
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (let yy = y; yy < y + h; yy += step) {
    for (let xx = x; xx < x + w; xx += step) {
      const idx = (yy * imageWidth + xx) * 4;
      r += data[idx]!;
      g += data[idx + 1]!;
      b += data[idx + 2]!;
      count += 1;
    }
  }

  if (count === 0) return { r: 0, g: 0, b: 0, error: 0 };

  r /= count;
  g /= count;
  b /= count;

  const averageLum = 0.299 * r + 0.587 * g + 0.114 * b;
  let error = 0;
  for (let yy = y; yy < y + h; yy += step) {
    for (let xx = x; xx < x + w; xx += step) {
      const idx = (yy * imageWidth + xx) * 4;
      const lum = 0.299 * data[idx]! + 0.587 * data[idx + 1]! + 0.114 * data[idx + 2]!;
      error += (lum - averageLum) ** 2;
    }
  }

  return { r, g, b, error: Math.sqrt(error / count) };
}

function buildCells(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number,
  maxDepth: number,
  minSize: number,
): QuadCell[] {
  const cells: QuadCell[] = [];

  const subdivide = (x: number, y: number, w: number, h: number, depth: number): void => {
    const stats = sampleRegion(data, width, x, y, w, h);
    const halfW = Math.floor(w / 2);
    const halfH = Math.floor(h / 2);
    const canSplit =
      depth < maxDepth && halfW >= minSize && halfH >= minSize && stats.error > threshold;

    if (!canSplit) {
      cells.push({ x, y, w, h, r: stats.r, g: stats.g, b: stats.b });
      return;
    }

    subdivide(x, y, halfW, halfH, depth + 1);
    subdivide(x + halfW, y, w - halfW, halfH, depth + 1);
    subdivide(x, y + halfH, halfW, h - halfH, depth + 1);
    subdivide(x + halfW, y + halfH, w - halfW, h - halfH, depth + 1);
  };

  subdivide(0, 0, width, height, 0);
  return cells;
}

/**
 * Adaptive quadtree partition by luminance variance — ported from cv-reels.
 */
export const quadtreeNode = defineNode<QuadtreeState>({
  type: "draw.quadtree",
  label: "Quadtree",
  category: "draw",
  description: "Subdivide the frame by detail into squares or circles (cv-reels Quadtree).",
  inputs: [{ id: "bg", label: "bg", type: "texture" }],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    {
      key: "shape",
      label: "Shape",
      type: "select",
      options: [
        { value: "square", label: "square" },
        { value: "circle", label: "circle" },
      ],
      default: "square",
    },
    {
      key: "threshold",
      label: "Detail threshold",
      type: "range",
      min: 2,
      max: 80,
      step: 1,
      default: 25,
    },
    { key: "maxDepth", label: "Max depth", type: "range", min: 2, max: 12, step: 1, default: 8 },
    { key: "minSize", label: "Min cell", type: "range", min: 2, max: 64, step: 1, default: 8 },
    { key: "gap", label: "Gap", type: "range", min: 0, max: 10, step: 0.5, default: 1 },
    { key: "outline", label: "Outline", type: "toggle", default: false },
    { key: "useImageColor", label: "Image color", type: "toggle", default: true },
    { key: "color", label: "Color", type: "color", default: "#f5f0e6" },
    { key: "bgColor", label: "Background", type: "color", default: "#0a0a0a" },
    { key: "replace", label: "Replace bg", type: "toggle", default: true },
    { key: "opacity", label: "Opacity", type: "range", min: 0, max: 1, step: 0.05, default: 1 },
  ],
  createState() {
    return { buffer: new PixelBuffer() };
  },
  disposeState(state) {
    state.buffer.dispose();
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const target = beginDraw(ctx, nodeId, inputs.bg ?? null);
    const source = inputs.bg;
    if (!isRenderTarget(source)) return { out: target };

    const { buffer } = runtime.state;
    const image = buffer.read(ctx.gl, source);
    const width = image.width;
    const height = image.height;

    const cells = buildCells(
      image.data,
      width,
      height,
      paramNumber(params, "threshold", 25),
      Math.max(1, Math.round(paramNumber(params, "maxDepth", 8))),
      Math.max(1, paramNumber(params, "minSize", 8)),
    );

    const replace = paramBool(params, "replace", true);
    const shape = paramString(params, "shape", "square");
    const gap = paramNumber(params, "gap", 1);
    const outline = paramBool(params, "outline", false);
    const useImageColor = paramBool(params, "useImageColor", true);
    const color = paramString(params, "color", "#f5f0e6");
    const bgColor = paramString(params, "bgColor", "#0a0a0a");
    const opacity = paramNumber(params, "opacity", 1);

    const ctx2d = buffer.context;
    if (replace) {
      ctx2d.globalAlpha = 1;
      ctx2d.fillStyle = bgColor;
      ctx2d.fillRect(0, 0, width, height);
    } else {
      ctx2d.putImageData(image, 0, 0);
    }

    ctx2d.save();
    ctx2d.globalAlpha = opacity;
    for (const cell of cells) {
      const cellGap = Math.min(gap, cell.w / 2, cell.h / 2);
      const fillW = Math.max(0, cell.w - cellGap * 2);
      const fillH = Math.max(0, cell.h - cellGap * 2);
      if (fillW <= 0 || fillH <= 0) continue;

      ctx2d.fillStyle = useImageColor
        ? `rgb(${cell.r | 0},${cell.g | 0},${cell.b | 0})`
        : color;

      if (shape === "circle") {
        const radius = Math.max(0, Math.min(fillW, fillH) / 2);
        ctx2d.beginPath();
        ctx2d.arc(cell.x + cell.w / 2, cell.y + cell.h / 2, radius, 0, Math.PI * 2);
        ctx2d.fill();
      } else {
        ctx2d.fillRect(cell.x + cellGap, cell.y + cellGap, fillW, fillH);
      }

      if (outline) {
        ctx2d.globalAlpha = opacity * 0.45;
        ctx2d.strokeStyle = color;
        ctx2d.lineWidth = 0.5;
        ctx2d.strokeRect(cell.x, cell.y, cell.w, cell.h);
        ctx2d.globalAlpha = opacity;
      }
    }
    ctx2d.restore();

    buffer.write(ctx as EngineContext, target);
    return { out: target };
  },
});
