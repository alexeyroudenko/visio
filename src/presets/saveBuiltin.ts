import { PRESET_OVERRIDES } from "virtual:preset-overrides";
import type { SerializedPatch } from "../store/persistence";

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
  return patch ? structuredClone(patch) : undefined;
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
