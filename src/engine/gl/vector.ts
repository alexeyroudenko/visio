import { getProgram } from "./program";

/**
 * Instanced 2D primitives for the draw nodes: soft round points and thick
 * segments. Coordinates are pixels of the target, y pointing down like canvas.
 */

const POINT_VS = `#version 300 es
in vec2 aCorner;
in vec2 aPos;
in float aSize;
in float aAlpha;
uniform vec2 uResolution;
/** Stroke width in px; 0 draws a filled disc instead of a ring. */
uniform float uThickness;
out vec2 vCorner;
out float vAlpha;
out float vSize;
out float vExtent;
void main() {
  vCorner = aCorner;
  vAlpha = aAlpha;
  vSize = aSize;
  // Grow the quad by the stroke so the outer half of a ring isn't clipped.
  float extent = aSize + uThickness;
  vExtent = extent;
  vec2 px = aPos + aCorner * extent;
  // Targets store v=0 at the top of the image, so y maps straight through.
  vec2 clip = vec2(px.x / uResolution.x * 2.0 - 1.0, px.y / uResolution.y * 2.0 - 1.0);
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const POINT_FS = `#version 300 es
precision highp float;
in vec2 vCorner;
in float vAlpha;
in float vSize;
in float vExtent;
uniform vec3 uColor;
uniform float uSoftness;
uniform float uThickness;
out vec4 fragColor;
void main() {
  // Work in px so the stroke width means the same at any radius.
  float dPx = length(vCorner) * vExtent;
  float edge;
  if (uThickness > 0.0) {
    float halfStroke = uThickness * 0.5;
    float feather = max(halfStroke * uSoftness, 0.5);
    edge = 1.0 - smoothstep(halfStroke - feather, halfStroke, abs(dPx - vSize));
  } else {
    float feather = max(vSize * uSoftness, 0.5);
    edge = 1.0 - smoothstep(vSize - feather, vSize, dPx);
  }
  if (edge <= 0.0) discard;
  fragColor = vec4(uColor, 1.0) * edge * vAlpha;
}`;

const SEGMENT_VS = `#version 300 es
in vec2 aCorner;
in vec2 aFrom;
in vec2 aTo;
in float aWidth;
in float aAlpha;
uniform vec2 uResolution;
out float vAcross;
out float vAlpha;
void main() {
  // The shared quad arrives as [-1,1]^2; remap to [0,1] along, [-0.5,0.5] across.
  float along = aCorner.x * 0.5 + 0.5;
  float across = aCorner.y * 0.5;
  vAcross = aCorner.y;
  vAlpha = aAlpha;
  vec2 dir = aTo - aFrom;
  float len = max(length(dir), 0.0001);
  vec2 unit = dir / len;
  vec2 normal = vec2(-unit.y, unit.x);
  vec2 px = aFrom + unit * (along * len) + normal * (across * aWidth);
  vec2 clip = vec2(px.x / uResolution.x * 2.0 - 1.0, px.y / uResolution.y * 2.0 - 1.0);
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const SEGMENT_FS = `#version 300 es
precision highp float;
in float vAcross;
in float vAlpha;
uniform vec3 uColor;
uniform float uSoftness;
out vec4 fragColor;
void main() {
  float edge = 1.0 - smoothstep(1.0 - uSoftness, 1.0, abs(vAcross));
  if (edge <= 0.0) discard;
  fragColor = vec4(uColor, 1.0) * edge * vAlpha;
}`;

export type BlendMode = "normal" | "add";

export interface PointBatch {
  /** [x, y, size, alpha] per point, pixel space. */
  data: Float32Array;
  count: number;
}

export interface SegmentBatch {
  /** [x0, y0, x1, y1, width, alpha] per segment, pixel space. */
  data: Float32Array;
  count: number;
}

interface Buffers {
  corner: WebGLBuffer;
  instance: WebGLBuffer;
  pointVao: WebGLVertexArrayObject;
  segmentVao: WebGLVertexArrayObject;
}

const perContext = new WeakMap<WebGL2RenderingContext, Buffers>();

function ensureBuffers(gl: WebGL2RenderingContext): Buffers {
  const hit = perContext.get(gl);
  if (hit) return hit;

  const corner = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, corner);
  // A quad as a triangle strip, in [-1,1] for points / [0,1]x[-0.5,0.5] for segments.
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );

  const instance = gl.createBuffer()!;

  const pointProgram = getProgram(gl, POINT_VS, POINT_FS);
  const pointVao = gl.createVertexArray()!;
  gl.bindVertexArray(pointVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, corner);
  const pCorner = pointProgram.attrib("aCorner");
  gl.enableVertexAttribArray(pCorner);
  gl.vertexAttribPointer(pCorner, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, instance);
  bindInstanced(gl, pointProgram.attrib("aPos"), 2, 16, 0);
  bindInstanced(gl, pointProgram.attrib("aSize"), 1, 16, 8);
  bindInstanced(gl, pointProgram.attrib("aAlpha"), 1, 16, 12);

  const segmentProgram = getProgram(gl, SEGMENT_VS, SEGMENT_FS);
  const segmentVao = gl.createVertexArray()!;
  gl.bindVertexArray(segmentVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, corner);
  const sCorner = segmentProgram.attrib("aCorner");
  gl.enableVertexAttribArray(sCorner);
  gl.vertexAttribPointer(sCorner, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, instance);
  bindInstanced(gl, segmentProgram.attrib("aFrom"), 2, 24, 0);
  bindInstanced(gl, segmentProgram.attrib("aTo"), 2, 24, 8);
  bindInstanced(gl, segmentProgram.attrib("aWidth"), 1, 24, 16);
  bindInstanced(gl, segmentProgram.attrib("aAlpha"), 1, 24, 20);

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  const buffers: Buffers = { corner, instance, pointVao, segmentVao };
  perContext.set(gl, buffers);
  return buffers;
}

