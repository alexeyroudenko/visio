import { copyTexture } from "../../engine/gl/quad";
import type { RenderTarget } from "../../engine/gl/rt";
import { SourceTexture } from "../../engine/gl/videoTexture";
import type { EngineContext } from "../../engine/types";

/**
 * CPU pixel scratch for glitch-style FX.
 *
 * Targets store v=0 at the image top; the fullscreen blit puts that at the
 * framebuffer bottom, so a plain readPixels buffer is already top-first and
 * matches canvas ImageData layout.
 */
export class PixelBuffer {
  private canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  private texture: SourceTexture | null = null;
  private pixels = new Uint8ClampedArray(0);
  private imageData: ImageData | null = null;
  private uploadId = 0;
  width = 0;
  height = 0;

  constructor() {
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
  }

  get context(): CanvasRenderingContext2D {
    return this.ctx;
  }

  get element(): HTMLCanvasElement {
    return this.canvas;
  }

  /** Pull RGBA from a render target into a reusable ImageData. */
  read(gl: WebGL2RenderingContext, source: RenderTarget): ImageData {
    const { width, height } = source;
    this.ensureSize(width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, source.framebuffer);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
    this.imageData = new ImageData(this.pixels, width, height);
    return this.imageData;
  }

  /** Push the current ImageData onto the 2D canvas (for drawImage / tint). */
  syncToCanvas(): void {
    if (!this.imageData) return;
    this.ctx.putImageData(this.imageData, 0, 0);
  }

  /** After canvas drawing, refresh the ImageData view. */
  syncFromCanvas(): ImageData {
    this.imageData = this.ctx.getImageData(0, 0, this.width, this.height);
    this.pixels = this.imageData.data;
    return this.imageData;
  }

  /** Upload the canvas into a graph render target. */
  write(ctx: EngineContext, target: RenderTarget): void {
    if (!this.texture) this.texture = new SourceTexture(ctx.gl, { premultiply: false });
    this.uploadId += 1;
    this.texture.upload(this.canvas, this.uploadId);
    copyTexture(ctx.gl, this.texture.texture, target);
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
  }

  private ensureSize(width: number, height: number): void {
    if (this.width === width && this.height === height && this.pixels.length === width * height * 4) {
      return;
    }
    this.width = width;
    this.height = height;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.pixels = new Uint8ClampedArray(width * height * 4);
    this.imageData = null;
  }
}

/** Deterministic [0,1) RNG — same as glitcher. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
