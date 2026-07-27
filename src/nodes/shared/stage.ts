export type FitMode = "cover" | "contain" | "stretch";

/**
 * Composites a source frame onto a patch-resolution canvas with fit + mirror.
 *
 * Trackers and the GL texture both read *this* canvas, so normalized landmark
 * coordinates land exactly on the rendered image — no mapping in draw nodes.
 */
export class StageCanvas {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: false })!;
  }

  draw(
    source: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    width: number,
    height: number,
    opts: { mode: FitMode; mirror: boolean },
  ): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);

    if (sourceWidth === 0 || sourceHeight === 0) return;

    if (opts.mirror) {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }

    if (opts.mode === "stretch") {
      ctx.drawImage(source, 0, 0, width, height);
      return;
    }

    const scale =
      opts.mode === "cover"
        ? Math.max(width / sourceWidth, height / sourceHeight)
        : Math.min(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    ctx.drawImage(
      source,
      (width - drawWidth) / 2,
      (height - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );
  }
}
