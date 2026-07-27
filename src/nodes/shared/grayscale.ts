import type { FrameValue } from "../../engine/types";

export interface EdgePoint {
  x: number;
  y: number;
  /** Unit gradient direction — Hough circles vote along it. */
  ux: number;
  uy: number;
  magnitude: number;
}

/**
 * Downscaled grayscale copy of a frame plus its Sobel gradients. Shared by the
 * CPU trackers (corners, Hough circles, Hough lines) so a patch running several
 * of them pays for the readback once per node, with zero per-frame allocation.
 */
export class GrayFrame {
  private canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  gray = new Float32Array(0);
  gradX = new Float32Array(0);
  gradY = new Float32Array(0);
  width = 0;
  height = 0;
  /** Downscale factor actually applied, for mapping results back. */
  factor = 1;

  constructor() {
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
  }

  update(frame: FrameValue, factor: number): void {
    const width = Math.max(8, Math.floor(frame.width / factor));
    const height = Math.max(8, Math.floor(frame.height / factor));
    this.factor = factor;

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.ctx.drawImage(frame.element, 0, 0, width, height);
    const image = this.ctx.getImageData(0, 0, width, height).data;

    const size = width * height;
    if (this.gray.length !== size) {
      this.gray = new Float32Array(size);
      this.gradX = new Float32Array(size);
      this.gradY = new Float32Array(size);
    }
    this.width = width;
    this.height = height;

    const { gray, gradX, gradY } = this;
    for (let i = 0; i < size; i += 1) {
      const p = i * 4;
      gray[i] = image[p] * 0.299 + image[p + 1] * 0.587 + image[p + 2] * 0.114;
    }

    gradX.fill(0);
    gradY.fill(0);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const i = y * width + x;
        gradX[i] =
          -gray[i - 1 - width] +
          gray[i + 1 - width] +
          -2 * gray[i - 1] +
          2 * gray[i + 1] +
          -gray[i - 1 + width] +
          gray[i + 1 + width];
        gradY[i] =
          -gray[i - width - 1] -
          2 * gray[i - width] -
          gray[i - width + 1] +
          gray[i + width - 1] +
          2 * gray[i + width] +
          gray[i + width + 1];
      }
    }
  }

  /**
   * Edge points above `threshold`, evenly subsampled to at most `limit` so the
   * Hough accumulators stay dense enough to peak without blowing up cost.
   */
  collectEdges(threshold: number, limit: number): EdgePoint[] {
    const { width, height, gradX, gradY } = this;
    const raw: EdgePoint[] = [];
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const i = y * width + x;
        const gx = gradX[i];
        const gy = gradY[i];
        const magnitude = Math.hypot(gx, gy);
        if (magnitude < threshold) continue;
        const inv = 1 / magnitude;
        raw.push({ x, y, ux: gx * inv, uy: gy * inv, magnitude });
      }
    }
    if (raw.length <= limit) return raw;

    const step = Math.ceil(raw.length / limit);
    const sampled: EdgePoint[] = [];
    for (let i = 0; i < raw.length; i += step) sampled.push(raw[i]);
    return sampled;
  }
}
