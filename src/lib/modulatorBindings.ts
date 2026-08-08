/**
 * Soft-bind a Modulator Drive node onto other nodes' range params.
 *
 * One shared LFO / audio drive on the graph can fan out to several targets
 * (per-target depth + bias). Applied in pushGraph / export after legacy
 * per-param `patch.modulators`, before analyzer soft-binds.
 *
 * Keep this module free of registry/graphStore imports — same cycle risk as
 * analyzerBindings.
 */

import type { ParamSpec } from "../engine/types";
import {
  DEFAULT_MODULATOR,
  MODULATOR_SHAPES,
  MODULATOR_SOURCES,
  modulatorDrive,
  type Modulator,
  type ModulatorShape,
  type ModulatorSource,
} from "./modulators";

export const MODULATOR_DRIVE_TYPE = "modulator.drive";

/** One soft-bind: the shared drive swings one range param on another node. */
export interface ModulatorBind {
  id: string;
  targetNode: string;
  targetParam: string;
  /** 0..1 — swing as a fraction of the target's half-range. */
  depth: number;
  /** −1..1 — constant offset in half-range units. */
  bias: number;
}

declare global {
  interface Window {
    __visioModulatorDrive?: Map<string, number>;
  }
}

/** HMR-stable last −1..1 drive per modulator node (Inspector meter). */
const lastDrive: Map<string, number> =
  (typeof window !== "undefined" && window.__visioModulatorDrive) || new Map();

if (typeof window !== "undefined") {
  window.__visioModulatorDrive = lastDrive;
}

export function getModulatorDrive(nodeId: string): number {
  return lastDrive.get(nodeId) ?? 0;
}

function newBindId(): string {
  return `b-${Math.random().toString(36).slice(2, 9)}`;
}

/** Normalize `params.binds` into a bind list. */
export function parseModulatorBinds(params: Record<string, unknown>): ModulatorBind[] {
  const raw = params.binds;
  if (!Array.isArray(raw)) return [];
  const out: ModulatorBind[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Partial<ModulatorBind>;
    if (typeof row.targetNode !== "string" || typeof row.targetParam !== "string") continue;
    const num = (v: unknown, fallback: number) =>
      typeof v === "number" && Number.isFinite(v) ? v : fallback;
    out.push({
      id: typeof row.id === "string" && row.id ? row.id : newBindId(),
      targetNode: row.targetNode,
      targetParam: row.targetParam,
      depth: Math.min(1, Math.max(0, num(row.depth, 0.5))),
      bias: Math.min(1, Math.max(-1, num(row.bias, 0))),
    });
  }
  return out;
}

export function emptyModulatorBind(): ModulatorBind {
  return { id: newBindId(), targetNode: "", targetParam: "", depth: 0.5, bias: 0 };
}

/** Shared drive config from a modulator.drive node's params. */
export function parseModulatorDriveConfig(params: Record<string, unknown>): Modulator {
  const source = MODULATOR_SOURCES.some((s) => s.value === params.source)
    ? (params.source as ModulatorSource)
    : DEFAULT_MODULATOR.source;
  const shape = MODULATOR_SHAPES.some((s) => s.value === params.shape)
    ? (params.shape as ModulatorShape)
    : DEFAULT_MODULATOR.shape;
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    source,
    shape,
    rateHz: Math.max(0, num(params.rateHz, DEFAULT_MODULATOR.rateHz)),
    // Depth/bias live on each bind; placeholders for modulatorDrive().
    depth: 1,
    bias: 0,
    phase: num(params.phase, DEFAULT_MODULATOR.phase),
    bandLoHz: Math.max(0, num(params.bandLoHz, DEFAULT_MODULATOR.bandLoHz ?? 20)),
    bandHiHz: Math.max(0, num(params.bandHiHz, DEFAULT_MODULATOR.bandHiHz ?? 200)),
  };
}

/** True when any modulator.drive has at least one soft-bind target. */
export function graphHasModulatorBindings(
  nodes: { data: { defType: string; params: Record<string, unknown> } }[],
): boolean {
  return nodes.some((n) => {
    if (n.data.defType !== MODULATOR_DRIVE_TYPE) return false;
    return parseModulatorBinds(n.data.params).some((b) => b.targetNode && b.targetParam);
  });
}

/** True when any modulator.drive uses the audio source (needs steady push). */
export function graphHasAudioModulatorDrives(
  nodes: { data: { defType: string; params: Record<string, unknown> } }[],
): boolean {
  return nodes.some((n) => {
    if (n.data.defType !== MODULATOR_DRIVE_TYPE) return false;
    return parseModulatorDriveConfig(n.data.params).source === "audio";
  });
}

/**
 * Apply shared drives from modulator.drive nodes onto the keyed param map.
 * Runs after legacy per-param modulators — graph routing wins on overlap.
 */
export function applyModulatorBindings(
  timelineSec: number,
  keyed: Map<string, Record<string, unknown>>,
  nodes: { id: string; defType: string; params: Record<string, unknown> }[],
  specOf: (nodeId: string, key: string) => ParamSpec | undefined,
  sampleAt?: (nodeId: string) => number | undefined,
): void {
  const drives = nodes.filter((n) => n.defType === MODULATOR_DRIVE_TYPE);
  if (drives.length === 0) return;

  for (const driveNode of drives) {
    const params = keyed.get(driveNode.id) ?? { ...driveNode.params };
    keyed.set(driveNode.id, params);

    const config = parseModulatorDriveConfig(params);
    const sample =
      config.source === "audio" ? sampleAt?.(driveNode.id) : undefined;
    const drive = modulatorDrive(config, timelineSec, sample);
    lastDrive.set(driveNode.id, drive);

    for (const bind of parseModulatorBinds(params)) {
      if (!bind.targetNode || !bind.targetParam) continue;

      let targetParams = keyed.get(bind.targetNode);
      if (!targetParams) {
        const ref = nodes.find((n) => n.id === bind.targetNode);
        if (!ref) continue;
        targetParams = { ...ref.params };
        keyed.set(bind.targetNode, targetParams);
      }

      const spec = specOf(bind.targetNode, bind.targetParam);
      if (!spec || spec.type !== "range") continue;

      const base =
        typeof targetParams[bind.targetParam] === "number"
          ? (targetParams[bind.targetParam] as number)
          : spec.default;
      const half = (spec.max - spec.min) / 2;
      const swing = drive * bind.depth * half;
      const value = base + swing + bind.bias * half;
      targetParams[bind.targetParam] = Math.min(spec.max, Math.max(spec.min, value));
    }
  }
}
