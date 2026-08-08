import type { Edge } from "@xyflow/react";
import {
  DEFAULT_DURATION_FRAMES,
  DEFAULT_FPS,
  parseParamPath,
  type ParamKeyframe,
  type ParamKeyframes,
} from "../lib/keyframes";
import { fileStem } from "../lib/fileStem";
import { parseModulators, type Modulators } from "../lib/modulators";
import { cutsFromUnknown } from "../lib/reelMarkers";
import { NODE_DEFS, defaultParams } from "../nodes/registry";
import { fileParam } from "../nodes/shared/fileParam";
import { LEGACY_SOURCE_TYPES } from "../nodes/source/media";
import type { PatchNode } from "./graphStore";

const STORAGE_KEY = "visio.patch.v4";
const FORMAT = 1;

/**
 * Timeline is optional and additive rather than a format bump: a patch saved
 * before keyframes existed still loads, and a build that predates them ignores
 * the field instead of rejecting the whole document.
 */
export interface SerializedTimeline {
  fps: number;
  durationInFrames: number;
  keyframes: ParamKeyframes;
  /**
   * Optional Hook/FormWait/Dev/Climax cuts (seconds) for the reel zone overlay.
   * Patches written before FormWait carry three cuts and are upgraded on load.
   */
  reelZones?: { cutsSec: [number, number, number, number]; dirty?: boolean };
  cueZoneTick?: boolean;
  cueDevMetronome?: boolean;
  cueDrone?: boolean;
  developmentBpm?: number;
  droneByZone?: Record<
    string,
    {
      enabled?: boolean;
      freq?: number;
      gain?: number;
      type?: string;
      detune?: number;
      cutoff?: number;
      lfoRate?: number;
      lfoDepth?: number;
      subGain?: number;
    }
  >;
}

export interface SerializedPatch {
  format: number;
  width: number;
  height: number;
  nodes: {
    id: string;
    type: string;
    position: { x: number; y: number };
    params: Record<string, unknown>;
    bypass?: boolean;
    debug?: boolean;
  }[];
  edges: {
    id: string;
    source: string;
    sourceHandle: string;
    target: string;
    targetHandle: string;
  }[];
  timeline?: SerializedTimeline;
  /** Optional for the same reason as `timeline` — older patches simply have none. */
  modulators?: Modulators;
  /**
   * Name of the footage the patch was built on. Dropped files live behind a
   * `blob:` URL that the params drop on save, so without this an exported patch
   * says nothing about which clip it belongs to.
   */
  source?: string;
}

/** Original media file name, video first — the same order downloads prefer. */
function sourceFileName(nodes: PatchNode[]): string | null {
  for (const prefer of ["video", "audio", "image"] as const) {
    for (const node of nodes) {
      const legacyMode = LEGACY_SOURCE_TYPES[node.data.defType];
      if (node.data.defType !== "source.media" && !legacyMode) continue;
      if ((node.data.params.mode ?? legacyMode) !== prefer) continue;
      const file = fileParam(node.data.params);
      if (file?.name) return file.name;
    }
  }
  return null;
}

/**
 * blob: URLs die with the tab — drop those on save. Public / http(s) file refs
 * (e.g. the bundled default image) are kept so reloads still show media.
 * Dropped footage is revived separately from IndexedDB (`mediaMemory` hydrate).
 */
function serializableParams(defType: string, params: Record<string, unknown>): Record<string, unknown> {
  const definition = NODE_DEFS[defType];
  if (!definition) return {};
  const clean: Record<string, unknown> = {};
  for (const spec of definition.params) {
    if (spec.type === "file") {
      const value = params[spec.key];
      if (
        value &&
        typeof value === "object" &&
        typeof (value as { url?: unknown }).url === "string" &&
        !(value as { url: string }).url.startsWith("blob:")
      ) {
        const file = value as { name: string; url: string; mime?: string; sizeBytes?: number };
        clean[spec.key] = {
          name: file.name,
          url: file.url,
          ...(file.mime ? { mime: file.mime } : {}),
          ...(file.sizeBytes != null ? { sizeBytes: file.sizeBytes } : {}),
        };
      }
      continue;
    }
    clean[spec.key] = params[spec.key];
  }
  return clean;
}

