/** Luminance is quantised to a byte, so the sort key indexes a bin directly. */
export const BINS = 256;

/** Rec.601 luma rounded to a byte. One pass over the frame replaces every `lum()` call. */
export function computeLuminance(data: Uint8ClampedArray, lum: Uint8Array, pixels: number): void {
  for (let i = 0, p = 0; i < pixels; i += 1, p += 4) {
    lum[i] = (0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]! + 0.5) | 0;
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
export function sortSpan(
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
    const value = lum[idx]!;
    if (value < lo) lo = value;
    if (value > hi) hi = value;
    counts[value]! += 1;
  }

  // A flat span is already sorted — skip straight to clearing the bins.
  if (lo !== hi) {
    let sum = 0;
    for (let value = lo; value <= hi; value += 1) {
      const count = counts[value]!;
      counts[value] = sum;
      sum += count;
    }

    idx = start;
    for (let k = 0; k < len; k += 1, idx += stride) {
      scratch[counts[lum[idx]!]!++] = words[idx]!;
    }

    idx = start;
    for (let k = 0; k < len; k += 1, idx += stride) {
      words[idx] = scratch[k]!;
    }
  }

  for (let value = lo; value <= hi; value += 1) counts[value] = 0;
}

/**
 * Walk rows (or columns) and sort every run of pixels brighter than the
 * threshold. Both orientations share this loop — only the stride differs.
 */
export function sortSpans(
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
      if (lum[idx]! <= thresh) {
        k += 1;
        idx += stride;
        continue;
      }
      const spanStart = idx;
      let len = 0;
      while (k < lineLength && lum[idx]! > thresh) {
        len += 1;
        k += 1;
        idx += stride;
      }
      if (len > 1) sortSpan(words, lum, spanStart, len, stride, counts, scratch);
    }
  }
}

/** Luminance + span sort in one shot — used by the worker and the inline path. */
export function sortFrame(
  words: Uint32Array,
  width: number,
  height: number,
  thresh: number,
  vert: boolean,
  lum: Uint8Array,
  counts: Uint32Array,
  scratch: Uint32Array,
): void {
  const pixels = width * height;
  const bytes = new Uint8ClampedArray(words.buffer, words.byteOffset, pixels * 4);
  computeLuminance(bytes, lum, pixels);
  sortSpans(words, lum, width, height, thresh, vert, counts, scratch);
}
