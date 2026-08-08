import { fileParam } from "../nodes/shared/fileParam";
import { useGraphStore } from "../store/graphStore";
import { rememberedFile } from "../store/mediaMemory";
import { fileStem } from "./fileStem";

export { fileStem };

/**
 * Best-effort original media filename stem from the open graph / media memory.
 * Used so downloads and captions lead with the native name, then our suffix.
 */
export function sourceMediaStem(): string | null {
  const { nodes } = useGraphStore.getState();
  for (const prefer of ["video", "audio", "image"] as const) {
    for (const node of nodes) {
      if (node.data.defType !== "source.media") continue;
      if (node.data.params.mode !== prefer) continue;
      const file = fileParam(node.data.params);
      if (file?.name) return fileStem(file.name);
    }
  }
  for (const prefer of ["video", "audio", "image"] as const) {
    const remembered = rememberedFile(prefer);
    if (remembered?.name) return fileStem(remembered.name);
  }
  return null;
}

/** `clip` + `-render-2026-…` → `clip-render-2026-…`; falls back to the suffix alone. */
export function withSourcePrefix(suffix: string): string {
  const stem = sourceMediaStem();
  if (!stem) return suffix;
  const clean = suffix.replace(/^-+/, "");
  return `${stem}-${clean}`;
}
