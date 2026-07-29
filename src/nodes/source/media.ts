import { copyTexture } from "../../engine/gl/quad";
import type { RenderTarget as RT } from "../../engine/gl/rt";
import { SourceTexture } from "../../engine/gl/videoTexture";
import type { EngineContext, FrameValue, NodeRuntime, ParamValues } from "../../engine/types";
import { publishMediaInfo } from "../../store/mediaInfoStore";
import { defineNode, paramBool, paramNumber, paramString } from "../defineNode";
import { fileParam } from "../shared/fileParam";
import { StageCanvas, type FitMode } from "../shared/stage";
type MediaMode = "camera" | "image" | "video" | "audio";

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
  /** Cached fps probe so we don't re-captureStream every frame. */
  probedFps: number | null;
  probedFpsUrl: string | null;
}

function codecFromMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const slash = mime.indexOf("/");
  if (slash < 0) return mime;
  const subtype = mime.slice(slash + 1);
  // video/webm;codecs=vp9 → prefer codecs= value when present
  const codecs = /codecs=([^;]+)/i.exec(mime);
  if (codecs?.[1]) return codecs[1].replace(/"/g, "").trim();
  return subtype || null;
}

function probeVideoFps(video: HTMLVideoElement): number | null {
  try {
    const capture = (
      video as HTMLVideoElement & { captureStream?: () => MediaStream }
    ).captureStream;
    if (typeof capture !== "function") return null;
    const stream = capture.call(video);
    const track = stream.getVideoTracks()[0];
    const rate = track?.getSettings().frameRate;
    stream.getTracks().forEach((t) => t.stop());
    if (typeof rate === "number" && Number.isFinite(rate) && rate >= 1 && rate <= 240) {
      return Math.round(rate * 1000) / 1000;
    }
  } catch {
    // ignore
  }
  return null;
}

function ensureProbedFps(state: MediaState, key: string): number | null {
  // Retry while null — first probe often runs before captureStream has a frameRate.
  if (state.probedFpsUrl === key && state.probedFps != null) return state.probedFps;
  state.probedFpsUrl = key;
  state.probedFps = probeVideoFps(state.video);
  return state.probedFps;
}

function publishClear(nodeId: string): void {
  publishMediaInfo(nodeId, null);
}

function isMediaMode(value: string): value is MediaMode {
  return value === "camera" || value === "image" || value === "video" || value === "audio";
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
  state.probedFps = null;
  state.probedFpsUrl = null;
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
  if (state.mode === "video" || state.mode === "audio") clearFileVideo(state);
  if (state.mode === "image") clearImage(state);
  state.mode = next;
  state.frameId = 0;
  state.lastTime = -1;
  state.probedFps = null;
  state.probedFpsUrl = null;
}

