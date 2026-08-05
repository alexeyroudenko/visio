/**
 * Soft-bind Audio Analyzer band level onto another node's range params.
 *
 * Measurement lives only in analyzer `evaluate()` (live audio playhead).
 * That pass publishes `lastOut` and queues a param override; the engine applies
 * overrides at the start of the next tick so Points Noise etc. see the value.
 *
 * Keep this module free of registry/graphStore imports — it is pulled in by
 * audio.analyzer, which the registry itself imports (cycle → blank boot).
 */

import type { NodeDefinition, ParamSpec } from "../engine/types";

export const ANALYZER_NODE_TYPE = "audio.analyzer";

declare global {
  interface Window {
    __visioAnalyzerSmoothed?: Map<string, number>;
    __visioAnalyzerLastOut?: Map<string, number>;
    __visioAnalyzerPending?: PendingBind[];
  }
}

interface PendingBind {
  targetNode: string;
  targetParam: string;
  level: number;
  depth: number;
}

interface EngineNodeRef {
  type: string;
  params: Record<string, unknown>;
}

/** HMR-stable maps — a reloaded module must not orphan evaluate's writes. */
const smoothed: Map<string, number> =
  (typeof window !== "undefined" && window.__visioAnalyzerSmoothed) || new Map();
const lastOut: Map<string, number> =
  (typeof window !== "undefined" && window.__visioAnalyzerLastOut) || new Map();
let pending: PendingBind[] =
  (typeof window !== "undefined" && window.__visioAnalyzerPending) || [];

if (typeof window !== "undefined") {
  window.__visioAnalyzerSmoothed = smoothed;
  window.__visioAnalyzerLastOut = lastOut;
  window.__visioAnalyzerPending = pending;
}

export function getAnalyzerOut(nodeId: string): number {
  return lastOut.get(nodeId) ?? 0;
}

export function clearAnalyzerState(nodeId?: string): void {
  if (nodeId) {
    smoothed.delete(nodeId);
    lastOut.delete(nodeId);
    return;
  }
  smoothed.clear();
  lastOut.clear();
  pending = [];
  if (typeof window !== "undefined") window.__visioAnalyzerPending = pending;
}

/** EMA toward `raw` with coefficient `smoothing` in 0..1 (higher = stickier). */
export function smoothAnalyzerLevel(
  nodeId: string,
  raw: number,
  smoothing: number,
): number {
  const alpha = Math.min(0.99, Math.max(0, smoothing));
  const prev = smoothed.get(nodeId);
  const next = prev == null ? raw : prev + (1 - alpha) * (raw - prev);
  smoothed.set(nodeId, next);
  return next;
}

export function finalizeAnalyzerOut(nodeId: string, level: number): number {
  const clamped = Math.min(1, Math.max(0, level));
  lastOut.set(nodeId, clamped);
  return clamped;
}

/** True when any analyzer has a soft-bind target — live pushGraph should keep ticking. */
export function graphHasAnalyzerBindings(
  nodes: { data: { defType: string; params: Record<string, unknown> } }[],
): boolean {
  return nodes.some(
    (n) =>
      n.data.defType === ANALYZER_NODE_TYPE &&
      typeof n.data.params.targetNode === "string" &&
      n.data.params.targetNode.length > 0 &&
      typeof n.data.params.targetParam === "string" &&
      n.data.params.targetParam.length > 0,
  );
}

/**
 * Map 0..1 analyzer out onto a range param. Depth scales how much of the span
 * is used (0 = min, 1 = full span).
 */
export function mapAnalyzerToRange(
  spec: Extract<ParamSpec, { type: "range" }>,
  out: number,
  depth: number,
): number {
  const t = Math.min(1, Math.max(0, out)) * Math.min(1, Math.max(0, depth));
  return spec.min + (spec.max - spec.min) * t;
}

/**
 * Called from analyzer evaluate after computing `level`. Queues a soft-bind for
 * the next engine tick (target may run earlier in this frame's topo order).
 */
export function queueAnalyzerBind(
  level: number,
  targetNode: string,
  targetParam: string,
  depth: number,
): void {
  if (!targetNode || !targetParam) return;
  pending = pending.filter(
    (b) => !(b.targetNode === targetNode && b.targetParam === targetParam),
  );
  pending.push({ targetNode, targetParam, level, depth });
  if (typeof window !== "undefined") window.__visioAnalyzerPending = pending;
}

/** Apply queued soft-binds onto the engine's live node param objects. */
export function applyPendingAnalyzerBinds(
  nodesById: Map<string, EngineNodeRef>,
  definitions: Record<string, NodeDefinition<never>>,
): void {
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  if (typeof window !== "undefined") window.__visioAnalyzerPending = pending;
  for (const bind of batch) {
    const node = nodesById.get(bind.targetNode);
    if (!node) continue;
    const spec = definitions[node.type]?.params.find((p) => p.key === bind.targetParam);
    if (!spec || spec.type !== "range") continue;
    node.params[bind.targetParam] = mapAnalyzerToRange(spec, bind.level, bind.depth);
  }
}

/**
 * Copy lastOut into the keyed param map for setGraph / export. Does not
 * recompute band energy — that clock was drifting from the live audio playhead.
 */
export function applyAnalyzerBindings(
  _timelineSec: number,
  keyed: Map<string, Record<string, unknown>>,
  nodes: { id: string; defType: string; params: Record<string, unknown> }[],
  _edges: unknown,
  specOf: (nodeId: string, key: string) => ParamSpec | undefined,
): void {
  const analyzers = nodes.filter((n) => n.defType === ANALYZER_NODE_TYPE);
  if (analyzers.length === 0) return;

  for (const analyzer of analyzers) {
    const level = lastOut.get(analyzer.id);
    if (level == null) continue;

    const params = keyed.get(analyzer.id) ?? { ...analyzer.params };
    keyed.set(analyzer.id, params);
    params.out = level;

    const targetNode = typeof params.targetNode === "string" ? params.targetNode : "";
    const targetParam = typeof params.targetParam === "string" ? params.targetParam : "";
    const depth =
      typeof params.depth === "number" && Number.isFinite(params.depth) ? params.depth : 1;
    if (!targetNode || !targetParam) continue;

    let targetParams = keyed.get(targetNode);
    if (!targetParams) {
      const ref = nodes.find((n) => n.id === targetNode);
      if (!ref) continue;
      targetParams = { ...ref.params };
      keyed.set(targetNode, targetParams);
    }
    const spec = specOf(targetNode, targetParam);
    if (!spec || spec.type !== "range") continue;
    targetParams[targetParam] = mapAnalyzerToRange(spec, level, depth);
  }
}
