import { bindTexture, copyTexture, drawFullscreen, FULLSCREEN_VS } from "../../engine/gl/quad";
import { getProgram } from "../../engine/gl/program";
import { bindTarget, clearTarget, isRenderTarget } from "../../engine/gl/rt";
import { SourceTexture } from "../../engine/gl/videoTexture";
import type { FrameValue } from "../../engine/types";
import { defineNode, paramNumber } from "../defineNode";
import { StageCanvas } from "../shared/stage";

const ZOOM_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uAmount;
uniform vec2 uCenter;
out vec4 fragColor;

void main() {
  // amount 1 = identity; >1 zooms in (crop); <1 zooms out (letterbox empty = black).
  vec2 uv = (vUv - uCenter) / max(uAmount, 0.001) + uCenter;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0);
    return;
  }
  fragColor = texture(uTex, uv);
}`;

interface ZoomState {
  stage: StageCanvas;
  /** Used when only a frame is wired — upload the zoomed canvas to GL. */
  upload: SourceTexture | null;
  frameId: number;
  drawKey: string;
}

function drawZoomedFrame(
  stage: StageCanvas,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  amount: number,
  centerX: number,
  centerY: number,
): void {
  if (stage.canvas.width !== width || stage.canvas.height !== height) {
    stage.canvas.width = width;
    stage.canvas.height = height;
  }
  const ctx = stage.canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  if (sourceWidth === 0 || sourceHeight === 0) return;

  const cx = centerX * width;
  const cy = centerY * height;
  const scale = Math.max(0.001, amount);
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);
  ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

export const zoomNode = defineNode<ZoomState>({
  type: "fx.zoom",
  label: "Zoom",
  category: "fx",
  description:
    "Scale texture and frame around a center (cover-style crop when amount > 1). Wire both so tracking matches the preview.",
  inputs: [
    { id: "src", label: "texture", type: "texture" },
    { id: "frame", label: "frame", type: "frame" },
  ],
  outputs: [
    { id: "out", label: "texture", type: "texture" },
    { id: "frame", label: "frame", type: "frame" },
  ],
  params: [
    { key: "amount", label: "Amount", type: "range", min: 0.25, max: 4, step: 0.01, default: 1.25 },
    { key: "centerX", label: "Center X", type: "range", min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: "centerY", label: "Center Y", type: "range", min: 0, max: 1, step: 0.01, default: 0.5 },
  ],
  createState() {
    return { stage: new StageCanvas(), upload: null, frameId: 0, drawKey: "" };
  },
  disposeState(state) {
    state.upload?.dispose();
  },
  evaluate({ ctx, nodeId, inputs, params, runtime }) {
    const gl = ctx.gl;
    const state = runtime.state;
    const target = ctx.target(nodeId, "out");
    const amount = paramNumber(params, "amount", 1.25);
    const centerX = paramNumber(params, "centerX", 0.5);
    const centerY = paramNumber(params, "centerY", 0.5);
    const sourceTex = inputs.src;
    const sourceFrame = inputs.frame as FrameValue | null;

    let outFrame: FrameValue | null = null;

    if (sourceFrame?.element) {
      const key = `${amount}:${centerX}:${centerY}:${sourceFrame.frameId}:${ctx.width}x${ctx.height}`;
      if (key !== state.drawKey) {
        state.drawKey = key;
        state.frameId += 1;
      }
      drawZoomedFrame(
        state.stage,
        sourceFrame.element,
        sourceFrame.width,
        sourceFrame.height,
        ctx.width,
        ctx.height,
        amount,
        centerX,
        centerY,
      );
      outFrame = {
        element: state.stage.canvas,
        width: ctx.width,
        height: ctx.height,
        timestampMs: sourceFrame.timestampMs,
        frameId: state.frameId,
      };
    }

    if (isRenderTarget(sourceTex)) {
      const program = getProgram(gl, FULLSCREEN_VS, ZOOM_FS);
      bindTarget(gl, target);
      gl.disable(gl.BLEND);
      program.use();
      bindTexture(gl, program, "uTex", sourceTex.texture, 0);
      gl.uniform1f(program.uniform("uAmount"), amount);
      gl.uniform2f(program.uniform("uCenter"), centerX, centerY);
      drawFullscreen(gl, program);
    } else if (outFrame) {
      // Frame-only wiring: feed the zoomed canvas into the texture path.
      if (!state.upload) state.upload = new SourceTexture(gl);
      state.upload.upload(state.stage.canvas, state.frameId);
      copyTexture(gl, state.upload.texture, target);
    } else {
      clearTarget(gl, target, 0, 0, 0, 0);
    }

    return { out: target, frame: outFrame };
  },
});
