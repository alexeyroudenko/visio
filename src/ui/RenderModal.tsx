import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatBitrate, loadRenderBitrate } from "../lib/renderBitrate";
import {
  DEFAULT_RENDER_FPS,
  loadRenderFps,
  saveRenderFps,
} from "../lib/renderFps";
import {
  DEFAULT_RENDER_FORMAT,
  type RenderFormat,
  loadRenderFormat,
  saveRenderFormat,
} from "../lib/renderFormat";
import { useGraphStore } from "../store/graphStore";
import { resolveRenderRange, useTimelineStore } from "../store/timelineStore";

const RENDER_FPS_PRESETS = [60, 30, 24] as const;

export interface RenderStartOptions {
  format: RenderFormat;
  outputFps: number;
  startFrame: number;
  endFrame: number;
}

export function RenderModal({
  open,
  onClose,
  rendering,
  renderProgress,
  onStart,
  onCancel,
}: {
  open: boolean;
  onClose: () => void;
  rendering: boolean;
  renderProgress: number;
  onStart: (options: RenderStartOptions) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const width = useGraphStore((state) => state.width);
  const height = useGraphStore((state) => state.height);
  const durationInFrames = useTimelineStore((state) => state.durationInFrames);
  const timelineFps = useTimelineStore((state) => state.fps);
  const currentFrame = useTimelineStore((state) => Math.round(state.currentFrame));
  const renderInFrame = useTimelineStore((state) => state.renderInFrame);
  const renderOutFrame = useTimelineStore((state) => state.renderOutFrame);
  const setRenderIn = useTimelineStore((state) => state.setRenderIn);
  const setRenderOut = useTimelineStore((state) => state.setRenderOut);
  const clearRenderRange = useTimelineStore((state) => state.clearRenderRange);

  const [format, setFormat] = useState<RenderFormat>(() => loadRenderFormat());
  const [outputFps, setOutputFps] = useState(() => loadRenderFps());
  const [startFrame, setStartFrame] = useState(0);
  const [endFrame, setEndFrame] = useState(durationInFrames);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFormat(loadRenderFormat());
    setOutputFps(loadRenderFps());
    setError(null);
    const range = resolveRenderRange(durationInFrames, renderInFrame, renderOutFrame);
    setStartFrame(range.startFrame);
    setEndFrame(range.endFrame);
  }, [open, durationInFrames, renderInFrame, renderOutFrame]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !rendering) onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, rendering]);

  const maxFrame = Math.max(0, durationInFrames);
  const safeStart = Math.max(0, Math.min(Math.round(startFrame), Math.max(0, maxFrame)));
  const safeEnd = Math.max(
    safeStart,
    Math.min(Math.round(endFrame), maxFrame),
  );
  const rangeFrames = Math.max(1, safeEnd - safeStart + 1);
  const rangeSec = (rangeFrames / Math.max(1, timelineFps)).toFixed(1);
  const bitrate = loadRenderBitrate();
  const fpsPresetMatch = RENDER_FPS_PRESETS.includes(
    outputFps as (typeof RENDER_FPS_PRESETS)[number],
  );

  const summary = useMemo(
    () =>
      `${width}×${height} · ${format.toUpperCase()} · ${outputFps} fps · ${formatBitrate(bitrate)}`,
    [bitrate, format, height, outputFps, width],
  );

  if (!open) return null;

  const commitStart = (frame: number) => {
    const next = Math.max(0, Math.min(Math.round(frame), maxFrame));
    setStartFrame(next);
    setRenderIn(next);
  };

  const commitEnd = (frame: number) => {
    const next = Math.max(0, Math.min(Math.round(frame), maxFrame));
    setEndFrame(next);
    setRenderOut(next);
  };

  const runExport = () => {
    setError(null);
    const nextFormat = saveRenderFormat(format);
    const nextFps = saveRenderFps(outputFps);
    setFormat(nextFormat);
    setOutputFps(nextFps);
    if (safeStart === 0 && safeEnd === maxFrame) {
      clearRenderRange();
    } else {
      setRenderIn(safeStart);
      setRenderOut(safeEnd);
    }
    try {
      onStart({
        format: nextFormat,
        outputFps: nextFps,
        startFrame: safeStart,
        endFrame: safeEnd,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Render failed");
    }
  };

  return createPortal(
    <div
      className="modal-backdrop modal-backdrop--render"
      onClick={() => {
        if (!rendering) onClose();
      }}
      role="presentation"
    >
      <div
        className="modal modal--render"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__header">
          <h2 id={titleId}>Render video</h2>
          <button
            type="button"
            className="button button--small"
            onClick={onClose}
            disabled={rendering}
          >
            Close
          </button>
        </header>

        <div className="modal__body">
          <p className="modal__hint modal__hint--lead">{summary}</p>

          <label className="modal__field">
            <span>Format</span>
            <select
              className="select"
              value={format}
              disabled={rendering}
              onChange={(event) => setFormat(event.target.value as RenderFormat)}
            >
              <option value="mp4">MP4 (WebCodecs)</option>
              <option value="webm">WebM</option>
            </select>
          </label>
          <p className="modal__hint">
            Default {DEFAULT_RENDER_FORMAT.toUpperCase()}. MP4 is best for sharing; WebM stays
            as a browser-native fallback.
          </p>

          <label className="modal__field">
            <span>Frame rate</span>
            <select
              className="select"
              value={fpsPresetMatch ? String(outputFps) : "custom"}
              disabled={rendering}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "custom") {
                  const typed = window.prompt("Render fps", String(outputFps));
                  if (typed == null) return;
                  setOutputFps(saveRenderFps(Number(typed)));
                  return;
                }
                setOutputFps(saveRenderFps(Number(value)));
              }}
            >
              {RENDER_FPS_PRESETS.map((value) => (
                <option key={value} value={value}>
                  {value} fps
                </option>
              ))}
              <option value="custom">
                {fpsPresetMatch ? "custom…" : `${outputFps} fps`}
              </option>
            </select>
          </label>
          <p className="modal__hint">
            Output fps (default {DEFAULT_RENDER_FPS}). Timeline stays at {timelineFps} fps.
          </p>

          <div className="modal__field-row">
            <label className="modal__field">
              <span>Start frame</span>
              <input
                className="input"
                type="number"
                min={0}
                max={maxFrame}
                step={1}
                disabled={rendering}
                value={safeStart}
                onChange={(event) => commitStart(Number(event.target.value))}
              />
            </label>
            <label className="modal__field">
              <span>End frame</span>
              <input
                className="input"
                type="number"
                min={0}
                max={maxFrame}
                step={1}
                disabled={rendering}
                value={safeEnd}
                onChange={(event) => commitEnd(Number(event.target.value))}
              />
            </label>
          </div>
          <p className="modal__hint">
            Range F{safeStart}–F{safeEnd} ({rangeFrames} tl-frames · {rangeSec}s). End is
            inclusive.
          </p>
          <div className="modal__footer-row modal__footer-row--tight">
            <button
              type="button"
              className="button button--small"
              disabled={rendering}
              onClick={() => commitStart(currentFrame)}
            >
              Start = playhead
            </button>
            <button
              type="button"
              className="button button--small"
              disabled={rendering}
              onClick={() => commitEnd(currentFrame)}
            >
              End = playhead
            </button>
            <button
              type="button"
              className="button button--small"
              disabled={rendering}
              onClick={() => {
                clearRenderRange();
                setStartFrame(0);
                setEndFrame(maxFrame);
              }}
            >
              Full
            </button>
          </div>

          {rendering ? (
            <div className="render-progress" aria-live="polite">
              <div className="render-progress__track">
                <div
                  className="render-progress__bar"
                  style={{ width: `${Math.round(renderProgress * 100)}%` }}
                />
              </div>
              <p className="modal__hint">
                Rendering… {Math.round(renderProgress * 100)}%
              </p>
            </div>
          ) : null}

          {error ? <p className="modal__status modal__status--error">{error}</p> : null}
        </div>

        <footer className="modal__footer">
          {rendering ? (
            <button type="button" className="button button--recording" onClick={onCancel}>
              Cancel {Math.round(renderProgress * 100)}%
            </button>
          ) : (
            <>
              <button type="button" className="button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="button button--render"
                disabled={rangeFrames < 1}
                onClick={runExport}
              >
                Download
              </button>
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
