import { useCallback, useEffect, useRef, useState } from "react";
import { CATEGORY_LABELS, NODE_LIST } from "../nodes/registry";
import { isNodeLocked, isNodeOmitted, setNodeShipped } from "../nodes/ship";
import { APP_VERSION_LABEL } from "../lib/appVersion";
import { loadRenderBitrate, saveRenderBitrate } from "../lib/renderBitrate";
import { loadRenderFps, saveRenderFps } from "../lib/renderFps";
import { useEngineStatsStore } from "../store/engineStatsStore";
import { useGraphStore } from "../store/graphStore";
import { useTimelineStore } from "../store/timelineStore";
import { PresetsModal } from "./PresetsModal";
import { SettingsModal } from "./SettingsModal";

const RESOLUTIONS = [
  { label: "1080×1920", width: 1080, height: 1920 },
  { label: "720×1280", width: 720, height: 1280 },
  { label: "360×640", width: 360, height: 640 },
  { label: "1080×1350", width: 1080, height: 1350 },
  { label: "1920×1080", width: 1920, height: 1080 },
  { label: "1280×720", width: 1280, height: 720 },
];

const CATEGORY_ORDER = ["source", "tracking", "draw", "fx", "audio", "output"];

export function Toolbar({
  recording,
  onToggleRecord,
  rendering,
  renderProgress,
  onToggleRender,
  renderingImage = false,
  onRenderImage,
  paused,
  onTogglePause,
  hideRecord = false,
  presetNudge = 0,
  openPresetsTick = 0,
  chromeHint = false,
  onChromeHintAck,
  onPresetsGateClose,
}: {
  recording: boolean;
  onToggleRecord: () => void;
  rendering: boolean;
  renderProgress: number;
  onToggleRender: () => void;
  renderingImage?: boolean;
  onRenderImage?: () => void;
  paused: boolean;
  onTogglePause: () => void;
  /** Portrait shell puts Record on the bottom shutter — hide the toolbar twin. */
  hideRecord?: boolean;
  /** Increment after an empty-graph drop: blink Presets 1s, then open the modal. */
  presetNudge?: number;
  /** Increment to open the preset grid immediately (welcome +). */
  openPresetsTick?: number;
  /** First-run tour: blink +Node / Presets / Render. */
  chromeHint?: boolean;
  onChromeHintAck?: () => void;
  /** Fires when that gated modal closes — caller resumes playback. */
  onPresetsGateClose?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [shipTick, setShipTick] = useState(0);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [presetsBlinking, setPresetsBlinking] = useState(false);
  const [presetsGated, setPresetsGated] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renderFps, setRenderFpsState] = useState(() => loadRenderFps());
  const [renderBitrate, setRenderBitrateState] = useState(() => loadRenderBitrate());
  const nudgeTimer = useRef(0);
  const fps = useEngineStatsStore((state) => state.fps);
  const frameMs = useEngineStatsStore((state) => state.frameMs);
  const nodeCount = useEngineStatsStore((state) => state.nodeCount);
  const timelineFrame = useTimelineStore((state) => Math.round(state.currentFrame));
  const renderInFrame = useTimelineStore((state) => state.renderInFrame);
  const renderOutFrame = useTimelineStore((state) => state.renderOutFrame);
  const addNode = useGraphStore((state) => state.addNode);
  const width = useGraphStore((state) => state.width);
  const height = useGraphStore((state) => state.height);
  const setResolution = useGraphStore((state) => state.setResolution);
  const closePresets = useCallback(() => {
    setPresetsOpen(false);
    setPresetsBlinking(false);
    if (presetsGated) {
      setPresetsGated(false);
      onPresetsGateClose?.();
    }
  }, [onPresetsGateClose, presetsGated]);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  useEffect(() => {
    if (!presetNudge) return;
    setPresetsBlinking(true);
    window.clearTimeout(nudgeTimer.current);
    nudgeTimer.current = window.setTimeout(() => {
      setPresetsBlinking(false);
      setPresetsGated(true);
      setPresetsOpen(true);
    }, 1000);
    return () => window.clearTimeout(nudgeTimer.current);
  }, [presetNudge]);

  useEffect(() => {
    if (!openPresetsTick) return;
    window.clearTimeout(nudgeTimer.current);
    setPresetsBlinking(false);
    setPresetsOpen(true);
  }, [openPresetsTick]);

  const commitRenderFps = useCallback((value: number) => {
    setRenderFpsState(saveRenderFps(value));
  }, []);

  const commitRenderBitrate = useCallback((value: number) => {
    setRenderBitrateState(saveRenderBitrate(value));
  }, []);

  const resolutionValue = `${width}x${height}`;
  const resolutionKnown = RESOLUTIONS.some(
    (item) => `${item.width}x${item.height}` === resolutionValue,
  );
  const menuNodes = import.meta.env.DEV
    ? NODE_LIST
    : NODE_LIST.filter((definition) => !isNodeOmitted(definition.type));

  return (
    <>
      <header className="toolbar">
        <div className="toolbar__brand">
          <strong>visio</strong>
          <span>node environment · tracking → graphics</span>
        </div>

        <div className="toolbar__actions">
          <button
            type="button"
            className="button"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Settings"
          >
            ☰
          </button>

          <div className="menu">
            <button
              type="button"
              className={`button${chromeHint ? " button--hint" : ""}`}
              onClick={() => {
                onChromeHintAck?.();
                setMenuOpen((open) => !open);
              }}
            >
              + Node
            </button>
            {menuOpen ? (
              <div
                className="menu__panel"
                data-ship={shipTick}
                onMouseLeave={() => setMenuOpen(false)}
              >
                {CATEGORY_ORDER.map((category) => {
                  const nodes = menuNodes.filter((definition) => definition.category === category);
                  if (nodes.length === 0) return null;
                  return (
                    <section key={category}>
                      <h4>{CATEGORY_LABELS[category]}</h4>
                      {nodes.map((definition) => {
                        const omitted = isNodeOmitted(definition.type);
                        const locked = isNodeLocked(definition.type);
                        return (
                          <div
                            key={definition.type}
                            className={`menu__row${omitted ? " menu__row--omitted" : ""}`}
                          >
                            {import.meta.env.DEV ? (
                              <label
                                className="menu__ship"
                                title={
                                  locked
                                    ? "Media and Output always ship"
                                    : omitted
                                      ? "Unchecked: left out of the production build"
                                      : "Checked: included in the production build"
                                }
                                onClick={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                              >
                                <input
                                  type="checkbox"
                                  checked={!omitted}
                                  disabled={locked}
                                  aria-label={`Include ${definition.label} in the production build`}
                                  onChange={async (event) => {
                                    const ship = event.target.checked;
                                    const ok = await setNodeShipped(definition.type, ship);
                                    if (!ok) event.target.checked = !ship;
                                    setShipTick((tick) => tick + 1);
                                  }}
                                />
                              </label>
                            ) : null}
                            <button
                              type="button"
                              className="menu__item"
                              onClick={() => {
                                // Drop new nodes in a loose diagonal so they never stack exactly.
                                addNode(definition.type, {
                                  x: 120 + Math.random() * 320,
                                  y: 80 + Math.random() * 320,
                                });
                                setMenuOpen(false);
                              }}
                            >
                              <span>{definition.label}</span>
                              <em>{definition.description}</em>
                            </button>
                          </div>
                        );
                      })}
                    </section>
                  );
                })}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            className={`button button--render${presetsBlinking ? " button--nudge" : ""}${chromeHint ? " button--hint" : ""}`}
            onClick={() => {
              onChromeHintAck?.();
              window.clearTimeout(nudgeTimer.current);
              if (presetsBlinking) setPresetsGated(true);
              setPresetsBlinking(false);
              setPresetsOpen(true);
            }}
            title="Load a preset patch · export / import / reset"
          >
            Presets
          </button>

          <select
            className="select"
            value={resolutionKnown ? resolutionValue : ""}
            onChange={(event) => {
              const preset = RESOLUTIONS.find(
                (item) => `${item.width}x${item.height}` === event.target.value,
              );
              if (preset) setResolution(preset.width, preset.height);
            }}
          >
            {!resolutionKnown ? (
              <option value="" disabled>
                {width}×{height}
              </option>
            ) : null}
            {RESOLUTIONS.map((preset) => (
              <option key={preset.label} value={`${preset.width}x${preset.height}`}>
                {preset.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            className={`button ${paused ? "button--paused" : ""}`}
            onClick={onTogglePause}
            disabled={rendering || renderingImage}
            title={
              paused
                ? "Play — resume the graph and sources (Space)"
                : "Pause — stop rAF, camera, and video (Space)"
            }
          >
            {paused ? "► Play" : "❚❚ Pause"}
          </button>

          {!hideRecord ? (
            <button
              type="button"
              className={`button ${recording ? "button--recording" : ""}`}
              onClick={onToggleRecord}
              disabled={paused || rendering || renderingImage}
              title="Realtime capture of the output canvas"
            >
              {recording ? "■ Stop" : "● Record"}
            </button>
          ) : null}

          <button
            type="button"
            className={`button button--render ${rendering ? "button--recording" : ""}${chromeHint ? " button--hint" : ""}`}
            onClick={() => {
              onChromeHintAck?.();
              onToggleRender();
            }}
            disabled={recording || renderingImage}
            title={
              renderInFrame != null && renderOutFrame != null
                ? `Offline Render video F${Math.min(renderInFrame, renderOutFrame)}–F${Math.max(renderInFrame, renderOutFrame)} @ ${renderFps} fps`
                : `Offline frame-by-frame timeline export @ ${renderFps} fps (not realtime)`
            }
          >
            {rendering ? `■ Cancel ${Math.round(renderProgress * 100)}%` : "Render video"}
          </button>

          <button
            type="button"
            className="button button--render"
            onClick={onRenderImage}
            disabled={recording || rendering || renderingImage || !onRenderImage}
            title={`PNG of the playhead frame at patch ${width}×${height} (not preview quality)`}
          >
            {renderingImage ? "Saving…" : "Render image"}
          </button>
        </div>

        <PresetsModal open={presetsOpen} onClose={closePresets} />
        <SettingsModal
          open={settingsOpen}
          onClose={closeSettings}
          renderFps={renderFps}
          onRenderFpsChange={commitRenderFps}
          renderBitrate={renderBitrate}
          onRenderBitrateChange={commitRenderBitrate}
        />
      </header>

      <div className="toolbar__stats" aria-live="polite">
        <span className="toolbar__stats-ver">{APP_VERSION_LABEL}</span>
        {" · "}
        {rendering
          ? `rendering · F${timelineFrame} · ${Math.round(renderProgress * 100)}%`
          : renderingImage
            ? `still · F${timelineFrame} · ${width}×${height}`
            : paused
            ? "paused · resources stopped"
            : `${fps} fps · ${frameMs} ms · ${nodeCount} nodes`}
      </div>
    </>
  );
}
