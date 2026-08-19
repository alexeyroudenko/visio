import type { CirclesValue, LinesValue, PointsValue } from "../../engine/types";
import type { CannyOptions } from "./canny";
import type { CircleOptions, LineOptions } from "./houghAlgorithms";
import type { CornerOptions } from "./cornerAlgorithms";

export interface HoughRequest {
  id: number;
  nodeId: string;
  kind: "circles" | "lines" | "corners";
  gradX: Float32Array;
  gradY: Float32Array;
  /** Luminance, posted with `canny` so aperture 5/7 can rebuild Sobel. */
  gray?: Float32Array;
  width: number;
  height: number;
  /** Required for circles/lines; ignored for corners. */
  edgeThreshold?: number;
  /** Lines only: run cv2.Canny before Hough instead of a magnitude threshold. */
  canny?: CannyOptions;
  options: CircleOptions | LineOptions | CornerOptions;
}

export type HoughResponse =
  | { id: number; nodeId: string; kind: "circles"; value: CirclesValue }
  | { id: number; nodeId: string; kind: "lines"; value: LinesValue }
  | { id: number; nodeId: string; kind: "corners"; value: PointsValue };
