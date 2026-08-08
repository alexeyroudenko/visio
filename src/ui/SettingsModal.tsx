import { useEffect, useId, useRef, useState } from "react";
import {
  loadPreviewQuality,
  PREVIEW_QUALITY_OPTIONS,
  savePreviewQuality,
  type PreviewQuality,
} from "../lib/previewQuality";
import {
  DEFAULT_RENDER_FPS,
  MAX_RENDER_FPS,
  MIN_RENDER_FPS,
  saveRenderFps,
} from "../lib/renderFps";

const RENDER_FPS_PRESETS = [60, 30, 24] as const;

export function SettingsModal({
  open,
  onClose,
  renderFps,
  onRenderFpsChange,
}: {
  open: boolean;
  onClose: () => void;
  renderFps: number;
  onRenderFpsChange: (fps: number) => void;
}) {
  const [quality, setQuality] = useState<PreviewQuality>(() => loadPreviewQuality());
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    setQuality(loadPreviewQuality());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const presetMatch = RENDER_FPS_PRESETS.includes(
    renderFps as (typeof RENDER_FPS_PRESETS)[number],
  );

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal modal--settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__header">
          <h2 id={titleId}>Settings</h2>
          <button type="button" className="button button--small" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="modal__body">
          <label className="modal__field">
            <span>Preview quality</span>
            <select
              className="select"
              value={String(quality)}
              onChange={(event) => {
                const next = savePreviewQuality(Number(event.target.value));
                setQuality(next);
              }}
            >
              {PREVIEW_QUALITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <p className="modal__hint">
            Scales the live WebGL buffer (1 = patch size; 0.5 / 0.25 / 0.125 → ½ / ¼ / ⅛).
            Speeds up preview; Record and offline Render stay at full resolution.
          </p>

          <label className="modal__field">
            <span>Render fps</span>
            <select
              className="select"
              value={presetMatch ? String(renderFps) : "custom"}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "custom") {
                  const typed = window.prompt(
                    `Render fps (${MIN_RENDER_FPS}–${MAX_RENDER_FPS})`,
                    String(renderFps),
                  );
                  if (typed == null) return;
                  onRenderFpsChange(saveRenderFps(Number(typed)));
                  return;
                }
                onRenderFpsChange(saveRenderFps(Number(value)));
              }}
            >
              {RENDER_FPS_PRESETS.map((value) => (
                <option key={value} value={value}>
                  {value} fps
                </option>
              ))}
              <option value="custom">
                {presetMatch ? "custom…" : `${renderFps} fps`}
              </option>
            </select>
          </label>
          <p className="modal__hint">
            Offline Render output frame rate (default {DEFAULT_RENDER_FPS}). Timeline fps stays
            separate — a 30 fps edit can still export at {renderFps} fps.
          </p>
        </div>
      </div>
    </div>
  );
}
