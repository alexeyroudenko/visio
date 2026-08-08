/**
 * Live preview render scale. Patch resolution stays full; the engine runs at
 * width×quality × height×quality so a lower setting is cheaper to draw.
 * Offline Render / Record ignore this and use the patch size.
 */
const STORAGE_KEY = "visio.previewQuality.v1";

export const PREVIEW_QUALITY_OPTIONS = [
  { value: 1, label: "1 — full", factor: 1 },
  { value: 0.5, label: "0.5 — ½", factor: 2 },
  { value: 0.25, label: "0.25 — ¼", factor: 3 },
  { value: 0.125, label: "0.125 — ⅛", factor: 4 },
] as const;

export type PreviewQuality = (typeof PREVIEW_QUALITY_OPTIONS)[number]["value"];

export const DEFAULT_PREVIEW_QUALITY: PreviewQuality = 1;

const listeners = new Set<() => void>();

export function clampPreviewQuality(value: number): PreviewQuality {
  const hit = PREVIEW_QUALITY_OPTIONS.find((o) => Math.abs(o.value - value) < 1e-6);
  return hit?.value ?? DEFAULT_PREVIEW_QUALITY;
}

export function loadPreviewQuality(): PreviewQuality {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return DEFAULT_PREVIEW_QUALITY;
    return clampPreviewQuality(Number(raw));
  } catch {
    return DEFAULT_PREVIEW_QUALITY;
  }
}

export function savePreviewQuality(quality: number): PreviewQuality {
  const next = clampPreviewQuality(quality);
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    /* private mode / quota */
  }
  for (const listener of listeners) listener();
  return next;
}

export function subscribePreviewQuality(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Engine buffer size for live preview at the current quality. */
export function previewRenderSize(
  width: number,
  height: number,
  quality: number = loadPreviewQuality(),
): { width: number; height: number } {
  const q = clampPreviewQuality(quality);
  return {
    width: Math.max(1, Math.round(width * q)),
    height: Math.max(1, Math.round(height * q)),
  };
}
