/**
 * Offline Render output frame rate. Separate from timeline fps (keyframes /
 * playhead): the export can upsample a 30 fps timeline to a 60 fps file.
 */
const STORAGE_KEY = "visio.renderFps.v1";

export const DEFAULT_RENDER_FPS = 60;
export const MIN_RENDER_FPS = 1;
export const MAX_RENDER_FPS = 120;

export function clampRenderFps(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RENDER_FPS;
  return Math.min(MAX_RENDER_FPS, Math.max(MIN_RENDER_FPS, Math.round(value)));
}

export function loadRenderFps(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return DEFAULT_RENDER_FPS;
    return clampRenderFps(Number(raw));
  } catch {
    return DEFAULT_RENDER_FPS;
  }
}

export function saveRenderFps(fps: number): number {
  const next = clampRenderFps(fps);
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    /* private mode / quota */
  }
  return next;
}
