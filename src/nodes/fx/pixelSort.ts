import { copyTexture } from "../../engine/gl/quad";
import { clearTarget, isRenderTarget, type RenderTarget } from "../../engine/gl/rt";
import { defineNode, paramBool, paramNumber } from "../defineNode";
import { PixelBuffer } from "../shared/pixelBuffer";
import { BINS, sortFrame } from "./pixelSortAlgorithms";
import { PixelSortJob } from "./pixelSortClient";
import type { PixelSortResponse } from "./pixelSortTypes";

/** Timings churn every frame; publishing them that often would re-render the graph. */
const STATUS_EVERY = 30;

interface PixelSortState {
  buffer: PixelBuffer;
  /** Frame index of the last sort, so throttling can reuse the target. */
  lastFrame: number;
  /** Sort key per pixel — computed once per frame, not once per comparison. */
  lum: Uint8Array;
  /** Counting-sort bins plus a one-span staging buffer, both reused across frames. */
  counts: Uint32Array;
  scratch: Uint32Array;
  job: PixelSortJob | null;
  /** Sorted words waiting to be written (worker path). */
  pending: PixelSortResponse | null;
  /** Width/height of the last uploaded sort — for pending write sizing. */
  lastW: number;
  lastH: number;
  readMs: number;
  sortMs: number;
  writeMs: number;
  statusFrame: number;
  statusMessage: string;
}

function ensureBuffers(state: PixelSortState, width: number, height: number): void {
  const pixels = width * height;
  if (state.lum.length !== pixels) state.lum = new Uint8Array(pixels);
  const longest = Math.max(width, height);
  if (state.scratch.length !== longest) state.scratch = new Uint32Array(longest);
}

function writeSorted(
  gl: WebGL2RenderingContext,
  ctx: { target: (nodeId: string, key: string, w?: number, h?: number) => RenderTarget },
  nodeId: string,
  state: PixelSortState,
  target: RenderTarget,
  width: number,
  height: number,
): void {
  const writeStart = performance.now();
  // Pending words are already at Scale resolution — upload then blit up if needed.
  const sized =
    target.width === width && target.height === height
      ? target
      : ctx.target(nodeId, "cpu", width, height);
  state.buffer.writePixels(gl, sized);
  if (sized !== target) copyTexture(gl, sized.texture, target);
  state.writeMs = performance.now() - writeStart;
  state.lastW = width;
  state.lastH = height;
}

