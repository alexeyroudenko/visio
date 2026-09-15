import { PRESET_OVERRIDES } from "virtual:preset-overrides";
import { fileParam } from "../nodes/shared/fileParam";
import { resolvePatchFiles, type SerializedPatch } from "../store/persistence";

/** Live copy: Save in this session updates it before the next reload. */
let overrides: Record<string, SerializedPatch> = {
  ...(PRESET_OVERRIDES as Record<string, SerializedPatch>),
};

if (import.meta.hot) {
  import.meta.hot.accept("virtual:preset-overrides", (mod) => {
    if (!mod) return;
    overrides = { ...(mod.PRESET_OVERRIDES as Record<string, SerializedPatch>) };
  });
}

export function builtinOverride(id: string): SerializedPatch | undefined {
  const patch = overrides[id];
  return patch ? resolvePatchFiles(structuredClone(patch)) : undefined;
}

const FILE_MODES = new Set(["image", "video", "audio"]);

function mediaHasFile(params: Record<string, unknown>): boolean {
  return Boolean(fileParam(params)?.url);
}

/**
 * Saving a builtin from a local blob strips `file` (`serializePatch`). A video
 * override with no URL opens empty on live. Fall back to the authored still.
 */
export function fillMissingMediaFiles(
  override: SerializedPatch,
  original: SerializedPatch,
): SerializedPatch {
  const byId = new Map(original.nodes.map((node) => [node.id, node]));
  let changed = false;
  const nodes = override.nodes.map((node) => {
    if (node.type !== "source.media") return node;
    const mode = node.params.mode;
    if (typeof mode !== "string" || !FILE_MODES.has(mode) || mediaHasFile(node.params)) {
      return node;
    }
    const fallback = byId.get(node.id);
    if (!fallback || !mediaHasFile(fallback.params)) return node;
    changed = true;
    return {
      ...node,
      params: {
        ...node.params,
        mode: fallback.params.mode ?? node.params.mode,
        file: structuredClone(fallback.params.file),
      },
    };
  });
  return changed ? { ...override, nodes } : override;
}

/** Persist the open graph over a builtin. Dev-only — the vite plugin writes the files. */
export async function saveBuiltinPreset(id: string, patch: SerializedPatch): Promise<boolean> {
  try {
    const res = await fetch("/__save-builtin-preset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, patch }),
    });
    if (!res.ok) return false;
    overrides = { ...overrides, [id]: structuredClone(patch) };
    return true;
  } catch {
    return false;
  }
}
