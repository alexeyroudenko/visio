import type { RenderTarget } from "./gl/rt";

/** Wire types. A link may only connect ports of the same type. */
export type PortType =
  | "frame"
  | "texture"
  | "landmarks"
  | "boxes"
  | "points"
  | "circles"
  | "lines"
  | "number";

/** Raw media frame — what MediaPipe / CPU trackers consume. */
export interface FrameValue {
  element: HTMLVideoElement | HTMLCanvasElement;
  width: number;
  height: number;
  /** Strictly increasing, ms. Required by *ForVideo detectors. */
  timestampMs: number;
  /** Bumps only when new pixels arrived — lets trackers skip idle frames. */
  frameId: number;
}

export interface Landmark {
  /** Normalized to [0,1] over the source frame. */
  x: number;
  y: number;
  z: number;
  score: number;
}

/** One tracked subject (a body, a hand, a face). */
export interface LandmarksValue {
  sets: Landmark[][];
  /** Bone pairs — index into a set. */
  connections: ReadonlyArray<readonly [number, number]>;
}

export interface Box {
  /** Normalized [0,1]. */
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  label: string;
  /** Stable id across frames when the tracker provides one. */
  id?: number;
}

export interface BoxesValue {
  boxes: Box[];
}

export interface PointsValue {
  points: { x: number; y: number; score: number }[];
}

export interface CirclesValue {
  /** x/y normalized to [0,1]; r as a fraction of frame width. */
  circles: { x: number; y: number; r: number; score: number }[];
}

export interface LinesValue {
  /** Endpoints normalized to [0,1]. */
  lines: { x1: number; y1: number; x2: number; y2: number; score: number }[];
}

export type PortValue =
  | FrameValue
  | RenderTarget
  | LandmarksValue
  | BoxesValue
  | PointsValue
  | CirclesValue
  | LinesValue
  | number
  | null;

export interface PortSpec {
  id: string;
  label: string;
  type: PortType;
}

export type ParamSpec =
  | { key: string; label: string; type: "range"; min: number; max: number; step: number; default: number }
  | { key: string; label: string; type: "toggle"; default: boolean }
  | { key: string; label: string; type: "color"; default: string }
  | { key: string; label: string; type: "select"; options: { value: string; label: string }[]; default: string }
  | { key: string; label: string; type: "file"; accept: string; default: null }
  | { key: string; label: string; type: "text"; default: string };

export type ParamValues = Record<string, unknown>;

export type NodeCategory = "source" | "tracking" | "draw" | "fx" | "output";

/** Per-node scratch: GL buffers, MediaPipe instances, accumulators. */
export interface NodeRuntime<S = unknown> {
  state: S;
  /** Set by a node while an async resource (model, camera) is still loading. */
  status: "idle" | "loading" | "ready" | "error";
  message: string | null;
}

export interface EvalArgs<S = unknown> {
  ctx: EngineContext;
  nodeId: string;
  inputs: Record<string, PortValue>;
  params: ParamValues;
  runtime: NodeRuntime<S>;
}

export interface NodeDefinition<S = unknown> {
  type: string;
  label: string;
  category: NodeCategory;
  description: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  params: ParamSpec[];
  /** Inputs read one frame late — edges into them may close a cycle. */
  delayedInputs?: string[];
  createState: (ctx: EngineContext) => S;
  disposeState?: (state: S, ctx: EngineContext) => void;
  /** Release live sources (camera tracks, video decode) while the engine is paused. */
  suspend?: (args: Omit<EvalArgs<S>, "inputs">) => void;
  /** Re-enable sources after pause. */
  resume?: (args: Omit<EvalArgs<S>, "inputs">) => void;
  evaluate: (args: EvalArgs<S>) => Record<string, PortValue>;
}

/** Everything a node needs from the engine during evaluate(). */
export interface EngineContext {
  gl: WebGL2RenderingContext;
  /** Render resolution of the patch, in px. */
  width: number;
  height: number;
  /** ms since engine start. */
  timeMs: number;
  /** Seconds since previous frame. */
  deltaSec: number;
  frameCount: number;
  /** Persistent render target owned by (nodeId, slot), resized on demand. */
  target: (nodeId: string, slot: string, width?: number, height?: number) => RenderTarget;
  /** Marks a node's status for the UI. */
  report: (nodeId: string, status: NodeRuntime["status"], message?: string | null) => void;
}
