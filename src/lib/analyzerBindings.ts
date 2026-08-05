/**
 * Soft-bind Audio Analyzer band level onto another node's range params.
 *
 * Binding is not a graph wire — the analyzer stores target node/param ids and
 * this pass writes the mapped value into the keyed param map before the engine
 * evaluates (same slot modulators use).
 */

import type { ParamSpec } from "../engine/types";
import { fileParam } from "../nodes/shared/fileParam";
import { useMediaInfoStore } from "../store/mediaInfoStore";
import { bandEnergy } from "./audioBands";
import { ensureAudioBuffer } from "./audioBuffers";
import { mediaPlayheadSec } from "./audioModSamples";

export const ANALYZER_NODE_TYPE = "audio.analyzer";

interface NodeRef {
  id: string;
  defType: string;
  params: Record<string, unknown>;
}

interface EdgeRef {
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
}

/** Per-analyzer smoothed level — shared with the node evaluate / Inspector. */
const smoothed = new Map<string, number>();
const lastOut = new Map<string, number>();

export function getAnalyzerOut(nodeId: string): number {
  // Prefer the soft-bind EMA when present so the Inspector meter matches displacement.
  return smoothed.get(nodeId) ?? lastOut.get(nodeId) ?? 0;
}

export function clearAnalyzerState(nodeId?: string): void {
  if (nodeId) {
    smoothed.delete(nodeId);
    lastOut.delete(nodeId);
    return;
  }
  smoothed.clear();
  lastOut.clear();
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

function mediaSourceForAnalyzer(
  analyzerId: string,
  nodes: NodeRef[],
  edges: EdgeRef[],
  keyed: Map<string, Record<string, unknown>>,
): NodeRef | null {
  const edge = edges.find(
    (e) => e.target === analyzerId && (e.targetHandle ?? "audio") === "audio",
  );
  if (!edge) return null;
  const source = nodes.find((n) => n.id === edge.source);
  if (!source) return null;
  const params = keyed.get(source.id) ?? source.params;
  return { ...source, params };
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

function playheadForMedia(
  mediaId: string,
  params: Record<string, unknown>,
  timelineSec: number,
  durationSec: number,
): number {
  const sync = params.syncTimeline === true;
  const live = useMediaInfoStore.getState().byId[mediaId]?.currentTimeSec;
  if (!sync && typeof live === "number" && Number.isFinite(live)) {
    return Math.max(0, live);
  }
  return mediaPlayheadSec(params, timelineSec, durationSec);
}

function numParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Compute band level for each analyzer, write `out`, and push onto bound targets.
 */
export function applyAnalyzerBindings(
  timelineSec: number,
  keyed: Map<string, Record<string, unknown>>,
  nodes: NodeRef[],
  edges: EdgeRef[],
  specOf: (nodeId: string, key: string) => ParamSpec | undefined,
): void {
  const analyzers = nodes.filter((n) => n.defType === ANALYZER_NODE_TYPE);
  if (analyzers.length === 0) return;

  for (const analyzer of analyzers) {
    const params = keyed.get(analyzer.id) ?? { ...analyzer.params };
    keyed.set(analyzer.id, params);

    const gain = numParam(params, "gain", 1);
    const smoothing = numParam(params, "smoothing", 0.7);
    const depth = numParam(params, "depth", 1);
    const loHz = numParam(params, "bandLoHz", 20);
    const hiHz = numParam(params, "bandHiHz", 8000);
    const targetNode = typeof params.targetNode === "string" ? params.targetNode : "";
    const targetParam = typeof params.targetParam === "string" ? params.targetParam : "";

    let raw = 0;
    const media = mediaSourceForAnalyzer(analyzer.id, nodes, edges, keyed);
    const file = media ? fileParam(media.params) : null;
    if (file && media) {
      const entry = ensureAudioBuffer(file.url, file.name);
      if (entry.buffer) {
        const timeSec = playheadForMedia(
          media.id,
          media.params,
          timelineSec,
          entry.buffer.duration,
        );
        raw = bandEnergy(entry.buffer, timeSec, loHz, hiHz);
      }
    }

    const level = smoothAnalyzerLevel(
      analyzer.id,
      Math.min(1, Math.max(0, raw * gain)),
      smoothing,
    );
    params.out = level;

    if (!targetNode || !targetParam) continue;
    const targetParams = keyed.get(targetNode);
    if (!targetParams) continue;
    const spec = specOf(targetNode, targetParam);
    if (!spec || spec.type !== "range") continue;
    targetParams[targetParam] = mapAnalyzerToRange(spec, level, depth);
  }
}
