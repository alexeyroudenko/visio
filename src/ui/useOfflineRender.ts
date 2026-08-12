import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Engine } from "../engine/runtime";
import { downloadTimelineRender, exportTimelineVideo } from "../lib/exportTimeline";
import { formatBitrate, loadRenderBitrate } from "../lib/renderBitrate";
import { loadRenderFps } from "../lib/renderFps";
import { appLog } from "../store/consoleStore";
import { currentTimeline, useGraphStore } from "../store/graphStore";
import { useModulatorStore } from "../store/modulatorStore";
import { downloadPatch, serializePatch } from "../store/persistence";
import { resolveRenderRange, useTimelineStore } from "../store/timelineStore";

/**
 * Offline frame-by-frame timeline export (toolbar Render). Not realtime —
 * seeks the playhead, forces video sync, ticks the graph, captures canvas.
 * Honours the scrubber In/Out render range when set.
 */
export function useOfflineRender(engineRef: RefObject<Engine | null>) {
  const [rendering, setRendering] = useState(false);
  const [progress, setProgress] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const start = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || rendering) return;

    const timeline = useTimelineStore.getState();
    const { nodes, edges, width, height } = useGraphStore.getState();
    const modulators = useModulatorStore.getState().byPath;
    const savedFrame = timeline.currentFrame;
    const outputFps = loadRenderFps();
    const bitrate = loadRenderBitrate();
    const { startFrame, endFrame } = resolveRenderRange(
      timeline.durationInFrames,
      timeline.renderInFrame,
      timeline.renderOutFrame,
    );
    const rangeFrames = Math.max(1, endFrame - startFrame + 1);
    const ranged =
      timeline.renderInFrame != null && timeline.renderOutFrame != null;

    timeline.pause();
    const controller = new AbortController();
    abortRef.current = controller;

    setRendering(true);
    setProgress(0);

    appLog(
      "info",
      "render",
      ranged
        ? `started · F${startFrame}–F${endFrame} (${rangeFrames} tl-frames) @ ${timeline.fps} fps → export ${outputFps} fps · ${formatBitrate(bitrate)}`
        : `started · ${timeline.durationInFrames} tl-frames @ ${timeline.fps} fps → export ${outputFps} fps · ${formatBitrate(bitrate)}`,
    );

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
        signal: controller.signal,
        onFrame: (frame) => {
          useTimelineStore.getState().seek(frame);
        },
        onProgress: setProgress,
      });
      const stem = downloadTimelineRender(blob);
      // Same basename as the video so a finished render and its graph stay paired.
      // A short delay keeps Chromium from collapsing the second save into one click.
      const patch = serializePatch(nodes, edges, width, height, currentTimeline(), modulators);
      window.setTimeout(() => {
        downloadPatch(patch, `${stem}.json`);
      }, 250);
      const videoExt = blob.type.includes("mp4") ? "mp4" : "webm";
      appLog(
        "ok",
        "render",
        `saved · ${stem}.${videoExt} + ${stem}.json · ${outputFrames} frames @ ${writtenFps} fps · ${(blob.size / (1024 * 1024)).toFixed(1)} MB`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted || /cancel/i.test(message)) {
        appLog("warn", "render", "cancelled");
      } else {
        appLog("error", "render", message);
      }
    } finally {
      abortRef.current = null;
      setRendering(false);
      setProgress(0);
      useTimelineStore.getState().seek(savedFrame);
    }
  }, [engineRef, rendering]);

  const toggle = useCallback(() => {
    if (rendering) cancel();
    else void start();
  }, [cancel, rendering, start]);

  return { rendering, progress, toggle, cancel };
}
