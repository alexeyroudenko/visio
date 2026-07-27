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

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;

/**
 * Owns the WebGL2 context and drives one evaluation pass per animation frame.
 * The React layer only ever hands it a graph description.
 */
export class Engine {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;

  private definitions: Record<string, NodeDefinition<never>> = {};
  private nodes: GraphNode[] = [];
  private slots = new Map<string, NodeSlot>();
  private targets = new Map<string, RenderTarget>();
  private outputs = new Map<string, Record<string, PortValue>>();
  private order: string[] = [];
  private inputMap = buildInputMap([]);

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

  setResolution(width: number, height: number): void {
    this.width = Math.max(16, Math.round(width));
    this.height = Math.max(16, Math.round(height));
    this.canvas.width = this.width;
    this.canvas.height = this.height;
  }

  /** Diffs against the live graph so node state (models, cameras) survives edits. */
  setGraph(nodes: GraphNode[], edges: GraphEdge[]): void {
    this.nodes = nodes;

    const seen = new Set<string>();
    for (const node of nodes) {
      seen.add(node.id);
      const existing = this.slots.get(node.id);
      const definition = this.definitions[node.type];
      if (!definition) continue;

      if (existing && existing.definition.type === node.type) continue;
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

    const sorted = topoSort(nodes, edges, this.definitions);
    this.order = sorted.order;
    this.inputMap = buildInputMap(edges);
    this.stats.nodeCount = nodes.length;

    for (const id of sorted.cyclic) {
      this.report(id, "error", "цикл в графе — разорви связь или используй Feedback");
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
      target: this.target,
      report: this.report,
    };
  }

  start(): void {
    if (this.rafHandle !== null) return;
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

  dispose(): void {
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
      const node = this.nodes.find((n) => n.id === id);
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
        const result = slot.definition.evaluate({
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
