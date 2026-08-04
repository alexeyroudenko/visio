import type { FrameValue, PointsValue } from "../../engine/types";
import { defineNode, paramBool, paramNumber } from "../defineNode";
import { GrayFrame } from "../shared/grayscale";
import { paramsKey } from "../shared/paramsKey";
import {
  detectShiTomasi,
  pointsFromCorners,
  type CornerOptions,
} from "./cornerAlgorithms";
import { HoughJob } from "./houghClient";

interface FeaturesState {
  frame: GrayFrame;
  lastFrameId: number;
  lastResult: PointsValue;
  paramsFingerprint: string;
  job: HoughJob | null;
}

const EMPTY: PointsValue = { points: [] };

/**
 * Shi–Tomasi corners (the goodFeaturesToTrack idea) over a downscaled
 * grayscale copy of the frame. Shares the Hough worker — gradients are the
 * same Sobel buffers circles/lines already post.
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
    { key: "interval", label: "Every N frames", type: "range", min: 1, max: 8, step: 1, default: 1 },
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

    const interval = Math.max(1, Math.round(paramNumber(params, "interval", 1)));
    if (frame.frameId === state.lastFrameId) return { out: state.lastResult };
    if (state.lastFrameId >= 0 && ctx.frameCount % interval !== 0) {
      return { out: state.lastResult };
    }

    const useWorker = paramBool(params, "worker", true);
    if (!state.job) {
      state.job = new HoughJob(nodeId, (response) => {
        if (response.kind === "corners") state.lastResult = response.value;
      });
    }
    if (useWorker && state.job.busy) return { out: state.lastResult };

    state.lastFrameId = frame.frameId;
    ctx.report(nodeId, "ready", null);

    const factor = Math.max(2, Math.round(paramNumber(params, "downscale", 4)));
    state.frame.update(frame, factor);
    const { width, height, gradX, gradY } = state.frame;

    const options: CornerOptions = {
      block: Math.max(3, Math.round(paramNumber(params, "block", 7)) | 1),
      maxCorners: Math.round(paramNumber(params, "maxCorners", 200)),
      quality: paramNumber(params, "quality", 0.08),
      // Distance is a UI value in output pixels; compare in downscaled space.
      minDistance: paramNumber(params, "minDistance", 12) / factor,
    };

    if (useWorker) {
      const posted = state.job.submit({
        kind: "corners",
        gradX: gradX.slice(),
        gradY: gradY.slice(),
        width,
        height,
        options,
      });
      if (posted) return { out: state.lastResult };
    }

    const hits = detectShiTomasi(gradX, gradY, width, height, options);
    state.lastResult = pointsFromCorners(hits, width, height);
    return { out: state.lastResult };
  },
});
