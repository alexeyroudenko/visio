import type { Edge } from "@xyflow/react";
import { ArrayBufferTarget, Muxer } from "webm-muxer";
import type { Engine } from "../engine/runtime";
import { NODE_DEFS } from "../nodes/registry";
import { LEGACY_SOURCE_TYPES } from "../nodes/source/media";
import type { PatchNode } from "../store/graphStore";
import { applyAnalyzerBindings } from "./analyzerBindings";
import { audioModulatorDriveSamples, audioModulatorSamples } from "./audioModSamples";
import { applyKeyframesToNodes, type ParamKeyframes } from "./keyframes";
import {
  applyModulatorBindings,
  MODULATOR_DRIVE_TYPE,
  parseModulatorDriveConfig,
} from "./modulatorBindings";
import { applyModulatorsToNodes, type Modulators } from "./modulators";
import { withSourcePrefix } from "./mediaName";
import {
  encodeAudioBufferOpus,
  mixRenderAudio,
  type EncodedAudioTrack,
} from "./renderAudio";

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

const EXPORT_BITRATE = 12_000_000;
const KEYFRAME_EVERY_SEC = 2;

function pickMimeType(): string {
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "video/webm";
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function engineNodeType(defType: string): string {
  return LEGACY_SOURCE_TYPES[defType] ? "source.media" : defType;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function frameDurationUs(fps: number): number {
  return Math.round(1_000_000 / fps);
}

function frameTimestampUs(frame: number, fps: number): number {
  return Math.round((frame * 1_000_000) / fps);
}

async function pickEncoderConfig(
  width: number,
  height: number,
  fps: number,
): Promise<{ codec: string; muxerCodec: "V_VP9" | "V_VP8" } | null> {
  if (typeof VideoEncoder === "undefined") return null;

  const candidates: { codec: string; muxerCodec: "V_VP9" | "V_VP8" }[] = [
    { codec: "vp09.00.10.08", muxerCodec: "V_VP9" },
    { codec: "vp9", muxerCodec: "V_VP9" },
    { codec: "vp8", muxerCodec: "V_VP8" },
  ];

  for (const candidate of candidates) {
    const result = await VideoEncoder.isConfigSupported({
      codec: candidate.codec,
      width,
      height,
      bitrate: EXPORT_BITRATE,
      framerate: fps,
    });
    if (result.supported) return candidate;
  }
  return null;
}

export interface ExportTimelineOptions {
  nodes: PatchNode[];
  edges: Edge[];
  width: number;
  height: number;
  /** Timeline fps (playhead / keyframes). */
  timelineFps: number;
  durationInFrames: number;
  paramKeyframes: ParamKeyframes;
  /**
   * Output file fps. Defaults to 60 — independent of the source video and of
   * timeline fps so a 30 fps edit can still export smooth 60 fps.
   */
  outputFps?: number;
  /** LFO + audio modulators — applied after keyframes so Render matches playback. */
  modulators?: Modulators;
  /** Called with the timeline frame shown in the UI playhead. */
  onFrame?: (timelineFrame: number) => void;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

interface RenderPassContext {
  engine: Engine;
  nodes: PatchNode[];
  graphEdges: ReturnType<typeof toGraphEdges>;
  paramKeyframes: ParamKeyframes;
  modulators: Modulators;
  timelineFps: number;
  outputFps: number;
  outputFrames: number;
  onFrame?: (timelineFrame: number) => void;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

function toGraphEdges(edges: Edge[]) {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle ?? "out",
    target: edge.target,
    targetHandle: edge.targetHandle ?? "in",
  }));
}

async function renderOneFrame(ctx: RenderPassContext, outputIndex: number): Promise<number> {
  if (ctx.signal?.aborted) throw new Error("Render cancelled");

  const timelineFrame = Math.round((outputIndex / ctx.outputFps) * ctx.timelineFps);
  ctx.onFrame?.(timelineFrame);

  const keyed = applyKeyframesToNodes(
    timelineFrame,
    ctx.nodes.map((node) => ({ id: node.id, params: node.data.params })),
    ctx.paramKeyframes,
  );

  const timelineSec = timelineFrame / Math.max(1, ctx.timelineFps);
  const samples = audioModulatorSamples(
    ctx.modulators,
    ctx.nodes.map((node) => ({
      id: node.id,
      params: keyed.get(node.id) ?? node.data.params,
    })),
    timelineSec,
  );
  const defTypeById = new Map(ctx.nodes.map((node) => [node.id, node.data.defType]));
  applyModulatorsToNodes(
    timelineSec,
    keyed,
    ctx.modulators,
    (nodeId, key) => {
      const defType = defTypeById.get(nodeId);
      return defType ? NODE_DEFS[defType]?.params.find((p) => p.key === key) : undefined;
    },
    (path) => samples.get(path),
  );
  const driveNodes = ctx.nodes
    .filter((node) => node.data.defType === MODULATOR_DRIVE_TYPE)
    .map((node) => {
      const params = keyed.get(node.id) ?? node.data.params;
      const config = parseModulatorDriveConfig(params);
      return {
        nodeId: node.id,
        bandLoHz: config.bandLoHz ?? 20,
        bandHiHz: config.bandHiHz ?? 200,
        audio: config.source === "audio",
      };
    });
  const driveSamples = audioModulatorDriveSamples(
    driveNodes
      .filter((d) => d.audio)
      .map(({ nodeId, bandLoHz, bandHiHz }) => ({ nodeId, bandLoHz, bandHiHz })),
    ctx.nodes.map((node) => ({
      id: node.id,
      params: keyed.get(node.id) ?? node.data.params,
    })),
    timelineSec,
  );
  applyModulatorBindings(
    timelineSec,
    keyed,
    ctx.nodes.map((node) => ({
      id: node.id,
      defType: node.data.defType,
      params: keyed.get(node.id) ?? node.data.params,
    })),
    (nodeId, key) => {
      const defType = defTypeById.get(nodeId);
      return defType ? NODE_DEFS[defType]?.params.find((p) => p.key === key) : undefined;
    },
    (nodeId) => driveSamples.get(nodeId),
  );
  applyAnalyzerBindings(
    timelineSec,
    keyed,
    ctx.nodes.map((node) => ({
      id: node.id,
      defType: node.data.defType,
      params: keyed.get(node.id) ?? node.data.params,
    })),
    ctx.graphEdges,
    (nodeId, key) => {
      const defType = defTypeById.get(nodeId);
      return defType ? NODE_DEFS[defType]?.params.find((p) => p.key === key) : undefined;
    },
  );

  ctx.engine.setTimeline(timelineFrame, ctx.timelineFps, false);
  ctx.engine.setGraph(
    ctx.nodes.map((node) => {
      const base = keyed.get(node.id) ?? node.data.params;
      const mode = LEGACY_SOURCE_TYPES[node.data.defType];
      return {
        id: node.id,
        type: engineNodeType(node.data.defType),
        params: mode && base.mode == null ? { ...base, mode } : base,
        bypass: node.data.bypass === true,
      };
    }),
    ctx.graphEdges,
  );

  await ctx.engine.seekVideosToPlayhead();
  await waitAnimationFrame();
  ctx.engine.tick();
  await waitAnimationFrame();
  ctx.engine.tick();

  ctx.onProgress?.((outputIndex + 1) / ctx.outputFrames);
  if (outputIndex % 2 === 1) await waitMs(0);
  return timelineFrame;
}

async function exportWithWebCodecs(
  canvas: HTMLCanvasElement,
  pass: RenderPassContext,
  width: number,
  height: number,
  audio: EncodedAudioTrack | null,
): Promise<Blob> {
  const encoderConfig = await pickEncoderConfig(width, height, pass.outputFps);
  if (!encoderConfig) throw new Error("WebCodecs encoder is not available");

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: encoderConfig.muxerCodec,
      width,
      height,
      frameRate: pass.outputFps,
    },
    ...(audio
      ? {
          audio: {
            codec: "A_OPUS",
            sampleRate: audio.sampleRate,
            numberOfChannels: audio.numberOfChannels,
          },
        }
      : {}),
    firstTimestampBehavior: "offset",
  });

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => {
      throw err;
    },
  });

  encoder.configure({
    codec: encoderConfig.codec,
    width,
    height,
    bitrate: EXPORT_BITRATE,
    framerate: pass.outputFps,
    latencyMode: "quality",
  });

  const durationUs = frameDurationUs(pass.outputFps);
  const keyframeInterval = Math.max(1, Math.round(pass.outputFps * KEYFRAME_EVERY_SEC));

  for (let i = 0; i < pass.outputFrames; i += 1) {
    await renderOneFrame(pass, i);

    const videoFrame = new VideoFrame(canvas, {
      timestamp: frameTimestampUs(i, pass.outputFps),
      duration: durationUs,
    });
    encoder.encode(videoFrame, { keyFrame: i % keyframeInterval === 0 });
    videoFrame.close();
  }

  await encoder.flush();

  if (audio) {
    for (const chunk of audio.chunks) {
      muxer.addAudioChunkRaw(chunk.data, chunk.type, chunk.timestamp);
    }
  }

  muxer.finalize();

  const buffer = muxer.target.buffer;
  if (!buffer) throw new Error("Muxer produced empty output");
  return new Blob([buffer], { type: "video/webm" });
}