/** Apply mute/volume and timeline/free playback shared by video + audio modes. */
function applyAvTransport(
  ctx: EngineContext,
  params: ParamValues,
  state: MediaState,
  video: HTMLVideoElement,
): void {
  const muted = paramBool(params, "muted", false);
  const volume = Math.max(0, Math.min(1, paramNumber(params, "volume", 1)));
  video.muted = muted;
  video.volume = volume;
  video.playbackRate = paramNumber(params, "speed", 1);

  const shouldPlay = paramBool(params, "playing", true);
  const syncTimeline =
    paramBool(params, "syncTimeline", false) || ctx.timelineForceSync;

  if (syncTimeline && Number.isFinite(video.duration) && video.duration > 0) {
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
    if (shouldPlay && video.paused) {
      void video.play().catch(() => {
        // Autoplay with sound is often blocked — fall back to muted.
        if (!video.muted) {
          video.muted = true;
          void video.play().catch(() => undefined);
        }
      });
    }
    if (!shouldPlay && !video.paused) video.pause();
  }
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
  description: "Camera, image, video, or audio — texture + frame (audio is silent black).",
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
        { value: "audio", label: "audio" },
      ],
      default: "image",
    },
    { key: "file", label: "File", type: "file", accept: "image/*,video/*,audio/*", default: null },
    { key: "playing", label: "Play", type: "toggle", default: true },
    { key: "muted", label: "Mute", type: "toggle", default: false },
    { key: "volume", label: "Volume", type: "range", min: 0, max: 1, step: 0.05, default: 1 },
    { key: "speed", label: "Speed", type: "range", min: 0.1, max: 3, step: 0.1, default: 1 },
    {
      key: "syncTimeline",
      label: "Sync with timeline",
      type: "toggle",
      default: false,
    },
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
    {
      key: "zoom",
      label: "Zoom",
      type: "range",
      min: 0,
      max: 2,
      step: 0.05,
      default: 1,
    },
  ],
  createState() {
    const image = new Image();
    image.decoding = "async";
    const video = document.createElement("video");
    // Start unmuted; autoplay policy may force mute on first play().
    video.muted = false;
    video.playsInline = true;
    video.loop = true;
    video.preload = "auto";
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
      probedFps: null,
      probedFpsUrl: null,
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
    } else if (mode === "video" || mode === "audio") {
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
    } else if (
      (mode === "video" || mode === "audio") &&
      paramBool(params, "playing", true) &&
      !paramBool(params, "syncTimeline", false)
    ) {
      state.video.muted = paramBool(params, "muted", false);
      state.video.volume = Math.max(0, Math.min(1, paramNumber(params, "volume", 1)));
      void state.video.play().catch(() => {
        if (!state.video.muted) {
          state.video.muted = true;
          void state.video.play().catch(() => undefined);
        }
      });
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
    const zoom = Math.max(0, paramNumber(params, "zoom", 1));

    if (mode === "camera") return evalCamera(ctx, nodeId, state, target, fit, mirror, zoom);
    if (mode === "image") {
      return evalImage(ctx, nodeId, params, runtime, state, target, fit, mirror, zoom);
    }
    if (mode === "audio") return evalAudio(ctx, nodeId, params, runtime, state, target);
    return evalVideo(ctx, nodeId, params, runtime, state, target, fit, mirror, zoom);
  },
});

function evalCamera(
  ctx: EngineContext,
  nodeId: string,
  state: MediaState,
  target: RT,
  fit: FitMode,
  mirror: boolean,
  zoom: number,
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
    publishClear(nodeId);
    return { out: target, frame: null };
  }

  if (video.currentTime !== state.lastTime) {
    state.lastTime = video.currentTime;
    state.frameId += 1;
  }

  const drawKey = `${fit}:${mirror}:${zoom}:${ctx.width}x${ctx.height}`;
  if (drawKey !== state.drawKey) {
    state.drawKey = drawKey;
    state.frameId += 1;
  }

  const track = state.stream?.getVideoTracks()[0];
  const settings = track?.getSettings();
  const fps =
    typeof settings?.frameRate === "number" && settings.frameRate > 0
      ? Math.round(settings.frameRate * 1000) / 1000
      : ensureProbedFps(state, "camera");

  publishMediaInfo(nodeId, {
    kind: "camera",
    width: video.videoWidth,
    height: video.videoHeight,
    name: track?.label || "camera",
    mime: null,
    codec: null,
    fps,
    playing: !video.paused,
  });

  state.stage.draw(video, video.videoWidth, video.videoHeight, ctx.width, ctx.height, {
    mode: fit,
    mirror,
    zoom,
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
  zoom: number,
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
    publishClear(nodeId);
    return { out: target, frame: null };
  }
  if (!state.imageReady || state.image.naturalWidth === 0) {
    return { out: target, frame: null };
  }

  const drawKey = `${fit}:${mirror}:${zoom}:${ctx.width}x${ctx.height}`;
  if (drawKey !== state.drawKey) {
    state.drawKey = drawKey;
    state.frameId += 1;
  }

  const mime = file?.mime ?? null;
  publishMediaInfo(nodeId, {
    kind: "image",
    width: state.image.naturalWidth,
    height: state.image.naturalHeight,
    name: file?.name ?? null,
    mime,
    codec: codecFromMime(mime),
  });

  state.stage.draw(
    state.image,
    state.image.naturalWidth,
    state.image.naturalHeight,
    ctx.width,
    ctx.height,
    { mode: fit, mirror, zoom },
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
  zoom: number,
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
    state.probedFps = null;
    state.probedFpsUrl = null;
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
    publishClear(nodeId);
    return { out: target, frame: null };
  }

  applyAvTransport(ctx, params, state, video);

  if (video.readyState < 2 || video.videoWidth === 0) {
    return { out: target, frame: null };
  }

  if (video.currentTime !== state.lastTime) {
    state.lastTime = video.currentTime;
    state.frameId += 1;
  }

  const drawKey = `${fit}:${mirror}:${zoom}:${ctx.width}x${ctx.height}`;
  if (drawKey !== state.drawKey) {
    state.drawKey = drawKey;
    state.frameId += 1;
  }

  const mime = file?.mime ?? null;
  const fps = ensureProbedFps(state, state.loadedUrl) ?? ctx.timelineFps;
  const durationSec = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
  const currentTimeSec = Number.isFinite(video.currentTime) ? video.currentTime : null;
  const currentFrame =
    currentTimeSec != null ? Math.floor(currentTimeSec * fps) : null;
  const totalFrames =
    durationSec != null ? Math.floor(durationSec * fps) : null;

  publishMediaInfo(nodeId, {
    kind: "video",
    width: video.videoWidth,
    height: video.videoHeight,
    name: file?.name ?? null,
    mime,
    codec: codecFromMime(mime),
    fps,
    durationSec,
    currentTimeSec,
    currentFrame,
    totalFrames,
    playing: !video.paused,
  });

  state.stage.draw(video, video.videoWidth, video.videoHeight, ctx.width, ctx.height, {
    mode: fit,
    mirror,
    zoom,
  });
  return emit(state, target, ctx);
}

