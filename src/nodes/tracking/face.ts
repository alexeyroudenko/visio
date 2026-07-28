import type { FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { createLandmarkerNode } from "./landmarkerFactory";
import { loadTasksVision, toConnections } from "./mediapipeShared";
import { paramNumber, paramString } from "../defineNode";

const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

/** Filled once the task module is loaded; read only after create() resolves. */
let contours: ReadonlyArray<readonly [number, number]> = [];
let tesselation: ReadonlyArray<readonly [number, number]> = [];

export const faceNode = createLandmarkerNode({
  type: "tracking.face",
  label: "Face Mesh",
  description: "478 face points: contours or full mesh.",
  connections: (params) =>
    paramString(params, "mesh", "contours") === "tesselation" ? tesselation : contours,
  modelKey: () => "face_landmarker",
  params: [
    {
      key: "mesh",
      label: "Mesh",
      type: "select",
      options: [
        { value: "contours", label: "contours" },
        { value: "tesselation", label: "full" },
      ],
      default: "contours",
    },
    { key: "numFaces", label: "Faces", type: "range", min: 1, max: 4, step: 1, default: 1 },
    {
      key: "confidence",
      label: "Threshold",
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
      numFaces: Math.round(paramNumber(params, "numFaces", 1)),
      minFaceDetectionConfidence: confidence,
      minFacePresenceConfidence: confidence,
      minTrackingConfidence: Math.max(0.2, confidence - 0.1),
    };
  },
  async create(fileset, params) {
    const { FaceLandmarker } = await loadTasksVision();
    if (contours.length === 0) {
      // Tesselation is 2600+ edges — usable, but contours read better as line art.
      contours = toConnections([
        ...FaceLandmarker.FACE_LANDMARKS_FACE_OVAL,
        ...FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
        ...FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
        ...FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW,
        ...FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW,
        ...FaceLandmarker.FACE_LANDMARKS_LIPS,
      ]);
      tesselation = toConnections(FaceLandmarker.FACE_LANDMARKS_TESSELATION);
    }

    const confidence = paramNumber(params, "confidence", 0.5);
    return FaceLandmarker.createFromOptions(fileset as never, {
      baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: Math.round(paramNumber(params, "numFaces", 1)),
      minFaceDetectionConfidence: confidence,
      minFacePresenceConfidence: confidence,
      minTrackingConfidence: Math.max(0.2, confidence - 0.1),
    });
  },
  extract(result) {
    return (result as FaceLandmarkerResult).faceLandmarks ?? [];
  },
});
