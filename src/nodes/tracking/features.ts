import type { FrameValue, PointsValue } from "../../engine/types";
import { defineNode, paramNumber } from "../defineNode";
import { GrayFrame } from "../shared/grayscale";

interface FeaturesState {
  frame: GrayFrame;
  lastFrameId: number;
  lastResult: PointsValue;
}

const EMPTY: PointsValue = { points: [] };

/**
 * Shi–Tomasi corners (the goodFeaturesToTrack idea) over a downscaled
 * grayscale copy of the frame. Ported from the cv-reels tracker.
 */
export const featuresNode = defineNode<FeaturesState>({
  type: "tracking.features",
  label: "Corners",
  category: "tracking",
  description: "Shi–Tomasi corners on the frame: a point cloud that reacts to texture.",
  inputs: [{ id: "frame", label: "frame", type: "frame" }],
  outputs: [{ id: "out", label: "points", type: "points" }],
  params: [
    { key: "downscale", label: "Downscale", type: "range", min: 2, max: 8, step: 1, default: 4 },
    { key: "block", label: "Window", type: "range", min: 3, max: 15, step: 2, default: 7 },
    { key: "maxCorners", label: "Max points", type: "range", min: 10, max: 600, step: 10, default: 200 },
    { key: "quality", label: "Quality", type: "range", min: 0.01, max: 0.5, step: 0.01, default: 0.08 },
    { key: "minDistance", label: "Min distance", type: "range", min: 2, max: 60, step: 1, default: 12 },
  ],
  createState() {
    return { frame: new GrayFrame(), lastFrameId: -1, lastResult: EMPTY };
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const state = runtime.state;
    const frame = inputs.frame as FrameValue | null;
    if (!frame) {
      ctx.report(nodeId, "idle", "connect a frame from a source");
      return { out: EMPTY };
    }
    if (frame.frameId === state.lastFrameId) return { out: state.lastResult };
    state.lastFrameId = frame.frameId;
    ctx.report(nodeId, "ready", null);

    const factor = Math.max(2, Math.round(paramNumber(params, "downscale", 4)));
    state.frame.update(frame, factor);
    const { width, height, gradX, gradY } = state.frame;

    const block = Math.max(3, Math.round(paramNumber(params, "block", 7)) | 1);
    const half = block >> 1;
    const responses: { x: number; y: number; score: number }[] = [];

    for (let y = half + 1; y < height - half - 1; y += half) {
      for (let x = half + 1; x < width - half - 1; x += half) {
        let sumXX = 0;
        let sumYY = 0;
        let sumXY = 0;
        for (let dy = -half; dy <= half; dy += 1) {
          for (let dx = -half; dx <= half; dx += 1) {
            const i = (y + dy) * width + (x + dx);
            const ix = gradX[i];
            const iy = gradY[i];
            sumXX += ix * ix;
            sumYY += iy * iy;
            sumXY += ix * iy;
          }
        }
        const trace = sumXX + sumYY;
        const det = sumXX * sumYY - sumXY * sumXY;
        const disc = trace * trace - 4 * det;
        if (disc < 0) continue;
        // Smaller eigenvalue of the structure tensor — the Shi–Tomasi score.
        const lambdaMin = (trace - Math.sqrt(disc)) / (2 * block * block);
        if (lambdaMin > 0) responses.push({ x, y, score: lambdaMin });
      }
    }

    if (responses.length === 0) {
      state.lastResult = EMPTY;
      return { out: EMPTY };
    }

    responses.sort((a, b) => b.score - a.score);
    const maxScore = responses[0].score;
    const minScore = maxScore * paramNumber(params, "quality", 0.08);
    const maxCorners = Math.round(paramNumber(params, "maxCorners", 200));
    // Distance is a UI value in output pixels; compare in downscaled space.
    const minDist = paramNumber(params, "minDistance", 12) / factor;
    const minDistSq = minDist * minDist;

    const kept: { x: number; y: number; score: number }[] = [];
    for (const candidate of responses) {
      if (candidate.score < minScore) break;
      if (kept.length >= maxCorners) break;
      let tooClose = false;
      for (const other of kept) {
        const dx = other.x - candidate.x;
        const dy = other.y - candidate.y;
        if (dx * dx + dy * dy < minDistSq) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) kept.push(candidate);
    }

    state.lastResult = {
      points: kept.map((point) => ({
        x: point.x / width,
        y: point.y / height,
        score: point.score / maxScore,
      })),
    };
    return { out: state.lastResult };
  },
});
