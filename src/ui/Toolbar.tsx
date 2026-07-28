import { useRef, useState } from "react";
import type { EngineStats } from "../engine/runtime";
import { CATEGORY_LABELS, NODE_LIST } from "../nodes/registry";
import { useGraphStore } from "../store/graphStore";

const RESOLUTIONS = [
  { label: "1280×720", width: 1280, height: 720 },
  { label: "1920×1080", width: 1920, height: 1080 },
  { label: "1080×1350", width: 1080, height: 1350 },
  { label: "1080×1920", width: 1080, height: 1920 },
];

const CATEGORY_ORDER = ["source", "tracking", "draw", "fx", "output"];

export function Toolbar({
  stats,
  recording,
  onToggleRecord,
  paused,
  onTogglePause,
}: {
  stats: EngineStats;
  recording: boolean;
  onToggleRecord: () => void;
  paused: boolean;
  onTogglePause: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const addNode = useGraphStore((state) => state.addNode);
  const width = useGraphStore((state) => state.width);
  const height = useGraphStore((state) => state.height);
  const setResolution = useGraphStore((state) => state.setResolution);
  const exportPatch = useGraphStore((state) => state.exportPatch);
  const importPatch = useGraphStore((state) => state.importPatch);
  const resetPatch = useGraphStore((state) => state.resetPatch);

  return (
    <header className="toolbar">
      <div className="toolbar__brand">
        <strong>visio</strong>
        <span>node environment · tracking → graphics</span>
      </div>

      <div className="toolbar__actions">
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

        <select
          className="select"
          value={`${width}x${height}`}
          onChange={(event) => {
            const preset = RESOLUTIONS.find(
              (item) => `${item.width}x${item.height}` === event.target.value,
            );
            if (preset) setResolution(preset.width, preset.height);
          }}
        >
          {RESOLUTIONS.map((preset) => (
            <option key={preset.label} value={`${preset.width}x${preset.height}`}>
              {preset.label}
            </option>
          ))}
        </select>

        <button type="button" className="button" onClick={exportPatch} title="Download patch JSON">
          Export
        </button>

        <button
          type="button"
          className="button"
          onClick={() => fileRef.current?.click()}
          title="Load patch from file"
        >
          Import
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          hidden
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setImportError(await importPatch(file));
            // Reset so picking the same file twice fires change again.
            event.target.value = "";
          }}
        />

        <button
          type="button"
          className="button"
          onClick={() => {
            if (window.confirm("Reset patch to the starter? Current patch will be lost.")) {
              resetPatch();
            }
          }}
          title="Restore starter patch"
        >
          Reset
        </button>

        <button
          type="button"
          className={`button ${paused ? "button--paused" : ""}`}
          onClick={onTogglePause}
          title={
            paused
              ? "Play — resume the graph and sources"
              : "Pause — stop rAF, camera, and video"
          }
        >
          {paused ? "► Play" : "❚❚ Pause"}
        </button>

        <button
          type="button"
          className={`button ${recording ? "button--recording" : ""}`}
          onClick={onToggleRecord}
          disabled={paused}
        >
          {recording ? "■ Stop" : "● Record"}
        </button>

        <span className="toolbar__stats">
          {importError ? (
            <em className="toolbar__error">{importError}</em>
          ) : paused ? (
            "paused · resources stopped"
          ) : (
            `${stats.fps} fps · ${stats.frameMs} ms · ${stats.nodeCount} nodes`
          )}
        </span>
      </div>
    </header>
  );
}
