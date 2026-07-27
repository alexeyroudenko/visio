import { copyTexture } from "../../engine/gl/quad";
import type { RenderTarget } from "../../engine/gl/rt";
import { SourceTexture } from "../../engine/gl/videoTexture";
import type { EngineContext } from "../../engine/types";

/**
 * A 2D canvas composited over a render target.
 *
 * Everything else in the graph draws on the GPU, but text has no cheap WebGL
 * equivalent — so nodes that need labels render their whole overlay here and
 * upload it once per frame.
 */
export class CanvasOverlay {
  private canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  private texture: SourceTexture | null = null;
  private uploadId = 0;

  constructor() {
    this.ctx = this.canvas.getContext("2d")!;
  }

  /** Clears and returns the drawing context, sized to the target. */
  begin(width: number, height: number): CanvasRenderingContext2D {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, width, height);
    this.ctx.globalAlpha = 1;
    return this.ctx;
  }

  /** Uploads what was drawn and blends it over the target. */
  commit(ctx: EngineContext, target: RenderTarget): void {
    if (!this.texture) this.texture = new SourceTexture(ctx.gl, { premultiply: true });
    this.uploadId += 1;
    this.texture.upload(this.canvas, this.uploadId);
    copyTexture(ctx.gl, this.texture.texture, target, { blend: true });
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
  }
}
