import type { CirclesValue, FrameValue } from "../../engine/types";
import { defineNode, paramNumber } from "../defineNode";
import { GrayFrame } from "../shared/grayscale";

interface CirclesState {
  frame: GrayFrame;
  lastFrameId: number;
  lastResult: CirclesValue;
  accumulator: Float32Array;
  smoothed: Float32Array;
  histogram: Float32Array;
}

const EMPTY: CirclesValue = { circles: [] };
const MAX_EDGES = 20_000;

/**
 * Hough gradient method — the OpenCV HoughCircles (HOUGH_GRADIENT) approach.
 *
 * Stage 1: each edge point votes for centers along its gradient direction, both
 * ways, across the radius range. Stage 2: accumulator peaks become centers, and
 * each center picks its radius from a histogram of edge distances. Voting into
 * exact (cx, cy, r) bins would be far too sparse to ever clear a threshold.
 */
export const houghCirclesNode = defineNode<CirclesState>({
  type: "tracking.circles",
  label: "Hough Circles",
  category: "tracking",
  description: "Круги по градиентному Хафу: центры и радиусы округлых форм.",
  inputs: [{ id: "frame", label: "frame", type: "frame" }],
  outputs: [{ id: "out", label: "circles", type: "circles" }],
  params: [
    { key: "downscale", label: "Даунскейл", type: "range", min: 2, max: 8, step: 1, default: 4 },
    { key: "edgeThreshold", label: "Порог краёв", type: "range", min: 20, max: 300, step: 5, default: 90 },
    { key: "votes", label: "Порог голосов", type: "range", min: 5, max: 200, step: 1, default: 40 },
    { key: "minRadius", label: "Радиус мин.", type: "range", min: 4, max: 200, step: 2, default: 16 },
    { key: "maxRadius", label: "Радиус макс.", type: "range", min: 8, max: 400, step: 2, default: 120 },
    { key: "minDistance", label: "Мин. дистанция", type: "range", min: 4, max: 300, step: 2, default: 40 },
    { key: "maxCircles", label: "Кругов макс.", type: "range", min: 1, max: 40, step: 1, default: 10 },
    { key: "interval", label: "Раз в N кадров", type: "range", min: 1, max: 8, step: 1, default: 2 },
  ],
  createState() {
    return {
      frame: new GrayFrame(),
      lastFrameId: -1,
      lastResult: EMPTY,
      accumulator: new Float32Array(0),
      smoothed: new Float32Array(0),
      histogram: new Float32Array(0),
    };
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const state = runtime.state;
    const frame = inputs.frame as FrameValue | null;
    if (!frame) {
      ctx.report(nodeId, "idle", "подключи frame от источника");
      return { out: EMPTY };
    }

    const interval = Math.max(1, Math.round(paramNumber(params, "interval", 2)));
    if (frame.frameId === state.lastFrameId || ctx.frameCount % interval !== 0) {
      return { out: state.lastResult };
    }
    state.lastFrameId = frame.frameId;
    ctx.report(nodeId, "ready", null);

    const factor = Math.max(2, Math.round(paramNumber(params, "downscale", 4)));
    state.frame.update(frame, factor);
    const { width, height } = state.frame;

    const edges = state.frame.collectEdges(
      paramNumber(params, "edgeThreshold", 90),
      MAX_EDGES,
    );
    if (edges.length === 0) {
      state.lastResult = EMPTY;
      return { out: EMPTY };
    }

    const minR = Math.max(2, Math.round(paramNumber(params, "minRadius", 16) / factor));
    const maxR = Math.max(minR + 1, Math.round(paramNumber(params, "maxRadius", 120) / factor));
    const minDist = Math.max(2, paramNumber(params, "minDistance", 40) / factor);

    const size = width * height;
    if (state.accumulator.length !== size) {
      state.accumulator = new Float32Array(size);
      state.smoothed = new Float32Array(size);
    }
    const acc = state.accumulator;
    const smooth = state.smoothed;
    acc.fill(0);

    for (const edge of edges) {
      for (let dir = -1; dir <= 1; dir += 2) {
        const stepX = edge.ux * dir;
        const stepY = edge.uy * dir;
        let cx = edge.x + stepX * minR;
        let cy = edge.y + stepY * minR;
        for (let r = minR; r <= maxR; r += 1) {
          const ax = cx | 0;
          const ay = cy | 0;
          if (ax >= 0 && ay >= 0 && ax < width && ay < height) acc[ay * width + ax] += 1;
          cx += stepX;
          cy += stepY;
        }
      }
    }

    // Box-blur the accumulator so votes scattered by gradient noise and radius
    // quantization reinforce one peak instead of several weak neighbours.
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            sum += acc[yy * width + xx];
          }
        }
        smooth[y * width + x] = sum;
      }
    }

    const threshold = paramNumber(params, "votes", 40);
    const peaks: { x: number; y: number; votes: number }[] = [];
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const value = smooth[y * width + x];
        if (value < threshold) continue;
        let isPeak = true;
        for (let dy = -1; dy <= 1 && isPeak; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            if (smooth[(y + dy) * width + (x + dx)] > value) {
              isPeak = false;
              break;
            }
          }
        }
        if (isPeak) peaks.push({ x, y, votes: value });
      }
    }

    if (peaks.length === 0) {
      state.lastResult = EMPTY;
      return { out: EMPTY };
    }

    peaks.sort((a, b) => b.votes - a.votes);

    const maxCircles = Math.round(paramNumber(params, "maxCircles", 10));
    const minDistSq = minDist * minDist;
    const accepted: { x: number; y: number; votes: number }[] = [];
    for (const peak of peaks) {
      if (accepted.length >= maxCircles) break;
      let tooClose = false;
      for (const other of accepted) {
        const dx = other.x - peak.x;
        const dy = other.y - peak.y;
        if (dx * dx + dy * dy < minDistSq) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) accepted.push(peak);
    }

    if (state.histogram.length !== maxR + 2) state.histogram = new Float32Array(maxR + 2);
    const histogram = state.histogram;
    const maxVotes = accepted[0]?.votes || 1;
    const minRSq = minR * minR;
    const maxRSq = maxR * maxR;
    const circles: CirclesValue["circles"] = [];

    for (const center of accepted) {
      histogram.fill(0);
      for (const edge of edges) {
        const dx = edge.x - center.x;
        const dy = edge.y - center.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < minRSq || distSq > maxRSq) continue;
        const r = Math.round(Math.sqrt(distSq));
        if (r >= minR && r <= maxR) histogram[r] += 1;
      }

      let bestR = minR;
      let bestCount = 0;
      for (let r = minR; r <= maxR; r += 1) {
        // Sum a small window so a soft distance peak isn't missed.
        const count = (histogram[r - 1] ?? 0) + histogram[r] + (histogram[r + 1] ?? 0);
        if (count > bestCount) {
          bestCount = count;
          bestR = r;
        }
      }
      if (bestCount <= 0) continue;

      circles.push({
        x: center.x / width,
        y: center.y / height,
        r: bestR / width,
        score: Math.min(1, center.votes / maxVotes),
      });
    }

    state.lastResult = { circles };
    return { out: state.lastResult };
  },
});