async function exportWithMediaRecorder(
  canvas: HTMLCanvasElement,
  pass: RenderPassContext,
): Promise<Blob> {
  const mimeType = pickMimeType();
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  if (!track || typeof track.requestFrame !== "function") {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("CanvasCaptureMediaStreamTrack.requestFrame is not available");
  }

  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: EXPORT_BITRATE,
  });

  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error("Render recorder error"));
  });

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const frameMs = 1000 / pass.outputFps;

  try {
    recorder.start(200);
    for (let i = 0; i < pass.outputFrames; i += 1) {
      await renderOneFrame(pass, i);
      track.requestFrame();
      // Pace wall-clock so MediaRecorder timestamps match source fps.
      await waitMs(frameMs);
    }
    recorder.stop();
    await stopped;
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }

  if (chunks.length === 0) throw new Error("No video data was recorded");
  return new Blob(chunks, { type: mimeType });
}

/**
 * Offline timeline export: seek playhead frame-by-frame (not realtime), force
 * video Media to the playhead, tick the graph, and capture each canvas frame.
 * Output fps defaults to 60; pass `outputFps` to override.
 */
export async function exportTimelineVideo(
  engine: Engine,
  options: ExportTimelineOptions,
): Promise<{ blob: Blob; outputFps: number; outputFrames: number }> {
  const {
    nodes,
    edges,
    width,
    height,
    timelineFps,
    durationInFrames,
    paramKeyframes,
    modulators = {},
    outputFps: outputFpsOpt,
    onFrame,
    onProgress,
    signal,
  } = options;

  if (durationInFrames <= 0) throw new Error("Timeline duration is empty");

  const outputFps = Math.max(1, Math.round(outputFpsOpt ?? 60));
  const durationSec = durationInFrames / Math.max(1, timelineFps);
  const outputFrames = Math.max(1, Math.round(durationSec * outputFps));

  const wasPaused = engine.isPaused;
  engine.setPaused(true);
  engine.setTimelineForceSync(true);
  engine.setDefinitions(NODE_DEFS);
  engine.setResolution(width, height);

  const pass: RenderPassContext = {
    engine,
    nodes,
    graphEdges: toGraphEdges(edges),
    paramKeyframes,
    modulators,
    timelineFps,
    outputFps,
    outputFrames,
    onFrame,
    onProgress,
    signal,
  };

  let encodedAudio: EncodedAudioTrack | null = null;
  try {
    const audioSources = engine.collectRenderAudioSources();
    if (audioSources.length > 0) {
      const mixed = await mixRenderAudio(audioSources, durationSec);
      if (mixed) {
        encodedAudio = await encodeAudioBufferOpus(mixed);
        if (!encodedAudio) {
          console.warn("AudioEncoder unavailable — render continues without audio");
        }
      }
    }
  } catch (err) {
    console.warn("Audio mix/encode failed — render continues without audio:", err);
  }

  try {
    const encoderConfig = await pickEncoderConfig(width, height, outputFps);
    if (encoderConfig && typeof VideoFrame !== "undefined") {
      try {
        const blob = await exportWithWebCodecs(
          engine.canvas,
          pass,
          width,
          height,
          encodedAudio,
        );
        return { blob, outputFps, outputFrames };
      } catch (err) {
        console.warn("WebCodecs export failed, falling back to MediaRecorder:", err);
      }
    }
    const blob = await exportWithMediaRecorder(engine.canvas, pass);
    return { blob, outputFps, outputFrames };
  } finally {
    engine.setTimelineForceSync(false);
    if (!wasPaused) engine.setPaused(false);
  }
}

export function downloadTimelineRender(blob: Blob): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = blob.type.includes("mp4") ? "mp4" : "webm";
  // Native media name first, then the render stamp we used to ship alone.
  downloadBlob(blob, `${withSourcePrefix(`render-${stamp}`)}.${ext}`);
}
