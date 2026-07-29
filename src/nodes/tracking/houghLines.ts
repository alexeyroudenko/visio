import type { FrameValue, LinesValue } from "../../engine/types";
import { defineNode, paramBool, paramNumber } from "../defineNode";
import { GrayFrame } from "../shared/grayscale";
import { paramsKey } from "../shared/paramsKey";
import { collectEdges, linesFromEdges, MAX_EDGES, type LineOptions } from "./houghAlgorithms";
import { HoughJob } from "./houghClient";

interface LinesState {
  frame: GrayFrame;
  lastFrameId: number;
  lastResult: LinesValue;
  paramsFingerprint: string;
  job: HoughJob | null;
}

const EMPTY: LinesValue = { lines: [] };

/**
 * Probabilistic Hough lines. Like the circles node, the transform lives in
 * `houghAlgorithms` and runs either inline or on the shared worker.
 */
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
    { key: "worker", label: "Run in worker", type: "toggle", default: true },
  ],
  createState() {
    return {
      frame: new GrayFrame(),
      lastFrameId: -1,
      lastResult: EMPTY,
      paramsFingerprint: "",
      job: null,
    };
  },
  disposeState(state) {
    state.job?.dispose();
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const state = runtime.state;
    const frame = inputs.frame as FrameValue | null;
    if (!frame) {
      ctx.report(nodeId, "idle", "connect a frame from a source");
      return { out: EMPTY };
    }

    const fingerprint = paramsKey(params);
    if (fingerprint !== state.paramsFingerprint) {
      state.paramsFingerprint = fingerprint;
      state.lastFrameId = -1;
      state.job?.cancel();
    }

    const interval = Math.max(1, Math.round(paramNumber(params, "interval", 2)));
    if (frame.frameId === state.lastFrameId) return { out: state.lastResult };
    if (state.lastFrameId >= 0 && ctx.frameCount % interval !== 0) {
      return { out: state.lastResult };
    }

    const useWorker = paramBool(params, "worker", true);
    if (!state.job) {
      state.job = new HoughJob(nodeId, (response) => {
        if (response.kind === "lines") state.lastResult = response.value;
      });
    }
    if (useWorker && state.job.busy) return { out: state.lastResult };

    state.lastFrameId = frame.frameId;
    ctx.report(nodeId, "ready", null);

    const factor = Math.max(2, Math.round(paramNumber(params, "downscale", 4)));
    state.frame.update(frame, factor);
    const { width, height, gradX, gradY } = state.frame;

    const options: LineOptions = {
      thetaStepDeg: paramNumber(params, "thetaStep", 1),
      votes: paramNumber(params, "votes", 40),
      minLength: paramNumber(params, "minLength", 60) / factor,
      maxGap: paramNumber(params, "maxGap", 12) / factor,
      maxLines: Math.round(paramNumber(params, "maxLines", 16)),
    };
    const edgeThreshold = paramNumber(params, "edgeThreshold", 80);

    if (useWorker) {
      const posted = state.job.submit({
        kind: "lines",
        gradX: gradX.slice(),
        gradY: gradY.slice(),
        width,
        height,
        edgeThreshold,
        options,
      });
      if (posted) return { out: state.lastResult };
    }

    const edges = collectEdges(gradX, gradY, width, height, edgeThreshold, MAX_EDGES);
    state.lastResult = edges.length === 0 ? EMPTY : linesFromEdges(edges, width, height, options);
    return { out: state.lastResult };
  },
});
