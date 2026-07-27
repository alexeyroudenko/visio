import type { HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { createLandmarkerNode } from "./landmarkerFactory";
import { loadTasksVision, toConnections } from "./mediapipeShared";
import { paramNumber } from "../defineNode";

const MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

/** Filled once the task module is loaded; read only after create() resolves. */
let connections: ReadonlyArray<readonly [number, number]> = [];

export const handsNode = createLandmarkerNode({
  type: "tracking.hands",
  label: "Hands",
  description: "21 точка на кисть, до 4 рук в кадре.",
  connections: () => connections,
  modelKey: () => "hand_landmarker",
  params: [
    { key: "numHands", label: "Рук", type: "range", min: 1, max: 4, step: 1, default: 2 },
    {
      key: "confidence",
      label: "Порог",
      type: "range",
      min: 0.1,
      max: 0.9,
      step: 0.05,
      default: 0.5,
    },
  ],
  toOptions(params) {
    const confidence = paramNumber(params, "confidence", 0.5);
    return {
      numHands: Math.round(paramNumber(params, "numHands", 2)),
      minHandDetectionConfidence: confidence,
      minHandPresenceConfidence: confidence,
      minTrackingConfidence: Math.max(0.2, confidence - 0.1),
    };
  },
  async create(fileset, params) {
    const { HandLandmarker } = await loadTasksVision();
    if (connections.length === 0) connections = toConnections(HandLandmarker.HAND_CONNECTIONS);

    const confidence = paramNumber(params, "confidence", 0.5);
    return HandLandmarker.createFromOptions(fileset as never, {
      baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: Math.round(paramNumber(params, "numHands", 2)),
      minHandDetectionConfidence: confidence,
      minHandPresenceConfidence: confidence,
      minTrackingConfidence: Math.max(0.2, confidence - 0.1),
    });
  },
  extract(result) {
    return (result as HandLandmarkerResult).landmarks ?? [];
  },
});
