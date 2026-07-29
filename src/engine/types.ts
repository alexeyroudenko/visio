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
  | "number"
  | "audio";

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

/**
 * A playing audio source: where to get the samples and where its playhead is.
 * Decoding is left to whoever consumes it — a Media node would otherwise pull
 * the whole file through `decodeAudioData` even with nothing wired up.
 */
export interface AudioValue {
  /** blob:/http: URL of the media — the identity key for the decode cache. */
  url: string;
  /** Samples, when the producer already has them. Otherwise decode from `url`. */
  buffer: AudioBuffer | null;
  /** Playhead inside the source, seconds. */
  timeSec: number;
  /** 0 when the element has not reported a duration yet. */
  durationSec: number;
  playing: boolean;
}

export type PortValue =
  | FrameValue
  | RenderTarget
  | LandmarksValue
  | BoxesValue
  | PointsValue
  | CirclesValue
  | LinesValue
  | AudioValue
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
  | { key: string; label: string; type: "text"; default: string }
  /** Multi-line source text — same value shape as `text`, taller control. */
  | { key: string; label: string; type: "code"; rows?: number; default: string };

export type ParamValues = Record<string, unknown>;

export type NodeCategory = "source" | "tracking" | "draw" | "fx" | "audio" | "output";

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
  /** Timeline playhead (video seeks when Media «Sync with timeline» is on). */
  timelineFrame: number;
  timelineFps: number;
  /** Timeline is playing — Media may scrub video if syncTimeline is enabled. */
  timelinePlaying: boolean;
  /**
   * Offline Render: force every video Media source to the playhead regardless
   * of the Sync with timeline toggle.
   */
  timelineForceSync: boolean;
  /** Persistent render target owned by (nodeId, slot), resized on demand. */
  target: (nodeId: string, slot: string, width?: number, height?: number) => RenderTarget;
  /** Marks a node's status for the UI. */
  report: (nodeId: string, status: NodeRuntime["status"], message?: string | null) => void;
}
