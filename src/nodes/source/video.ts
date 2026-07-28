import { copyTexture } from "../../engine/gl/quad";
import { SourceTexture } from "../../engine/gl/videoTexture";
import type { FrameValue } from "../../engine/types";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import { StageCanvas, type FitMode } from "../shared/stage";

interface VideoState {
  video: HTMLVideoElement;
  stage: StageCanvas;
  texture: SourceTexture | null;
  loadedUrl: string | null;
  frameId: number;
  lastTime: number;
}

/** The UI stores a picked file as this shape (object URL created on pick). */
export interface FileParam {
  name: string;
  url: string;
}

function fileParam(params: Record<string, unknown>): FileParam | null {
  const value = params.file;
  if (value && typeof value === "object" && typeof (value as FileParam).url === "string") {
    return value as FileParam;
  }
  return null;
}

export const videoNode = defineNode<VideoState>({
  type: "source.video",
  label: "Video File",
  category: "source",
  description: "Local video file (drag-and-drop). Loops; playback speed is adjustable.",
  inputs: [],
  outputs: [
    { id: "out", label: "texture", type: "texture" },
    { id: "frame", label: "frame", type: "frame" },
  ],
  params: [
    { key: "file", label: "File", type: "file", accept: "video/*", default: null },
    { key: "playing", label: "Play", type: "toggle", default: true },
    { key: "speed", label: "Speed", type: "range", min: 0.1, max: 3, step: 0.1, default: 1 },
    { key: "mirror", label: "Mirror", type: "toggle", default: false },
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
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    return {
      video,
      stage: new StageCanvas(),
      texture: null,
      loadedUrl: null,
      frameId: 0,
      lastTime: -1,
    };
  },
  disposeState(state) {
    state.video.pause();
    state.video.removeAttribute("src");
    state.video.load();
    state.texture?.dispose();
  },
  suspend({ runtime }) {
    runtime.state.video.pause();
  },
  resume({ params, runtime }) {
    if (paramBool(params, "playing", true)) {
      void runtime.state.video.play().catch(() => undefined);
    }
  },
  evaluate({ ctx, nodeId, params, runtime }) {
    const state = runtime.state;
    if (!state.texture) state.texture = new SourceTexture(ctx.gl);

    const file = fileParam(params);
    if (file && file.url !== state.loadedUrl) {
      state.loadedUrl = file.url;
      state.video.src = file.url;
      state.frameId = 0;
      state.lastTime = -1;
      ctx.report(nodeId, "loading", file.name);
      state.video
        .play()
        .then(() => ctx.report(nodeId, "ready", file.name))
        .catch((error: unknown) => {
          ctx.report(nodeId, "error", error instanceof Error ? error.message : "failed to open");
        });
    }

    const target = ctx.target(nodeId, "out");
    const { video } = state;
    if (!state.loadedUrl) {
      if (runtime.status === "idle") ctx.report(nodeId, "idle", "drop a video file");
      return { out: target, frame: null };
    }

    video.playbackRate = paramNumber(params, "speed", 1);
    const shouldPlay = paramBool(params, "playing", true);
    if (shouldPlay && video.paused) void video.play().catch(() => undefined);
    if (!shouldPlay && !video.paused) video.pause();

    if (video.readyState < 2 || video.videoWidth === 0) {
      return { out: target, frame: null };
    }

    if (video.currentTime !== state.lastTime) {
      state.lastTime = video.currentTime;
      state.frameId += 1;
    }

    state.stage.draw(video, video.videoWidth, video.videoHeight, ctx.width, ctx.height, {
      mode: paramString(params, "fit", "cover") as FitMode,
      mirror: paramBool(params, "mirror", false),
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
