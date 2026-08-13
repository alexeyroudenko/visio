import { useEffect, useId, useRef, useState } from "react";
import {
  loadPreviewQuality,
  PREVIEW_QUALITY_OPTIONS,
  savePreviewQuality,
  type PreviewQuality,
} from "../lib/previewQuality";
import {
  DEFAULT_RENDER_BITRATE,
  formatBitrate,
  MAX_RENDER_BITRATE,
  MIN_RENDER_BITRATE,
  saveRenderBitrate,
} from "../lib/renderBitrate";
import {
  DEFAULT_RENDER_FPS,
  MAX_RENDER_FPS,
  MIN_RENDER_FPS,
  saveRenderFps,
} from "../lib/renderFps";
import { promptInstall, useInstallState } from "../lib/pwa";

const RENDER_FPS_PRESETS = [60, 30, 24] as const;
const RENDER_BITRATE_PRESETS = [4, 8, 12, 20, 40, 80].map((mbps) => mbps * 1_000_000);

export function SettingsModal({
  open,
  onClose,
  renderFps,
  onRenderFpsChange,
  renderBitrate,
  onRenderBitrateChange,
}: {
  open: boolean;
  onClose: () => void;
  renderFps: number;
  onRenderFpsChange: (fps: number) => void;
  renderBitrate: number;
  onRenderBitrateChange: (bps: number) => void;
}) {
  const [quality, setQuality] = useState<PreviewQuality>(() => loadPreviewQuality());
  const install = useInstallState();
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
  const bitratePresetMatch = RENDER_BITRATE_PRESETS.includes(renderBitrate);

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

          <label className="modal__field">
            <span>Render bitrate</span>
            <select
              className="select"
              value={bitratePresetMatch ? String(renderBitrate) : "custom"}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "custom") {
                  const typed = window.prompt(
                    `Render bitrate in Mbps (${MIN_RENDER_BITRATE / 1_000_000}–${
                      MAX_RENDER_BITRATE / 1_000_000
                    })`,
                    String(renderBitrate / 1_000_000),
                  );
                  if (typed == null) return;
                  onRenderBitrateChange(saveRenderBitrate(Number(typed) * 1_000_000));
                  return;
                }
                onRenderBitrateChange(saveRenderBitrate(Number(value)));
              }}
            >
              {RENDER_BITRATE_PRESETS.map((value) => (
                <option key={value} value={value}>
                  {formatBitrate(value)}
                </option>
              ))}
              <option value="custom">
                {bitratePresetMatch ? "custom…" : formatBitrate(renderBitrate)}
              </option>
            </select>
          </label>
          <p className="modal__hint">
            Video bitrate for Record and offline Render (default{" "}
            {formatBitrate(DEFAULT_RENDER_BITRATE)}). Higher keeps more detail in grain and fast
            motion at the cost of file size.
          </p>

          <div className="modal__field">
            <span>Install as app</span>
            {install.canPrompt ? (
              <button type="button" className="button" onClick={() => void promptInstall()}>
                Install visio
              </button>
            ) : null}
          </div>
          <p className="modal__hint">
            {install.installed
              ? "Running as an installed app. The shell is cached, so it opens offline — media and MediaPipe models still need the network on first use."
              : install.canPrompt
                ? "Puts visio on the desktop or home screen and runs it in its own window, without browser chrome."
                : install.ios
                  ? "iPhone / iPad: open the Share menu and pick “Add to Home Screen”. Works from Chrome and Safari alike — both use WebKit."
                  : "Chrome and Edge put an install icon in the address bar once the page has been open for a moment. Desktop Safari and Firefox don’t install web apps."}
          </p>
        </div>
      </div>
    </div>
  );
}
