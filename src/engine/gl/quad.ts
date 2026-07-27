import { getProgram, type Program } from "./program";
import { bindTarget, type RenderTarget } from "./rt";

/** Fullscreen triangle — no vertex buffer, position derived from gl_VertexID. */
export const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = pos;
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`;

const COPY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uOpacity;
uniform bool uFlipY;
out vec4 fragColor;
void main() {
  vec2 uv = uFlipY ? vec2(vUv.x, 1.0 - vUv.y) : vUv;
  fragColor = texture(uTex, uv) * uOpacity;
}`;

let vao: WebGLVertexArrayObject | null = null;

/** All fullscreen passes share one empty VAO. */
function ensureVao(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  if (!vao) vao = gl.createVertexArray();
  return vao!;
}

export function drawFullscreen(gl: WebGL2RenderingContext, program: Program): void {
  gl.bindVertexArray(ensureVao(gl));
  program.use();
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
}

export function bindTexture(
  gl: WebGL2RenderingContext,
  program: Program,
  name: string,
  texture: WebGLTexture,
  unit: number,
): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(program.uniform(name), unit);
}

/** Copies a texture into a target. Used for previews and the final output blit. */
export function copyTexture(
  gl: WebGL2RenderingContext,
  source: WebGLTexture,
  target: RenderTarget | null,
  opts: {
    opacity?: number;
    flipY?: boolean;
    viewport?: [number, number];
    /** Blend over what's already there instead of replacing it. */
    blend?: boolean;
  } = {},
): void {
  const program = getProgram(gl, FULLSCREEN_VS, COPY_FS);
  if (target) {
    bindTarget(gl, target);
  } else {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (opts.viewport) gl.viewport(0, 0, opts.viewport[0], opts.viewport[1]);
  }
  program.use();
  if (opts.blend) {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  } else {
    gl.disable(gl.BLEND);
  }
  bindTexture(gl, program, "uTex", source, 0);
  gl.uniform1f(program.uniform("uOpacity"), opts.opacity ?? 1);
  gl.uniform1i(program.uniform("uFlipY"), opts.flipY ? 1 : 0);
  drawFullscreen(gl, program);
}
