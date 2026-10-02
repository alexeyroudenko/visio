import type { Landmark, LandmarksValue } from "../../engine/types";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import { CanvasOverlay } from "../shared/canvasOverlay";
import { beginDraw } from "../shared/drawTarget";
import {
  analyzePose,
  POSE_STATE_LABELS,
  POSE_STATE_PRIORITY,
  type PoseStateId,
} from "./skeletonAnalyzeClassifiers";
import { POSE_LEN } from "./skeletonAnalyzeFeatures";

interface AnalyzeState {
  overlay: CanvasOverlay;
  /** Per-subject ring buffers, oldest → newest. */
  history: Map<number, Landmark[][]>;
  holdId: PoseStateId | null;
  holdLeft: number;
  lastConfidence: number;
}

function clonePose(set: Landmark[]): Landmark[] {
  return set.map((lm) => ({ x: lm.x, y: lm.y, z: lm.z, score: lm.score }));
}

function pushHistory(
  map: Map<number, Landmark[][]>,
  subject: number,
  set: Landmark[],
  maxLen: number,
): Landmark[][] {
  let buf = map.get(subject);
  if (!buf) {
    buf = [];
    map.set(subject, buf);
  }
  buf.push(clonePose(set));
  while (buf.length > maxLen) buf.shift();
  return buf;
}

/**
 * Pose action classifier: MediaPipe 33-point skeleton → label overlaid on the
 * incoming texture (стоит / идёт / танцует / …).
 */
