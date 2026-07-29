import { useEffect, useId, useRef, useState } from "react";
import {
  addUserPreset,
  DEFAULT_PRESET_ID,
  downloadUserPresets,
  getPreset,
  listPresets,
  removeUserPreset,
  type PatchPreset,
} from "../presets";
import { appLog } from "../store/consoleStore";
import { serializePatch } from "../store/persistence";
import { currentTimeline, useGraphStore } from "../store/graphStore";

export function PresetsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [selectedId, setSelectedId] = useState(DEFAULT_PRESET_ID);
  const [presets, setPresets] = useState<PatchPreset[]>(() => listPresets());
  const [status, setStatus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const loadPreset = useGraphStore((state) => state.loadPreset);
  const exportPatch = useGraphStore((state) => state.exportPatch);
  const importPatch = useGraphStore((state) => state.importPatch);
  const resetPatch = useGraphStore((state) => state.resetPatch);
  const titleId = useId();
  const listId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const refresh = () => setPresets(listPresets());
  const savedCount = presets.filter((preset) => preset.builtin !== true).length;

  useEffect(() => {
    if (!open) return;
    refresh();
    const active = useGraphStore.getState().activePresetId;
    const list = listPresets();
    const next =
      active && list.some((preset) => preset.id === active) ? active : DEFAULT_PRESET_ID;
    setSelectedId(next);
    setStatus(null);
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

  const selected = getPreset(selectedId) ?? presets[0];

  const applyLoad = (preset: PatchPreset) => {
    if (
      !window.confirm(`Load “${preset.label}”? The current patch will be replaced.`)
    ) {
      return;
    }
    const ok = loadPreset(preset.id);
    if (!ok) {
      setStatus(`Failed to load “${preset.label}”`);
      return;
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal modal--presets"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__header">
          <h2 id={titleId}>Presets</h2>
          <button type="button" className="button button--small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal__body">
          <div className="preset-list" role="listbox" id={listId} aria-label="Presets">
            {presets.map((preset) => {
              const saved = preset.builtin !== true;
              const active = preset.id === selected?.id;
              return (
                <div
                  key={preset.id}
                  className={`preset-list__row ${active ? "preset-list__row--active" : ""}`}
                  role="option"
                  aria-selected={active}
                >
                  <button
                    type="button"
                    className="preset-list__item"
                    title="Click to select · double-click to load"
                    onClick={() => {
                      setSelectedId(preset.id);
                      setStatus(null);
                    }}
                    onDoubleClick={() => applyLoad(preset)}
                  >
                    <span className="preset-list__mark" aria-hidden="true">
                      {saved ? "✓" : ""}
                    </span>
                    <span className="preset-list__text">
                      <span className="preset-list__label">{preset.label}</span>
                      <span className="preset-list__desc">{preset.description}</span>
                    </span>
                  </button>
                  {saved ? (
                    <button
                      type="button"
                      className="button button--small preset-list__delete"
                      title={`Delete “${preset.label}”`}
                      aria-label={`Delete ${preset.label}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (!window.confirm(`Delete saved preset “${preset.label}”?`)) return;
                        if (!removeUserPreset(preset.id)) return;
                        refresh();
                        if (useGraphStore.getState().activePresetId === preset.id) {
                          useGraphStore.getState().clearActivePreset();
                        }
                        if (selectedId === preset.id) {
                          setSelectedId(DEFAULT_PRESET_ID);
                        }
                        setStatus(`Deleted “${preset.label}”`);
                        appLog("info", "preset", `deleted “${preset.label}”`);
                      }}
                    >
                      Delete
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          {status ? <p className="modal__status">{status}</p> : null}
        </div>

        <footer className="modal__footer modal__footer--stack">
          <div className="modal__footer-row">
            <button
              type="button"
              className="button"
              onClick={() => {
                exportPatch();
                setStatus("Exported current patch");
                appLog("ok", "patch", "exported patch JSON");
              }}
              title="Download current patch JSON"
            >
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
                const error = await importPatch(file);
                event.target.value = "";
                if (error) {
                  setStatus(error);
                  return;
                }
                setStatus(`Imported “${file.name}”`);
                onClose();
              }}
            />
            <button
              type="button"
              className="button"
              onClick={() => {
                if (window.confirm("Reset patch to the starter? Current patch will be lost.")) {
                  resetPatch();
                  onClose();
                }
              }}
              title="Restore starter patch"
            >
              Reset
            </button>
            <div className="modal__footer-spacer" />
            <button
              type="button"
              className="button"
              onClick={() => {
                const suggested = `Patch ${new Date().toLocaleString()}`;
                const label = window.prompt("Name for this preset:", suggested);
                if (label === null) return;
                const { nodes, edges, width, height } = useGraphStore.getState();
                // A preset is a patch, so it carries the animation too.
                const id = addUserPreset(
                  label,
                  serializePatch(nodes, edges, width, height, currentTimeline()),
                );
                refresh();
                setSelectedId(id);
                setStatus(`Saved “${label.trim() || "Untitled"}”`);
                appLog("ok", "preset", `saved “${label.trim() || "Untitled"}”`);
              }}
            >
              Add current
            </button>
            <button
              type="button"
              className="button"
              disabled={savedCount === 0}
              title="Download all saved (non-builtin) presets as JSON"
              onClick={() => {
                const count = downloadUserPresets();
                setStatus(`Exported ${count} saved preset${count === 1 ? "" : "s"}`);
                appLog("ok", "preset", `exported ${count} saved presets`);
              }}
            >
              Export saved
            </button>
          </div>
          <div className="modal__footer-row">
            <div className="modal__footer-spacer" />
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="button button--accent"
              disabled={!selected}
              onClick={() => {
                if (selected) applyLoad(selected);
              }}
            >
              Load
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