function bindInstanced(
  gl: WebGL2RenderingContext,
  location: number,
  size: number,
  stride: number,
  offset: number,
): void {
  if (location < 0) return;
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
  gl.vertexAttribDivisor(location, 1);
}

export function applyBlend(gl: WebGL2RenderingContext, mode: BlendMode): void {
  gl.enable(gl.BLEND);
  // Premultiplied output from the fragment shaders above.
  if (mode === "add") gl.blendFunc(gl.ONE, gl.ONE);
  else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
}

export function drawPoints(
  gl: WebGL2RenderingContext,
  batch: PointBatch,
  opts: {
    color: [number, number, number];
    softness?: number;
    blend?: BlendMode;
    /** px stroke width; omit or 0 for filled discs. */
    thickness?: number;
  },
): void {
  if (batch.count === 0) return;
  const buffers = ensureBuffers(gl);
  const program = getProgram(gl, POINT_VS, POINT_FS);

  gl.bindVertexArray(buffers.pointVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.instance);
  gl.bufferData(gl.ARRAY_BUFFER, batch.data.subarray(0, batch.count * 4), gl.DYNAMIC_DRAW);

  program.use();
  applyBlend(gl, opts.blend ?? "normal");
  const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
  gl.uniform2f(program.uniform("uResolution"), viewport[2], viewport[3]);
  gl.uniform3fv(program.uniform("uColor"), opts.color);
  gl.uniform1f(program.uniform("uSoftness"), opts.softness ?? 0.3);
  gl.uniform1f(program.uniform("uThickness"), opts.thickness ?? 0);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
  gl.bindVertexArray(null);
}

export function drawSegments(
  gl: WebGL2RenderingContext,
  batch: SegmentBatch,
  opts: { color: [number, number, number]; softness?: number; blend?: BlendMode },
): void {
  if (batch.count === 0) return;
  const buffers = ensureBuffers(gl);
  const program = getProgram(gl, SEGMENT_VS, SEGMENT_FS);

  gl.bindVertexArray(buffers.segmentVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.instance);
  gl.bufferData(gl.ARRAY_BUFFER, batch.data.subarray(0, batch.count * 6), gl.DYNAMIC_DRAW);

  program.use();
  applyBlend(gl, opts.blend ?? "normal");
  const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
  gl.uniform2f(program.uniform("uResolution"), viewport[2], viewport[3]);
  gl.uniform3fv(program.uniform("uColor"), opts.color);
  gl.uniform1f(program.uniform("uSoftness"), opts.softness ?? 0.4);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
  gl.bindVertexArray(null);
}

/** Grow-only scratch arrays so draw nodes don't allocate per frame. */
export class BatchBuilder {
  private points = new Float32Array(4 * 1024);
  private segments = new Float32Array(6 * 1024);
  pointCount = 0;
  segmentCount = 0;

  reset(): void {
    this.pointCount = 0;
    this.segmentCount = 0;
  }

  addPoint(x: number, y: number, size: number, alpha: number): void {
    const offset = this.pointCount * 4;
    if (offset + 4 > this.points.length) {
      const grown = new Float32Array(this.points.length * 2);
      grown.set(this.points);
      this.points = grown;
    }
    this.points[offset] = x;
    this.points[offset + 1] = y;
    this.points[offset + 2] = size;
    this.points[offset + 3] = alpha;
    this.pointCount += 1;
  }

  addSegment(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    width: number,
    alpha: number,
  ): void {
    const offset = this.segmentCount * 6;
    if (offset + 6 > this.segments.length) {
      const grown = new Float32Array(this.segments.length * 2);
      grown.set(this.segments);
      this.segments = grown;
    }
    this.segments[offset] = x0;
    this.segments[offset + 1] = y0;
    this.segments[offset + 2] = x1;
    this.segments[offset + 3] = y1;
    this.segments[offset + 4] = width;
    this.segments[offset + 5] = alpha;
    this.segmentCount += 1;
  }

  addRect(x: number, y: number, w: number, h: number, width: number, alpha: number): void {
    this.addSegment(x, y, x + w, y, width, alpha);
    this.addSegment(x + w, y, x + w, y + h, width, alpha);
    this.addSegment(x + w, y + h, x, y + h, width, alpha);
    this.addSegment(x, y + h, x, y, width, alpha);
  }

  pointBatch(): PointBatch {
    return { data: this.points, count: this.pointCount };
  }

  segmentBatch(): SegmentBatch {
    return { data: this.segments, count: this.segmentCount };
  }
}
