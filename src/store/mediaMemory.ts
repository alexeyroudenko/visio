import type { FileParam } from "../nodes/shared/fileParam";
import { loadResetOnVisit } from "../lib/resetOnVisit";
import {
  clearAllMediaFiles,
  deleteMediaFile,
  getAllMediaFiles,
  persistFileParam,
  reviveStoredFile,
} from "./mediaFileDb";

/**
 * The last file you opened, per source type, plus which type you were on.
 *
 * Dropping a video and then trying a different preset used to throw the video
 * away — presets carry their own `mode` and `file`, and a preset load replaces
 * the graph wholesale. This remembers both across loads, so the patch changes
 * and the footage stays.
 *
 * Same tab, and across reloads when Reset-on-visit is off (dev default).
 * IndexedDB keeps a copy of blob files; boot either wipes it (reset on visit)
 * or revives the files so the restored patch has footage again.
 */

export type MediaMode = "camera" | "image" | "video" | "audio";
/** Camera has no file; the other three each remember their own. */
type FileMode = Exclude<MediaMode, "camera">;

interface RememberedFile extends FileParam {
  /** Live File — used to refill `<input type="file">` after a restore. */
  fileObj?: File;
}

interface MediaMemory {
  mode: MediaMode | null;
  files: Partial<Record<FileMode, RememberedFile>>;
  /** Resolves once the boot wipe of last visit's files has finished (or failed). */
  ready: Promise<void>;
}

const MODE_KEY = "visio.mediaMode.v1";

declare global {
  interface Window {
    /** Survives Vite HMR — reloading a module must not lose the open footage. */
    __visioMediaMemory?: MediaMemory;
    /** Preset-preview capture: keep each patch's authored Media file. */
    __visioPreferAuthoredMedia?: boolean;
    /** Survives HMR so a module reload does not wipe the live session's IDB. */
    __visioMediaBootCleared?: boolean;
  }
}

const memory: MediaMemory = (typeof window !== "undefined"
  ? window.__visioMediaMemory
  : undefined) ?? {
  mode: null,
  files: {},
  ready: Promise.resolve(),
};

if (typeof window !== "undefined") window.__visioMediaMemory = memory;

function writeStoredMode(mode: MediaMode | null): void {
  try {
    if (mode) localStorage.setItem(MODE_KEY, mode);
    else localStorage.removeItem(MODE_KEY);
  } catch {
    /* private mode / quota */
  }
}

function asMode(value: unknown): MediaMode | null {
  return value === "camera" || value === "image" || value === "video" || value === "audio"
    ? value
    : null;
}

function asFileMode(value: unknown): FileMode | null {
  const mode = asMode(value);
  return mode && mode !== "camera" ? mode : null;
}

