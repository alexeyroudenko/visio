import type { Edge } from "@xyflow/react";
import { NODE_DEFS, defaultParams } from "../nodes/registry";
import type { PatchNode } from "./graphStore";

const STORAGE_KEY = "visio.patch.v3";
const FORMAT = 1;

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
  }[];
  edges: {
    id: string;
    source: string;
    sourceHandle: string;
    target: string;
    targetHandle: string;
  }[];
}

/**
 * blob: URLs die with the tab — drop those on save. Public / http(s) file refs
 * (e.g. the bundled default image) are kept so reloads still show media.
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
        clean[spec.key] = value;
      }
      continue;
    }
    clean[spec.key] = params[spec.key];
  }
  return clean;
}

export function serializePatch(
  nodes: PatchNode[],
  edges: Edge[],
  width: number,
  height: number,
): SerializedPatch {
  return {
    format: FORMAT,
    width,
    height,
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.defType,
      position: node.position,
      params: serializableParams(node.data.defType, node.data.params),
      ...(node.data.bypass ? { bypass: true } : {}),
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle ?? "out",
      target: edge.target,
      targetHandle: edge.targetHandle ?? "in",
    })),
  };
}

export interface ParsedPatch {
  nodes: PatchNode[];
  edges: Edge[];
  width: number;
  height: number;
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
    nodes.push({
      id: entry.id,
      type: "patch",
      position: {
        x: Number(entry.position?.x) || 0,
        y: Number(entry.position?.y) || 0,
      },
      // Defaults first, so params added since the patch was saved exist.
      data: {
        defType: entry.type,
        params: { ...defaultParams(entry.type), ...(entry.params ?? {}) },
        bypass: entry.bypass === true,
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
  link.download = `visio-patch-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
