import { getProgram } from "../../engine/gl/program";
import { bindTexture, drawFullscreen, FULLSCREEN_VS } from "../../engine/gl/quad";
import { isRenderTarget, type RenderTarget } from "../../engine/gl/rt";
import type { EngineContext, PointsValue } from "../../engine/types";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import { CanvasOverlay } from "../shared/canvasOverlay";
import { beginDraw } from "../shared/drawTarget";
import { createLcg } from "../shared/rng";

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

interface GridState {
  overlay: CanvasOverlay;
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
    { id: "points", label: "points", type: "points" },
  ],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "color", label: "Color", type: "color", default: "#f5f0e6" },
    { key: "maxDepth", label: "Depth", type: "range", min: 1, max: 8, step: 1, default: 5 },
    { key: "minSize", label: "Min cell", type: "range", min: 16, max: 300, step: 4, default: 64 },
    { key: "stroke", label: "Stroke", type: "range", min: 0.5, max: 8, step: 0.5, default: 1 },
    { key: "opacity", label: "Opacity", type: "range", min: 0, max: 1, step: 0.05, default: 1 },
    { key: "labels", label: "Labels", type: "toggle", default: true },
    { key: "labelSize", label: "Font size", type: "range", min: 8, max: 40, step: 1, default: 13 },
    { key: "labelText", label: "Text", type: "text", default: "Element" },
    { key: "effectChance", label: "Effect cell fraction", type: "range", min: 0, max: 1, step: 0.05, default: 0 },
    { key: "effectSeed", label: "Effect seed", type: "range", min: 1, max: 999, step: 1, default: 42 },
  ],
  createState() {
    return { overlay: new CanvasOverlay() };
  },
  disposeState(state) {
    state.overlay.dispose();
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const target = beginDraw(ctx, nodeId, inputs.bg ?? null);
    const data = inputs.points as PointsValue | null;
    if (!data || data.points.length === 0) return { out: target };

    const width = target.width;
    const height = target.height;
    const cells = buildGrid(
      data.points.map((point) => ({ x: point.x * width, y: point.y * height })),
      width,
      height,
      Math.round(paramNumber(params, "maxDepth", 5)),
      Math.max(8, paramNumber(params, "minSize", 64)),
    );
    if (cells.length === 0) return { out: target };

    // Smear a seeded subset of cells before the strokes go on top.
    const effectChance = Math.max(0, Math.min(1, paramNumber(params, "effectChance", 0)));
    const background = inputs.bg;
    if (effectChance > 0 && isRenderTarget(background)) {
      const rng = createLcg(paramNumber(params, "effectSeed", 42));
      for (const cell of cells) {
        if (rng() < effectChance) smearCell(ctx, background, target, cell);
      }
    }

    const color = paramString(params, "color", "#f5f0e6");
    const stroke = paramNumber(params, "stroke", 1);
    const showLabels = paramBool(params, "labels", true);
    const labelSize = paramNumber(params, "labelSize", 13);
    const labelText = paramString(params, "labelText", "Element");
    const padding = Math.max(2, labelSize * 0.5);

    const overlay = runtime.state.overlay.begin(width, height);
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

    runtime.state.overlay.commit(ctx, target);
    return { out: target };
  },
});
