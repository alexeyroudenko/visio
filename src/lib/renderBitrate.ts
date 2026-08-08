/**
 * Video bitrate for Record and offline Render, in bits per second. Kept apart
 * from render fps: doubling the frame rate does not buy more data on its own,
 * so the two dials have to be set independently.
 */
const STORAGE_KEY = "visio.renderBitrate.v1";

export const DEFAULT_RENDER_BITRATE = 12_000_000;
export const MIN_RENDER_BITRATE = 500_000;
export const MAX_RENDER_BITRATE = 200_000_000;

export function clampRenderBitrate(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RENDER_BITRATE;
  return Math.min(MAX_RENDER_BITRATE, Math.max(MIN_RENDER_BITRATE, Math.round(value)));
}

export function loadRenderBitrate(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return DEFAULT_RENDER_BITRATE;
    return clampRenderBitrate(Number(raw));
  } catch {
    return DEFAULT_RENDER_BITRATE;
  }
}

export function saveRenderBitrate(bps: number): number {
  const next = clampRenderBitrate(bps);
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    /* private mode / quota */
  }
  return next;
}

/** `12_000_000` → `12 Mbps`; keeps one decimal for values like 2.5 Mbps. */
export function formatBitrate(bps: number): string {
  const mbps = bps / 1_000_000;
  return `${Number.isInteger(mbps) ? mbps : mbps.toFixed(1)} Mbps`;
}
