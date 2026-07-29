import { copyTexture } from "../../engine/gl/quad";
import type { RenderTarget as RT } from "../../engine/gl/rt";
import { SourceTexture } from "../../engine/gl/videoTexture";
import type { EngineContext, FrameValue, NodeRuntime, ParamValues } from "../../engine/types";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import { fileParam } from "../shared/fileParam";
import { StageCanvas, type FitMode } from "../shared/stage";
type MediaMode = "camera" | "image" | "video";

interface MediaState {
  mode: MediaMode | null;
  image: HTMLImageElement;
  video: HTMLVideoElement;
  stage: StageCanvas;
  texture: SourceTexture | null;
  stream: MediaStream | null;
  cameraRequested: boolean;
  cameraFailed: boolean;
  loadedUrl: string | null;
  imageReady: boolean;
  frameId: number;
  lastTime: number;
  drawKey: string;
  suspended: boolean;
}

function isMediaMode(value: string): value is MediaMode {
  return value === "camera" || value === "image" || value === "video";
}

function stopCamera(state: MediaState): void {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  state.video.srcObject = null;
  state.cameraRequested = false;
  state.cameraFailed = false;
}

function clearFileVideo(state: MediaState): void {
  state.video.pause();
  state.video.removeAttribute("src");
  state.video.load();
  state.loadedUrl = null;
  state.lastTime = -1;
}

function clearImage(state: MediaState): void {
  state.image.removeAttribute("src");
  state.loadedUrl = null;
  state.imageReady = false;
  state.drawKey = "";
}

function switchMode(state: MediaState, next: MediaMode): void {
  if (state.mode === next) return;
  if (state.mode === "camera") stopCamera(state);
  if (state.mode === "video") clearFileVideo(state);
  if (state.mode === "image") clearImage(state);
  state.mode = next;
  state.frameId = 0;
  state.lastTime = -1;
}

function emit(
  state: MediaState,
  target: RT,
  ctx: EngineContext,
): { out: RT; frame: FrameValue } {
  state.texture!.upload(state.stage.canvas, state.frameId);
  copyTexture(ctx.gl, state.texture!.texture, target);
  return {
    out: target,
    frame: {
      element: state.stage.canvas,
      width: ctx.width,
      height: ctx.height,
      timestampMs: ctx.timeMs,
      frameId: state.frameId,
    },
  };
}

export const mediaNode = defineNode<MediaState>({
  type: "source.media",
  label: "Media",
  category: "source",
  description: "Camera, still image, or video file — one source for texture + frame.",
  inputs: [],
  outputs: [
    { id: "out", label: "texture", type: "texture" },
    { id: "frame", label: "frame", type: "frame" },
  ],
  params: [
    {
      key: "mode",
      label: "Source",
      type: "select",
      options: [
        { value: "camera", label: "camera" },
        { value: "image", label: "image" },
        { value: "video", label: "video" },
      ],
      default: "image",
    },
    { key: "file", label: "File", type: "file", accept: "image/*,video/*", default: null },
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
    const image = new Image();
    image.decoding = "async";
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.loop = true;
    return {
      mode: null,
      image,
      video,
      stage: new StageCanvas(),
      texture: null,
      stream: null,
      cameraRequested: false,
      cameraFailed: false,
      loadedUrl: null,
      imageReady: false,
      frameId: 0,
      lastTime: -1,
      drawKey: "",
      suspended: false,
    };
  },
  disposeState(state) {
    stopCamera(state);
    clearFileVideo(state);
    clearImage(state);
    state.texture?.dispose();
  },
  suspend({ params, runtime }) {
    const state = runtime.state;
    state.suspended = true;
    const mode = paramString(params, "mode", "image");
    if (mode === "camera") {
      state.stream?.getTracks().forEach((track) => {
        track.enabled = false;
      });
      state.video.pause();
    } else if (mode === "video") {
      state.video.pause();
    }
  },
  resume({ params, runtime }) {
    const state = runtime.state;
    state.suspended = false;
    const mode = paramString(params, "mode", "image");
    if (mode === "camera") {
      state.stream?.getTracks().forEach((track) => {
        track.enabled = true;
      });
      if (state.stream) void state.video.play().catch(() => undefined);
    } else if (mode === "video" && paramBool(params, "playing", true)) {
      void state.video.play().catch(() => undefined);
    }
  },
  evaluate({ ctx, nodeId, params, runtime }) {
    const state = runtime.state;
    if (!state.texture) state.texture = new SourceTexture(ctx.gl);

    const rawMode = paramString(params, "mode", "image");
    const mode: MediaMode = isMediaMode(rawMode) ? rawMode : "image";
    switchMode(state, mode);

    const target = ctx.target(nodeId, "out");
    const fit = paramString(params, "fit", "cover") as FitMode;
    const mirror = paramBool(params, "mirror", mode === "camera");

    if (mode === "camera") return evalCamera(ctx, nodeId, state, target, fit, mirror);
    if (mode === "image") return evalImage(ctx, nodeId, params, runtime, state, target, fit, mirror);
    return evalVideo(ctx, nodeId, params, runtime, state, target, fit, mirror);
  },
});

