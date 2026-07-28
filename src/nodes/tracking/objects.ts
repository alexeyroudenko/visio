import type { ObjectDetector, ObjectDetectorResult } from "@mediapipe/tasks-vision";
import type { BoxesValue, FrameValue } from "../../engine/types";
import { defineNode, paramNumber } from "../defineNode";
import { loadTasksVision, loadVisionFileset, Monotonic } from "./mediapipeShared";

const MODEL =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";

interface ObjectsState {
  instance: ObjectDetector | null;
  loading: boolean;
  failed: boolean;
  clock: Monotonic;
  lastFrameId: number;
  lastResult: BoxesValue;
  optionsKey: string;
}

const EMPTY: BoxesValue = { boxes: [] };

export const objectsNode = defineNode<ObjectsState>({
  type: "tracking.objects",
  label: "Objects",
  category: "tracking",
  description: "EfficientDet-Lite0: object boxes with label and confidence.",
  inputs: [{ id: "frame", label: "frame", type: "frame" }],
  outputs: [{ id: "out", label: "boxes", type: "boxes" }],
  params: [
    { key: "maxResults", label: "Objects", type: "range", min: 1, max: 20, step: 1, default: 8 },
    { key: "score", label: "Threshold", type: "range", min: 0.1, max: 0.9, step: 0.05, default: 0.4 },
    { key: "interval", label: "Every N frames", type: "range", min: 1, max: 8, step: 1, default: 2 },
  ],
  createState() {
    return {
      instance: null,
      loading: false,
      failed: false,
      clock: new Monotonic(),
      lastFrameId: -1,
      lastResult: EMPTY,
      optionsKey: "",
    };
  },
  disposeState(state) {
    state.instance?.close();
    state.instance = null;
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const state = runtime.state;
    const frame = inputs.frame as FrameValue | null;
    if (!frame) {
      if (!state.failed) ctx.report(nodeId, "idle", "connect a frame from a source");
      return { out: EMPTY };
    }

    const options = {
      maxResults: Math.round(paramNumber(params, "maxResults", 8)),
      scoreThreshold: paramNumber(params, "score", 0.4),
    };
    const optionsKey = JSON.stringify(options);

    if (!state.instance && !state.loading && !state.failed) {
      state.loading = true;
      state.optionsKey = optionsKey;
      ctx.report(nodeId, "loading", "loading model…");
      void Promise.all([loadVisionFileset(), loadTasksVision()])
        .then(([fileset, mp]) =>
          mp.ObjectDetector.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
            runningMode: "VIDEO",
            ...options,
          }),
        )
        .then((instance) => {
          state.instance = instance;
          state.loading = false;
          ctx.report(nodeId, "ready", null);
        })
        .catch((error: unknown) => {
          state.loading = false;
          state.failed = true;
          ctx.report(nodeId, "error", error instanceof Error ? error.message : "model error");
        });
    }

    const instance = state.instance;
    if (!instance) return { out: state.lastResult };

    if (optionsKey !== state.optionsKey) {
      state.optionsKey = optionsKey;
      void instance.setOptions(options).catch(() => undefined);
    }

    const interval = Math.max(1, Math.round(paramNumber(params, "interval", 2)));
    if (frame.frameId === state.lastFrameId || ctx.frameCount % interval !== 0) {
      return { out: state.lastResult };
    }
    state.lastFrameId = frame.frameId;

    try {
      const result = instance.detectForVideo(
        frame.element,
        state.clock.next(frame.timestampMs),
      ) as ObjectDetectorResult;
      state.lastResult = {
        boxes: (result.detections ?? []).map((detection) => {
          const box = detection.boundingBox;
          const category = detection.categories?.[0];
          return {
            // MediaPipe reports pixels of the input image; the graph wants 0..1.
            x: (box?.originX ?? 0) / frame.width,
            y: (box?.originY ?? 0) / frame.height,
            w: (box?.width ?? 0) / frame.width,
            h: (box?.height ?? 0) / frame.height,
            score: category?.score ?? 0,
            label: category?.categoryName ?? "",
          };
        }),
      };
    } catch (error) {
      ctx.report(nodeId, "error", error instanceof Error ? error.message : "detect failed");
    }

    return { out: state.lastResult };
  },
});