function evalAudio(
  ctx: EngineContext,
  nodeId: string,
  params: ParamValues,
  runtime: NodeRuntime<MediaState>,
  state: MediaState,
  target: RT,
) {
  // HTMLVideoElement plays audio files fine; we just don't draw frames.
  state.video.autoplay = false;
  state.video.loop = true;
  const video = state.video;
  const file = fileParam(params);

  if (file && file.url !== state.loadedUrl) {
    state.loadedUrl = file.url;
    video.src = file.url;
    state.frameId = 0;
    state.lastTime = -1;
    state.probedFps = null;
    state.probedFpsUrl = null;
    ctx.report(nodeId, "loading", file.name);
    video
      .play()
      .then(() => ctx.report(nodeId, "ready", file.name))
      .catch((error: unknown) => {
        ctx.report(nodeId, "error", error instanceof Error ? error.message : "failed to open");
      });
  }

  if (!state.loadedUrl) {
    if (runtime.status === "idle") ctx.report(nodeId, "idle", "drop an audio file");
    publishClear(nodeId);
    return { out: target, frame: null };
  }

  applyAvTransport(ctx, params, state, video);

  if (video.readyState < 1) {
    return { out: target, frame: null };
  }

  if (video.currentTime !== state.lastTime) {
    state.lastTime = video.currentTime;
    state.frameId += 1;
  }

  const mime = file?.mime ?? null;
  const durationSec = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
  const currentTimeSec = Number.isFinite(video.currentTime) ? video.currentTime : null;
  // No reliable fps for audio — use timeline fps for a frame index.
  const fps = ctx.timelineFps;
  const currentFrame =
    currentTimeSec != null ? Math.floor(currentTimeSec * fps) : null;
  const totalFrames = durationSec != null ? Math.floor(durationSec * fps) : null;

  publishMediaInfo(nodeId, {
    kind: "audio",
    width: 0,
    height: 0,
    name: file?.name ?? null,
    mime,
    codec: codecFromMime(mime),
    fps,
    durationSec,
    currentTimeSec,
    currentFrame,
    totalFrames,
    playing: !video.paused,
  });

  // Silent black frame so the graph still has a texture/frame currency.
  state.stage.draw(video, 0, 0, ctx.width, ctx.height, { mode: "cover", mirror: false });
  return emit(state, target, ctx);
}

/** Old patch types → unified Media node. */
export const LEGACY_SOURCE_TYPES: Record<string, MediaMode> = {
  "source.camera": "camera",
  "source.image": "image",
  "source.video": "video",
};
