import { copyTexture } from "../../engine/gl/quad";
import type { RenderTarget } from "../../engine/gl/rt";
import type { EngineContext, FrameValue, LinesValue, PortValue } from "../../engine/types";
import { defineNode, paramBool, paramNumber } from "../defineNode";
import { GrayFrame } from "../shared/grayscale";
import { paramsKey } from "../shared/paramsKey";
import { PixelBuffer } from "../shared/pixelBuffer";
import { cannyEdges, parseCannyAperture, type CannyOptions } from "./canny";
import { collectEdges, linesFromEdges, MAX_EDGES, type LineOptions } from "./houghAlgorithms";
import { HoughJob } from "./houghClient";

interface LinesState {
  frame: GrayFrame;
  lastFrameId: number;
  lastResult: LinesValue;
  lastPreview: RenderTarget | null;
  paramsFingerprint: string;
  job: HoughJob | null;
  buffer: PixelBuffer | null;
  cannyMask: Uint8Array;
}

const EMPTY: LinesValue = { lines: [] };
const WHITE = 0xffffffff;
const BLACK = 0xff000000;

/**
 * Probabilistic Hough lines. Like the circles node, the transform lives in
 * `houghAlgorithms` and runs either inline or on the shared worker.
 */
export const houghLinesNode = defineNode<LinesState>({
  type: "tracking.lines",
  label: "Hough Lines",
  category: "tracking",
  description: "Segments via probabilistic Hough. Optional cv2.Canny before the vote.",
  inputs: [{ id: "frame", label: "frame", type: "frame" }],
  outputs: [
    { id: "out", label: "lines", type: "lines" },
    { id: "preview", label: "texture", type: "texture" },
  ],
  params: [
    { key: "canny", label: "Canny", type: "toggle", default: false },
    { key: "cannyView", label: "view result", type: "toggle", default: false },
    { key: "cannyThreshold1", label: "threshold1", type: "range", min: 0, max: 800, step: 5, default: 50 },
    { key: "cannyThreshold2", label: "threshold2", type: "range", min: 0, max: 800, step: 5, default: 150 },
    {
      key: "cannyAperture",
      label: "apertureSize",
      type: "select",
      options: [
        { value: "3", label: "3" },
        { value: "5", label: "5" },
        { value: "7", label: "7" },
      ],
      default: "3",
    },
    { key: "cannyL2", label: "L2gradient", type: "toggle", default: false },
    { key: "downscale", label: "Downscale", type: "range", min: 1, max: 16, step: 1, default: 4 },
    { key: "edgeThreshold", label: "Edge threshold", type: "range", min: 1, max: 800, step: 5, default: 80 },
    { key: "votes", label: "Vote threshold", type: "range", min: 1, max: 500, step: 1, default: 40 },
    { key: "thetaStep", label: "Angle step °", type: "range", min: 0.25, max: 15, step: 0.25, default: 1 },
    { key: "minLength", label: "Min length", type: "range", min: 1, max: 2000, step: 5, default: 60 },
    { key: "maxLength", label: "Max length", type: "range", min: 0, max: 2000, step: 5, default: 400 },
    { key: "maxGap", label: "Max gap", type: "range", min: 1, max: 400, step: 1, default: 12 },
    { key: "maxLines", label: "Max lines", type: "range", min: 1, max: 400, step: 1, default: 16 },
    { key: "interval", label: "Every N frames", type: "range", min: 1, max: 16, step: 1, default: 2 },
    { key: "worker", label: "Run in worker", type: "toggle", default: true },
  ],
  createState() {
    return {
      frame: new GrayFrame(),
      lastFrameId: -1,
      lastResult: EMPTY,
      lastPreview: null,
      paramsFingerprint: "",
      job: null,
      buffer: null,
      cannyMask: new Uint8Array(0),
    };
  },
  disposeState(state) {
    state.job?.dispose();
    state.buffer?.dispose();
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const state = runtime.state;
    const view = paramBool(params, "canny", false) && paramBool(params, "cannyView", false);
    const pack = (lines: LinesValue, preview: PortValue = state.lastPreview): Record<string, PortValue> => ({
      out: lines,
      preview: view ? preview : null,
    });

    const frame = inputs.frame as FrameValue | null;
    if (!frame) {
      ctx.report(nodeId, "idle", "connect a frame from a source");
      return pack(EMPTY, null);
    }

    const fingerprint = paramsKey(params);
    if (fingerprint !== state.paramsFingerprint) {
      state.paramsFingerprint = fingerprint;
      state.lastFrameId = -1;
      state.job?.cancel();
    }

    const interval = Math.max(1, Math.round(paramNumber(params, "interval", 2)));
    if (frame.frameId === state.lastFrameId) return pack(state.lastResult);
    if (state.lastFrameId >= 0 && ctx.frameCount % interval !== 0) {
      return pack(state.lastResult);
    }

    const useWorker = paramBool(params, "worker", true) && !view;
    if (!state.job) {
      state.job = new HoughJob(nodeId, (response) => {
        if (response.kind === "lines") state.lastResult = response.value;
      });
    }
    if (useWorker && state.job.busy) return pack(state.lastResult);

    state.lastFrameId = frame.frameId;
    ctx.report(nodeId, "ready", null);

    const factor = Math.max(1, Math.round(paramNumber(params, "downscale", 4)));
    state.frame.update(frame, factor);
    const { width, height, gray, gradX, gradY } = state.frame;

    const options: LineOptions = {
      thetaStepDeg: paramNumber(params, "thetaStep", 1),
      votes: paramNumber(params, "votes", 40),
      minLength: paramNumber(params, "minLength", 60) / factor,
      maxLength: paramNumber(params, "maxLength", 400) / factor,
      maxGap: Math.max(6, paramNumber(params, "maxGap", 12) / factor),
      maxLines: Math.round(paramNumber(params, "maxLines", 16)),
    };
    const edgeThreshold = paramNumber(params, "edgeThreshold", 80);
    const useCanny = paramBool(params, "canny", false);
    const canny: CannyOptions | undefined = useCanny
      ? {
          threshold1: paramNumber(params, "cannyThreshold1", 50),
          threshold2: paramNumber(params, "cannyThreshold2", 150),
          apertureSize: parseCannyAperture(params.cannyAperture),
          l2gradient: paramBool(params, "cannyL2", false),
        }
      : undefined;

    if (useWorker) {
      const posted = state.job.submit({
        kind: "lines",
        gradX: gradX.slice(),
        gradY: gradY.slice(),
        gray: canny ? gray.slice() : undefined,
        width,
        height,
        edgeThreshold,
        canny,
        options,
      });
      if (posted) return pack(state.lastResult);
    }

    const mask = view ? ensureMask(state, width * height) : undefined;
    const edges = canny
      ? cannyEdges(gray, width, height, canny, MAX_EDGES, gradX, gradY, mask)
      : collectEdges(gradX, gradY, width, height, edgeThreshold, MAX_EDGES);
    let preview: PortValue = state.lastPreview;
    if (view && mask) {
      preview = uploadCannyMask(state, ctx, nodeId, mask, width, height);
      state.lastPreview = preview;
    }
    state.lastResult = edges.length === 0 ? EMPTY : linesFromEdges(edges, width, height, options);
    return pack(state.lastResult, preview);
  },
});

function ensureMask(state: LinesState, size: number): Uint8Array {
  if (state.cannyMask.length !== size) state.cannyMask = new Uint8Array(size);
  return state.cannyMask;
}

function uploadCannyMask(
  state: LinesState,
  ctx: EngineContext,
  nodeId: string,
  mask: Uint8Array,
  width: number,
  height: number,
): RenderTarget {
  if (!state.buffer) state.buffer = new PixelBuffer();
  const n = width * height;
  if (state.buffer.width !== width || state.buffer.height !== height) {
    state.buffer.setWords(new Uint32Array(n), width, height);
  }
  const words = state.buffer.words;
  for (let i = 0; i < n; i += 1) words[i] = mask[i]! ? WHITE : BLACK;
  const preview = ctx.target(nodeId, "preview");
  if (preview.width === width && preview.height === height) {
    state.buffer.writePixels(ctx.gl, preview);
    return preview;
  }
  const small = ctx.target(nodeId, "cannySmall", width, height);
  state.buffer.writePixels(ctx.gl, small);
  copyTexture(ctx.gl, small.texture, preview);
  return preview;
}
