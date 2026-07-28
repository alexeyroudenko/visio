import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { FrameValue, LandmarksValue, NodeDefinition, ParamSpec } from "../../engine/types";
import { defineNode, paramNumber } from "../defineNode";
import { loadVisionFileset, Monotonic } from "./mediapipeShared";

interface LandmarkerLike {
  detectForVideo: (source: HTMLCanvasElement | HTMLVideoElement, timestampMs: number) => unknown;
  setOptions?: (options: Record<string, unknown>) => Promise<void>;
  close: () => void;
}

interface LandmarkerState {
  instance: LandmarkerLike | null;
  loading: boolean;
  failed: boolean;
  clock: Monotonic;
  lastFrameId: number;
  lastResult: LandmarksValue;
  /** Which model file is currently loaded — a change forces a rebuild. */
  loadedModelKey: string | null;
  /** Fingerprint of live-tunable options — a change forces setOptions. */
  optionsKey: string;
}

export interface LandmarkerConfig {
  type: string;
  label: string;
  description: string;
  params: ParamSpec[];
  /** Bone pairs may depend on params (e.g. face contours vs tesselation). */
  connections: (params: Record<string, unknown>) => ReadonlyArray<readonly [number, number]>;
  /** Identity of the model to load; changing it rebuilds the task. */
  modelKey: (params: Record<string, unknown>) => string;
  create: (fileset: unknown, params: Record<string, unknown>) => Promise<LandmarkerLike>;
  /** Options that can be changed without reloading the model. */
  toOptions: (params: Record<string, unknown>) => Record<string, unknown>;
  extract: (result: unknown) => NormalizedLandmark[][];
}

const EMPTY: LandmarksValue = { sets: [], connections: [] };

/**
 * Pose / hands / face differ only in model, options and result shape — the
 * lazy-load, throttle and normalize logic is identical, so it lives here.
 */
export function createLandmarkerNode(config: LandmarkerConfig): NodeDefinition<never> {
  return defineNode<LandmarkerState>({
    type: config.type,
    label: config.label,
    category: "tracking",
    description: config.description,
    inputs: [{ id: "frame", label: "frame", type: "frame" }],
    outputs: [{ id: "out", label: "landmarks", type: "landmarks" }],
    params: [
      ...config.params,
      {
        key: "interval",
        label: "Every N frames",
        type: "range",
        min: 1,
        max: 6,
        step: 1,
        default: 1,
      },
    ],
    createState() {
      return {
        instance: null,
        loading: false,
        failed: false,
        clock: new Monotonic(),
        lastFrameId: -1,
        lastResult: EMPTY,
        loadedModelKey: null,
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

      const modelKey = config.modelKey(params);

      // Switching the model means a different task file: tear down and reload.
      if (state.instance && state.loadedModelKey !== modelKey) {
        state.instance.close();
        state.instance = null;
        state.loadedModelKey = null;
        state.failed = false;
      }

      if (!state.instance && !state.loading && !state.failed) {
        state.loading = true;
        state.optionsKey = JSON.stringify(config.toOptions(params));
        ctx.report(nodeId, "loading", "loading model…");
        void loadVisionFileset()
          .then((fileset) => config.create(fileset, params))
          .then((instance) => {
            state.instance = instance;
            state.loadedModelKey = modelKey;
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

      const optionsKey = JSON.stringify(config.toOptions(params));
      if (optionsKey !== state.optionsKey) {
        state.optionsKey = optionsKey;
        void instance
          .setOptions?.({ ...config.toOptions(params), runningMode: "VIDEO" })
          .catch(() => undefined);
      }

      const interval = Math.max(1, Math.round(paramNumber(params, "interval", 1)));
      const isNewFrame = frame.frameId !== state.lastFrameId;
      const dueThisTick = ctx.frameCount % interval === 0;
      if (!isNewFrame || !dueThisTick) return { out: state.lastResult };
      state.lastFrameId = frame.frameId;

      try {
        const raw = instance.detectForVideo(frame.element, state.clock.next(frame.timestampMs));
        const sets = config.extract(raw).map((set) =>
          set.map((lm) => ({
            x: lm.x,
            y: lm.y,
            z: lm.z ?? 0,
            score: lm.visibility ?? 1,
          })),
        );
        state.lastResult = { sets, connections: config.connections(params) };
      } catch (error) {
        ctx.report(nodeId, "error", error instanceof Error ? error.message : "detect failed");
      }

      return { out: state.lastResult };
    },
  });
}
