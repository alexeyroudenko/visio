import { getProgram } from "../../engine/gl/program";
import { bindTexture, drawFullscreen, FULLSCREEN_VS } from "../../engine/gl/quad";
import { isRenderTarget, type RenderTarget } from "../../engine/gl/rt";
import type { EngineContext, FrameValue, PointsValue } from "../../engine/types";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import { CanvasOverlay } from "../shared/canvasOverlay";
import { beginDraw } from "../shared/drawTarget";
import { PixelBuffer } from "../shared/pixelBuffer";
import { mulberry32 } from "../shared/rng";

/**
 * Samples one column of the source and stretches it across the cell — the
 * "stretched center line" smear from the cv-reels grid.
 */
const SMEAR_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uResolution;
uniform float uColumnX;
out vec4 fragColor;
void main() {
  // gl_FragCoord is in target space, so the column keeps its vertical position
  // even though the viewport is clipped to the cell.
  float v = gl_FragCoord.y / uResolution.y;
  fragColor = texture(uTex, vec2(uColumnX, v));
}`;

function smearCell(
  ctx: EngineContext,
  source: RenderTarget,
  target: RenderTarget,
  cell: Cell,
): void {
  const gl = ctx.gl;
  const x = Math.round(cell.x);
  const y = Math.round(cell.y);
  const w = Math.max(1, Math.round(cell.w));
  const h = Math.max(1, Math.round(cell.h));

  const program = getProgram(gl, FULLSCREEN_VS, SMEAR_FS);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  // Clipping the viewport to the cell means the pass only touches those pixels.
  gl.viewport(x, y, w, h);
  gl.disable(gl.BLEND);
  program.use();
  bindTexture(gl, program, "uTex", source.texture, 0);
  gl.uniform2f(program.uniform("uResolution"), target.width, target.height);
  gl.uniform1f(program.uniform("uColumnX"), (x + w / 2) / target.width);
  drawFullscreen(gl, program);

  gl.viewport(0, 0, target.width, target.height);
}

interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Downscaled boolean mask of "drawn content" pixels (non-background). */
interface ContentMask {
  data: Uint8Array;
  sw: number;
  sh: number;
  scaleX: number;
  scaleY: number;
}

interface GridState {
  overlay: CanvasOverlay;
  buffer: PixelBuffer;
  /** Scratch for downscaled content-mask sampling. */
  maskCanvas: HTMLCanvasElement;
  maskCtx: CanvasRenderingContext2D;
  /**
   * Last built content mask. It describes the background, which changes far
   * slower than the cells sitting on top of it, so it is worth keeping between
   * frames — building it costs a full-frame readback or a getImageData.
   * `maskFrame < 0` means "never built", which is not the same as "built and
   * found nothing": without that distinction an empty frame would rebuild the
   * mask every tick, the exact case the throttle exists for.
   */
  mask: ContentMask | null;
  maskFrame: number;
  maskW: number;
  maskH: number;
}

function colorDistance(
  r: number,
  g: number,
  b: number,
  ref: [number, number, number],
): number {
  const dr = r - ref[0];
  const dg = g - ref[1];
  const db = b - ref[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function ensureMaskScratch(
  state: GridState,
  sw: number,
  sh: number,
): CanvasRenderingContext2D {
  if (state.maskCanvas.width !== sw || state.maskCanvas.height !== sh) {
    state.maskCanvas.width = sw;
    state.maskCanvas.height = sh;
  }
  return state.maskCtx;
}

/**
 * Content mask from ImageData (cv-reels): pixel is content when opaque and
 * different from the average corner color.
 */
function buildContentMaskFromImage(
  image: ImageData,
  width: number,
  height: number,
): ContentMask | null {
  const { data, width: sw, height: sh } = image;
  if (sw < 1 || sh < 1) return null;

  const inset = Math.max(1, Math.floor(Math.min(sw, sh) * 0.04));

  const sampleCorner = (cx: number, cy: number): [number, number, number] | null => {
    const x = Math.round(Math.min(sw - 1, Math.max(0, cx)));
    const y = Math.round(Math.min(sh - 1, Math.max(0, cy)));
    const idx = (y * sw + x) * 4;
    if (data[idx + 3]! < 8) return null;
    return [data[idx]!, data[idx + 1]!, data[idx + 2]!];
  };

  const corners = [
    sampleCorner(inset, inset),
    sampleCorner(sw - 1 - inset, inset),
    sampleCorner(inset, sh - 1 - inset),
    sampleCorner(sw - 1 - inset, sh - 1 - inset),
  ].filter((c): c is [number, number, number] => c !== null);

  const imageBg: [number, number, number] =
    corners.length > 0
      ? [
          corners.reduce((s, c) => s + c[0], 0) / corners.length,
          corners.reduce((s, c) => s + c[1], 0) / corners.length,
          corners.reduce((s, c) => s + c[2], 0) / corners.length,
        ]
      : [0, 0, 0];

  const threshold = 32;
  const mask = new Uint8Array(sw * sh);
  let hasContent = false;

  for (let i = 0; i < sw * sh; i += 1) {
    const idx = i * 4;
    if (data[idx + 3]! < 8) continue;
    const dist = colorDistance(data[idx]!, data[idx + 1]!, data[idx + 2]!, imageBg);
    if (dist > threshold) {
      mask[i] = 1;
      hasContent = true;
    }
  }

  if (!hasContent) return null;
  return { data: mask, sw, sh, scaleX: width / sw, scaleY: height / sh };
}

/** Prefer Media `frame` (2D canvas). Fall back to reading the bg texture. */
function buildContentMask(
  ctx: EngineContext,
  state: GridState,
  width: number,
  height: number,
  background: unknown,
  frame: FrameValue | null,
): ContentMask | null {
  const sw = Math.max(1, Math.min(width, 480));
  const sh = Math.max(1, Math.round((height * sw) / width));
  const mctx = ensureMaskScratch(state, sw, sh);
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.clearRect(0, 0, sw, sh);

  if (frame?.element && frame.width > 0 && frame.height > 0) {
    mctx.drawImage(frame.element, 0, 0, frame.width, frame.height, 0, 0, sw, sh);
    return buildContentMaskFromImage(mctx.getImageData(0, 0, sw, sh), width, height);
  }

  if (!isRenderTarget(background)) return null;
  if (!state.buffer) state.buffer = new PixelBuffer();

  const full = state.buffer.read(ctx.gl, background);
  state.buffer.syncToCanvas();
  mctx.drawImage(state.buffer.element, 0, 0, full.width, full.height, 0, 0, sw, sh);
  return buildContentMaskFromImage(mctx.getImageData(0, 0, sw, sh), width, height);
}

/**
 * Trims cells touching a canvas edge to the extreme content pixel within that
 * cell's band — local silhouette hug, not a global bbox (cv-reels).
 */
function trimCellsToContentEdge(
  cells: Cell[],
  mask: ContentMask,
  width: number,
  height: number,
  minSize: number,
): Cell[] {
  const edgeTol = 2;
  const { data, sw, sh, scaleX, scaleY } = mask;
  const trimmed: Cell[] = [];

  const toSampleX = (x: number) => Math.min(sw - 1, Math.max(0, Math.floor(x / scaleX)));
  const toSampleY = (y: number) => Math.min(sh - 1, Math.max(0, Math.floor(y / scaleY)));

  for (const cell of cells) {
    let { x, y, w, h } = cell;
    const right = x + w;
    const bottom = y + h;

    const sx0 = toSampleX(x);
    const sx1 = toSampleX(right - 1);
    const sy0 = toSampleY(y);
    const sy1 = toSampleY(bottom - 1);

    const touchesLeft = x <= edgeTol;
    const touchesRight = right >= width - edgeTol;
    const touchesTop = y <= edgeTol;
    const touchesBottom = bottom >= height - edgeTol;

    if (touchesLeft) {
      let minX = -1;
      for (let sxx = sx0; sxx <= sx1 && minX < 0; sxx += 1) {
        for (let syy = sy0; syy <= sy1; syy += 1) {
          if (data[syy * sw + sxx]) {
            minX = sxx;
            break;
          }
        }
      }
      if (minX < 0) continue;
      const clipLeft = Math.max(x, minX * scaleX);
      w = right - clipLeft;
      x = clipLeft;
    }

    if (touchesRight) {
      let maxX = -1;
      for (let sxx = sx1; sxx >= sx0 && maxX < 0; sxx -= 1) {
        for (let syy = sy0; syy <= sy1; syy += 1) {
          if (data[syy * sw + sxx]) {
            maxX = sxx;
            break;
          }
        }
      }
      if (maxX < 0) continue;
      const clipRight = Math.min(x + w, (maxX + 1) * scaleX);
      w = clipRight - x;
    }

    if (touchesTop) {
      let minY = -1;
      for (let syy = sy0; syy <= sy1 && minY < 0; syy += 1) {
        for (let sxx = sx0; sxx <= sx1; sxx += 1) {
          if (data[syy * sw + sxx]) {
            minY = syy;
            break;
          }
        }
      }
      if (minY < 0) continue;
      const clipTop = Math.max(y, minY * scaleY);
      h = bottom - clipTop;
      y = clipTop;
    }

    if (touchesBottom) {
      let maxY = -1;
      for (let syy = sy1; syy >= sy0 && maxY < 0; syy -= 1) {
        for (let sxx = sx0; sxx <= sx1; sxx += 1) {
          if (data[syy * sw + sxx]) {
            maxY = syy;
            break;
          }
        }
      }
      if (maxY < 0) continue;
      const clipBottom = Math.min(y + h, (maxY + 1) * scaleY);
      h = clipBottom - y;
    }

    if (w >= minSize && h >= minSize) {
      trimmed.push({ x, y, w, h });
    }
  }

  return trimmed;
}

/**
 * Recursively partitions the frame (a guillotine / k-d split) using feature
 * points as split positions, producing a Mondrian-like grid of leaf cells.
 * Ported from the cv-reels brand generator.
 */
function buildGrid(
  points: { x: number; y: number }[],
  width: number,
  height: number,
  maxDepth: number,
  minSize: number,
): Cell[] {
  const cells: Cell[] = [];

  const split = (rect: Cell, inside: { x: number; y: number }[], depth: number): void => {
    const tooSmall = rect.w < minSize * 2 || rect.h < minSize * 2;
    if (depth >= maxDepth || inside.length === 0 || tooSmall) {
      cells.push(rect);
      return;
    }

    // Always cut across the longer side, at the median point.
    const vertical = rect.w >= rect.h;
    const sorted = [...inside].sort((a, b) => (vertical ? a.x - b.x : a.y - b.y));
    const median = sorted[Math.floor(sorted.length / 2)];
    if (!median) {
      cells.push(rect);
      return;
    }

    if (vertical) {
      const splitX = Math.round(median.x);
      if (splitX - rect.x < minSize || rect.x + rect.w - splitX < minSize) {
        cells.push(rect);
        return;
      }
      const leftWidth = splitX - rect.x;
      split(
        { x: rect.x, y: rect.y, w: leftWidth, h: rect.h },
        inside.filter((p) => p.x < splitX),
        depth + 1,
      );
      split(
        { x: splitX, y: rect.y, w: rect.w - leftWidth, h: rect.h },
        inside.filter((p) => p.x >= splitX),
        depth + 1,
      );
    } else {
      const splitY = Math.round(median.y);
      if (splitY - rect.y < minSize || rect.y + rect.h - splitY < minSize) {
        cells.push(rect);
        return;
      }
      const topHeight = splitY - rect.y;
      split(
        { x: rect.x, y: rect.y, w: rect.w, h: topHeight },
        inside.filter((p) => p.y < splitY),
        depth + 1,
      );
      split(
        { x: rect.x, y: splitY, w: rect.w, h: rect.h - topHeight },
        inside.filter((p) => p.y >= splitY),
        depth + 1,
      );
    }
  };

  split({ x: 0, y: 0, w: width, h: height }, points, 0);
  return cells;
}

export const featuresGridNode = defineNode<GridState>({
  type: "draw.featuresGrid",
  label: "Features Grid",
  category: "draw",
  description: "Mondrian grid: frame recursively split by tracking points, with cell labels.",
  inputs: [
    { id: "bg", label: "bg", type: "texture" },
    { id: "frame", label: "frame", type: "frame" },
    { id: "points", label: "points", type: "points" },
  ],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "color", label: "Color", type: "color", default: "#f5f0e6" },
    { key: "maxDepth", label: "Depth", type: "range", min: 1, max: 8, step: 1, default: 5 },
    { key: "minSize", label: "Min cell", type: "range", min: 16, max: 300, step: 4, default: 64 },
    { key: "stroke", label: "Stroke", type: "range", min: 0.5, max: 8, step: 0.5, default: 1 },
    { key: "opacity", label: "Opacity", type: "range", min: 0, max: 1, step: 0.05, default: 1 },
    {
      key: "useContentEdge",
      label: "Use content edge",
      type: "toggle",
      default: false,
    },
    {
      key: "edgeInterval",
      label: "Edge mask every N frames",
      type: "range",
      min: 1,
      max: 8,
      step: 1,
      default: 1,
    },
    { key: "labels", label: "Labels", type: "toggle", default: true },
    { key: "labelSize", label: "Font size", type: "range", min: 8, max: 40, step: 1, default: 13 },
    { key: "labelText", label: "Text", type: "text", default: "Element" },
    { key: "effectChance", label: "Effect cell fraction", type: "range", min: 0, max: 1, step: 0.05, default: 0 },
    {
      key: "effectMinArea",
      label: "Effect min area",
      type: "range",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
    },
    {
      key: "effectMaxArea",
      label: "Effect max area",
      type: "range",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
    { key: "effectSeed", label: "Effect seed", type: "range", min: 0, max: 9999, step: 1, default: 42 },
  ],
  createState() {
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = 1;
    maskCanvas.height = 1;
    return {
      overlay: new CanvasOverlay(),
      buffer: new PixelBuffer(),
      maskCanvas,
      maskCtx: maskCanvas.getContext("2d", { willReadFrequently: true })!,
      mask: null,
      maskFrame: -1,
      maskW: 0,
      maskH: 0,
    };
  },
  disposeState(state) {
    state.overlay.dispose();
    state.buffer.dispose();
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const target = beginDraw(ctx, nodeId, inputs.bg ?? null);
    const data = inputs.points as PointsValue | null;
    if (!data || data.points.length === 0) return { out: target };

    const state = runtime.state;
    // HMR may keep an older createState() shape without buffer/mask scratch.
    if (!state.buffer) state.buffer = new PixelBuffer();
    if (!state.maskCanvas) {
      state.maskCanvas = document.createElement("canvas");
      state.maskCanvas.width = 1;
      state.maskCanvas.height = 1;
      state.maskCtx = state.maskCanvas.getContext("2d", { willReadFrequently: true })!;
    }

    const width = target.width;
    const height = target.height;
    const minSize = Math.max(8, paramNumber(params, "minSize", 64));
    let cells = buildGrid(
      data.points.map((point) => ({ x: point.x * width, y: point.y * height })),
      width,
      height,
      Math.round(paramNumber(params, "maxDepth", 5)),
      minSize,
    );

    const background = inputs.bg;
    const frame = inputs.frame as FrameValue | null;
    if (cells.length > 0 && paramBool(params, "useContentEdge", false)) {
      // Trimming stays per-frame — it is cheap and the cells move every frame.
      // Only the mask behind it is throttled. A resolution change invalidates it
      // outright, since its scale factors are tied to the frame it was built for.
      const edgeInterval = Math.max(1, Math.round(paramNumber(params, "edgeInterval", 1)));
      const stale =
        state.maskFrame < 0 ||
        state.maskW !== width ||
        state.maskH !== height ||
        ctx.frameCount - state.maskFrame >= edgeInterval;
      if (stale) {
        state.mask = buildContentMask(ctx, state, width, height, background, frame);
        state.maskFrame = ctx.frameCount;
        state.maskW = width;
        state.maskH = height;
      }
      if (state.mask) {
        cells = trimCellsToContentEdge(cells, state.mask, width, height, minSize);
      }
    }

    if (cells.length === 0) return { out: target };

    // Area window is relative to the largest cell this frame (0 = empty,
    // 1 = that largest cell). Then Effect cell fraction picks among survivors:
    // 1 → every cell in the band, <1 → seeded subset.
    const effectChance = Math.max(0, Math.min(1, paramNumber(params, "effectChance", 0)));
    let effectMinArea = Math.max(0, Math.min(1, paramNumber(params, "effectMinArea", 0)));
    let effectMaxArea = Math.max(0, Math.min(1, paramNumber(params, "effectMaxArea", 1)));
    if (effectMinArea > effectMaxArea) {
      const swap = effectMinArea;
      effectMinArea = effectMaxArea;
      effectMaxArea = swap;
    }
    if (effectChance > 0 && isRenderTarget(background)) {
      let largest = 0;
      for (const cell of cells) largest = Math.max(largest, cell.w * cell.h);
      largest = Math.max(1, largest);

      const seed = Math.round(paramNumber(params, "effectSeed", 42));
      const takeAll = effectChance >= 1 - 1e-6;
      for (let i = 0; i < cells.length; i += 1) {
        const cell = cells[i]!;
        const areaFrac = (cell.w * cell.h) / largest;
        if (areaFrac < effectMinArea || areaFrac > effectMaxArea) continue;
        if (!takeAll) {
          const roll = mulberry32(seed + (i + 1) * 374761 + 17 * 9973)();
          if (roll >= effectChance) continue;
        }
        smearCell(ctx, background, target, cell);
      }
    }

    const color = paramString(params, "color", "#f5f0e6");
    const stroke = paramNumber(params, "stroke", 1);
    const showLabels = paramBool(params, "labels", true);
    const labelSize = paramNumber(params, "labelSize", 13);
    const labelText = paramString(params, "labelText", "Element");
    const padding = Math.max(2, labelSize * 0.5);

    const overlay = state.overlay.begin(width, height);
    overlay.globalAlpha = paramNumber(params, "opacity", 1);
    overlay.strokeStyle = color;
    overlay.fillStyle = color;
    overlay.lineWidth = stroke;
    overlay.font = `${labelSize}px ui-sans-serif, system-ui, sans-serif`;
    overlay.textAlign = "left";
    overlay.textBaseline = "top";

    cells.forEach((cell, index) => {
      // Half-pixel offset keeps thin strokes crisp instead of straddling pixels.
      overlay.strokeRect(cell.x + 0.5, cell.y + 0.5, cell.w - 1, cell.h - 1);
      if (!showLabels) return;
      overlay.fillText(
        `${labelText} ${index + 1}`,
        cell.x + padding,
        cell.y + padding,
        Math.max(0, cell.w - padding * 2),
      );
    });

    state.overlay.commit(ctx, target);
    return { out: target };
  },
});