/**
 * Keyframes on a file param would save a `blob:` URL that dies with the tab —
 * the same reason `serializableParams` drops the params themselves. Tracks for
 * nodes that no longer exist go too, so deleting a node takes its keys with it.
 */
function serializableKeyframes(
  nodes: PatchNode[],
  keyframes: ParamKeyframes,
): ParamKeyframes {
  const defTypeById = new Map(nodes.map((node) => [node.id, node.data.defType]));
  const clean: ParamKeyframes = {};
  for (const [path, keys] of Object.entries(keyframes)) {
    if (!keys?.length) continue;
    const parsed = parseParamPath(path);
    if (!parsed) continue;
    const defType = defTypeById.get(parsed.nodeId);
    if (!defType) continue;
    const spec = NODE_DEFS[defType]?.params.find((p) => p.key === parsed.key);
    if (!spec || spec.type === "file") continue;
    clean[path] = keys;
  }
  return clean;
}

export function serializePatch(
  nodes: PatchNode[],
  edges: Edge[],
  width: number,
  height: number,
  timeline?: SerializedTimeline,
  modulators?: Modulators,
): SerializedPatch {
  const source = sourceFileName(nodes);
  return {
    format: FORMAT,
    width,
    height,
    ...(source ? { source } : {}),
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.defType,
      position: node.position,
      params: serializableParams(node.data.defType, node.data.params),
      ...(node.data.bypass ? { bypass: true } : {}),
      ...(node.data.debug ? { debug: true } : {}),
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle ?? "out",
      target: edge.target,
      targetHandle: edge.targetHandle ?? "in",
    })),
    ...(timeline
      ? {
          timeline: {
            fps: timeline.fps,
            durationInFrames: timeline.durationInFrames,
            keyframes: serializableKeyframes(nodes, timeline.keyframes),
            ...(timeline.reelZones
              ? {
                  reelZones: {
                    cutsSec: [...timeline.reelZones.cutsSec] as [number, number, number, number],
                    dirty: !!timeline.reelZones.dirty,
                  },
                }
              : {}),
            ...(typeof timeline.cueZoneTick === "boolean"
              ? { cueZoneTick: timeline.cueZoneTick }
              : {}),
            ...(typeof timeline.cueDevMetronome === "boolean"
              ? { cueDevMetronome: timeline.cueDevMetronome }
              : {}),
            ...(typeof timeline.cueDrone === "boolean" ? { cueDrone: timeline.cueDrone } : {}),
            ...(typeof timeline.developmentBpm === "number"
              ? { developmentBpm: timeline.developmentBpm }
              : {}),
            ...(timeline.droneByZone ? { droneByZone: timeline.droneByZone } : {}),
          },
        }
      : {}),
    ...(modulators && Object.keys(modulators).length > 0 ? { modulators } : {}),
  };
}

export interface ParsedPatch {
  nodes: PatchNode[];
  edges: Edge[];
  width: number;
  height: number;
  /** Absent when the patch predates keyframes — the timeline is then left as is. */
  timeline: SerializedTimeline | null;
  modulators: Modulators;
}

