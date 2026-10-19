import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Engine } from "../engine/runtime";
import { scrub, track } from "../lib/analytics";
import {
  downloadTimelineImage,
  downloadTimelineRender,
  exportTimelineImage,
  exportTimelineVideo,
  RenderCancelledWithPartial,
  timelinePartialRenderStem,
} from "../lib/exportTimeline";
import { formatBitrate, loadRenderBitrate } from "../lib/renderBitrate";
import { loadRenderFps } from "../lib/renderFps";
import {
  type RenderFormat,
  loadRenderFormat,
} from "../lib/renderFormat";
import { appLog } from "../store/consoleStore";
import { serializeCurrentPatch, useGraphStore } from "../store/graphStore";
import { useModulatorStore } from "../store/modulatorStore";
import { resolveRenderRange, useTimelineStore } from "../store/timelineStore";
import { patchJsonForMetadata } from "../lib/visioPatchMeta";

export interface OfflineRenderOptions {
  format?: RenderFormat;
  outputFps?: number;
  startFrame?: number;
  endFrame?: number;
}

/**
 * Offline frame-by-frame timeline export (toolbar Render). Not realtime —
 * seeks the playhead, forces video sync, ticks the graph, captures canvas.
 * Honours the scrubber In/Out render range when set (or an explicit range).
 */
