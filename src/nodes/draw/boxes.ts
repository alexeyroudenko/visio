import { hexToRgb } from "../../engine/gl/program";
import { clearTarget } from "../../engine/gl/rt";
import { BatchBuilder, drawPoints, drawSegments, type BlendMode } from "../../engine/gl/vector";
import type { Box, BoxesValue, EngineContext } from "../../engine/types";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import { CanvasOverlay } from "../shared/canvasOverlay";
import { beginDraw, BLEND_PARAM } from "../shared/drawTarget";

interface BoxesState {
  batch: BatchBuilder;
  overlay: CanvasOverlay;
}

/** `person 87%`, `#3 87%`, or `person #3 87%` — whatever the detector filled in. */
function boxCaption(box: Box): string {
  const name = typeof box.label === "string" ? box.label.trim() : "";
  const pct = `${Math.round(Math.max(0, Math.min(1, box.score)) * 100)}%`;
  if (name && box.id != null) return `${name} #${box.id} ${pct}`;
  if (name) return `${name} ${pct}`;
  if (box.id != null) return `#${box.id} ${pct}`;
  return pct;
}

function paintLabels(
  overlay: CanvasRenderingContext2D,
  boxes: readonly Box[],
  width: number,
  height: number,
  color: string,
  fontSize: number,
  opacity: number,
  fade: boolean,
): void {
  overlay.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  overlay.textAlign = "left";
  overlay.textBaseline = "top";
  const padX = Math.max(3, fontSize * 0.35);
  const padY = Math.max(2, fontSize * 0.2);
  const rgb = hexToRgb(color);
  const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const textColor = luminance > 0.6 ? "#111111" : "#ffffff";

  for (const box of boxes) {
    const caption = boxCaption(box);
    if (!caption) continue;
    const alpha = fade ? Math.max(0.15, box.score) * opacity : opacity;
    const x = box.x * width;
    const y = box.y * height;
    const w = Math.max(0, box.w * width);
    const h = Math.max(0, box.h * height);
    if (w < 4 || h < 4) continue;
    const textW = overlay.measureText(caption).width;
    const barW = Math.min(w, textW + padX * 2);
    const barH = Math.min(h, fontSize + padY * 2);
    overlay.globalAlpha = alpha;
    overlay.fillStyle = color;
    overlay.fillRect(x, y, barW, barH);
    overlay.fillStyle = textColor;
    overlay.fillText(caption, x + padX, y + padY, Math.max(0, barW - padX * 2));
  }
  overlay.globalAlpha = 1;
}

function paintMask(
  ctx: EngineContext,
  nodeId: string,
  overlay: CanvasOverlay,
  boxes: readonly Box[],
  width: number,
  height: number,
) {
  const mask = ctx.target(nodeId, "mask");
  clearTarget(ctx.gl, mask, 0, 0, 0, 1);
  if (boxes.length === 0) return mask;
  const c2d = overlay.begin(width, height);
  c2d.fillStyle = "#ffffff";
  for (const box of boxes) {
    const x = box.x * width;
    const y = box.y * height;
    const w = box.w * width;
    const h = box.h * height;
    if (w <= 0 || h <= 0) continue;
    c2d.fillRect(x, y, w, h);
  }
  overlay.commit(ctx, mask);
  return mask;
}

export const drawBoxesNode = defineNode<BoxesState>({
  type: "draw.boxes",
  label: "Draw Boxes",
  category: "draw",
  description: "Detection boxes with optional labels; also a white mask of the same boxes.",
  inputs: [
    { id: "bg", label: "bg", type: "texture" },
    { id: "boxes", label: "boxes", type: "boxes" },
  ],
  outputs: [
    { id: "out", label: "texture", type: "texture" },
    { id: "mask", label: "mask", type: "texture" },
  ],
  params: [
    { key: "color", label: "Color", type: "color", default: "#ff5c7a" },
    { key: "width", label: "Stroke", type: "range", min: 0.5, max: 12, step: 0.5, default: 2 },
    { key: "opacity", label: "Opacity", type: "range", min: 0, max: 1, step: 0.05, default: 1 },
    { key: "scoreFade", label: "Fade by score", type: "toggle", default: true },
    { key: "centers", label: "Center point", type: "toggle", default: true },
    { key: "centerSize", label: "Point size", type: "range", min: 1, max: 30, step: 1, default: 8 },
    { key: "labels", label: "Labels", type: "toggle", default: true },
    { key: "labelSize", label: "Font size", type: "range", min: 8, max: 40, step: 1, default: 13 },
    BLEND_PARAM,
  ],
  createState() {
    return { batch: new BatchBuilder(), overlay: new CanvasOverlay() };
  },
  disposeState(state) {
    state.overlay.dispose();
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const target = beginDraw(ctx, nodeId, inputs.bg ?? null);
    const data = inputs.boxes as BoxesValue | null;
    const boxes = data?.boxes ?? [];
    if (!runtime.state.overlay) runtime.state.overlay = new CanvasOverlay();
    const overlay = runtime.state.overlay;

    if (boxes.length === 0) {
      return { out: target, mask: paintMask(ctx, nodeId, overlay, boxes, target.width, target.height) };
    }

    const { batch } = runtime.state;
    batch.reset();

    const width = target.width;
    const height = target.height;
    const opacity = paramNumber(params, "opacity", 1);
    const strokeWidth = paramNumber(params, "width", 2);
    const fade = paramBool(params, "scoreFade", true);
    const centers = paramBool(params, "centers", true);
    const centerSize = paramNumber(params, "centerSize", 8);
    const showLabels = paramBool(params, "labels", true);
    const labelSize = paramNumber(params, "labelSize", 13);
    const blend = paramString(params, "blend", "normal") as BlendMode;
    const colorHex = paramString(params, "color", "#ff5c7a");

    for (const box of boxes) {
      const alpha = fade ? Math.max(0.15, box.score) * opacity : opacity;
      const x = box.x * width;
      const y = box.y * height;
      const w = box.w * width;
      const h = box.h * height;
      batch.addRect(x, y, w, h, strokeWidth, alpha);
      if (centers) batch.addPoint(x + w / 2, y + h / 2, centerSize, alpha);
    }

    const color = hexToRgb(colorHex);
    drawSegments(ctx.gl, batch.segmentBatch(), { color, blend });
    drawPoints(ctx.gl, batch.pointBatch(), { color, blend });

    if (showLabels) {
      const c2d = overlay.begin(width, height);
      paintLabels(c2d, boxes, width, height, colorHex, labelSize, opacity, fade);
      overlay.commit(ctx, target);
    }

    return {
      out: target,
      mask: paintMask(ctx, nodeId, overlay, boxes, width, height),
    };
  },
});
