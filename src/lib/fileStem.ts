/**
 * Standalone so anything that names a download can use it — `mediaName` reaches
 * into the graph store, which the persistence layer cannot import back.
 */

/** Strip extension: `clip.mp4` → `clip`. */
export function fileStem(name: string): string {
  const base = name.trim().replace(/[/\\?%*:|"<>]/g, "-");
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return base || "visio";
  return base.slice(0, dot) || base;
}
