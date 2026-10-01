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

/** Fold degrees into [0, 180). */
export function normalizeSortAngle(degrees: number): number {
  let angle = degrees % 180;
  if (angle < 0) angle += 180;
  return angle;
}

/**
 * Rotation 0 keeps the Vertical toggle; any other angle is absolute degrees
 * from horizontal (90 ≡ vertical column sort).
 */
export function effectiveSortAngle(rotationDeg: number, vert: boolean): number {
  const angle = normalizeSortAngle(rotationDeg);
  if (angle < 0.5 || angle > 179.5) return vert ? 90 : 0;
  return angle;
}

/**
 * Rotate packed RGBA words into a padded axis-aligned buffer. Empty cells stay 0.
 * `minX`/`minY` are the translation applied so every source corner fits.
 */
export function rotateWords(
  src: Uint32Array,
  width: number,
  height: number,
  angleDeg: number,
): { words: Uint32Array; width: number; height: number; minX: number; minY: number } {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners: Array<[number, number]> = [
    [0, 0],
    [width - 1, 0],
    [width - 1, height - 1],
    [0, height - 1],
  ];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of corners) {
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    if (rx < minX) minX = rx;
    if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry;
    if (ry > maxY) maxY = ry;
  }
  const outW = Math.max(1, Math.ceil(maxX - minX + 1));
  const outH = Math.max(1, Math.ceil(maxY - minY + 1));
  const out = new Uint32Array(outW * outH);
  const invCos = Math.cos(-rad);
  const invSin = Math.sin(-rad);
  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      const dx = x + minX;
      const dy = y + minY;
      const sx = Math.round(dx * invCos - dy * invSin);
      const sy = Math.round(dx * invSin + dy * invCos);
      if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
        out[y * outW + x] = src[sy * width + sx]!;
      }
    }
  }
  return { words: out, width: outW, height: outH, minX, minY };
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

/**
 * Sort along `angleDeg` degrees from horizontal. Cardinal angles (0 / 90)
 * use the fast row/column path; other angles rotate → horizontal sort → sample back.
 */
export function sortFrameAtAngle(
  words: Uint32Array,
  width: number,
  height: number,
  thresh: number,
  angleDeg: number,
  lum: Uint8Array,
  counts: Uint32Array,
  scratch: Uint32Array,
): void {
  const angle = normalizeSortAngle(angleDeg);
  if (angle < 0.5 || angle > 179.5) {
    sortFrame(words, width, height, thresh, false, lum, counts, scratch);
    return;
  }
  if (Math.abs(angle - 90) < 0.5) {
    sortFrame(words, width, height, thresh, true, lum, counts, scratch);
    return;
  }

  const rotated = rotateWords(words, width, height, -angle);
  const rPixels = rotated.width * rotated.height;
  const rLum = lum.length >= rPixels ? lum : new Uint8Array(rPixels);
  const longest = Math.max(rotated.width, rotated.height);
  const rScratch = scratch.length >= longest ? scratch : new Uint32Array(longest);
  sortFrame(
    rotated.words,
    rotated.width,
    rotated.height,
    thresh,
    false,
    rLum,
    counts,
    rScratch,
  );

  const rad = (-angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const rx = Math.round(x * cos - y * sin - rotated.minX);
      const ry = Math.round(x * sin + y * cos - rotated.minY);
      if (rx >= 0 && rx < rotated.width && ry >= 0 && ry < rotated.height) {
        words[y * width + x] = rotated.words[ry * rotated.width + rx]!;
      }
    }
  }
}
