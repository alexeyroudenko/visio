import { useEffect, useRef, useState, type RefObject } from "react";
import { Engine, type EngineStats } from "../engine/runtime";
import { NODE_DEFS } from "../nodes/registry";
import { useGraphStore } from "../store/graphStore";

/**
 * Bridges the React graph description to the imperative engine: one Engine per
 * canvas, re-fed whenever nodes, edges, params or resolution change.
 */
export function useEngine(canvasRef: RefObject<HTMLCanvasElement | null>) {
  const engineRef = useRef<Engine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<EngineStats>({ fps: 0, frameMs: 0, nodeCount: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let engine: Engine;
    try {
      engine = new Engine(canvas);
    } catch (err) {
      setError(err instanceof Error ? err.message : "не удалось создать WebGL2-контекст");
      return;
    }

    engine.setDefinitions(NODE_DEFS);
    engine.onStatus((statuses) => useGraphStore.getState().setStatuses(statuses));
    engineRef.current = engine;

    const { width, height, nodes, edges } = useGraphStore.getState();
    engine.setResolution(width, height);
    engine.setGraph(
      nodes.map((node) => ({
        id: node.id,
        type: node.data.defType,
        params: node.data.params,
        bypass: node.data.bypass === true,
      })),
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        sourceHandle: edge.sourceHandle ?? "out",
        target: edge.target,
        targetHandle: edge.targetHandle ?? "in",
      })),
    );
    engine.start();

    // Status updates flow back into the store from the engine itself, so only
    // rebuild when the graph or resolution actually changed.
    let prevNodes = nodes;
    let prevEdges = edges;
    let prevWidth = width;
    let prevHeight = height;

    const unsubscribe = useGraphStore.subscribe((state) => {
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

      engine.setResolution(state.width, state.height);
      engine.setGraph(
        state.nodes.map((node) => ({
          id: node.id,
          type: node.data.defType,
          params: node.data.params,
          bypass: node.data.bypass === true,
        })),
        state.edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          sourceHandle: edge.sourceHandle ?? "out",
          target: edge.target,
          targetHandle: edge.targetHandle ?? "in",
        })),
      );
    });

    const statsTimer = window.setInterval(() => setStats({ ...engine.stats }), 500);

    return () => {
      window.clearInterval(statsTimer);
      unsubscribe();
      engine.dispose();
      engineRef.current = null;
    };
  }, [canvasRef]);

  return { engineRef, error, stats };
}
