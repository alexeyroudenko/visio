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
  private pixelWords = new Uint32Array(0);
  private imageData: ImageData | null = null;
  private uploadId = 0;
  /**
   * Pixel-pack buffers for `readAsync`, allocated on first use. Each slot in
   * flight is another frame of latency, so this is deliberately one: a caller
   * doing real per-frame work leaves the GPU far more time than a readback
   * needs, and a second slot would buy throughput nobody is short of while
   * doubling the lag.
   */
  private slots: { pbo: WebGLBuffer | null; fence: WebGLSync | null; bytes: number }[] = [
    { pbo: null, fence: null, bytes: 0 },
  ];
  /** FIFO over `slots`: retire at `head`, issue at `tail`. */
  private head = 0;
  private tail = 0;
  private inFlight = 0;
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

  /**
   * The same bytes viewed as one word per pixel. Moving pixels around costs a
   * single assignment instead of four, and the byte order inside a word is
   * whatever the platform uses either way — nothing here unpacks channels.
   */
  get words(): Uint32Array {
    return this.pixelWords;
  }

  /** Pull RGBA from a render target into a reusable ImageData. */
  read(gl: WebGL2RenderingContext, source: RenderTarget): ImageData {
    const { width, height } = source;
    this.ensureSize(width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, source.framebuffer);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
    // The view wraps `pixels` in place, so it only has to be rebuilt on resize.
    if (!this.imageData) this.imageData = new ImageData(this.pixels, width, height);
    return this.imageData;
  }

  /**
   * Same readback, but without waiting for the GPU.
   *
   * `read` blocks until every queued command has finished, because the pixels
   * have to exist by the time it returns. Here the copy goes into a pixel-pack
   * buffer instead, a fence records when the GPU is done with it, and the result
   * is only pulled to the CPU on a later frame once that fence has signalled.
   * Nothing ever waits: an unsignalled fence just means "not this frame".
   *
   * The cost is latency — what comes back is the frame the readback started on,
   * so the caller is always one behind. Returns null until the first has landed.
   *
   * One slot by design: a second would pipeline issue+retire without waiting
   * for a free slot, but doubles the lag for no throughput anyone needs here.
   */
  readAsync(gl: WebGL2RenderingContext, source: RenderTarget): ImageData | null {
    const { width, height } = source;
    // A resize makes anything in flight the wrong shape.
    if (width !== this.width || height !== this.height) this.discardPending(gl);
    this.ensureSize(width, height);

    const bytes = width * height * 4;
    const count = this.slots.length;
    let landed: ImageData | null = null;

    // Retire the oldest readback first, so frames come back in the order they
    // were issued.
    if (this.inFlight > 0) {
      const slot = this.slots[this.head]!;
      const status = gl.clientWaitSync(slot.fence!, 0, 0);
      const done = status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED;
      if (done || status === gl.WAIT_FAILED) {
        if (done) {
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.pixels);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
          if (!this.imageData) this.imageData = new ImageData(this.pixels, width, height);
          landed = this.imageData;
        }
        gl.deleteSync(slot.fence!);
        slot.fence = null;
        this.head = (this.head + 1) % count;
        this.inFlight -= 1;
      }
    }

    // Start another one whenever a slot is free. Bailing out here instead would
    // leave the second buffer permanently unused and the queue stuck.
    if (this.inFlight < count) {
      const slot = this.slots[this.tail]!;
      if (!slot.pbo) slot.pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
      if (slot.bytes !== bytes) {
        gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
        slot.bytes = bytes;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, source.framebuffer);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      // Without this the fence can sit unflushed in the client queue and a
      // zero-timeout clientWaitSync never sees it signal — the readback would
      // silently never land.
      gl.flush();
      this.tail = (this.tail + 1) % count;
      this.inFlight += 1;
    }

    return landed;
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
    this.pixelWords = new Uint32Array(
      this.pixels.buffer,
      this.pixels.byteOffset,
      this.width * this.height,
    );
    return this.imageData;
  }

  /** Upload the canvas into a graph render target. */
  write(ctx: EngineContext, target: RenderTarget): void {
    if (!this.texture) this.texture = new SourceTexture(ctx.gl, { premultiply: false });
    this.uploadId += 1;
    this.texture.upload(this.canvas, this.uploadId);
    copyTexture(ctx.gl, this.texture.texture, target);
  }

  /**
   * Upload the pixel buffer straight into a target's texture, skipping the 2D
   * canvas and the fullscreen blit. Only for nodes that edit bytes rather than
   * draw — anything that paints with the 2D context still needs `write`.
   * Values go up as-is: everything in the graph is already premultiplied.
   */
  writePixels(gl: WebGL2RenderingContext, target: RenderTarget): void {
    if (target.width !== this.width || target.height !== this.height) return;
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.width,
      this.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.pixels,
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  dispose(gl?: WebGL2RenderingContext): void {
    this.texture?.dispose();
    this.texture = null;
    if (gl) this.discardPending(gl, true);
  }

  /** Drop in-flight readbacks — their pixels no longer describe anything useful. */
  private discardPending(gl: WebGL2RenderingContext, deleteBuffers = false): void {
    for (const slot of this.slots) {
      if (slot.fence) {
        gl.deleteSync(slot.fence);
        slot.fence = null;
      }
      if (deleteBuffers && slot.pbo) {
        gl.deleteBuffer(slot.pbo);
        slot.pbo = null;
        slot.bytes = 0;
      }
    }
    this.head = 0;
    this.tail = 0;
    this.inFlight = 0;
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
    this.pixelWords = new Uint32Array(this.pixels.buffer, 0, width * height);
    this.imageData = null;
  }
}