/** Drops anything malformed rather than letting one bad key break a load. */
function parseTimeline(raw: unknown, nodeIds: Set<string>): SerializedTimeline | null {
  if (!raw || typeof raw !== "object") return null;
  const timeline = raw as Partial<SerializedTimeline>;

  const keyframes: ParamKeyframes = {};
  if (timeline.keyframes && typeof timeline.keyframes === "object") {
    for (const [path, keys] of Object.entries(timeline.keyframes)) {
      const parsed = parseParamPath(path);
      if (!parsed || !nodeIds.has(parsed.nodeId) || !Array.isArray(keys)) continue;
      const clean: ParamKeyframe[] = keys
        .filter(
          (key): key is ParamKeyframe =>
            !!key && typeof key === "object" && Number.isFinite((key as ParamKeyframe).frame),
        )
        .map((key) => ({ frame: Math.max(0, Math.round(key.frame)), value: key.value }))
        .sort((a, b) => a.frame - b.frame);
      if (clean.length) keyframes[path] = clean;
    }
  }

  const fps = Number(timeline.fps);
  const duration = Number(timeline.durationInFrames);
  let reelZones: SerializedTimeline["reelZones"];
  const rawZones = (timeline as { reelZones?: unknown }).reelZones;
  if (rawZones && typeof rawZones === "object") {
    const cuts = cutsFromUnknown((rawZones as { cutsSec?: unknown }).cutsSec);
    if (cuts) {
      reelZones = {
        cutsSec: [cuts[0], cuts[1], cuts[2], cuts[3]],
        dirty: !!(rawZones as { dirty?: unknown }).dirty,
      };
    }
  }
  return {
    fps: Number.isFinite(fps) && fps >= 1 ? fps : DEFAULT_FPS,
    durationInFrames:
      Number.isFinite(duration) && duration >= 1
        ? Math.round(duration)
        : DEFAULT_DURATION_FRAMES,
    keyframes,
    ...(reelZones ? { reelZones } : {}),
    ...(typeof (timeline as { cueZoneTick?: unknown }).cueZoneTick === "boolean"
      ? { cueZoneTick: (timeline as { cueZoneTick: boolean }).cueZoneTick }
      : {}),
    ...(typeof (timeline as { cueDevMetronome?: unknown }).cueDevMetronome === "boolean"
      ? { cueDevMetronome: (timeline as { cueDevMetronome: boolean }).cueDevMetronome }
      : {}),
    ...(typeof (timeline as { cueDrone?: unknown }).cueDrone === "boolean"
      ? { cueDrone: (timeline as { cueDrone: boolean }).cueDrone }
      : {}),
    ...(typeof (timeline as { developmentBpm?: unknown }).developmentBpm === "number"
      ? { developmentBpm: (timeline as { developmentBpm: number }).developmentBpm }
      : {}),
    ...((timeline as { droneByZone?: unknown }).droneByZone
      ? { droneByZone: (timeline as { droneByZone: SerializedTimeline["droneByZone"] }).droneByZone }
      : {}),
  };
}

/** Returns null for anything that isn't a patch we can safely load. */
export function parsePatch(raw: unknown): ParsedPatch | null {
  if (!raw || typeof raw !== "object") return null;
  const patch = raw as Partial<SerializedPatch>;
  if (patch.format !== FORMAT || !Array.isArray(patch.nodes) || !Array.isArray(patch.edges)) {
    return null;
  }

  const nodes: PatchNode[] = [];
  for (const entry of patch.nodes) {
    // Skip node types this build no longer knows about rather than failing.
    if (!entry || typeof entry.id !== "string" || !NODE_DEFS[entry.type]) continue;

    const legacyMode = LEGACY_SOURCE_TYPES[entry.type];
    const defType = legacyMode ? "source.media" : entry.type;
    const migratedParams = legacyMode
      ? { mode: legacyMode, ...(entry.params ?? {}) }
      : (entry.params ?? {});

    nodes.push({
      id: entry.id,
      type: "patch",
      position: {
        x: Number(entry.position?.x) || 0,
        y: Number(entry.position?.y) || 0,
      },
      // Defaults first, so params added since the patch was saved exist.
      data: {
        defType,
        params: { ...defaultParams(defType), ...migratedParams },
        bypass: entry.bypass === true,
        debug: entry.debug === true,
      },
    });
  }

  const ids = new Set(nodes.map((node) => node.id));
  const edges: Edge[] = patch.edges
    .filter((edge) => edge && ids.has(edge.source) && ids.has(edge.target))
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle,
      target: edge.target,
      targetHandle: edge.targetHandle,
    }));

  if (nodes.length === 0) return null;

  return {
    nodes,
    edges,
    width: Number(patch.width) || 1080,
    height: Number(patch.height) || 1920,
    timeline: parseTimeline(patch.timeline, ids),
    modulators: parseModulators(patch.modulators, ids),
  };
}

export function saveToStorage(patch: SerializedPatch): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(patch));
  } catch {
    // Private mode or a full quota — autosave is best-effort.
  }
}

export function loadFromStorage(): ParsedPatch | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return parsePatch(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function clearStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do — the next save will overwrite anyway.
  }
}

export function downloadPatch(patch: SerializedPatch): void {
  const blob = new Blob([JSON.stringify(patch, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const stamp = new Date().toISOString().slice(0, 10);
  // Native media name first, then the stamp — same shape as render downloads.
  const stem = patch.source ? fileStem(patch.source) : null;
  link.download = stem ? `${stem}-visio-patch-${stamp}.json` : `visio-patch-${stamp}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