function asFile(value: unknown): FileParam | null {
  if (!value || typeof value !== "object") return null;
  const file = value as FileParam;
  if (typeof file.url !== "string") return null;
  return file;
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

/** True once this tab has opened a source — boot must not wipe that. */
let sessionTouched = false;

/** Record a Media node's current source type, and its file under that type. */
export function rememberMedia(
  params: Record<string, unknown>,
  fileObj?: File | null,
): void {
  const mode = asMode(params.mode);
  if (mode) {
    sessionTouched = true;
    memory.mode = mode;
    writeStoredMode(mode);
  }
  if (!mode || mode === "camera") return;

  const file = asFile(params.file);
  if (!file) return;
  const previous = memory.files[mode];
  const nextObj = fileObj ?? file.fileObj;
  if (previous?.url === file.url) {
    // Same URL — still refresh fileObj if the picker just handed us one.
    if (nextObj && !previous.fileObj) {
      memory.files[mode] = { ...previous, fileObj: nextObj };
    }
    return;
  }
  memory.files[mode] = { ...file, fileObj: nextObj ?? undefined };
  if (previous) release(previous.url);

  // IndexedDB copy so a restore-on-reload can revive blob: files.
  void persistFileParam(mode, file, nextObj).catch(() => {
    /* ignore */
  });
}

/** The file last opened in this source type, if there was one. */
export function rememberedFile(mode: unknown): RememberedFile | null {
  const key = asMode(mode);
  if (!key || key === "camera") return null;
  return memory.files[key] ?? null;
}

/**
 * Media params for a patch being loaded.
 *
 * Always restore the remembered *file* for the node's authored mode (so a
 * dropped track survives preset switches). Only override `mode` itself when
 * the patch has a single Media node — multi-source presets (audio + image)
 * must keep each node's authored mode or the audio wire goes dead.
 */
export function recallMediaParams(
  params: Record<string, unknown>,
  opts?: { allowModeOverride?: boolean },
): Record<string, unknown> {
  if (
    preferAuthoredMedia ||
    (typeof window !== "undefined" && window.__visioPreferAuthoredMedia)
  ) {
    return params;
  }
  const patchMode = asMode(params.mode) ?? "image";
  const allowModeOverride = opts?.allowModeOverride !== false;
  const mode = allowModeOverride && memory.mode ? memory.mode : patchMode;
  const file = rememberedFile(mode);
  if (mode === patchMode && !file) return params;

  const next: Record<string, unknown> = { ...params, mode };
  if (file) next.file = file;
  // Switching type with nothing remembered for it: dropping the preset's file
  // is the point, or a video source would be left pointing at a PNG.
  else if (mode !== patchMode) next.file = null;
  return next;
}

/** Capture / export: use each patch's own Media file instead of session memory. */
let preferAuthoredMedia = false;

export function setPreferAuthoredMedia(next: boolean): void {
  preferAuthoredMedia = next;
  if (typeof window !== "undefined") window.__visioPreferAuthoredMedia = next;
}

/** Drop every remembered mode/file (selftest / session reset). */
export function clearMediaMemory(): void {
  for (const key of Object.keys(memory.files) as FileMode[]) {
    const previous = memory.files[key];
    delete memory.files[key];
    if (previous) release(previous.url);
  }
  memory.mode = null;
  writeStoredMode(null);
}

/**
 * Reset: forget everything, IndexedDB included, so a drop or template starts
 * without last session's footage.
 */
export function forgetAllMedia(): void {
  for (const mode of ["image", "video", "audio"] as FileMode[]) forgetMediaFile(mode);
  memory.mode = null;
  writeStoredMode(null);
}

/** Drop a remembered mode's file from memory + IndexedDB. */
export function forgetMediaFile(mode: unknown): void {
  const key = asFileMode(mode);
  if (!key) return;
  const previous = memory.files[key];
  delete memory.files[key];
  if (previous) release(previous.url);
  void deleteMediaFile(key).catch(() => {
    /* ignore */
  });
}

let hydrateStarted = false;

/**
 * Boot: wipe last visit's files when Reset-on-visit is on, otherwise revive
 * them from IndexedDB. Safe to call more than once — only the first call does
 * work. Returns the shared ready promise.
 */
export function hydrateMediaMemory(): Promise<void> {
  if (hydrateStarted) return memory.ready;
  hydrateStarted = true;

  if (typeof window === "undefined") {
    memory.ready = Promise.resolve();
    return memory.ready;
  }

  if (window.__visioMediaBootCleared) {
    memory.ready = Promise.resolve();
    return memory.ready;
  }

  memory.ready = (async () => {
    try {
      // A drop that landed before this ran must not be deleted or overwritten.
      if (sessionTouched) return;
      if (loadResetOnVisit()) {
        await clearAllMediaFiles();
        memory.mode = null;
        writeStoredMode(null);
      } else {
        const rows = await getAllMediaFiles();
        for (const row of rows) {
          const { param, fileObj } = reviveStoredFile(row);
          memory.files[row.mode] = { ...param, fileObj };
        }
        try {
          memory.mode = asMode(localStorage.getItem(MODE_KEY));
        } catch {
          /* private mode */
        }
      }
    } catch {
      /* private mode / blocked IDB — session memory still works */
    }
    window.__visioMediaBootCleared = true;
  })();

  return memory.ready;
}

/** True once hydrate has settled (success or failure). */
export function mediaMemoryReady(): Promise<void> {
  return memory.ready;
}

// Kick off as soon as the module loads — boot wipe should finish before a drop.
if (typeof window !== "undefined") hydrateMediaMemory();
