import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Engine } from "../engine/runtime";
import { audioModulatorSamples } from "../lib/audioModSamples";
import { bindPresetPreviewCapture } from "../lib/capturePresetPreviews";
import { applyKeyframesToNodes } from "../lib/keyframes";
import { applyModulatorsToNodes } from "../lib/modulators";
import { NODE_DEFS } from "../nodes/registry";
import { LEGACY_SOURCE_TYPES } from "../nodes/source/media";
import { appLog } from "../store/consoleStore";
import { useEngineStatsStore } from "../store/engineStatsStore";
import { useGraphStore } from "../store/graphStore";
import { useModulatorStore } from "../store/modulatorStore";
import { useTimelineStore } from "../store/timelineStore";

function engineNodeType(defType: string): string {
  return LEGACY_SOURCE_TYPES[defType] ? "source.media" : defType;
}
/**
 * Bridges the React graph description to the imperative engine: one Engine per
 * canvas, re-fed whenever nodes, edges, params, timeline playhead or resolution
 * change.
 *
 * Stats go to a separate store so the React Flow tree is not re-rendered every
 * 500ms (that was resetting in-progress node drags).
 */
export function useEngine(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  /** Remount the engine when the canvas moves (e.g. horizontal ↔ vertical shell). */
  layoutKey: string | number = "default",
) {
  const engineRef = useRef<Engine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let engine: Engine;
    try {
      engine = new Engine(canvas);
    } catch (err) {
      const message = err instanceof Error ? err.message : "failed to create WebGL2 context";
      setError(message);
      appLog("error", "engine", message);
      return;
    }

    engine.setDefinitions(NODE_DEFS);
    engine.onStatus((statuses) => useGraphStore.getState().setStatuses(statuses));
    engineRef.current = engine;
    bindPresetPreviewCapture(canvas);

    const pushGraph = () => {
      const { width, height, nodes, edges } = useGraphStore.getState();
      const timeline = useTimelineStore.getState();
      const keyed = applyKeyframesToNodes(
        timeline.currentFrame,
        nodes.map((node) => ({ id: node.id, params: node.data.params })),
        timeline.paramKeyframes,
      );
      // Modulators ride on top of the keyframed value, and run on timeline time
      // so an offline render reproduces exactly what playback showed.
      const defTypeById = new Map(nodes.map((node) => [node.id, node.data.defType]));
      const modulators = useModulatorStore.getState().byPath;
      const timelineSec = timeline.currentFrame / timeline.fps;
      const samples = audioModulatorSamples(
        modulators,
        nodes.map((node) => ({
          id: node.id,
          params: keyed.get(node.id) ?? node.data.params,
        })),
        timelineSec,
      );
      applyModulatorsToNodes(
        timelineSec,
        keyed,
        modulators,
        (nodeId, key) => {
          const defType = defTypeById.get(nodeId);
          return defType ? NODE_DEFS[defType]?.params.find((p) => p.key === key) : undefined;
        },
        (path) => samples.get(path),
      );

      engine.setResolution(width, height);
      engine.setTimeline(timeline.currentFrame, timeline.fps, timeline.isPlaying);
      // Refresh defs every push so HMR-added nodes (converters, etc.) are live.
      engine.setDefinitions(NODE_DEFS);
      engine.setGraph(
        nodes.map((node) => ({
          id: node.id,
          type: engineNodeType(node.data.defType),
          params: (() => {
            const base = keyed.get(node.id) ?? node.data.params;
            const mode = LEGACY_SOURCE_TYPES[node.data.defType];
            return mode && base.mode == null ? { ...base, mode } : base;
          })(),
          bypass: node.data.bypass === true,
          debug: node.data.debug === true,
        })),
        edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          sourceHandle: edge.sourceHandle ?? "out",
          target: edge.target,
          targetHandle: edge.targetHandle ?? "in",
        })),
      );
    };

    pushGraph();
    engine.start();
    setPaused(false);
    useEngineStatsStore.getState().setStats({ ...engine.stats });
    const { width, height, nodes } = useGraphStore.getState();
    appLog("ok", "engine", `started · ${width}×${height} · ${nodes.length} nodes`);

    let prevNodes = useGraphStore.getState().nodes;
    let prevEdges = useGraphStore.getState().edges;
    let prevWidth = useGraphStore.getState().width;
    let prevHeight = useGraphStore.getState().height;
    let prevFrame = useTimelineStore.getState().currentFrame;
    let prevKeys = useTimelineStore.getState().paramKeyframes;
    let prevPlaying = useTimelineStore.getState().isPlaying;
    let prevModulators = useModulatorStore.getState().byPath;

    const unsubGraph = useGraphStore.subscribe((state) => {
      if (
        state.nodes === prevNodes &&
        state.edges === prevEdges &&
        state.width === prevWidth &&
        state.height === prevHeight
      ) {
        return;
      }
      prevNodes = state.nodes;
      prevEdges = state.edges;
      prevWidth = state.width;
      prevHeight = state.height;
      pushGraph();
    });

    const unsubTimeline = useTimelineStore.subscribe((state) => {
      if (
        state.currentFrame === prevFrame &&
        state.paramKeyframes === prevKeys &&
        state.isPlaying === prevPlaying
      ) {
        return;
      }
      prevFrame = state.currentFrame;
      prevKeys = state.paramKeyframes;
      prevPlaying = state.isPlaying;
      pushGraph();
    });

    const unsubModulators = useModulatorStore.subscribe((state) => {
      if (state.byPath === prevModulators) return;
      prevModulators = state.byPath;
      pushGraph();
    });

    const statsTimer = window.setInterval(() => {
      useEngineStatsStore.getState().setStats({ ...engine.stats });
    }, 500);

    // Audio modulators need a steady push even when the timeline is parked:
    // decode may finish mid-session, and free-running Media still moves energy.
    const audioTimer = window.setInterval(() => {
      const mods = useModulatorStore.getState().byPath;
      if (Object.values(mods).some((m) => m.source === "audio")) pushGraph();
    }, 1000 / 30);

    return () => {
      window.clearInterval(statsTimer);
      window.clearInterval(audioTimer);
      unsubGraph();
      unsubTimeline();
      unsubModulators();
      bindPresetPreviewCapture(null);
      engine.dispose();
      engineRef.current = null;
    };
  }, [canvasRef, layoutKey]);

  const togglePause = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const next = !engine.isPaused;
    engine.setPaused(next);
    setPaused(next);
    appLog("info", "engine", next ? "paused" : "playing");
  }, []);

  return { engineRef, error, paused, togglePause };
}
