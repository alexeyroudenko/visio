import { useCallback, useState } from "react";
import { CATEGORY_LABELS, NODE_LIST } from "../nodes/registry";
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
  paused,
  onTogglePause,
  hideRecord = false,
}: {
  recording: boolean;
  onToggleRecord: () => void;
  rendering: boolean;
  renderProgress: number;
  onToggleRender: () => void;
  paused: boolean;
  onTogglePause: () => void;
  /** Portrait shell puts Record on the bottom shutter — hide the toolbar twin. */
  hideRecord?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renderFps, setRenderFpsState] = useState(() => loadRenderFps());
  const fps = useEngineStatsStore((state) => state.fps);
  const frameMs = useEngineStatsStore((state) => state.frameMs);
  const nodeCount = useEngineStatsStore((state) => state.nodeCount);
  const timelineFrame = useTimelineStore((state) => Math.round(state.currentFrame));
  const addNode = useGraphStore((state) => state.addNode);
  const width = useGraphStore((state) => state.width);
  const height = useGraphStore((state) => state.height);
  const setResolution = useGraphStore((state) => state.setResolution);
  const closePresets = useCallback(() => setPresetsOpen(false), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const commitRenderFps = useCallback((value: number) => {
    setRenderFpsState(saveRenderFps(value));
  }, []);

  const resolutionValue = `${width}x${height}`;
  const resolutionKnown = RESOLUTIONS.some(
    (item) => `${item.width}x${item.height}` === resolutionValue,
  );

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
            <button type="button" className="button" onClick={() => setMenuOpen((open) => !open)}>
              + Node
            </button>
            {menuOpen ? (
              <div className="menu__panel" onMouseLeave={() => setMenuOpen(false)}>
                {CATEGORY_ORDER.map((category) => (
                  <section key={category}>
                    <h4>{CATEGORY_LABELS[category]}</h4>
                    {NODE_LIST.filter((definition) => definition.category === category).map(
                      (definition) => (
                        <button
                          key={definition.type}
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
                      ),
                    )}
                  </section>
                ))}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            className="button"
            onClick={() => setPresetsOpen(true)}
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
            disabled={rendering}
            title={
              paused
                ? "Play — resume the graph and sources"
                : "Pause — stop rAF, camera, and video"
            }
          >
            {paused ? "► Play" : "❚❚ Pause"}
          </button>

          {!hideRecord ? (
            <button
              type="button"
              className={`button ${recording ? "button--recording" : ""}`}
              onClick={onToggleRecord}
              disabled={paused || rendering}
              title="Realtime capture of the output canvas"
            >
              {recording ? "■ Stop" : "● Record"}
            </button>
          ) : null}

          <button
            type="button"
            className={`button ${rendering ? "button--recording" : ""}`}
            onClick={onToggleRender}
            disabled={recording}
            title={`Offline frame-by-frame timeline export @ ${renderFps} fps (not realtime)`}
          >
            {rendering ? `■ Cancel ${Math.round(renderProgress * 100)}%` : "Render"}
          </button>
        </div>

        <PresetsModal open={presetsOpen} onClose={closePresets} />
        <SettingsModal
          open={settingsOpen}
          onClose={closeSettings}
          renderFps={renderFps}
          onRenderFpsChange={commitRenderFps}
        />
      </header>

      <div className="toolbar__stats" aria-live="polite">
        {rendering
          ? `rendering · F${timelineFrame} · ${Math.round(renderProgress * 100)}%`
          : paused
            ? "paused · resources stopped"
            : `${fps} fps · ${frameMs} ms · ${nodeCount} nodes`}
      </div>
    </>
  );
}
