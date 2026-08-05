/**
 * Soft-bind Audio Analyzer band levels onto other nodes' range params.
 *
 * Measurement lives in analyzer `evaluate()` (live audio playhead). That pass
 * publishes per-band outs and queues param overrides; the engine applies them
 * at the start of the next tick.
 *
 * Keep this module free of registry/graphStore imports — it is pulled in by
 * audio.analyzer, which the registry itself imports (cycle → blank boot).
 */

import type { NodeDefinition, ParamSpec } from "../engine/types";

export const ANALYZER_NODE_TYPE = "audio.analyzer";

export type AnalyzerBandId = "low" | "mid" | "high";

export const ANALYZER_BANDS: {
  id: AnalyzerBandId;
  label: string;
  loKey: string;
  hiKey: string;
  outKey: string;
  defaultLo: number;
  defaultHi: number;
}[] = [
  { id: "low", label: "Low", loKey: "lowLoHz", hiKey: "lowHiHz", outKey: "outLow", defaultLo: 20, defaultHi: 200 },
  { id: "mid", label: "Mid", loKey: "midLoHz", hiKey: "midHiHz", outKey: "outMid", defaultLo: 200, defaultHi: 2000 },
  {
    id: "high",
    label: "High",
    loKey: "highLoHz",
    hiKey: "highHiHz",
    outKey: "outHigh",
    defaultLo: 2000,
    defaultHi: 8000,
  },
];

/** One soft-bind: a band level drives one range param on another node. */
export interface AnalyzerBind {
  id: string;
  band: AnalyzerBandId;
  targetNode: string;
  targetParam: string;
  /** 0..1 — how much of the target range the band level covers. */
  depth: number;
}

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

export function analyzerOutKey(nodeId: string, band: AnalyzerBandId): string {
  return `${nodeId}:${band}`;
}

export function getAnalyzerOut(nodeId: string, band: AnalyzerBandId = "low"): number {
  return lastOut.get(analyzerOutKey(nodeId, band)) ?? 0;
}

export function clearAnalyzerState(nodeId?: string): void {
  if (nodeId) {
    for (const band of ANALYZER_BANDS) {
      const key = analyzerOutKey(nodeId, band.id);
      smoothed.delete(key);
      lastOut.delete(key);
    }
    // Legacy single-key cleanup.
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
  slotKey: string,
  raw: number,
  smoothing: number,
): number {
  const alpha = Math.min(0.99, Math.max(0, smoothing));
  const prev = smoothed.get(slotKey);
  const next = prev == null ? raw : prev + (1 - alpha) * (raw - prev);
  smoothed.set(slotKey, next);
  return next;
}

export function finalizeAnalyzerOut(slotKey: string, level: number): number {
  const clamped = Math.min(1, Math.max(0, level));
  lastOut.set(slotKey, clamped);
  return clamped;
}

function isBandId(value: unknown): value is AnalyzerBandId {
  return value === "low" || value === "mid" || value === "high";
}

function newBindId(): string {
  return `b-${Math.random().toString(36).slice(2, 9)}`;
}

/** Normalize `params.binds` (+ legacy single target) into a bind list. */
export function parseAnalyzerBinds(params: Record<string, unknown>): AnalyzerBind[] {
  const raw = params.binds;
  if (Array.isArray(raw)) {
    const out: AnalyzerBind[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Partial<AnalyzerBind>;
      if (!isBandId(row.band)) continue;
      if (typeof row.targetNode !== "string" || typeof row.targetParam !== "string") continue;
      const depth =
        typeof row.depth === "number" && Number.isFinite(row.depth)
          ? Math.min(1, Math.max(0, row.depth))
          : 1;
      out.push({
        id: typeof row.id === "string" && row.id ? row.id : newBindId(),
        band: row.band,
        targetNode: row.targetNode,
        targetParam: row.targetParam,
        depth,
      });
    }
    return out;
  }

  // Legacy single bind → low band.
  const targetNode = typeof params.targetNode === "string" ? params.targetNode : "";
  const targetParam = typeof params.targetParam === "string" ? params.targetParam : "";
  if (!targetNode || !targetParam) return [];
  const depth =
    typeof params.depth === "number" && Number.isFinite(params.depth)
      ? Math.min(1, Math.max(0, params.depth))
      : 1;
  return [{ id: "legacy", band: "low", targetNode, targetParam, depth }];
}

export function emptyAnalyzerBind(band: AnalyzerBandId = "low"): AnalyzerBind {
  return { id: newBindId(), band, targetNode: "", targetParam: "", depth: 1 };
}

/** True when any analyzer has at least one soft-bind target. */
export function graphHasAnalyzerBindings(
  nodes: { data: { defType: string; params: Record<string, unknown> } }[],
): boolean {
  return nodes.some((n) => {
    if (n.data.defType !== ANALYZER_NODE_TYPE) return false;
    return parseAnalyzerBinds(n.data.params).some((b) => b.targetNode && b.targetParam);
  });
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
 * Called from analyzer evaluate after computing a band level. Queues a soft-bind
 * for the next engine tick.
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
 * Copy per-band lastOut into the keyed param map for setGraph / export.
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
    const params = keyed.get(analyzer.id) ?? { ...analyzer.params };
    keyed.set(analyzer.id, params);

    const levels: Partial<Record<AnalyzerBandId, number>> = {};
    for (const band of ANALYZER_BANDS) {
      const level = lastOut.get(analyzerOutKey(analyzer.id, band.id));
      if (level == null) continue;
      levels[band.id] = level;
      params[band.outKey] = level;
    }

    for (const bind of parseAnalyzerBinds(params)) {
      if (!bind.targetNode || !bind.targetParam) continue;
      const level = levels[bind.band];
      if (level == null) continue;

      let targetParams = keyed.get(bind.targetNode);
      if (!targetParams) {
        const ref = nodes.find((n) => n.id === bind.targetNode);
        if (!ref) continue;
        targetParams = { ...ref.params };
        keyed.set(bind.targetNode, targetParams);
      }
      const spec = specOf(bind.targetNode, bind.targetParam);
      if (!spec || spec.type !== "range") continue;
      targetParams[bind.targetParam] = mapAnalyzerToRange(spec, level, bind.depth);
    }
  }
}
