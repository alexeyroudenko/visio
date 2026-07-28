import { copyTexture } from "../../engine/gl/quad";
import { SourceTexture } from "../../engine/gl/videoTexture";
import type { FrameValue } from "../../engine/types";
import { defineNode, paramBool, paramString } from "../defineNode";
import { StageCanvas, type FitMode } from "../shared/stage";

interface CameraState {
  video: HTMLVideoElement;
  stage: StageCanvas;
  stream: MediaStream | null;
  texture: SourceTexture | null;
  requested: boolean;
  failed: boolean;
  frameId: number;
  lastTime: number;
  /** True while the engine is paused — ignore late getUserMedia play(). */
  suspended: boolean;
}

export const cameraNode = defineNode<CameraState>({
  type: "source.camera",
  label: "Camera",
  category: "source",
  description: "Webcam via getUserMedia. Provides a frame for tracking and a texture.",
  inputs: [],
  outputs: [
    { id: "out", label: "texture", type: "texture" },
    { id: "frame", label: "frame", type: "frame" },
  ],
  params: [
    { key: "mirror", label: "Mirror", type: "toggle", default: true },
    {
      key: "fit",
      label: "Fit",
      type: "select",
      options: [
        { value: "cover", label: "cover" },
        { value: "contain", label: "contain" },
        { value: "stretch", label: "stretch" },
      ],
      default: "cover",
    },
  ],
  createState() {
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    return {
      video,
      stage: new StageCanvas(),
      stream: null,
      texture: null,
      requested: false,
      failed: false,
      frameId: 0,
      lastTime: -1,
      suspended: false,
    };
  },
  disposeState(state) {
    state.stream?.getTracks().forEach((track) => track.stop());
    state.texture?.dispose();
    state.video.srcObject = null;
  },
  suspend({ runtime }) {
    const state = runtime.state;
    state.suspended = true;
    state.stream?.getTracks().forEach((track) => {
      track.enabled = false;
    });
    state.video.pause();
  },
  resume({ runtime }) {
    const state = runtime.state;
    state.suspended = false;
    state.stream?.getTracks().forEach((track) => {
      track.enabled = true;
    });
    if (state.stream) void state.video.play().catch(() => undefined);
  },
  evaluate({ ctx, nodeId, params, runtime }) {
    const state = runtime.state;
    if (!state.texture) state.texture = new SourceTexture(ctx.gl);

    if (!state.requested && !state.failed) {
      state.requested = true;
      ctx.report(nodeId, "loading", "requesting camera access…");
      navigator.mediaDevices
        .getUserMedia({ video: { width: 1280, height: 720 }, audio: false })
        .then((stream) => {
          state.stream = stream;
          state.video.srcObject = stream;
          if (state.suspended) {
            stream.getTracks().forEach((track) => {
              track.enabled = false;
            });
            return;
          }
          return state.video.play();
        })
        .then(() => ctx.report(nodeId, "ready", null))
        .catch((error: unknown) => {
          state.failed = true;
          ctx.report(nodeId, "error", error instanceof Error ? error.message : "camera unavailable");
        });
    }

    const target = ctx.target(nodeId, "out");
    const { video } = state;
    if (video.readyState < 2 || video.videoWidth === 0) {
      return { out: target, frame: null };
    }

    if (video.currentTime !== state.lastTime) {
      state.lastTime = video.currentTime;
      state.frameId += 1;
    }

    state.stage.draw(video, video.videoWidth, video.videoHeight, ctx.width, ctx.height, {
      mode: paramString(params, "fit", "cover") as FitMode,
      mirror: paramBool(params, "mirror", true),
    });
    state.texture.upload(state.stage.canvas, state.frameId);
    copyTexture(ctx.gl, state.texture.texture, target);

    const frame: FrameValue = {
      element: state.stage.canvas,
      width: ctx.width,
      height: ctx.height,
      timestampMs: ctx.timeMs,
      frameId: state.frameId,
    };
    return { out: target, frame };
  },
});
