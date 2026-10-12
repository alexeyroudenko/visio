/**
 * Offline Render container format. MP4 (H.264 via WebCodecs) is the default —
 * widest sharing compatibility; WebM remains as a fallback / preference.
 */
const STORAGE_KEY = "visio.renderFormat.v1";

export type RenderFormat = "mp4" | "webm";

export const DEFAULT_RENDER_FORMAT: RenderFormat = "mp4";

export function isRenderFormat(value: unknown): value is RenderFormat {
  return value === "mp4" || value === "webm";
}

export function loadRenderFormat(): RenderFormat {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (isRenderFormat(raw)) return raw;
  } catch {
    /* private mode / blocked storage */
  }
  return DEFAULT_RENDER_FORMAT;
}

export function saveRenderFormat(format: RenderFormat): RenderFormat {
  const next = isRenderFormat(format) ? format : DEFAULT_RENDER_FORMAT;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  return next;
}
