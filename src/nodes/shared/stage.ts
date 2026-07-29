export type FitMode = "cover" | "contain" | "stretch";

/**
 * Cover-crop source rect and centered destination for a zoom factor
 * (1 = fill frame). Same math as cv-reels `getCoverRects`.
 */
export function getCoverRects(
  iw: number,
  ih: number,
  width: number,
  height: number,
  zoom = 1,
): { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } {
  const aspect = iw / ih;
  const targetAspect = width / height;

  let sx: number;
  let sy: number;
  let sw: number;
  let sh: number;

  if (aspect > targetAspect) {
    sh = ih;
    sw = sh * targetAspect;
    sx = (iw - sw) / 2;
    sy = 0;
  } else {
    sw = iw;
    sh = sw / targetAspect;
    sx = 0;
    sy = (ih - sh) / 2;
  }

  const dw = width * zoom;
  const dh = height * zoom;
  const dx = (width - dw) / 2;
  const dy = (height - dh) / 2;

  return { sx, sy, sw, sh, dx, dy, dw, dh };
}

/**
 * Composites a source frame onto a patch-resolution canvas with fit + mirror + zoom.
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
    opts: { mode: FitMode; mirror: boolean; zoom?: number },
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

    const zoom = Math.max(0, opts.zoom ?? 1);
    if (zoom <= 0) return;

    if (opts.mirror) {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }

    if (opts.mode === "stretch") {
      const dw = width * zoom;
      const dh = height * zoom;
      ctx.drawImage(source, (width - dw) / 2, (height - dh) / 2, dw, dh);
      return;
    }

    if (opts.mode === "cover") {
      const { sx, sy, sw, sh, dx, dy, dw, dh } = getCoverRects(
        sourceWidth,
        sourceHeight,
        width,
        height,
        zoom,
      );
      if (dw <= 0 || dh <= 0) return;
      ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
      return;
    }

    // contain: fit inside, then scale by zoom around center
    const scale = Math.min(width / sourceWidth, height / sourceHeight) * zoom;
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
