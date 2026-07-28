import type { FrameValue, LinesValue } from "../../engine/types";
import { defineNode, paramNumber } from "../defineNode";
import { GrayFrame, type EdgePoint } from "../shared/grayscale";

interface LinesState {
  frame: GrayFrame;
  lastFrameId: number;
  lastResult: LinesValue;
  accumulator: Int32Array;
  cosTable: Float32Array;
  sinTable: Float32Array;
  tableSize: number;
}

const EMPTY: LinesValue = { lines: [] };
const MAX_EDGES = 20_000;

/** Probabilistic Hough transform — the OpenCV HoughLinesP approach. */
export const houghLinesNode = defineNode<LinesState>({
  type: "tracking.lines",
  label: "Hough Lines",
  category: "tracking",
  description: "Segments via probabilistic Hough: edges, walls, object boundaries.",
  inputs: [{ id: "frame", label: "frame", type: "frame" }],
  outputs: [{ id: "out", label: "lines", type: "lines" }],
  params: [
    { key: "downscale", label: "Downscale", type: "range", min: 2, max: 8, step: 1, default: 4 },
    { key: "edgeThreshold", label: "Edge threshold", type: "range", min: 20, max: 300, step: 5, default: 80 },
    { key: "votes", label: "Vote threshold", type: "range", min: 10, max: 200, step: 1, default: 40 },
    { key: "thetaStep", label: "Angle step °", type: "range", min: 0.5, max: 5, step: 0.5, default: 1 },
    { key: "minLength", label: "Min length", type: "range", min: 10, max: 500, step: 5, default: 60 },
    { key: "maxGap", label: "Max gap", type: "range", min: 1, max: 60, step: 1, default: 12 },
    { key: "maxLines", label: "Max lines", type: "range", min: 1, max: 60, step: 1, default: 16 },
    { key: "interval", label: "Every N frames", type: "range", min: 1, max: 8, step: 1, default: 2 },
  ],
  createState() {
    return {
      frame: new GrayFrame(),
      lastFrameId: -1,
      lastResult: EMPTY,
      accumulator: new Int32Array(0),
      cosTable: new Float32Array(0),
      sinTable: new Float32Array(0),
      tableSize: 0,
    };
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const state = runtime.state;
    const frame = inputs.frame as FrameValue | null;
    if (!frame) {
      ctx.report(nodeId, "idle", "connect a frame from a source");
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
      paramNumber(params, "edgeThreshold", 80),
      MAX_EDGES,
    );
    if (edges.length === 0) {
      state.lastResult = EMPTY;
      return { out: EMPTY };
    }

    const rhoStep = 1;
    const thetaStep = (paramNumber(params, "thetaStep", 1) * Math.PI) / 180;
    const numTheta = Math.max(2, Math.ceil(Math.PI / thetaStep));
    const maxRho = Math.ceil(Math.hypot(width, height));
    const rhoBins = Math.ceil((maxRho * 2) / rhoStep) + 1;
    const rhoOffset = Math.floor(rhoBins / 2);

    if (state.tableSize !== numTheta) {
      state.cosTable = new Float32Array(numTheta);
      state.sinTable = new Float32Array(numTheta);
      for (let t = 0; t < numTheta; t += 1) {
        state.cosTable[t] = Math.cos(t * thetaStep);
        state.sinTable[t] = Math.sin(t * thetaStep);
      }
      state.tableSize = numTheta;
    }
    const { cosTable, sinTable } = state;

    const accSize = rhoBins * numTheta;
    if (state.accumulator.length !== accSize) state.accumulator = new Int32Array(accSize);
    const acc = state.accumulator;
    acc.fill(0);

    for (const edge of edges) {
      for (let t = 0; t < numTheta; t += 1) {
        const rho = edge.x * cosTable[t] + edge.y * sinTable[t];
        const ri = Math.round(rho / rhoStep) + rhoOffset;
        if (ri >= 0 && ri < rhoBins) acc[ri * numTheta + t] += 1;
      }
    }

    const threshold = paramNumber(params, "votes", 40);
    const candidates: { ri: number; theta: number; votes: number }[] = [];
    for (let ri = 1; ri < rhoBins - 1; ri += 1) {
      for (let t = 0; t < numTheta; t += 1) {
        const votes = acc[ri * numTheta + t];
        if (votes < threshold) continue;
        // Keep only local maxima; theta wraps around at ±π.
        const prev = t === 0 ? numTheta - 1 : t - 1;
        const next = t === numTheta - 1 ? 0 : t + 1;
        if (
          votes < acc[(ri - 1) * numTheta + t] ||
          votes < acc[(ri + 1) * numTheta + t] ||
          votes < acc[ri * numTheta + prev] ||
          votes < acc[ri * numTheta + next]
        ) {
          continue;
        }
        candidates.push({ ri, theta: t, votes });
      }
    }

    if (candidates.length === 0) {
      state.lastResult = EMPTY;
      return { out: EMPTY };
    }
    candidates.sort((a, b) => b.votes - a.votes);

    const maxLines = Math.round(paramNumber(params, "maxLines", 16));
    const minLength = paramNumber(params, "minLength", 60) / factor;
    const maxGap = paramNumber(params, "maxGap", 12) / factor;
    const lines: LinesValue["lines"] = [];
    const maxCandidates = Math.max(maxLines * 8, 64);

    const pushSegment = (start: EdgePoint, end: EdgePoint, votes: number): void => {
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      if (length < minLength) return;
      lines.push({
        x1: start.x / width,
        y1: start.y / height,
        x2: end.x / width,
        y2: end.y / height,
        score: Math.min(1, votes / (threshold * 3)),
      });
    };

    for (let ci = 0; ci < candidates.length && ci < maxCandidates; ci += 1) {
      if (lines.length >= maxLines) break;
      const { ri, theta, votes } = candidates[ci];
      const rho = (ri - rhoOffset) * rhoStep;
      const cosT = cosTable[theta];
      const sinT = sinTable[theta];

      const onLine = edges.filter(
        (edge) => Math.abs(edge.x * cosT + edge.y * sinT - rho) < rhoStep * 1.5,
      );
      if (onLine.length < 2) continue;

      // Walk the edge points along the line and cut at gaps.
      const dirX = -sinT;
      const dirY = cosT;
      onLine.sort((a, b) => a.x * dirX + a.y * dirY - (b.x * dirX + b.y * dirY));

      let segStart = onLine[0];
      let segEnd = segStart;
      for (let i = 1; i < onLine.length; i += 1) {
        const point = onLine[i];
        if (Math.hypot(point.x - segEnd.x, point.y - segEnd.y) <= maxGap) {
          segEnd = point;
        } else {
          pushSegment(segStart, segEnd, votes);
          if (lines.length >= maxLines) break;
          segStart = point;
          segEnd = point;
        }
      }
      if (lines.length < maxLines) pushSegment(segStart, segEnd, votes);
    }

    state.lastResult = { lines };
    return { out: state.lastResult };
  },
});
