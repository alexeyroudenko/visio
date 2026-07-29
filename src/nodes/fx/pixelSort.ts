import { copyTexture } from "../../engine/gl/quad";
import { clearTarget, isRenderTarget, type RenderTarget } from "../../engine/gl/rt";
import { defineNode, paramBool, paramNumber } from "../defineNode";
import { PixelBuffer } from "../shared/pixelBuffer";

/** Luminance is quantised to a byte, so the sort key indexes a bin directly. */
const BINS = 256;
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

/** Rec.601 luma rounded to a byte. One pass over the frame replaces every `lum()` call. */
function computeLuminance(data: Uint8ClampedArray, lum: Uint8Array, pixels: number): void {
  for (let i = 0, p = 0; i < pixels; i += 1, p += 4) {
    lum[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2] + 0.5) | 0;
  }
}

/**
 * Stable counting sort of one span, in place.
 *
 * The key is already a byte, so no comparisons happen at all: count, prefix-sum,
 * scatter. Every pass — including clearing the bins — is bounded by the span's
 * own luminance range rather than all 256 slots, so a frame made of two-pixel
 * spans does not pay for the full histogram each time. Clearing has to walk the
 * whole range and not just the values present: an empty bin inside the range
 * still picked up an offset from the prefix sum, and leaving it there would
 * corrupt the next span.
 *
 * `lum` is deliberately left alone while `words` moves under it. Spans never
 * overlap and are visited in order, so the now-stale keys are never read again.
 */
function sortSpan(
  words: Uint32Array,
  lum: Uint8Array,
  start: number,
  len: number,
  stride: number,
  counts: Uint32Array,
  scratch: Uint32Array,
): void {
  let lo = 255;
  let hi = 0;
  let idx = start;
  for (let k = 0; k < len; k += 1, idx += stride) {
    const value = lum[idx];
    if (value < lo) lo = value;
    if (value > hi) hi = value;
    counts[value] += 1;
  }

  // A flat span is already sorted — skip straight to clearing the bins.
  if (lo !== hi) {
    let sum = 0;
    for (let value = lo; value <= hi; value += 1) {
      const count = counts[value];
      counts[value] = sum;
      sum += count;
    }

    idx = start;
    for (let k = 0; k < len; k += 1, idx += stride) {
      scratch[counts[lum[idx]]++] = words[idx];
    }

    idx = start;
    for (let k = 0; k < len; k += 1, idx += stride) {
      words[idx] = scratch[k];
    }
  }

  for (let value = lo; value <= hi; value += 1) counts[value] = 0;
}

/**
 * Walk rows (or columns) and sort every run of pixels brighter than the
 * threshold. Both orientations share this loop — only the stride differs.
 */
function sortSpans(
  words: Uint32Array,
  lum: Uint8Array,
  width: number,
  height: number,
  thresh: number,
  vert: boolean,
  counts: Uint32Array,
  scratch: Uint32Array,
): void {
  const lines = vert ? width : height;
  const lineLength = vert ? height : width;
  const stride = vert ? width : 1;

  for (let line = 0; line < lines; line += 1) {
    let idx = vert ? line : line * width;
    let k = 0;
    while (k < lineLength) {
      if (lum[idx] <= thresh) {
        k += 1;
        idx += stride;
        continue;
      }
      const spanStart = idx;
      let len = 0;
      while (k < lineLength && lum[idx] > thresh) {
        len += 1;
        k += 1;
        idx += stride;
      }
      if (len > 1) sortSpan(words, lum, spanStart, len, stride, counts, scratch);
    }
  }
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
  ],
  createState() {
    return {
      buffer: new PixelBuffer(),
      lastFrame: -1,
      lum: new Uint8Array(0),
      counts: new Uint32Array(BINS),
      scratch: new Uint32Array(0),
      readMs: 0,
      sortMs: 0,
      writeMs: 0,
      statusFrame: -1,
      statusMessage: "",
    };
  },
  disposeState(state) {
    state.buffer.dispose();
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const gl = ctx.gl;
    const target = ctx.target(nodeId, "out");
    const source = inputs.src;
    if (!isRenderTarget(source)) {
      clearTarget(gl, target, 0, 0, 0, 0);
      return { out: target };
    }

    // A full readback plus sort is expensive; on skipped frames the target
    // still holds the previous result, so leaving it alone is the throttle.
    const interval = Math.max(1, Math.round(paramNumber(params, "interval", 1)));
    if (runtime.state.lastFrame >= 0 && ctx.frameCount % interval !== 0) {
      return { out: target };
    }
    runtime.state.lastFrame = ctx.frameCount;

    const state = runtime.state;
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

    const readStart = performance.now();
    const image = buffer.read(gl, readSource);
    const sortStart = performance.now();

    const width = image.width;
    const height = image.height;
    ensureBuffers(state, width, height);
    computeLuminance(image.data, state.lum, width * height);
    sortSpans(
      buffer.words,
      state.lum,
      width,
      height,
      Math.round(paramNumber(params, "thresh", 110)),
      paramBool(params, "vert", false),
      state.counts,
      state.scratch,
    );

    // Straight into the target texture: the 2D canvas roundtrip that Quadtree and
    // Features Grid need is three full-frame copies this node never uses. Only a
    // size mismatch (downscale, or a source larger than the graph) needs a blit.
    const writeStart = performance.now();
    const sized =
      small ??
      (target.width === width && target.height === height
        ? target
        : ctx.target(nodeId, "cpu", width, height));
    buffer.writePixels(gl, sized);
    if (sized !== target) copyTexture(gl, sized.texture, target);
    const end = performance.now();

    state.readMs = sortStart - readStart;
    state.sortMs = writeStart - sortStart;
    state.writeMs = end - writeStart;
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
