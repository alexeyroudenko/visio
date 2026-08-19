/**
 * OpenCV-style Canny (`cv2.Canny`) with no DOM — same code on the main thread
 * and in the Hough worker. GrayFrame already has 3×3 Sobel; aperture 5/7
 * recomputes Sobel from luminance.
 */
import type { EdgePoint } from "../shared/grayscale";
import { thinEdges } from "./houghAlgorithms";

export type CannyAperture = 3 | 5 | 7;

export interface CannyOptions {
  threshold1: number;
  threshold2: number;
  apertureSize: CannyAperture;
  l2gradient: boolean;
}

const TAN_22_5 = 0.41421356237309505;

const scratch = {
  mag: new Float32Array(0),
  nms: new Float32Array(0),
  gx: new Float32Array(0),
  gy: new Float32Array(0),
  tmp: new Float32Array(0),
  stack: new Int32Array(0),
};

const KERNELS: Record<CannyAperture, { smooth: number[]; deriv: number[] }> = {
  3: { smooth: [1, 2, 1], deriv: [-1, 0, 1] },
  5: { smooth: [1, 4, 6, 4, 1], deriv: [-1, -2, 0, 2, 1] },
  7: { smooth: [1, 6, 15, 20, 15, 6, 1], deriv: [-1, -4, -5, 0, 5, 4, 1] },
};

function clampAperture(value: number): CannyAperture {
  if (value >= 7) return 7;
  if (value >= 5) return 5;
  return 3;
}

export function parseCannyAperture(value: unknown): CannyAperture {
  const n = typeof value === "number" ? value : Number(value);
  if (n === 5 || n === 7) return n;
  return 3;
}

function sample(gray: Float32Array, width: number, height: number, x: number, y: number): number {
  const xx = x < 0 ? 0 : x >= width ? width - 1 : x;
  const yy = y < 0 ? 0 : y >= height ? height - 1 : y;
  return gray[yy * width + xx]!;
}

/** Separable Sobel, OpenCV `getDerivKernels` binomial + derivative. */
function sobel(
  gray: Float32Array,
  width: number,
  height: number,
  aperture: CannyAperture,
  outX: Float32Array,
  outY: Float32Array,
): void {
  const { smooth, deriv } = KERNELS[aperture];
  const r = (aperture - 1) / 2;
  const tmp = scratch.tmp;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -r; k <= r; k += 1) sum += sample(gray, width, height, x + k, y) * deriv[k + r]!;
      tmp[y * width + x] = sum;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -r; k <= r; k += 1) sum += sample(tmp, width, height, x, y + k) * smooth[k + r]!;
      outX[y * width + x] = sum;
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -r; k <= r; k += 1) sum += sample(gray, width, height, x + k, y) * smooth[k + r]!;
      tmp[y * width + x] = sum;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -r; k <= r; k += 1) sum += sample(tmp, width, height, x, y + k) * deriv[k + r]!;
      outY[y * width + x] = sum;
    }
  }
}

function neighbors(gx: number, gy: number, i: number, width: number): [number, number] {
  const ax = Math.abs(gx);
  const ay = Math.abs(gy);
  if (ax > ay * TAN_22_5 && ax * TAN_22_5 > ay) return [i - 1, i + 1];
  if (ay > ax * TAN_22_5 && ay * TAN_22_5 > ax) return [i - width, i + width];
  if (gx * gy > 0) return [i - width - 1, i + width + 1];
  return [i - width + 1, i + width - 1];
}

/**
 * Canny on a downscaled gray buffer. Returns Hough-ready edge points (with
 * unit gradient) subsampled to `limit`.
 */
export function cannyEdges(
  gray: Float32Array,
  width: number,
  height: number,
  opts: CannyOptions,
  limit: number,
  existingGradX?: Float32Array,
  existingGradY?: Float32Array,
  /** Optional 0/255 hysteresis mask (before spatial thinning) for a preview. */
  maskOut?: Uint8Array,
): EdgePoint[] {
  const aperture = clampAperture(opts.apertureSize);
  const size = width * height;
  if (scratch.mag.length !== size) {
    scratch.mag = new Float32Array(size);
    scratch.nms = new Float32Array(size);
    scratch.gx = new Float32Array(size);
    scratch.gy = new Float32Array(size);
    scratch.tmp = new Float32Array(size);
    scratch.stack = new Int32Array(size);
  }
  const mag = scratch.mag;
  const nms = scratch.nms;
  mag.fill(0);
  nms.fill(0);

  const useExisting = aperture === 3 && existingGradX !== undefined && existingGradY !== undefined;
  const gx: Float32Array = useExisting ? existingGradX : scratch.gx;
  const gy: Float32Array = useExisting ? existingGradY : scratch.gy;
  if (!useExisting) sobel(gray, width, height, aperture, scratch.gx, scratch.gy);

  const l2 = opts.l2gradient;
  for (let i = 0; i < size; i += 1) {
    mag[i] = l2 ? gx[i]! * gx[i]! + gy[i]! * gy[i]! : Math.abs(gx[i]!) + Math.abs(gy[i]!);
  }

  let low = Math.min(opts.threshold1, opts.threshold2);
  let high = Math.max(opts.threshold1, opts.threshold2);
  if (l2) {
    low *= low;
    high *= high;
  }

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const m = mag[i]!;
      if (m < low) continue;
      const [a, b] = neighbors(gx[i]!, gy[i]!, i, width);
      if (m >= mag[a]! && m > mag[b]!) nms[i] = m;
    }
  }

  const mask = scratch.tmp;
  mask.fill(0);
  const stack = scratch.stack;
  let top = 0;
  for (let i = 0; i < size; i += 1) {
    const m = nms[i]!;
    if (m >= high) {
      mask[i] = 2;
      stack[top] = i;
      top += 1;
    } else if (m >= low) {
      mask[i] = 1;
    }
  }

  while (top > 0) {
    top -= 1;
    const i = stack[top]!;
    const x = i % width;
    const y = (i / width) | 0;
    for (let dy = -1; dy <= 1; dy += 1) {
      const yy = y + dy;
      if (yy < 0 || yy >= height) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const xx = x + dx;
        if (xx < 0 || xx >= width) continue;
        const n = yy * width + xx;
        if (mask[n] !== 1) continue;
        mask[n] = 2;
        stack[top] = n;
        top += 1;
      }
    }
  }

  if (maskOut && maskOut.length === size) {
    for (let i = 0; i < size; i += 1) maskOut[i] = mask[i] === 2 ? 255 : 0;
  }

  const raw: EdgePoint[] = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      if (mask[i] !== 2) continue;
      const gxv = gx[i]!;
      const gyv = gy[i]!;
      const length = Math.hypot(gxv, gyv);
      const inv = length > 1e-6 ? 1 / length : 0;
      raw.push({ x, y, ux: gxv * inv, uy: gyv * inv, magnitude: length });
    }
  }
  return thinEdges(raw, width, height, limit);
}
