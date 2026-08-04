import type { PoseLandmarkerResult } from "@mediapipe/tasks-vision";
import { createLandmarkerNode } from "./landmarkerFactory";
import { loadTasksVision, toConnections } from "./mediapipeShared";
import { paramNumber, paramString } from "../defineNode";

const MODELS: Record<string, string> = {
  lite: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  full: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  heavy:
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task",
};

/** Filled once the task module is loaded; read only after create() resolves. */
let connections: ReadonlyArray<readonly [number, number]> = [];

export const poseNode = createLandmarkerNode({
  type: "tracking.pose",
  label: "Pose",
  description: "BlazePose: 33 skeleton points per person.",
  connections: () => connections,
  modelKey: (params) => paramString(params, "model", "lite"),
  params: [
    {
      key: "model",
      label: "Model",
      type: "select",
      options: [
        { value: "lite", label: "lite" },
        { value: "full", label: "full" },
        { value: "heavy", label: "heavy" },
      ],
      default: "lite",
    },
    { key: "numPoses", label: "People", type: "range", min: 1, max: 4, step: 1, default: 1 },
    {
      key: "confidence",
      label: "Threshold",
      type: "range",
      min: 0.1,
      max: 0.9,
      step: 0.05,
      default: 0.1,
    },
  ],
  toOptions(params) {
    const confidence = paramNumber(params, "confidence", 0.1);
    return {
      numPoses: Math.round(paramNumber(params, "numPoses", 1)),
      minPoseDetectionConfidence: confidence,
      minPosePresenceConfidence: confidence,
      minTrackingConfidence: Math.max(0.05, confidence - 0.05),
    };
  },
  async create(fileset, params) {
    const { PoseLandmarker } = await loadTasksVision();
    if (connections.length === 0) connections = toConnections(PoseLandmarker.POSE_CONNECTIONS);

    const model = paramString(params, "model", "lite");
    const confidence = paramNumber(params, "confidence", 0.1);
    return PoseLandmarker.createFromOptions(fileset as never, {
      baseOptions: { modelAssetPath: MODELS[model] ?? MODELS.lite, delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: Math.round(paramNumber(params, "numPoses", 1)),
      minPoseDetectionConfidence: confidence,
      minPosePresenceConfidence: confidence,
      minTrackingConfidence: Math.max(0.05, confidence - 0.05),
    });
  },
  extract(result) {
    return (result as PoseLandmarkerResult).landmarks ?? [];
  },
});
