import type { FileParam } from "../nodes/shared/fileParam";

/**
 * The last file you opened, per source type, plus which type you were on.
 *
 * Dropping a video and then trying a different preset used to throw the video
 * away — presets carry their own `mode` and `file`, and a preset load replaces
 * the graph wholesale. This remembers both across loads, so the patch changes
 * and the footage stays.
 *
 * Session-scoped on purpose: the files are `blob:` URLs minted from a dropped
 * File, and those do not survive a reload no matter where we write them down.
 */

export type MediaMode = "camera" | "image" | "video" | "audio";
/** Camera has no file; the other three each remember their own. */
type FileMode = Exclude<MediaMode, "camera">;

interface MediaMemory {
  mode: MediaMode | null;
  files: Partial<Record<FileMode, FileParam>>;
}

declare global {
  interface Window {
    /** Survives Vite HMR — reloading a module must not lose the open footage. */
    __visioMediaMemory?: MediaMemory;
  }
}

const memory: MediaMemory = (typeof window !== "undefined"
  ? window.__visioMediaMemory
  : undefined) ?? { mode: null, files: {} };

if (typeof window !== "undefined") window.__visioMediaMemory = memory;

function asMode(value: unknown): MediaMode | null {
  return value === "camera" || value === "image" || value === "video" || value === "audio"
    ? value
    : null;
}

function asFile(value: unknown): FileParam | null {
  if (!value || typeof value !== "object") return null;
  return typeof (value as FileParam).url === "string" ? (value as FileParam) : null;
}

/**
 * The memory is the last thing holding a dropped file's object URL, so it is
 * also what releases it — and only once nothing else remembers the same one.
 */
function release(url: string): void {
  if (!url.startsWith("blob:")) return;
  for (const file of Object.values(memory.files)) {
    if (file?.url === url) return;
  }
  URL.revokeObjectURL(url);
}

/** Record a Media node's current source type, and its file under that type. */
export function rememberMedia(params: Record<string, unknown>): void {
  const mode = asMode(params.mode);
  if (mode) memory.mode = mode;
  if (!mode || mode === "camera") return;

  const file = asFile(params.file);
  if (!file) return;
  const previous = memory.files[mode];
  if (previous?.url === file.url) return;
  memory.files[mode] = file;
  if (previous) release(previous.url);
}

/** The file last opened in this source type, if there was one. */
export function rememberedFile(mode: unknown): FileParam | null {
  const key = asMode(mode);
  if (!key || key === "camera") return null;
  return memory.files[key] ?? null;
}

/**
 * Media params for a patch being loaded: the remembered source type wins over
 * the one the preset shipped with, and the remembered file over its file.
 * Returns the input untouched when there is nothing to say, so a first-run
 * session gets exactly the preset as authored.
 */
export function recallMediaParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const patchMode = asMode(params.mode) ?? "image";
  const mode = memory.mode ?? patchMode;
  const file = rememberedFile(mode);
  if (mode === patchMode && !file) return params;

  const next: Record<string, unknown> = { ...params, mode };
  if (file) next.file = file;
  // Switching type with nothing remembered for it: dropping the preset's file
  // is the point, or a video source would be left pointing at a PNG.
  else if (mode !== patchMode) next.file = null;
  return next;
}
