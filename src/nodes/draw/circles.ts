import { hexToRgb } from "../../engine/gl/program";
import { BatchBuilder, drawPoints, type BlendMode } from "../../engine/gl/vector";
import type { CirclesValue } from "../../engine/types";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import { beginDraw, BLEND_PARAM } from "../shared/drawTarget";

interface CirclesState {
  batch: BatchBuilder;
}

export const drawCirclesNode = defineNode<CirclesState>({
  type: "draw.circles",
  label: "Draw Circles",
  category: "draw",
  description: "Окружности из детекции: контур или заливка, радиус можно масштабировать.",
  inputs: [
    { id: "bg", label: "bg", type: "texture" },
    { id: "circles", label: "circles", type: "circles" },
  ],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "color", label: "Цвет", type: "color", default: "#8fd6ff" },
    { key: "thickness", label: "Толщина", type: "range", min: 0.5, max: 20, step: 0.5, default: 2 },
    { key: "fill", label: "Заливка", type: "toggle", default: false },
    { key: "radiusScale", label: "Радиус ×", type: "range", min: 0.1, max: 3, step: 0.05, default: 1 },
    { key: "opacity", label: "Прозрачность", type: "range", min: 0, max: 1, step: 0.05, default: 1 },
    { key: "scoreFade", label: "Гасить по score", type: "toggle", default: true },
    BLEND_PARAM,
  ],
  createState() {
    return { batch: new BatchBuilder() };
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const target = beginDraw(ctx, nodeId, inputs.bg ?? null);
    const data = inputs.circles as CirclesValue | null;
    if (!data || data.circles.length === 0) return { out: target };

    const { batch } = runtime.state;
    batch.reset();

    const width = target.width;
    const height = target.height;
    const opacity = paramNumber(params, "opacity", 1);
    const fade = paramBool(params, "scoreFade", true);
    const radiusScale = paramNumber(params, "radiusScale", 1);
    const fill = paramBool(params, "fill", false);
    const thickness = paramNumber(params, "thickness", 2);

    for (const circle of data.circles) {
      const alpha = fade ? Math.max(0.15, circle.score) * opacity : opacity;
      if (alpha <= 0.01) continue;
      // Radius arrives as a fraction of width; the point shader wants px.
      const radius = Math.max(1, circle.r * width * radiusScale);
      batch.addPoint(circle.x * width, circle.y * height, radius, alpha);
    }

    drawPoints(ctx.gl, batch.pointBatch(), {
      color: hexToRgb(paramString(params, "color", "#8fd6ff")),
      blend: paramString(params, "blend", "normal") as BlendMode,
      thickness: fill ? 0 : thickness,
      softness: 0.15,
    });

    return { out: target };
  },
});
