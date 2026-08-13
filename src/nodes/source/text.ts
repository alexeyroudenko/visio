import { clearTarget, isRenderTarget } from "../../engine/gl/rt";
import { welcomeText } from "../../lib/appVersion";
import { defineNode, paramNumber, paramString } from "../defineNode";
import { CanvasOverlay } from "../shared/canvasOverlay";
import { beginDraw } from "../shared/drawTarget";

const FONT = "Telegraf, system-ui, -apple-system, sans-serif";
/** Overlay CSS sizes are for a ~1080-tall card; scale from the shorter edge. */
const CARD = 1080;

interface TextState {
  overlay: CanvasOverlay;
}

interface LinePaint {
  text: string;
  size: number;
  weight: number;
  tracking: number;
  alpha: number;
  underline: boolean;
  gapAfter: number;
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function titleLines(raw: string[], unit: number): LinePaint[] {
  const mark = Math.max(24, 70 * unit);
  const small = Math.max(10, 13 * unit);
  const hint = Math.max(10, 14 * unit);
  const gap = 16 * unit;
  const brandGap = 8 * unit;
  const afterBrand = 12 * unit;

  if (raw.length === 0) return [];
  if (raw.length === 1) {
    return [
      { text: raw[0]!, size: mark, weight: 200, tracking: 0.06, alpha: 1, underline: false, gapAfter: 0 },
    ];
  }

  const out: LinePaint[] = raw.map((text, i) => {
    const last = i === raw.length - 1;
    if (i === 0) {
      return { text, size: mark, weight: 200, tracking: 0.06, alpha: 1, underline: false, gapAfter: brandGap };
    }
    if (i === 1) {
      return {
        text,
        size: small,
        weight: 400,
        tracking: 0.16,
        alpha: 0.44,
        underline: false,
        gapAfter: brandGap,
      };
    }
    if (last && raw.length >= 3) {
      return { text, size: small, weight: 400, tracking: 0.04, alpha: 1, underline: true, gapAfter: 0 };
    }
    const isHint = /drop /i.test(text);
    return {
      text,
      size: isHint ? hint : small,
      weight: 400,
      tracking: isHint ? 0.04 : 0.06,
      alpha: isHint ? 0.63 : 0.44,
      underline: false,
      gapAfter: last ? 0 : gap,
    };
  });
  if (out.length > 2) out[1]!.gapAfter = brandGap + afterBrand;
  return out;
}

function plainLines(raw: string[], unit: number): LinePaint[] {
  const size = Math.max(12, 48 * unit);
  const gap = size * 0.35;
  return raw.map((text, i) => ({
    text,
    size,
    weight: 400,
    tracking: 0.04,
    alpha: 1,
    underline: false,
    gapAfter: i === raw.length - 1 ? 0 : gap,
  }));
}

function setTracking(c2d: CanvasRenderingContext2D, px: string): void {
  try {
    c2d.letterSpacing = px;
  } catch {
    /* letterSpacing is missing on some 2d contexts — tracking is cosmetic */
  }
}

function paintCard(
  c2d: CanvasRenderingContext2D,
  width: number,
  height: number,
  raw: string[],
  opts: { layout: string; align: string; color: string; size: number; opacity: number },
): void {
  const unit = (Math.min(width, height) / CARD) * Math.max(0.05, opts.size);
  const lines = opts.layout === "plain" ? plainLines(raw, unit) : titleLines(raw, unit);
  if (lines.length === 0) return;

  const block = lines.reduce((sum, line) => sum + line.size + line.gapAfter, 0);
  const align: CanvasTextAlign =
    opts.align === "left" ? "left" : opts.align === "right" ? "right" : "center";
  const x = align === "left" ? width * 0.08 : align === "right" ? width * 0.92 : width * 0.5;

  c2d.textAlign = align;
  c2d.textBaseline = "middle";
  c2d.fillStyle = opts.color;

  let y = (height - block) / 2;
  for (const line of lines) {
    const mid = y + line.size / 2;
    const px = Math.max(1, Math.round(line.size));
    c2d.globalAlpha = opts.opacity * line.alpha;
    c2d.font = `${line.weight} ${px}px ${FONT}`;
    setTracking(c2d, `${line.tracking * px}px`);
    c2d.fillText(line.text, x, mid);
    if (line.underline && line.text.length > 0) {
      const w = c2d.measureText(line.text).width;
      const x0 = align === "left" ? x : align === "right" ? x - w : x - w / 2;
      c2d.fillRect(x0, mid + px * 0.38, w, Math.max(1, px * 0.06));
    }
    y += line.size + line.gapAfter;
  }
  setTracking(c2d, "0px");
  c2d.globalAlpha = 1;
}

export const textNode = defineNode<TextState>({
  type: "source.text",
  label: "Text",
  category: "source",
  description: "Title card — the empty-screen stack, or any multiline text on black (or over a background).",
  inputs: [{ id: "bg", label: "bg", type: "texture" }],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "text", label: "Text", type: "code", rows: 8, default: welcomeText() },
    {
      key: "layout",
      label: "Layout",
      type: "select",
      options: [
        { value: "title", label: "title card" },
        { value: "plain", label: "plain" },
      ],
      default: "title",
    },
    {
      key: "align",
      label: "Align",
      type: "select",
      options: [
        { value: "center", label: "center" },
        { value: "left", label: "left" },
        { value: "right", label: "right" },
      ],
      default: "center",
    },
    { key: "color", label: "Color", type: "color", default: "#ffffff" },
    { key: "size", label: "Size", type: "range", min: 0.25, max: 3, step: 0.05, default: 1 },
    { key: "opacity", label: "Opacity", type: "range", min: 0, max: 1, step: 0.05, default: 1 },
  ],
  createState() {
    return { overlay: new CanvasOverlay() };
  },
  disposeState(state) {
    state.overlay.dispose();
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const bg = inputs.bg ?? null;
    const target = beginDraw(ctx, nodeId, bg);
    if (!isRenderTarget(bg)) clearTarget(ctx.gl, target, 0, 0, 0, 1);

    const text = paramString(params, "text", welcomeText());
    const lines = splitLines(text);
    if (lines.every((line) => line.length === 0)) return { out: target };

    const c2d = runtime.state.overlay.begin(target.width, target.height);
    paintCard(c2d, target.width, target.height, lines, {
      layout: paramString(params, "layout", "title"),
      align: paramString(params, "align", "center"),
      color: paramString(params, "color", "#ffffff"),
      size: paramNumber(params, "size", 1),
      opacity: Math.max(0, Math.min(1, paramNumber(params, "opacity", 1))),
    });
    runtime.state.overlay.commit(ctx, target);
    return { out: target };
  },
});