export function useOfflineRender(engineRef: RefObject<Engine | null>) {
  const [rendering, setRendering] = useState(false);
  const [renderingImage, setRenderingImage] = useState(false);
  const [progress, setProgress] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const start = useCallback(async (options: OfflineRenderOptions = {}) => {
    const engine = engineRef.current;
    if (!engine || rendering || renderingImage) return;

    const timeline = useTimelineStore.getState();
    const { nodes, edges, width, height } = useGraphStore.getState();
    const modulators = useModulatorStore.getState().byPath;
    const savedFrame = timeline.currentFrame;
    const outputFps = options.outputFps ?? loadRenderFps();
    const bitrate = loadRenderBitrate();
    const format = options.format ?? loadRenderFormat();
    const resolved =
      options.startFrame != null && options.endFrame != null
        ? {
            startFrame: Math.round(options.startFrame),
            endFrame: Math.round(options.endFrame),
          }
        : resolveRenderRange(
            timeline.durationInFrames,
            timeline.renderInFrame,
            timeline.renderOutFrame,
          );
    let { startFrame, endFrame } = resolved;
    if (endFrame < startFrame) [startFrame, endFrame] = [endFrame, startFrame];
    const rangeFrames = Math.max(1, endFrame - startFrame + 1);
    const ranged =
      startFrame > 0 || endFrame < timeline.durationInFrames;

    timeline.pause();
    const controller = new AbortController();
    abortRef.current = controller;

    setRendering(true);
    setProgress(0);

    appLog(
      "info",
      "render",
      ranged
        ? `started · ${format} · F${startFrame}–F${endFrame} (${rangeFrames} tl-frames) @ ${timeline.fps} fps → export ${outputFps} fps · ${formatBitrate(bitrate)}`
        : `started · ${format} · ${timeline.durationInFrames} tl-frames @ ${timeline.fps} fps → export ${outputFps} fps · ${formatBitrate(bitrate)}`,
    );

    const startedAt = performance.now();
    let latestProgress = 0;
    track("render_started", {
      frames: rangeFrames,
      ranged,
      format,
      timeline_fps: timeline.fps,
      output_fps: outputFps,
      bitrate,
      w: width,
      h: height,
      nodes: nodes.length,
    });

    // Snapshot before encode so MP4 moov metadata matches the graph that
    // produced the frames. No companion .json download — patch lives in metadata.
    const patchJson =
      format === "mp4" ? patchJsonForMetadata(serializeCurrentPatch()) : undefined;

    try {
      const { blob, outputFps: writtenFps, outputFrames } = await exportTimelineVideo(engine, {
        nodes,
        edges,
        width,
        height,
        timelineFps: timeline.fps,
        durationInFrames: timeline.durationInFrames,
        startFrame,
        endFrame,
        paramKeyframes: timeline.paramKeyframes,
        modulators,
        outputFps,
        bitrate,
        format,
        patchJson,
        signal: controller.signal,
        onFrame: (frame) => {
          useTimelineStore.getState().seek(frame);
        },
        onProgress: (value) => {
          // Mirrored into a local: the state value read from the catch block
          // would be the one captured when this callback was created.
          latestProgress = value;
          setProgress(value);
        },
      });
      const stem = downloadTimelineRender(blob);
      const videoExt = blob.type.includes("mp4") ? "mp4" : "webm";
      const embedded =
        videoExt === "mp4" && patchJson ? " · patch in metadata" : "";
      appLog(
        "ok",
        "render",
        `saved · ${stem}.${videoExt}${embedded} · ${outputFrames} frames @ ${writtenFps} fps · ${(blob.size / (1024 * 1024)).toFixed(1)} MB`,
      );
      track("render_finished", {
        frames: outputFrames,
        output_fps: writtenFps,
        format: videoExt,
        size_mb: Number((blob.size / (1024 * 1024)).toFixed(1)),
        // How long a user is willing to wait — pair with render_started drop-off.
        wait_sec: Number(((performance.now() - startedAt) / 1000).toFixed(1)),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const waitSec = Number(((performance.now() - startedAt) / 1000).toFixed(1));
      if (error instanceof RenderCancelledWithPartial) {
        const stem = downloadTimelineRender(error.blob, timelinePartialRenderStem());
        const videoExt = error.blob.type.includes("mp4") ? "mp4" : "webm";
        appLog(
          "warn",
          "render",
          `cancelled · saved partial ${stem}.${videoExt} · ${error.framesEncoded} frames · ${(error.blob.size / (1024 * 1024)).toFixed(1)} MB`,
        );
        track("render_cancelled", {
          wait_sec: waitSec,
          progress: Number(latestProgress.toFixed(2)),
          partial: true,
          frames: error.framesEncoded,
        });
      } else if (controller.signal.aborted || /cancel/i.test(message)) {
        appLog("warn", "render", "cancelled");
        // Cancelling at 80% means something different from cancelling at 5%.
        track("render_cancelled", { wait_sec: waitSec, progress: Number(latestProgress.toFixed(2)) });
      } else {
        appLog("error", "render", message);
        track("render_failed", { reason: scrub(message), wait_sec: waitSec });
      }
    } finally {
      abortRef.current = null;
      setRendering(false);
      setProgress(0);
      useTimelineStore.getState().seek(savedFrame);
    }
  }, [engineRef, rendering, renderingImage]);

  const startImage = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || rendering || renderingImage) return;

    const timeline = useTimelineStore.getState();
    const { nodes, edges, width, height } = useGraphStore.getState();
    const modulators = useModulatorStore.getState().byPath;
    const frame = Math.round(timeline.currentFrame);

    timeline.pause();
    setRenderingImage(true);

    appLog("info", "render", `still · F${frame} · ${width}×${height} PNG`);
    const startedAt = performance.now();
    track("render_started", {
      frames: 1,
      format: "png",
      w: width,
      h: height,
      nodes: nodes.length,
    });

    try {
      const { blob } = await exportTimelineImage(engine, {
        nodes,
        edges,
        width,
        height,
        timelineFps: timeline.fps,
        frame,
        paramKeyframes: timeline.paramKeyframes,
        modulators,
      });
      const stem = downloadTimelineImage(blob);
      appLog(
        "ok",
        "render",
        `saved · ${stem}.png · ${width}×${height} · ${(blob.size / 1024).toFixed(0)} KB`,
      );
      track("render_finished", {
        frames: 1,
        format: "png",
        size_mb: Number((blob.size / (1024 * 1024)).toFixed(2)),
        wait_sec: Number(((performance.now() - startedAt) / 1000).toFixed(1)),
        w: width,
        h: height,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const waitSec = Number(((performance.now() - startedAt) / 1000).toFixed(1));
      appLog("error", "render", message);
      track("render_failed", { reason: scrub(message), wait_sec: waitSec, format: "png" });
    } finally {
      setRenderingImage(false);
    }
  }, [engineRef, rendering, renderingImage]);

  const toggle = useCallback(() => {
    if (rendering) cancel();
    else void start();
  }, [cancel, rendering, start]);

  return {
    rendering,
    renderingImage,
    progress,
    start,
    toggle,
    renderImage: startImage,
    cancel,
  };
}