function evalCamera(
  ctx: EngineContext,
  nodeId: string,
  state: MediaState,
  target: RT,
  fit: FitMode,
  mirror: boolean,
) {
  state.video.autoplay = true;
  state.video.loop = false;

  if (!state.cameraRequested && !state.cameraFailed) {
    state.cameraRequested = true;
    ctx.report(nodeId, "loading", "requesting camera access…");
    navigator.mediaDevices
      .getUserMedia({ video: { width: 1280, height: 720 }, audio: false })
      .then((stream) => {
        if (state.mode !== "camera") {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
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
      .then(() => {
        if (state.mode === "camera") ctx.report(nodeId, "ready", null);
      })
      .catch((error: unknown) => {
        state.cameraFailed = true;
        ctx.report(nodeId, "error", error instanceof Error ? error.message : "camera unavailable");
      });
  }

  const { video } = state;
  if (video.readyState < 2 || video.videoWidth === 0) {
    return { out: target, frame: null };
  }

  if (video.currentTime !== state.lastTime) {
    state.lastTime = video.currentTime;
    state.frameId += 1;
  }

  state.stage.draw(video, video.videoWidth, video.videoHeight, ctx.width, ctx.height, {
    mode: fit,
    mirror,
  });
  return emit(state, target, ctx);
}

function evalImage(
  ctx: EngineContext,
  nodeId: string,
  params: ParamValues,
  runtime: NodeRuntime<MediaState>,
  state: MediaState,
  target: RT,
  fit: FitMode,
  mirror: boolean,
) {
  const file = fileParam(params);
  if (file && file.url !== state.loadedUrl) {
    state.loadedUrl = file.url;
    state.imageReady = false;
    state.frameId = 0;
    ctx.report(nodeId, "loading", file.name);
    state.image.onload = () => {
      state.imageReady = true;
      state.frameId += 1;
      ctx.report(nodeId, "ready", file.name);
    };
    state.image.onerror = () => {
      state.imageReady = false;
      ctx.report(nodeId, "error", "failed to open image");
    };
    state.image.src = file.url;
  }

  if (!state.loadedUrl) {
    if (runtime.status === "idle") ctx.report(nodeId, "idle", "drop an image file");
    return { out: target, frame: null };
  }
  if (!state.imageReady || state.image.naturalWidth === 0) {
    return { out: target, frame: null };
  }

  const drawKey = `${fit}:${mirror}:${ctx.width}x${ctx.height}`;
  if (drawKey !== state.drawKey) {
    state.drawKey = drawKey;
    state.frameId += 1;
  }

  state.stage.draw(
    state.image,
    state.image.naturalWidth,
    state.image.naturalHeight,
    ctx.width,
    ctx.height,
    { mode: fit, mirror },
  );
  return emit(state, target, ctx);
}

function evalVideo(
  ctx: EngineContext,
  nodeId: string,
  params: ParamValues,
  runtime: NodeRuntime<MediaState>,
  state: MediaState,
  target: RT,
  fit: FitMode,
  mirror: boolean,
) {
  state.video.autoplay = false;
  state.video.loop = true;
  const video = state.video;
  const file = fileParam(params);

  if (file && file.url !== state.loadedUrl) {
    state.loadedUrl = file.url;
    video.src = file.url;
    state.frameId = 0;
    state.lastTime = -1;
    ctx.report(nodeId, "loading", file.name);
    video
      .play()
      .then(() => ctx.report(nodeId, "ready", file.name))
      .catch((error: unknown) => {
        ctx.report(nodeId, "error", error instanceof Error ? error.message : "failed to open");
      });
  }

  if (!state.loadedUrl) {
    if (runtime.status === "idle") ctx.report(nodeId, "idle", "drop a video file");
    return { out: target, frame: null };
  }

  video.playbackRate = paramNumber(params, "speed", 1);
  const shouldPlay = paramBool(params, "playing", true);

  if (ctx.timelinePlaying && Number.isFinite(video.duration) && video.duration > 0) {
    const speed = Math.max(0.001, paramNumber(params, "speed", 1));
    let t = (ctx.timelineFrame / ctx.timelineFps) * speed;
    t = ((t % video.duration) + video.duration) % video.duration;
    if (Math.abs(video.currentTime - t) > 1 / ctx.timelineFps) {
      try {
        video.currentTime = t;
      } catch {
        // Seeking before metadata is ready — ignore.
      }
    }
    if (!video.paused) video.pause();
  } else if (!state.suspended) {
    if (shouldPlay && video.paused) void video.play().catch(() => undefined);
    if (!shouldPlay && !video.paused) video.pause();
  }

  if (video.readyState < 2 || video.videoWidth === 0) {
    return { out: target, frame: null };
  }

  if (video.currentTime !== state.lastTime) {
    state.lastTime = video.currentTime;
    state.frameId += 1;
  }

  state.stage.draw(video, video.videoWidth, video.videoHeight, ctx.width, ctx.height, {
    mode: fit,
    mirror,
  });
  return emit(state, target, ctx);
}

/** Old patch types → unified Media node. */
export const LEGACY_SOURCE_TYPES: Record<string, MediaMode> = {
  "source.camera": "camera",
  "source.image": "image",
  "source.video": "video",
};
