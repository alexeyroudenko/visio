/**
 * Uploads a <video>/<canvas> into a GL texture, keeping v=0 at the image top
 * (the convention every target in the graph follows).
 */
export class SourceTexture {
  private gl: WebGL2RenderingContext;
  readonly texture: WebGLTexture;
  width = 1;
  height = 1;
  private lastFrameId = -1;
  /** Overlays with soft edges must be premultiplied to blend correctly. */
  private premultiply: boolean;

  constructor(gl: WebGL2RenderingContext, options: { premultiply?: boolean } = {}) {
    this.gl = gl;
    this.premultiply = options.premultiply ?? false;
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** No-op when the source has not produced a new frame since last call. */
  upload(source: HTMLVideoElement | HTMLCanvasElement, frameId: number): void {
    if (frameId === this.lastFrameId) return;
    const width =
      source instanceof HTMLVideoElement ? source.videoWidth : source.width;
    const height =
      source instanceof HTMLVideoElement ? source.videoHeight : source.height;
    if (width === 0 || height === 0) return;

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, this.premultiply);
    if (width !== this.width || height !== this.height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
      this.width = width;
      this.height = height;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.lastFrameId = frameId;
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
  }
}
