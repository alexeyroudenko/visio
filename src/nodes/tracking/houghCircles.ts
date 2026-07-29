import type { CirclesValue, FrameValue } from "../../engine/types";
import { defineNode, paramBool, paramNumber } from "../defineNode";
import { GrayFrame } from "../shared/grayscale";
import { paramsKey } from "../shared/paramsKey";
import {
  circlesFromEdges,
  collectEdges,
  MAX_EDGES,
  type CircleOptions,
} from "./houghAlgorithms";
import { HoughJob } from "./houghClient";

interface CirclesState {
  frame: GrayFrame;
  lastFrameId: number;
  lastResult: CirclesValue;
  paramsFingerprint: string;
  job: HoughJob | null;
}

const EMPTY: CirclesValue = { circles: [] };

/**
 * Hough gradient circles. The transform itself lives in `houghAlgorithms` so it
 * can run either here or in a worker; this node reads the frame, downscales it,
 * and decides which.
 */
export const houghCirclesNode = defineNode<CirclesState>({
  type: "tracking.circles",
  label: "Hough Circles",
  category: "tracking",
  description: "Circles via gradient Hough: centers and radii of round shapes.",
  inputs: [{ id: "frame", label: "frame", type: "frame" }],
  outputs: [{ id: "out", label: "circles", type: "circles" }],
  params: [
    { key: "downscale", label: "Downscale", type: "range", min: 2, max: 8, step: 1, default: 4 },
    { key: "edgeThreshold", label: "Edge threshold", type: "range", min: 20, max: 300, step: 5, default: 90 },
    { key: "votes", label: "Vote threshold", type: "range", min: 5, max: 200, step: 1, default: 40 },
    { key: "minRadius", label: "Min radius", type: "range", min: 4, max: 200, step: 2, default: 16 },
    { key: "maxRadius", label: "Max radius", type: "range", min: 8, max: 400, step: 2, default: 120 },
    { key: "minDistance", label: "Min distance", type: "range", min: 4, max: 300, step: 2, default: 40 },
    { key: "maxCircles", label: "Max circles", type: "range", min: 1, max: 40, step: 1, default: 10 },
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
      // Whatever is running was started under the old settings.
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
        if (response.kind === "circles") state.lastResult = response.value;
      });
    }
    // A job is still running — let it finish rather than stacking stale frames.
    if (useWorker && state.job.busy) return { out: state.lastResult };

    state.lastFrameId = frame.frameId;
    ctx.report(nodeId, "ready", null);

    const factor = Math.max(2, Math.round(paramNumber(params, "downscale", 4)));
    state.frame.update(frame, factor);
    const { width, height, gradX, gradY } = state.frame;

    const options: CircleOptions = {
      minR: Math.max(2, Math.round(paramNumber(params, "minRadius", 16) / factor)),
      maxR: 0,
      minDist: Math.max(2, paramNumber(params, "minDistance", 40) / factor),
      votes: paramNumber(params, "votes", 40),
      maxCircles: Math.round(paramNumber(params, "maxCircles", 10)),
    };
    options.maxR = Math.max(
      options.minR + 1,
      Math.round(paramNumber(params, "maxRadius", 120) / factor),
    );
    const edgeThreshold = paramNumber(params, "edgeThreshold", 90);

    if (useWorker) {
      // Copies: GrayFrame reuses its arrays, and posting transfers ownership.
      const posted = state.job.submit({
        kind: "circles",
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
    state.lastResult =
      edges.length === 0 ? EMPTY : circlesFromEdges(edges, width, height, options);
    return { out: state.lastResult };
  },
});
