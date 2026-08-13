import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  addUserPreset,
  builtinPreviewUrl,
  DEFAULT_PRESET_ID,
  downloadUserPresets,
  getPreset,
  listPresets,
  removeUserPreset,
  type PatchPreset,
} from "../presets";
import { isOmitted, setPresetShipped } from "../presets/ship";
import { recapturePresetPreview } from "../lib/capturePresetPreviews";
import { saveBuiltinPreset } from "../presets/saveBuiltin";
import { appLog } from "../store/consoleStore";
import { currentTimeline, useGraphStore } from "../store/graphStore";
import { useModulatorStore } from "../store/modulatorStore";
import { serializePatch } from "../store/persistence";

function presetThumb(preset: PatchPreset): string | null {
  if (preset.preview) return preset.preview;
  if (preset.builtin) return builtinPreviewUrl(preset.id);
  return null;
}

export function PresetsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [selectedId, setSelectedId] = useState(DEFAULT_PRESET_ID);
  const [presets, setPresets] = useState<PatchPreset[]>(() => listPresets());
  const [status, setStatus] = useState<string | null>(null);
  const [brokenThumbs, setBrokenThumbs] = useState<Record<string, true>>({});
  const [thumbRev, setThumbRev] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
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
    setBrokenThumbs({});
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
    const empty = useGraphStore.getState().nodes.length === 0;
    if (
      !empty &&
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

  return createPortal(
    <div className="modal-backdrop modal-backdrop--presets" onClick={onClose} role="presentation">
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
              const thumb = brokenThumbs[preset.id] ? null : presetThumb(preset);
              const thumbSrc =
                thumb && thumbRev[preset.id] ? `${thumb}?v=${thumbRev[preset.id]}` : thumb;
              const omitted = preset.builtin === true && isOmitted(preset.id);
              return (
                <div
                  key={preset.id}
                  className={`preset-list__row ${active ? "preset-list__row--active" : ""}${omitted ? " preset-list__row--omitted" : ""}`}
                  role="option"
                  aria-selected={active}
                >
                  {import.meta.env.DEV && preset.builtin === true ? (
                    <label
                      className="preset-list__ship"
                      title={
                        preset.id === DEFAULT_PRESET_ID
                          ? "Default preset always ships"
                          : omitted
                            ? "Unchecked: left out of the production build"
                            : "Checked: included in the production build"
                      }
                      onClick={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => event.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={!omitted}
                        disabled={preset.id === DEFAULT_PRESET_ID}
                        aria-label={`Include ${preset.label} in the production build`}
                        onChange={async (event) => {
                          const ship = event.target.checked;
                          const ok = await setPresetShipped(preset.id, ship);
                          if (!ok) event.target.checked = !ship;
                          refresh();
                        }}
                      />
                    </label>
                  ) : null}
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
                      ✕
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="preset-list__item"
                    title={`${preset.label} — click to select · double-click to load`}
                    onClick={() => {
                      setSelectedId(preset.id);
                      setStatus(null);
                    }}
                    onDoubleClick={() => applyLoad(preset)}
                  >
                    <span className="preset-list__thumb" aria-hidden="true">
                      {thumbSrc ? (
                        <img
                          src={thumbSrc}
                          alt=""
                          loading="lazy"
                          onError={() =>
                            setBrokenThumbs((prev) => ({ ...prev, [preset.id]: true }))
                          }
                        />
                      ) : (
                        <span className="preset-list__thumb-empty" />
                      )}
                    </span>
                    <span className="preset-list__text">
                      <span className="preset-list__label">
                        {saved ? <span className="preset-list__mark">✓ </span> : null}
                        {preset.label}
                      </span>
                      <span className="preset-list__desc">{preset.description}</span>
                    </span>
                  </button>
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
                if (window.confirm("Clear the patch? Current patch will be lost.")) {
                  resetPatch();
                  onClose();
                }
              }}
              title="Clear the patch — same as first launch"
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
            {import.meta.env.DEV && selected?.builtin === true ? (
              <button
                type="button"
                className="button button--render"
                disabled={saving}
                title="Overwrite this builtin with the current patch and recapture its thumb"
                onClick={async () => {
                  if (
                    !window.confirm(
                      `Overwrite builtin “${selected.label}” with the current patch?`,
                    )
                  ) {
                    return;
                  }
                  setSaving(true);
                  const { nodes, edges, width, height } = useGraphStore.getState();
                  const patch = serializePatch(
                    nodes,
                    edges,
                    width,
                    height,
                    currentTimeline(),
                    useModulatorStore.getState().byPath,
                  );
                  const ok = await saveBuiltinPreset(selected.id, patch);
                  if (!ok) {
                    setSaving(false);
                    setStatus(`Failed to save “${selected.label}”`);
                    return;
                  }
                  setStatus(`Saved “${selected.label}” · capturing preview…`);
                  const thumbOk = await recapturePresetPreview(selected.id);
                  setThumbRev((prev) => ({ ...prev, [selected.id]: Date.now() }));
                  setBrokenThumbs((prev) => {
                    const next = { ...prev };
                    delete next[selected.id];
                    return next;
                  });
                  setSaving(false);
                  setStatus(
                    thumbOk
                      ? `Saved builtin “${selected.label}”`
                      : `Saved builtin “${selected.label}” (preview failed)`,
                  );
                  appLog(
                    thumbOk ? "ok" : "warn",
                    "preset",
                    thumbOk
                      ? `saved builtin “${selected.label}”`
                      : `saved builtin “${selected.label}” but preview capture failed`,
                  );
                }}
              >
                Save
              </button>
            ) : null}
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
    </div>,
    document.body,
  );
}
