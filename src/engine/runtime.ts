import { buildInputMap, topoSort, type GraphEdge, type GraphNode } from "./graph";
import { copyTexture } from "./gl/quad";
import {
  createRenderTarget,
  disposeRenderTarget,
  isRenderTarget,
  resizeRenderTarget,
  type RenderTarget,
} from "./gl/rt";
import type {
  EngineContext,
  NodeDefinition,
  NodeRuntime,
  PortValue,
} from "./types";

function waitForVideoSeek(video: HTMLVideoElement, time: number): Promise<void> {
  const target = Math.max(0, time);
  if (Math.abs(video.currentTime - target) < 1 / 60 && video.readyState >= 2) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };

    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    try {
      video.pause();
      video.currentTime = target;
    } catch {
      cleanup();
      resolve();
    }
  });
}

const TEXTURE_BYPASS_PREF = new Set(["src", "bg", "base"]);

/** Map each output to a same-typed input (same id → preferred names → first match). */
function bypassOutputs(
  definition: NodeDefinition<never>,
  inputs: Record<string, PortValue>,
): Record<string, PortValue> {
  const result: Record<string, PortValue> = {};
  for (const out of definition.outputs) {
    const candidates = definition.inputs.filter((port) => port.type === out.type);
    const pick =
      candidates.find((port) => port.id === out.id) ??
      candidates.find((port) => TEXTURE_BYPASS_PREF.has(port.id)) ??
      candidates[0];
    result[out.id] = pick ? (inputs[pick.id] ?? null) : null;
  }
  return result;
}

export interface EngineStats {
  fps: number;
  frameMs: number;
  nodeCount: number;
}

export type StatusListener = (
  statuses: Record<string, { status: NodeRuntime["status"]; message: string | null }>,
) => void;

interface NodeSlot {
  definition: NodeDefinition<never>;
  runtime: NodeRuntime<never>;
}

const DEFAULT_WIDTH = 1080;
const DEFAULT_HEIGHT = 1920;

/**
 * Owns the WebGL2 context and drives one evaluation pass per animation frame.
 * The React layer only ever hands it a graph description.
 */
export class Engine {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;

  private definitions: Record<string, NodeDefinition<never>> = {};
  private nodes: GraphNode[] = [];
  /** Same nodes by id — `tick` walks `order` and must not scan the list per node. */
  private nodesById = new Map<string, GraphNode>();
  private slots = new Map<string, NodeSlot>();
  private targets = new Map<string, RenderTarget>();
  private outputs = new Map<string, Record<string, PortValue>>();
  private order: string[] = [];
  private inputMap = buildInputMap([]);
  /** Node ids/types + wiring; when this changes, slots are rebuilt from scratch. */
  private topologyKey = "";

  private rafHandle: number | null = null;
  private startTime = 0;
  private lastFrameTime = 0;
  private frameCount = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;

  private statusDirty = false;
  private statusListener: StatusListener | null = null;