export const pixelSortNode = defineNode<PixelSortState>({
  type: "fx.pixelSort",
  label: "Pixel Sort",
  category: "fx",
  description:
    "Sorts pixels by luminance in contiguous spans. Runs on CPU — drop Scale before Every N frames.",
  inputs: [{ id: "src", label: "texture", type: "texture" }],
  outputs: [{ id: "out", label: "texture", type: "texture" }],
  params: [
    { key: "thresh", label: "Threshold", type: "range", min: 0, max: 255, step: 1, default: 110 },
    { key: "vert", label: "Vertical", type: "toggle", default: false },
    { key: "scale", label: "Scale", type: "range", min: 0.25, max: 1, step: 0.25, default: 1 },
    { key: "interval", label: "Every N frames", type: "range", min: 1, max: 8, step: 1, default: 1 },
    { key: "asyncRead", label: "Async readback", type: "toggle", default: false },
    { key: "worker", label: "Run in worker", type: "toggle", default: true },
  ],
  createState() {
    return {
      buffer: new PixelBuffer(),
      lastFrame: -1,
      lum: new Uint8Array(0),
      counts: new Uint32Array(BINS),
      scratch: new Uint32Array(0),
      job: null,
      pending: null,
      lastW: 0,
      lastH: 0,
      readMs: 0,
      sortMs: 0,
      writeMs: 0,
      statusFrame: -1,
      statusMessage: "",
    };
  },
  disposeState(state, ctx) {
    state.job?.dispose();
    state.buffer.dispose(ctx.gl);
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const gl = ctx.gl;
    const target = ctx.target(nodeId, "out");
    const source = inputs.src;
    if (!isRenderTarget(source)) {
      clearTarget(gl, target, 0, 0, 0, 0);
      return { out: target };
    }

    const state = runtime.state;
    if (!state.job) {
      state.job = new PixelSortJob(nodeId, (response) => {
        state.pending = response;
      });
    }

    // Worker reply landed — upload before deciding whether to start another sort.
    if (state.pending) {
      const pending = state.pending;
      state.pending = null;
      state.sortMs = pending.sortMs;
      state.buffer.setWords(pending.words, pending.width, pending.height);
      writeSorted(gl, ctx, nodeId, state, target, pending.width, pending.height);
      if (ctx.frameCount - state.statusFrame >= STATUS_EVERY) {
        state.statusFrame = ctx.frameCount;
        const message =
          `${pending.width}×${pending.height} · read ${Math.round(state.readMs)} ms · ` +
          `sort ${Math.round(state.sortMs)} ms · write ${Math.round(state.writeMs)} ms`;
        if (message !== state.statusMessage) {
          state.statusMessage = message;
          ctx.report(nodeId, "ready", message);
        }
      }
    }

    // A full readback plus sort is expensive; on skipped frames the target
    // still holds the previous result, so leaving it alone is the throttle.
    const interval = Math.max(1, Math.round(paramNumber(params, "interval", 1)));
    if (runtime.state.lastFrame >= 0 && ctx.frameCount % interval !== 0) {
      return { out: target };
    }

    const useWorker = paramBool(params, "worker", true);
    // A job is still running — let it finish rather than stacking stale frames.
    if (useWorker && state.job.busy) return { out: target };

    runtime.state.lastFrame = ctx.frameCount;

    const { buffer } = state;

    // Sorting is linear in pixel count, so half scale is a quarter of the work.
    // Unlike the frame throttle it keeps the effect live, just coarser.
    const scale = Math.min(1, Math.max(0.25, paramNumber(params, "scale", 1)));
    let readSource: RenderTarget = source;
    let small: RenderTarget | null = null;
    if (scale < 1) {
      small = ctx.target(
        nodeId,
        "small",
        Math.max(1, Math.round(source.width * scale)),
        Math.max(1, Math.round(source.height * scale)),
      );
      copyTexture(gl, source.texture, small);
      readSource = small;
    }

    // Async trades a frame of latency for the pipeline stall in readPixels. What
    // lands is the frame the readback started on, so the effect runs one behind —
    // fine for a glitch, not always what you want, hence the toggle.
    const readStart = performance.now();
    const image = paramBool(params, "asyncRead", false)
      ? buffer.readAsync(gl, readSource)
      : buffer.read(gl, readSource);
    // Nothing has landed yet (first frames, or the GPU is still busy) — the
    // target keeps what it had, exactly like a throttled frame.
    if (!image) return { out: target };
    const sortStart = performance.now();
    state.readMs = sortStart - readStart;

    const width = image.width;
    const height = image.height;
    const thresh = Math.round(paramNumber(params, "thresh", 110));
    const vert = paramBool(params, "vert", false);

    if (useWorker) {
      // Copy: PixelBuffer reuses its array, and posting transfers ownership.
      const words = buffer.words.slice();
      const posted = state.job.submit({ words, width, height, thresh, vert });
      if (posted) return { out: target };
    }

    ensureBuffers(state, width, height);
    sortFrame(buffer.words, width, height, thresh, vert, state.lum, state.counts, state.scratch);
    state.sortMs = performance.now() - sortStart;

    const writeStart = performance.now();
    const sized =
      small ??
      (target.width === width && target.height === height
        ? target
        : ctx.target(nodeId, "cpu", width, height));
    buffer.writePixels(gl, sized);
    if (sized !== target) copyTexture(gl, sized.texture, target);
    const end = performance.now();

    state.writeMs = end - writeStart;
    state.lastW = width;
    state.lastH = height;
    if (ctx.frameCount - state.statusFrame >= STATUS_EVERY) {
      state.statusFrame = ctx.frameCount;
      const message =
        `${width}×${height} · read ${Math.round(state.readMs)} ms · ` +
        `sort ${Math.round(state.sortMs)} ms · write ${Math.round(state.writeMs)} ms`;
      if (message !== state.statusMessage) {
        state.statusMessage = message;
        ctx.report(nodeId, "ready", message);
      }
    }

    return { out: target };
  },
});
