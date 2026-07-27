/** A color texture + its framebuffer. The only "image" currency in the graph. */
export interface RenderTarget {
  readonly kind: "rt";
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

export function createRenderTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): RenderTarget {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return { kind: "rt", texture, framebuffer, width, height };
}

export function resizeRenderTarget(
  gl: WebGL2RenderingContext,
  rt: RenderTarget,
  width: number,
  height: number,
): void {
  if (rt.width === width && rt.height === height) return;
  gl.bindTexture(gl.TEXTURE_2D, rt.texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  rt.width = width;
  rt.height = height;
}

export function disposeRenderTarget(gl: WebGL2RenderingContext, rt: RenderTarget): void {
  gl.deleteFramebuffer(rt.framebuffer);
  gl.deleteTexture(rt.texture);
}

export function bindTarget(gl: WebGL2RenderingContext, rt: RenderTarget): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, rt.framebuffer);
  gl.viewport(0, 0, rt.width, rt.height);
}

export function clearTarget(
  gl: WebGL2RenderingContext,
  rt: RenderTarget,
  r = 0,
  g = 0,
  b = 0,
  a = 0,
): void {
  bindTarget(gl, rt);
  gl.clearColor(r, g, b, a);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

export function isRenderTarget(value: unknown): value is RenderTarget {
  return typeof value === "object" && value !== null && (value as RenderTarget).kind === "rt";
}
