import { BUILTIN_PRESETS } from "../presets";
import { isOmitted } from "../presets/ship";
import { useGraphStore } from "../store/graphStore";
import { useMediaInfoStore } from "../store/mediaInfoStore";
import { setPreferAuthoredMedia } from "../store/mediaMemory";
import { useTimelineStore } from "../store/timelineStore";

export type PresetPreviewCapture = {
  id: string;
  label: string;
  /** JPEG data URL, thumbnail size (omitted when saved to disk). */
  dataUrl: string;
  /** True when the thumb was POSTed to the local vite writer. */
  saved?: boolean;
};

/** Display card is 160×284; capture at 4× for sharp thumbs on retina. */
const THUMB_W = 160 * 4;
const THUMB_H = 284 * 4;

/** Tracking models need longer to download + detect on a still. */
const TRACKING_PRESET_IDS = new Set([
  "track-objects",
  "track-face-mesh",
  "track-features",
  "track-features-points",
  "features-tracking",
  "track-hough-circles",
  "track-hough-lines",
  "features-connectors",
  "features-voronoi",
  "features-delaunay",
  "features-mst",
  "features-radial",
  "features-particles",
  "corners-features-grid",
]);

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function waitFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    let left = count;
    const tick = () => {
      left -= 1;
      if (left <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Ensure the preset's Media still has decoded before we grab a thumb. */
async function waitForPresetImage(timeoutMs = 5000): Promise<void> {
  const media = useGraphStore
    .getState()
    .nodes.find((node) => node.data.defType === "source.media");
  if (!media) return;
  const file = media.data.params.file as { url?: string; name?: string } | undefined;
  const url = typeof file?.url === "string" ? file.url : null;
  const name = typeof file?.name === "string" ? file.name : null;
  if (url) {
    await new Promise<void>((resolve) => {
      const img = new Image();
      const done = () => resolve();
      const timer = window.setTimeout(done, timeoutMs);
      img.onload = () => {
        window.clearTimeout(timer);
        done();
      };
      img.onerror = () => {
        window.clearTimeout(timer);
        done();
      };
      img.src = url;
    });
  }
  // Engine status flips to ready + filename only after the texture upload.
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const status = useGraphStore.getState().statuses[media.id];
    const info = useMediaInfoStore.getState().byId?.[media.id];
    const statusOk = status?.status === "ready" && (!name || status.message === name);
    const infoOk = !name || info?.name === name;
    if (statusOk && infoOk) return;
    await waitMs(50);
  }
}

/** Downscale the output canvas to a small JPEG for the presets picker. */
export function canvasToPresetThumb(canvas: HTMLCanvasElement): string {
  const thumb = document.createElement("canvas");
  thumb.width = THUMB_W;
  thumb.height = THUMB_H;
  const ctx = thumb.getContext("2d");
  if (!ctx) return canvas.toDataURL("image/jpeg", 0.82);
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, THUMB_W, THUMB_H);
  const srcW = canvas.width || 1;
  const srcH = canvas.height || 1;
  const scale = Math.max(THUMB_W / srcW, THUMB_H / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  ctx.drawImage(canvas, (THUMB_W - dw) / 2, (THUMB_H - dh) / 2, dw, dh);
  return thumb.toDataURL("image/jpeg", 0.82);
}

/** Cheap fingerprint so we can tell when the preview actually swapped. */
function canvasFingerprint(canvas: HTMLCanvasElement): string {
  const probe = document.createElement("canvas");
  probe.width = 32;
  probe.height = 32;
  const ctx = probe.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(canvas, 0, 0, 32, 32);
  const { data } = ctx.getImageData(0, 0, 32, 32);
  let hash = 0;
  for (let i = 0; i < data.length; i += 17) hash = (hash * 33 + data[i]!) >>> 0;
  return hash.toString(16);
}

async function saveThumbToDevServer(id: string, dataUrl: string): Promise<boolean> {
  try {
    const res = await fetch("/__save-preset-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, dataUrl }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Grab the live output as this builtin's picker thumb. Does not reload the graph. */
export async function recapturePresetPreview(id: string): Promise<boolean> {
  const canvas = window.__visioPreviewCanvas;
  if (!canvas) return false;
  await waitFrames(8);
  return saveThumbToDevServer(id, canvasToPresetThumb(canvas));
}

/**
 * Load every builtin preset, settle a few frames, and return JPEG thumbs.
 * In `vite` dev, each thumb is also written to `public/presets/<id>.jpg`.
 * Uses each preset's authored Media still (not session camera/file memory).
 */
export async function captureBuiltinPresetPreviews(
  canvas: HTMLCanvasElement,
  opts?: { settleMs?: number; ids?: string[]; save?: boolean },
): Promise<PresetPreviewCapture[]> {
  const settleMs = opts?.settleMs ?? 1200;
  const save = opts?.save !== false;
  // Hidden / omitted presets have no card in the production picker; asking for
  // one by id still works, for the session that ships it again.
  const wanted = opts?.ids?.length
    ? BUILTIN_PRESETS.filter((preset) => opts.ids!.includes(preset.id))
    : BUILTIN_PRESETS.filter((preset) => !isOmitted(preset.id));
  const out: PresetPreviewCapture[] = [];
  const graph = useGraphStore.getState();

  setPreferAuthoredMedia(true);
  let previousFp = "";
  try {
    for (const preset of wanted) {
      graph.loadPreset(preset.id);
      await waitForPresetImage();
      // Mid-timeline for keyed / modulated demos so the thumb isn't the idle start.
      const timeline = useTimelineStore.getState();
      if (preset.id === "keyframed-zoom" || preset.id === "modulated-slice") {
        timeline.seek(Math.round(timeline.durationInFrames * 0.35));
      } else {
        timeline.seek(0);
      }
      const wait = TRACKING_PRESET_IDS.has(preset.id)
        ? Math.max(settleMs, 3200)
        : settleMs;
      await waitMs(wait);
      await waitFrames(16);
      // Media texture can lag one preset behind; wait until the pixels change.
      let fp = canvasFingerprint(canvas);
      for (let i = 0; i < 40 && previousFp !== "" && fp === previousFp; i += 1) {
        await waitMs(200);
        await waitFrames(4);
        fp = canvasFingerprint(canvas);
      }
      previousFp = fp;
      const dataUrl = canvasToPresetThumb(canvas);
      const saved = save ? await saveThumbToDevServer(preset.id, dataUrl) : false;
      out.push({
        id: preset.id,
        label: preset.label,
        dataUrl: save ? "" : dataUrl,
        saved,
      });
    }
  } finally {
    setPreferAuthoredMedia(false);
  }

  return out;
}

declare global {
  interface Window {
    __visioCapturePresetPreviews?: (
      opts?: { settleMs?: number; ids?: string[]; save?: boolean },
    ) => Promise<PresetPreviewCapture[]>;
    __visioPreviewCanvas?: HTMLCanvasElement | null;
  }
}

/** Register the capture entry-point used by the local browser automation. */
export function bindPresetPreviewCapture(canvas: HTMLCanvasElement | null): void {
  window.__visioPreviewCanvas = canvas;
  window.__visioCapturePresetPreviews = async (opts) => {
    const target = window.__visioPreviewCanvas;
    if (!target) throw new Error("preview canvas is not ready");
    return captureBuiltinPresetPreviews(target, opts);
  };
}