export const skeletonAnalyzeNode = defineNode<AnalyzeState>({
  type: "tracking.skeletonAnalyze",
  label: "Skeleton Analyze",
  category: "tracking",
  description:
    "Classifies BlazePose (33) into stand / walk / dance / sit / lie / squat / run / jump / bend / fall and draws the label.",
  inputs: [
    { id: "bg", label: "bg", type: "texture" },
    { id: "landmarks", label: "landmarks", type: "landmarks" },
  ],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    {
      key: "subject",
      label: "Subject",
      type: "range",
      min: 0,
      max: 4,
      step: 1,
      default: 0,
    },
    {
      key: "minScore",
      label: "Min landmark score",
      type: "range",
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.2,
    },
    {
      key: "historyFrames",
      label: "History frames",
      type: "range",
      min: 8,
      max: 90,
      step: 1,
      default: 24,
    },
    {
      key: "minConfidence",
      label: "Min confidence",
      type: "range",
      min: 0.1,
      max: 0.9,
      step: 0.05,
      default: 0.35,
    },
    {
      key: "holdFrames",
      label: "Hold frames",
      type: "range",
      min: 0,
      max: 45,
      step: 1,
      default: 8,
    },
    {
      key: "showConfidence",
      label: "Show confidence",
      type: "toggle",
      default: true,
    },
    {
      key: "showScores",
      label: "Show all scores",
      type: "toggle",
      default: false,
    },
    { key: "color", label: "Color", type: "color", default: "#f5f0e6" },
    {
      key: "fontSize",
      label: "Font size",
      type: "range",
      min: 12,
      max: 96,
      step: 1,
      default: 54,
    },
    {
      key: "opacity",
      label: "Opacity",
      type: "range",
      min: 0,
      max: 1,
      step: 0.05,
      default: 1,
    },
    {
      key: "align",
      label: "Align",
      type: "select",
      options: [
        { value: "top-left", label: "top left" },
        { value: "top-center", label: "top center" },
        { value: "top-right", label: "top right" },
        { value: "bottom-left", label: "bottom left" },
        { value: "bottom-center", label: "bottom center" },
        { value: "bottom-right", label: "bottom right" },
      ],
      default: "bottom-center",
    },
    {
      key: "margin",
      label: "Margin",
      type: "range",
      min: 0,
      max: 120,
      step: 2,
      default: 24,
    },
    {
      key: "bottomInset",
      label: "Bottom inset",
      type: "range",
      min: 0,
      max: 0.5,
      step: 0.01,
      default: 0.3,
    },
  ],
  createState() {
    return {
      overlay: new CanvasOverlay(),
      history: new Map(),
      holdId: null,
      holdLeft: 0,
      lastConfidence: 0,
    };
  },
  disposeState(state) {
    state.overlay.dispose();
    state.history.clear();
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const target = beginDraw(ctx, nodeId, inputs.bg ?? null);
    const data = inputs.landmarks as LandmarksValue | null;
    const state = runtime.state;
    const width = target.width;
    const height = target.height;

    const subject = Math.round(paramNumber(params, "subject", 0));
    const minScore = paramNumber(params, "minScore", 0.2);
    const historyFrames = Math.round(paramNumber(params, "historyFrames", 24));
    const minConfidence = paramNumber(params, "minConfidence", 0.35);
    const holdFrames = Math.round(paramNumber(params, "holdFrames", 8));
    const showConfidence = paramBool(params, "showConfidence", true);
    const showScores = paramBool(params, "showScores", false);

    let label = "—";
    let confidence = 0;
    let scoreLines: string[] = [];

    const set =
      data && subject >= 0 && subject < data.sets.length ? data.sets[subject]! : null;

    if (set && set.length >= POSE_LEN) {
      const history = pushHistory(state.history, subject, set, historyFrames);
      const analysis = analyzePose(set, history, minConfidence, minScore);

      if (analysis.id) {
        state.holdId = analysis.id;
        state.holdLeft = holdFrames;
        label = analysis.label;
        confidence = analysis.confidence;
      } else if (state.holdId && state.holdLeft > 0) {
        state.holdLeft -= 1;
        label = POSE_STATE_LABELS[state.holdId];
        confidence = state.lastConfidence;
      } else {
        state.holdId = null;
        label = "—";
        confidence = 0;
      }

      state.lastConfidence = confidence;

      if (showScores) {
        scoreLines = POSE_STATE_PRIORITY.map((id) => {
          const r = analysis.scores[id];
          const mark = r.match ? "●" : "·";
          return `${mark} ${POSE_STATE_LABELS[id]}  ${Math.round(r.confidence * 100)}%`;
        });
      }
    } else {
      state.holdId = null;
      state.holdLeft = 0;
      label = "no skeleton";
      confidence = 0;
    }

    const headline =
      showConfidence && confidence > 0
        ? `${label}  ${Math.round(confidence * 100)}%`
        : label;

    const color = paramString(params, "color", "#f5f0e6");
    const fontSize = paramNumber(params, "fontSize", 54);
    const opacity = paramNumber(params, "opacity", 1);
    const align = paramString(params, "align", "bottom-center");
    const margin = paramNumber(params, "margin", 24);
    const bottomInset = Math.min(0.5, Math.max(0, paramNumber(params, "bottomInset", 0.3)));

    const overlay = state.overlay.begin(width, height);
    overlay.globalAlpha = opacity;
    overlay.textBaseline = "top";

    const lines = showScores && scoreLines.length > 0 ? [headline, ...scoreLines] : [headline];
    const scoreLineH = Math.max(12, fontSize * 0.45) * 1.25;
    const blockH = fontSize * 1.2 + (lines.length - 1) * scoreLineH;
    const fromBottom = align.startsWith("bottom");
    // Bottom placements: baseline at 30% from the bottom, horizontally centered.
    const startY = fromBottom
      ? height * (1 - bottomInset) - blockH * 0.5
      : margin;

    for (let i = 0; i < lines.length; i += 1) {
      const text = lines[i]!;
      const size = i === 0 ? fontSize : Math.max(12, fontSize * 0.45);
      overlay.font =
        i === 0
          ? `600 ${size}px ui-sans-serif, system-ui, sans-serif`
          : `400 ${size}px ui-sans-serif, system-ui, sans-serif`;
      const textW = overlay.measureText(text).width;
      let x = margin;
      if (align.endsWith("center")) x = (width - textW) * 0.5;
      else if (align.endsWith("right")) x = width - margin - textW;
      const y = startY + (i === 0 ? 0 : fontSize * 1.2 + (i - 1) * scoreLineH);
      overlay.fillStyle = "rgba(0,0,0,0.55)";
      overlay.fillText(text, x + 1, y + 1);
      overlay.fillStyle = color;
      overlay.fillText(text, x, y);
    }

    state.overlay.commit(ctx, target);
    return { out: target };
  },
});