  width = DEFAULT_WIDTH;
  height = DEFAULT_HEIGHT;
  stats: EngineStats = { fps: 0, frameMs: 0, nodeCount: 0 };
  /** Texture the Output node produced last frame, for preview and recording. */
  displayTarget: RenderTarget | null = null;
  private paused = false;
  private timelineFrame = 0;
  private timelineFps = 30;
  private timelinePlaying = false;
  private timelineForceSync = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;
  }

  setDefinitions(defs: Record<string, NodeDefinition<never>>): void {
    this.definitions = defs;
  }

  onStatus(listener: StatusListener | null): void {
    this.statusListener = listener;
  }

  /** Current status of one node, without waiting for the next listener push. */
  statusOf(nodeId: string): { status: NodeRuntime["status"]; message: string | null } | null {
    const slot = this.slots.get(nodeId);
    return slot ? { status: slot.runtime.status, message: slot.runtime.message } : null;
  }

  setResolution(width: number, height: number): void {
    this.width = Math.max(16, Math.round(width));
    this.height = Math.max(16, Math.round(height));
    this.canvas.width = this.width;
    this.canvas.height = this.height;
  }

  setTimeline(frame: number, fps: number, playing: boolean): void {
    this.timelineFrame = frame;
    this.timelineFps = Math.max(1, fps);
    this.timelinePlaying = playing;
  }

  /** Offline Render drives video sources to the playhead even without Sync. */
  setTimelineForceSync(force: boolean): void {
    this.timelineForceSync = force;
  }

  /**
   * Seek every file-video Media node to the current timeline playhead and wait
   * until the decoder has the frame. Used by offline Render.
   */
  async seekVideosToPlayhead(): Promise<void> {
    const frame = this.timelineFrame;
    const fps = this.timelineFps;
    const waits: Promise<void>[] = [];

    for (const node of this.nodes) {
      if (node.type !== "source.media") continue;
      const slot = this.slots.get(node.id);
      const state = slot?.runtime.state as
        | { mode?: string; video?: HTMLVideoElement }
        | undefined;
      const video = state?.video;
      if (!state || (state.mode !== "video" && state.mode !== "audio") || !video) continue;
      if (!Number.isFinite(video.duration) || video.duration <= 0) continue;

      const speed =
        typeof node.params.speed === "number" && Number.isFinite(node.params.speed)
          ? Math.max(0.001, node.params.speed)
          : 1;
      let t = (frame / fps) * speed;
      t = ((t % video.duration) + video.duration) % video.duration;
      waits.push(waitForVideoSeek(video, t));
    }

    await Promise.all(waits);
  }

  /**
   * Audio-bearing Media sources for offline Render (video/audio file URLs).
   * Skips muted nodes and camera streams.
   */
  collectRenderAudioSources(): {
    url: string;
    speed: number;
    volume: number;
  }[] {
    const out: { url: string; speed: number; volume: number }[] = [];
    for (const node of this.nodes) {
      if (node.type !== "source.media") continue;
      const mode = node.params.mode;
      if (mode !== "video" && mode !== "audio") continue;
      if (node.params.muted === true) continue;
      const file = node.params.file;
      const url =
        file && typeof file === "object" && typeof (file as { url?: unknown }).url === "string"
          ? (file as { url: string }).url
          : null;
      if (!url) continue;
      const speed =
        typeof node.params.speed === "number" && Number.isFinite(node.params.speed)
          ? Math.max(0.001, node.params.speed)
          : 1;
      const volume =
        typeof node.params.volume === "number" && Number.isFinite(node.params.volume)
          ? Math.max(0, Math.min(1, node.params.volume))
          : 1;
      if (volume <= 0) continue;
      out.push({ url, speed, volume });
    }
    return out;
  }

  /**
   * Best-effort fps of the first ready file-video Media source (for Render).
   * Falls back to null when the browser does not expose frameRate.
   */
  detectSourceVideoFps(): number | null {
    for (const node of this.nodes) {
      if (node.type !== "source.media") continue;
      const slot = this.slots.get(node.id);
      const state = slot?.runtime.state as
        | { mode?: string; video?: HTMLVideoElement }
        | undefined;
      const video = state?.video;
      if (!state || state.mode !== "video" || !video) continue;
      if (video.readyState < 2 || video.videoWidth === 0) continue;

      try {
        const capture = (
          video as HTMLVideoElement & { captureStream?: () => MediaStream }
        ).captureStream;
        if (typeof capture !== "function") continue;
        const stream = capture.call(video);
        const track = stream.getVideoTracks()[0];
        const rate = track?.getSettings().frameRate;
        stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
        if (typeof rate === "number" && Number.isFinite(rate) && rate >= 1 && rate <= 240) {
          return Math.round(rate * 1000) / 1000;
        }
      } catch {
        // captureStream can throw if the element has no frame yet.
      }
    }
    return null;
  }

  /**
   * Diffs against the live graph so node state (models, cameras) survives edits.
   * Topology changes clear cached port values so a preset load cannot keep a
   * previous frame stuck on the Output path.
   */
  setGraph(nodes: GraphNode[], edges: GraphEdge[]): void {
    this.nodes = nodes;
    this.nodesById = new Map(nodes.map((node) => [node.id, node]));

    const topologyKey = [
      ...nodes.map((node) => `${node.id}@${node.type}`).sort(),
      ...edges
        .map(
          (edge) =>
            `${edge.source}.${edge.sourceHandle ?? "out"}>${edge.target}.${edge.targetHandle ?? "in"}`,
        )
        .sort(),
    ].join("|");
    const topologyChanged = topologyKey !== this.topologyKey;
    this.topologyKey = topologyKey;

    const seen = new Set<string>();
    for (const node of nodes) {
      seen.add(node.id);
      const existing = this.slots.get(node.id);
      const definition = this.definitions[node.type];
      if (!definition) continue;

      if (existing && existing.definition.type === node.type) {
        // Pick up HMR evaluate/params without recreating node state.
        existing.definition = definition;
        continue;
      }
      if (existing) this.disposeSlot(node.id);

      const runtime: NodeRuntime<never> = {
        state: definition.createState(this.context(0)) as never,
        status: "idle",
        message: null,
      };
      this.slots.set(node.id, { definition, runtime });
    }

    for (const id of [...this.slots.keys()]) {
      if (!seen.has(id)) this.disposeSlot(id);
    }

    if (topologyChanged) {
      this.outputs.clear();
      this.displayTarget = null;
    }

    const sorted = topoSort(nodes, edges, this.definitions);
    this.order = sorted.order;
    this.inputMap = buildInputMap(edges);
    this.stats.nodeCount = nodes.length;

    for (const id of sorted.cyclic) {
      this.report(id, "error", "cycle in graph — break a link or use Feedback");
    }
  }

  private disposeSlot(id: string): void {
    const slot = this.slots.get(id);
    if (slot) {
      slot.definition.disposeState?.(slot.runtime.state, this.context(0));
      this.slots.delete(id);
    }
    for (const [key, target] of this.targets) {
      if (key.startsWith(`${id}:`)) {
        disposeRenderTarget(this.gl, target);
        this.targets.delete(key);
      }
    }
    this.outputs.delete(id);
  }

  private target = (nodeId: string, slot: string, width?: number, height?: number): RenderTarget => {
    const key = `${nodeId}:${slot}`;
    const w = Math.max(1, Math.round(width ?? this.width));
    const h = Math.max(1, Math.round(height ?? this.height));
    let rt = this.targets.get(key);
    if (!rt) {
      rt = createRenderTarget(this.gl, w, h);
      this.targets.set(key, rt);
    } else {
      resizeRenderTarget(this.gl, rt, w, h);
    }
    return rt;
  };

  private report = (nodeId: string, status: NodeRuntime["status"], message?: string | null): void => {
    const slot = this.slots.get(nodeId);
    if (!slot) return;
    const nextMessage = message ?? null;
    if (slot.runtime.status === status && slot.runtime.message === nextMessage) return;
    slot.runtime.status = status;
    slot.runtime.message = nextMessage;
    this.statusDirty = true;
  };

  private context(timeMs: number, deltaSec = 0): EngineContext {
    return {
      gl: this.gl,
      width: this.width,
      height: this.height,
      timeMs,
      deltaSec,
      frameCount: this.frameCount,
      timelineFrame: this.timelineFrame,
      timelineFps: this.timelineFps,
      timelinePlaying: this.timelinePlaying,
      timelineForceSync: this.timelineForceSync,
      target: this.target,
      report: this.report,
    };
  }

  start(): void {
    if (this.paused || this.rafHandle !== null) return;
    this.startTime = performance.now();
    this.lastFrameTime = this.startTime;
    const tick = () => {
      this.rafHandle = requestAnimationFrame(tick);
      this.tick();
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Freeze the graph: no rAF ticks (no GL/MediaPipe work) and suspend live
   * sources so the camera/video stop consuming CPU.
   */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      this.stop();
      this.forEachLiveHook("suspend");
    } else {
      this.forEachLiveHook("resume");
      this.start();
    }
  }

  private forEachLiveHook(hook: "suspend" | "resume"): void {
    const ctx = this.context(performance.now() - (this.startTime || performance.now()), 0);
    for (const node of this.nodes) {
      const slot = this.slots.get(node.id);
      const fn = slot?.definition[hook];
      if (!slot || !fn) continue;
      fn({
        ctx,
        nodeId: node.id,
        params: node.params,
        runtime: slot.runtime,
      });
    }
  }

  dispose(): void {
    this.paused = false;
    this.stop();
    for (const id of [...this.slots.keys()]) this.disposeSlot(id);
  }

  /** One evaluation pass. Public so tests can step the graph without rAF. */
  tick(): void {
    const now = performance.now();
    const deltaSec = Math.min(0.25, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    this.frameCount += 1;

    const ctx = this.context(now - this.startTime, deltaSec);
    const gl = this.gl;
    this.displayTarget = null;

    for (const id of this.order) {
      const node = this.nodesById.get(id);
      const slot = this.slots.get(id);
      if (!node || !slot) continue;

      const inputs: Record<string, PortValue> = {};
      const links = this.inputMap.get(id);
      if (links) {
        for (const [handle, link] of links) {
          inputs[handle] = this.outputs.get(link.source)?.[link.sourceHandle] ?? null;
        }
      }

      try {
        const result = node.bypass
          ? bypassOutputs(slot.definition, inputs)
          : slot.definition.evaluate({
              ctx,
              nodeId: id,
              inputs,
              params: node.params,
              runtime: slot.runtime,
            });
        this.outputs.set(id, result);

        if (slot.definition.category === "output" && isRenderTarget(result.out)) {
          this.displayTarget = result.out;
        }
      } catch (error) {
        this.outputs.set(id, {});
        this.report(id, "error", error instanceof Error ? error.message : String(error));
      }
    }

    // Present. Without an Output node the canvas stays black rather than stale.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);
    if (this.displayTarget) {
      // Targets keep v=0 at the image top; the default framebuffer wants it flipped.
      copyTexture(gl, this.displayTarget.texture, null, {
        flipY: true,
        viewport: [this.canvas.width, this.canvas.height],
      });
    } else {
      gl.clearColor(0.05, 0.05, 0.06, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    const frameMs = performance.now() - now;
    this.fpsAccum += deltaSec;
    this.fpsFrames += 1;
    if (this.fpsAccum >= 0.5) {
      this.stats = {
        fps: Math.round(this.fpsFrames / this.fpsAccum),
        frameMs: Math.round(frameMs * 10) / 10,
        nodeCount: this.nodes.length,
      };
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    if (this.statusDirty && this.statusListener) {
      this.statusDirty = false;
      const snapshot: Record<string, { status: NodeRuntime["status"]; message: string | null }> = {};
      for (const [id, slot] of this.slots) {
        snapshot[id] = { status: slot.runtime.status, message: slot.runtime.message };
      }
      this.statusListener(snapshot);
    }
  }
}
