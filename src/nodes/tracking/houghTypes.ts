import type { CirclesValue, LinesValue } from "../../engine/types";
import type { CircleOptions, LineOptions } from "./houghAlgorithms";

export interface HoughRequest {
  id: number;
  nodeId: string;
  kind: "circles" | "lines";
  gradX: Float32Array;
  gradY: Float32Array;
  width: number;
  height: number;
  edgeThreshold: number;
  options: CircleOptions | LineOptions;
}

export type HoughResponse =
  | { id: number; nodeId: string; kind: "circles"; value: CirclesValue }
  | { id: number; nodeId: string; kind: "lines"; value: LinesValue };
