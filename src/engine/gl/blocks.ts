import { getProgram } from "./program";

/**
 * Instanced textured quads: each instance copies a rectangle of the source
 * texture to another rectangle of the target, optionally tinted.
 *
 * This is the GPU equivalent of a batch of `ctx.drawImage(src, sx,sy,sw,sh, …)`
 * calls, which is what the glitcher block scatter is built from.
 */

const BLOCK_VS = `#version 300 es
in vec2 aCorner;
in vec4 aSrc;
in vec4 aDst;
in vec4 aTint;
out vec2 vSrcUv;
out vec4 vTint;
void main() {
  vSrcUv = aSrc.xy + aCorner * aSrc.zw;
  vTint = aTint;
  vec2 uv = aDst.xy + aCorner * aDst.zw;
  // Targets keep v=0 at the top, so uv maps straight to clip space.
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

const BLOCK_FS = `#version 300 es
precision highp float;
in vec2 vSrcUv;
in vec4 vTint;
uniform sampler2D uTex;
out vec4 fragColor;

float overlayChannel(float base, float blend) {
  return base < 0.5 ? 2.0 * base * blend : 1.0 - 2.0 * (1.0 - base) * (1.0 - blend);
}

void main() {
  vec4 texel = texture(uTex, vSrcUv);
  vec3 rgb = texel.rgb;
  if (vTint.a > 0.0) {
    vec3 blended = vec3(
      overlayChannel(rgb.r, vTint.r),
      overlayChannel(rgb.g, vTint.g),
      overlayChannel(rgb.b, vTint.b)
    );
    rgb = mix(rgb, blended, vTint.a);
  }
  fragColor = vec4(rgb, texel.a);
}`;

const FLOATS_PER_INSTANCE = 12;
const STRIDE = FLOATS_PER_INSTANCE * 4;

interface Buffers {
  corner: WebGLBuffer;
  instance: WebGLBuffer;
  vao: WebGLVertexArrayObject;
}

const perContext = new WeakMap<WebGL2RenderingContext, Buffers>();

function bindInstanced(
  gl: WebGL2RenderingContext,
  location: number,
  size: number,
  offset: number,
): void {
  if (location < 0) return;
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, STRIDE, offset);
  gl.vertexAttribDivisor(location, 1);
}

function ensureBuffers(gl: WebGL2RenderingContext): Buffers {
  const hit = perContext.get(gl);
  if (hit) return hit;

  const program = getProgram(gl, BLOCK_VS, BLOCK_FS);
  const corner = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, corner);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

  const instance = gl.createBuffer()!;
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, corner);
  const cornerLoc = program.attrib("aCorner");
  gl.enableVertexAttribArray(cornerLoc);
  gl.vertexAttribPointer(cornerLoc, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, instance);
  bindInstanced(gl, program.attrib("aSrc"), 4, 0);
  bindInstanced(gl, program.attrib("aDst"), 4, 16);
  bindInstanced(gl, program.attrib("aTint"), 4, 32);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  const buffers: Buffers = { corner, instance, vao };
  perContext.set(gl, buffers);
  return buffers;
}

/** Grow-only instance data, so a busy patch doesn't allocate every frame. */
export class BlockBatch {
  private data = new Float32Array(FLOATS_PER_INSTANCE * 256);
  count = 0;

  reset(): void {
    this.count = 0;
  }

  /** All rects are in uv space (0..1). Pass tintAlpha 0 for no tint. */
  add(
    src: [number, number, number, number],
    dst: [number, number, number, number],
    tint: [number, number, number],
    tintAlpha: number,
  ): void {
    const offset = this.count * FLOATS_PER_INSTANCE;
    if (offset + FLOATS_PER_INSTANCE > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data.set(src, offset);
    this.data.set(dst, offset + 4);
    this.data[offset + 8] = tint[0];
    this.data[offset + 9] = tint[1];
    this.data[offset + 10] = tint[2];
    this.data[offset + 11] = tintAlpha;
    this.count += 1;
  }

  view(): Float32Array {
    return this.data.subarray(0, this.count * FLOATS_PER_INSTANCE);
  }
}

/** Draws the batch into whatever framebuffer is currently bound. */
export function drawBlocks(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  batch: BlockBatch,
): void {
  if (batch.count === 0) return;
  const buffers = ensureBuffers(gl);
  const program = getProgram(gl, BLOCK_VS, BLOCK_FS);

  gl.bindVertexArray(buffers.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.instance);
  gl.bufferData(gl.ARRAY_BUFFER, batch.view(), gl.DYNAMIC_DRAW);

  program.use();
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(program.uniform("uTex"), 0);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
  gl.bindVertexArray(null);
}
