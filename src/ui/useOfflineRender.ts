import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Engine } from "../engine/runtime";
import { downloadTimelineRender, exportTimelineVideo } from "../lib/exportTimeline";
import { appLog } from "../store/consoleStore";
import { useGraphStore } from "../store/graphStore";
import { useModulatorStore } from "../store/modulatorStore";
import { useTimelineStore } from "../store/timelineStore";

/**
 * Offline frame-by-frame timeline export (toolbar Render). Not realtime —
 * seeks the playhead, forces video sync, ticks the graph, captures canvas.
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

    timeline.pause();
    const controller = new AbortController();
    abortRef.current = controller;

    setRendering(true);
    setProgress(0);

    const sourceFps = engine.detectSourceVideoFps();
    const outputFpsHint = sourceFps ?? timeline.fps;
    appLog(
      "info",
      "render",
      `started · ${timeline.durationInFrames} tl-frames @ ${timeline.fps} fps` +
        (sourceFps ? ` → export ${outputFpsHint} fps (source)` : ` → export ${outputFpsHint} fps`),
    );

    try {
      const { blob, outputFps, outputFrames } = await exportTimelineVideo(engine, {
        nodes,
        edges,
        width,
        height,
        timelineFps: timeline.fps,
        durationInFrames: timeline.durationInFrames,
        paramKeyframes: timeline.paramKeyframes,
        modulators,
        signal: controller.signal,
        onFrame: (frame) => {
          useTimelineStore.getState().seek(frame);
        },
        onProgress: setProgress,
      });
      downloadTimelineRender(blob);
      appLog(
        "ok",
        "render",
        `saved · ${outputFrames} frames @ ${outputFps} fps · ${(blob.size / (1024 * 1024)).toFixed(1)} MB`,
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
