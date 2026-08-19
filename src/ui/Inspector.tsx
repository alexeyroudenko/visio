import type { ParamSpec } from "../engine/types";
import {
  ANALYZER_BANDS,
  emptyAnalyzerBind,
  getAnalyzerOut,
  parseAnalyzerBinds,
  type AnalyzerBandId,
  type AnalyzerBind,
} from "../lib/analyzerBindings";
import { getValueAtFrame, paramPath } from "../lib/keyframes";
import {
  emptyModulatorBind,
  getModulatorDrive,
  MODULATOR_DRIVE_TYPE,
  parseModulatorBinds,
  type ModulatorBind,
} from "../lib/modulatorBindings";
import {
  AUDIO_BAND_PRESETS,
  matchAudioBandPreset,
  modulatedValue,
  MODULATOR_SHAPES,
  MODULATOR_SOURCES,
  type Modulator,
} from "../lib/modulators";
import { SHADER_PRESETS } from "../nodes/fx/shaderPresets";
import {
  BUNDLED_AUDIO_FILES,
  BUNDLED_IMAGE_FILES,
  DEFAULT_AUDIO_FILE,
  type FileParam,
} from "../nodes/shared/fileParam";
import { CATEGORY_LABELS, NODE_DEFS } from "../nodes/registry";
import { useGraphStore } from "../store/graphStore";
import { useMediaInfoStore } from "../store/mediaInfoStore";
import { useModulatorStore } from "../store/modulatorStore";
import { useTimelineStore } from "../store/timelineStore";
import { MediaInfoPanel } from "./MediaInfoPanel";
import { useMediaInfoWindow } from "./useMediaInfoWindow";
import { Knob } from "./Knob";
import { useEffect, useRef, useState } from "react";

/** Resolve `<input accept>` tokens against a File (MIME and/or extension). */
function fileMatchesAccept(file: File, accept: string): boolean {
  const tokens = accept
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return true;

  const mime = (file.type || "").toLowerCase();
  const name = file.name.toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot) : "";

  return tokens.some((token) => {
    if (token === "*/*") return true;
    if (token.endsWith("/*")) {
      const prefix = token.slice(0, -1); // "image/"
      if (mime.startsWith(prefix)) return true;
      if (prefix === "image/" && /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/.test(ext)) return true;
      if (prefix === "video/" && /\.(mp4|webm|mov|m4v|ogg|ogv|mkv)$/.test(ext)) return true;
      if (prefix === "audio/" && /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|webm)$/.test(ext)) return true;
      return false;
    }
    if (token.startsWith(".")) return ext === token;
    return mime === token;
  });
}

function mediaFileAccept(mode: unknown): string | undefined {
  if (mode === "video") return "video/*";
  if (mode === "image") return "image/*";
  if (mode === "audio") return "audio/*";
  return undefined;
}

/**
 * File picker that can be re-filled from a restored File (IndexedDB → File →
 * DataTransfer). Browsers forbid setting the path as a string, but they do
 * allow assigning a FileList built from a File we already hold.
 */
function FileParamControl({
  spec,
  value,
  onChange,
  acceptOverride,
}: {
  spec: ParamSpec;
  value: unknown;
  onChange: (next: unknown) => void;
  acceptOverride?: string;
}) {
  const current = (value as FileParam | null) ?? null;
  const accept =
    acceptOverride ?? (spec.type === "file" ? spec.accept : undefined) ?? "";
  const inputRef = useRef<HTMLInputElement>(null);
  const showLibrary = (() => {
    const tokens = accept
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    if (tokens.length === 0) return false;
    // Only the image-source Media picker — not the mixed camera default accept.
    return tokens.every(
      (token) =>
        token === "image/*" ||
        token.startsWith("image/") ||
        token === ".png" ||
        token === ".jpg" ||
        token === ".jpeg" ||
        token === ".webp",
    );
  })();
  const showAudioLibrary = (() => {
    const tokens = accept
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    if (tokens.length === 0) return false;
    return tokens.every(
      (token) =>
        token === "audio/*" ||
        token.startsWith("audio/") ||
        token === ".mp3" ||
        token === ".wav" ||
        token === ".ogg" ||
        token === ".m4a",
    );
  })();

  useEffect(() => {
    const input = inputRef.current;
    const fileObj = current?.fileObj;
    if (!input || !fileObj) return;
    // Already showing this file — leave the user's fresh pick alone.
    if (input.files?.[0]?.name === fileObj.name && input.files[0].size === fileObj.size) {
      return;
    }
    try {
      const transfer = new DataTransfer();
      transfer.items.add(fileObj);
      input.files = transfer.files;
    } catch {
      // Some browsers reject programmatic FileList assignment — the hint
      // below still shows the restored name.
    }
  }, [current?.url, current?.fileObj]);

  return (
    <div className="param param--file">
      <label className="param">
        <span className="param__label">{spec.label}</span>
        <input
          ref={inputRef}
          key={accept}
          type="file"
          accept={accept}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (!fileMatchesAccept(file, accept ?? "")) {
              event.target.value = "";
              return;
            }
            // The previous blob is not revoked here: mediaMemory still holds
            // it so switching back to that source type gets the file again,
            // and it releases the URL once nothing remembers it.
            onChange({
              name: file.name,
              url: URL.createObjectURL(file),
              mime: file.type || undefined,
              sizeBytes: file.size,
              fileObj: file,
            } satisfies FileParam);
          }}
        />
        {current ? <em className="param__hint">{current.name}</em> : null}
      </label>
      {showLibrary && BUNDLED_IMAGE_FILES.length > 0 ? (
        <div className="media-library" aria-label="Stock images">
          <span className="param__label">Library</span>
          <div className="media-library__row">
            {BUNDLED_IMAGE_FILES.map(({ file, label }) => {
              const active =
                current?.name === file.name ||
                (typeof current?.url === "string" && current.url.endsWith(file.name));
              return (
                <button
                  key={file.name}
                  type="button"
                  className={`media-library__item${active ? " media-library__item--active" : ""}`}
                  title={file.name}
                  onClick={() => onChange({ ...file })}
                >
                  <img src={file.url} alt="" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {showAudioLibrary ? (
        <div className="media-library" aria-label="Stock audio">
          <span className="param__label">Library</span>
          <div className="media-library__row">
            {BUNDLED_AUDIO_FILES.map(({ file, label }) => {
              const active =
                current?.name === file.name ||
                (typeof current?.url === "string" && current.url.endsWith(file.name));
              return (
                <button
                  key={file.name}
                  type="button"
                  className={`media-library__item${active ? " media-library__item--active" : ""}`}
                  title={file.name}
                  onClick={() => onChange({ ...file })}
                >
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ParamControl({
  spec,
  value,
  onChange,
  acceptOverride,
}: {
  spec: ParamSpec;
  value: unknown;
  onChange: (next: unknown) => void;
  /** Dynamic accept for file inputs (e.g. Media source mode). */
  acceptOverride?: string;
}) {
  switch (spec.type) {
    case "range": {
      const current = typeof value === "number" ? value : spec.default;
      return (
        <Knob
          label={spec.label}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={current}
          onChange={(next) => onChange(next)}
        />
      );
    }
    case "toggle": {
      const current = typeof value === "boolean" ? value : spec.default;
      return (
        <label className="param param--row">
          <input
            type="checkbox"
            checked={current}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="param__label">{spec.label}</span>
        </label>
      );
    }
    case "color": {
      const current = typeof value === "string" ? value : spec.default;
      return (
        <label className="param param--row">
          <input
            type="color"
            value={current}
            onChange={(event) => onChange(event.target.value)}
          />
          <span className="param__label">{spec.label}</span>
        </label>
      );
    }
    case "select": {
      const current = typeof value === "string" ? value : spec.default;
      return (
        <label className="param">
          <span className="param__label">{spec.label}</span>
          <select value={current} onChange={(event) => onChange(event.target.value)}>
            {spec.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      );
    }
    case "file": {
      return (
        <FileParamControl
          spec={spec}
          value={value}
          onChange={onChange}
          acceptOverride={acceptOverride}
        />
      );
    }
    case "text": {
      const current = typeof value === "string" ? value : spec.default;
      return (
        <label className="param">
          <span className="param__label">{spec.label}</span>
          <input type="text" value={current} onChange={(event) => onChange(event.target.value)} />
        </label>
      );
    }
    case "code": {
      const current = typeof value === "string" ? value : spec.default;
      return (
        <label className="param">
          <span className="param__label">{spec.label}</span>
          <textarea
            className="param__code"
            rows={spec.rows ?? 14}
            spellCheck={false}
            value={current}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      );
    }
    case "json":
      // Soft-binds and other structured values use a custom panel.
      return null;
    default:
      return null;
  }
}

/**
 * Starting points for the Shader node. These write into the `source` param like
 * any edit would, so a preset is a place to start from, not a mode to be in.
 */
function ShaderPresetPicker({ onPick }: { onPick: (source: string) => void }) {
  return (
    <div className="shader-presets">
      <span className="shader-presets__label">Start from</span>
      <div className="shader-presets__row">
        {SHADER_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="button button--small"
            title={`${preset.description} — replaces the source below`}
            onClick={() => onPick(preset.source)}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The knobs of a bound modulator, laid out with the same controls as any param. */
function ModulatorPanel({
  modulator,
  onChange,
  onRelease,
}: {
  modulator: Modulator;
  onChange: (patch: Partial<Modulator>) => void;
  onRelease: () => void;
}) {
  const isAudio = modulator.source === "audio";
  const bandPreset = matchAudioBandPreset(modulator.bandLoHz ?? 20, modulator.bandHiHz ?? 200);

  return (
    <div className="modulator">
      <div className="modulator__head">
        <span className="modulator__title">Modulator</span>
        <button type="button" className="button button--small" onClick={onRelease}>
          Release
        </button>
      </div>
      <ParamControl
        spec={{
          key: "source",
          label: "Source",
          type: "select",
          options: MODULATOR_SOURCES,
          default: "lfo",
        }}
        value={modulator.source}
        onChange={(next) => onChange({ source: next as Modulator["source"] })}
      />
      {isAudio ? (
        <>
          <ParamControl
            spec={{
              key: "bandPreset",
              label: "Band",
              type: "select",
              options: AUDIO_BAND_PRESETS.map(({ value, label }) => ({ value, label })),
              default: "low",
            }}
            value={bandPreset}
            onChange={(next) => {
              const preset = AUDIO_BAND_PRESETS.find((p) => p.value === next);
              if (!preset || preset.value === "custom") return;
              onChange({ bandLoHz: preset.lo, bandHiHz: preset.hi });
            }}
          />
          <div className="modulator__knobs">
            <ParamControl
              spec={{
                key: "bandLoHz",
                label: "Band lo Hz",
                type: "range",
                min: 20,
                max: 8000,
                step: 10,
                default: 20,
              }}
              value={modulator.bandLoHz ?? 20}
              onChange={(next) => onChange({ bandLoHz: next as number })}
            />
            <ParamControl
              spec={{
                key: "bandHiHz",
                label: "Band hi Hz",
                type: "range",
                min: 20,
                max: 16000,
                step: 10,
                default: 200,
              }}
              value={modulator.bandHiHz ?? 200}
              onChange={(next) => onChange({ bandHiHz: next as number })}
            />
            <ParamControl
              spec={{
                key: "depth",
                label: "Depth",
                type: "range",
                min: 0,
                max: 1,
                step: 0.01,
                default: 0.5,
              }}
              value={modulator.depth}
              onChange={(next) => onChange({ depth: next as number })}
            />
            <ParamControl
              spec={{
                key: "bias",
                label: "Bias",
                type: "range",
                min: -1,
                max: 1,
                step: 0.01,
                default: 0,
              }}
              value={modulator.bias}
              onChange={(next) => onChange({ bias: next as number })}
            />
          </div>
        </>
      ) : (
        <>
          <ParamControl
            spec={{
              key: "shape",
              label: "Shape",
              type: "select",
              options: MODULATOR_SHAPES,
              default: "sine",
            }}
            value={modulator.shape}
            onChange={(next) => onChange({ shape: next as Modulator["shape"] })}
          />
          <div className="modulator__knobs">
            <ParamControl
              spec={{
                key: "rateHz",
                label: "Rate Hz",
                type: "range",
                min: 0,
                max: 8,
                step: 0.05,
                default: 0.5,
              }}
              value={modulator.rateHz}
              onChange={(next) => onChange({ rateHz: next as number })}
            />
            <ParamControl
              spec={{
                key: "depth",
                label: "Depth",
                type: "range",
                min: 0,
                max: 1,
                step: 0.01,
                default: 0.5,
              }}
              value={modulator.depth}
              onChange={(next) => onChange({ depth: next as number })}
            />
            <ParamControl
              spec={{
                key: "bias",
                label: "Bias",
                type: "range",
                min: -1,
                max: 1,
                step: 0.01,
                default: 0,
              }}
              value={modulator.bias}
              onChange={(next) => onChange({ bias: next as number })}
            />
            <ParamControl
              spec={{
                key: "phase",
                label: "Phase",
                type: "range",
                min: 0,
                max: 1,
                step: 0.01,
                default: 0,
              }}
              value={modulator.phase}
              onChange={(next) => onChange({ phase: next as number })}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** ◆ toggles a key at the playhead; it is filled while one sits exactly there. */
function KeyToggle({ animated, onFrame, onClick }: {
  animated: boolean;
  onFrame: boolean;
  onClick: () => void;
}) {
  const title = onFrame
    ? "Remove the keyframe at the playhead"
    : animated
      ? "Key this value at the playhead"
      : "Animate: key this value at the playhead";
  return (
    <button
      type="button"
      className={`param-key${animated ? " param-key--animated" : ""}${onFrame ? " param-key--on" : ""}`}
      title={title}
      onClick={onClick}
    >
      ◆
    </button>
  );
}

/** ↑ promotes a range knob onto the patch mixer (performance view). */
function PublishToggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`param-pub${on ? " param-pub--on" : ""}`}
      title={on ? "Unpublish — hide this knob from the patch mixer" : "Publish — show this knob on the patch mixer"}
      aria-label="Publish"
      aria-pressed={on}
      onClick={onClick}
    >
      ↑
    </button>
  );
}

/** Low / mid / high meters + multi bind rows (+ / −) for Audio Analyzer. */
function AnalyzerBindPanel({
  nodeId,
  params,
  onChange,
}: {
  nodeId: string;
  params: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  const nodes = useGraphStore((state) => state.nodes);
  const [levels, setLevels] = useState(() => ({
    low: getAnalyzerOut(nodeId, "low"),
    mid: getAnalyzerOut(nodeId, "mid"),
    high: getAnalyzerOut(nodeId, "high"),
  }));

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setLevels({
        low: getAnalyzerOut(nodeId, "low"),
        mid: getAnalyzerOut(nodeId, "mid"),
        high: getAnalyzerOut(nodeId, "high"),
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [nodeId]);

  const binds = parseAnalyzerBinds(params);

  const bindableNodes = nodes.filter((n) => {
    if (n.id === nodeId) return false;
    const def = NODE_DEFS[n.data.defType];
    return !!def?.params.some((p) => p.type === "range");
  });

  const setBinds = (next: AnalyzerBind[]) => onChange("binds", next);

  const updateBind = (id: string, patch: Partial<AnalyzerBind>) => {
    setBinds(binds.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  };

  const rangeParamsFor = (targetNodeId: string) => {
    const def = NODE_DEFS[nodes.find((n) => n.id === targetNodeId)?.data.defType ?? ""];
    return (def?.params ?? []).filter((p) => p.type === "range");
  };

  return (
    <div className="analyzer-bind">
      {ANALYZER_BANDS.map((band) => {
        const level = levels[band.id];
        return (
          <div key={band.id} className="analyzer-bind__band">
            <div className="param">
              <span className="param__label">{band.label}</span>
              <div className="analyzer-bind__meter" title={level.toFixed(3)}>
                <div
                  className="analyzer-bind__fill"
                  style={{ width: `${Math.round(level * 100)}%` }}
                />
                <span className="analyzer-bind__value">{level.toFixed(3)}</span>
              </div>
            </div>
            <div className="analyzer-bind__hz">
              <label className="param">
                <span className="param__label">min Hz</span>
                <input
                  type="number"
                  min={20}
                  max={20000}
                  step={10}
                  value={Number(params[band.loKey] ?? band.defaultLo)}
                  onChange={(e) => onChange(band.loKey, Number(e.target.value))}
                />
              </label>
              <label className="param">
                <span className="param__label">max Hz</span>
                <input
                  type="number"
                  min={20}
                  max={20000}
                  step={10}
                  value={Number(params[band.hiKey] ?? band.defaultHi)}
                  onChange={(e) => onChange(band.hiKey, Number(e.target.value))}
                />
              </label>
            </div>
          </div>
        );
      })}

      <div className="analyzer-bind__targets">
        <div className="analyzer-bind__targets-head">
          <span className="param__label">Bindings</span>
          <button
            type="button"
            className="analyzer-bind__add"
            onClick={() => setBinds([...binds, emptyAnalyzerBind()])}
            title="Add binding"
          >
            +
          </button>
        </div>
        {binds.length === 0 ? (
          <p className="analyzer-bind__empty">No bindings — press + to route a band to a param.</p>
        ) : null}
        {binds.map((bind) => {
          const rangeParams = rangeParamsFor(bind.targetNode);
          return (
            <div key={bind.id} className="analyzer-bind__row">
              <select
                aria-label="Band"
                value={bind.band}
                onChange={(e) =>
                  updateBind(bind.id, { band: e.target.value as AnalyzerBandId })
                }
              >
                {ANALYZER_BANDS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Target node"
                value={bind.targetNode}
                onChange={(e) => {
                  const nextNode = e.target.value;
                  const first = rangeParamsFor(nextNode)[0];
                  updateBind(bind.id, {
                    targetNode: nextNode,
                    targetParam: first?.key ?? "",
                  });
                }}
              >
                <option value="">— node —</option>
                {bindableNodes.map((n) => {
                  const def = NODE_DEFS[n.data.defType];
                  return (
                    <option key={n.id} value={n.id}>
                      {def ? `${def.label} (${n.id})` : n.id}
                    </option>
                  );
                })}
              </select>
              <select
                aria-label="Target param"
                value={bind.targetParam}
                disabled={!bind.targetNode || rangeParams.length === 0}
                onChange={(e) => updateBind(bind.id, { targetParam: e.target.value })}
              >
                <option value="">— param —</option>
                {rangeParams.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
              <label className="analyzer-bind__depth" title="Depth">
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={bind.depth}
                  onChange={(e) =>
                    updateBind(bind.id, {
                      depth: Math.min(1, Math.max(0, Number(e.target.value) || 0)),
                    })
                  }
                />
              </label>
              <button
                type="button"
                className="analyzer-bind__remove"
                onClick={() => setBinds(binds.filter((b) => b.id !== bind.id))}
                title="Remove binding"
              >
                −
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Shared drive meter + multi bind rows (+ / −) for Modulator Drive. */
function ModulatorBindPanel({
  nodeId,
  params,
  onChange,
}: {
  nodeId: string;
  params: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  const nodes = useGraphStore((state) => state.nodes);
  const [drive, setDrive] = useState(() => getModulatorDrive(nodeId));

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setDrive(getModulatorDrive(nodeId));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [nodeId]);

  const binds = parseModulatorBinds(params);
  const meter = (drive + 1) / 2;

  const bindableNodes = nodes.filter((n) => {
    if (n.id === nodeId) return false;
    if (n.data.defType === MODULATOR_DRIVE_TYPE) return false;
    const def = NODE_DEFS[n.data.defType];
    return !!def?.params.some((p) => p.type === "range");
  });

  const setBinds = (next: ModulatorBind[]) => onChange("binds", next);

  const updateBind = (id: string, patch: Partial<ModulatorBind>) => {
    setBinds(binds.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  };

  const rangeParamsFor = (targetNodeId: string) => {
    const def = NODE_DEFS[nodes.find((n) => n.id === targetNodeId)?.data.defType ?? ""];
    return (def?.params ?? []).filter((p) => p.type === "range");
  };

  return (
    <div className="analyzer-bind">
      <div className="param">
        <span className="param__label">Drive</span>
        <div className="analyzer-bind__meter" title={drive.toFixed(3)}>
          <div
            className="analyzer-bind__fill"
            style={{ width: `${Math.round(meter * 100)}%` }}
          />
          <span className="analyzer-bind__value">{drive.toFixed(3)}</span>
        </div>
      </div>

      <div className="analyzer-bind__targets">
        <div className="analyzer-bind__targets-head">
          <span className="param__label">Bindings</span>
          <button
            type="button"
            className="analyzer-bind__add"
            onClick={() => setBinds([...binds, emptyModulatorBind()])}
            title="Add binding"
          >
            +
          </button>
        </div>
        {binds.length === 0 ? (
          <p className="analyzer-bind__empty">
            No bindings — press + to route this drive to a param.
          </p>
        ) : null}
        {binds.map((bind) => {
          const rangeParams = rangeParamsFor(bind.targetNode);
          return (
            <div key={bind.id} className="analyzer-bind__row">
              <select
                aria-label="Target node"
                value={bind.targetNode}
                onChange={(e) => {
                  const nextNode = e.target.value;
                  const first = rangeParamsFor(nextNode)[0];
                  updateBind(bind.id, {
                    targetNode: nextNode,
                    targetParam: first?.key ?? "",
                  });
                }}
              >
                <option value="">— node —</option>
                {bindableNodes.map((n) => {
                  const def = NODE_DEFS[n.data.defType];
                  return (
                    <option key={n.id} value={n.id}>
                      {def ? `${def.label} (${n.id})` : n.id}
                    </option>
                  );
                })}
              </select>
              <select
                aria-label="Target param"
                value={bind.targetParam}
                disabled={!bind.targetNode || rangeParams.length === 0}
                onChange={(e) => updateBind(bind.id, { targetParam: e.target.value })}
              >
                <option value="">— param —</option>
                {rangeParams.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
              <label className="analyzer-bind__depth" title="Depth">
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={bind.depth}
                  onChange={(e) =>
                    updateBind(bind.id, {
                      depth: Math.min(1, Math.max(0, Number(e.target.value) || 0)),
                    })
                  }
                />
              </label>
              <label className="analyzer-bind__depth" title="Bias">
                <input
                  type="number"
                  min={-1}
                  max={1}
                  step={0.05}
                  value={bind.bias}
                  onChange={(e) =>
                    updateBind(bind.id, {
                      bias: Math.min(1, Math.max(-1, Number(e.target.value) || 0)),
                    })
                  }
                />
              </label>
              <button
                type="button"
                className="analyzer-bind__remove"
                onClick={() => setBinds(binds.filter((b) => b.id !== bind.id))}
                title="Remove binding"
              >
                −
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Inspector() {
  const selectedId = useGraphStore((state) => state.selectedId);
  const node = useGraphStore((state) => state.nodes.find((n) => n.id === state.selectedId));
  const status = useGraphStore((state) => (selectedId ? state.statuses[selectedId] : undefined));
  const mediaInfo = useMediaInfoStore((state) =>
    selectedId ? state.byId[selectedId] : undefined,
  );
  const { open: openMediaInfo } = useMediaInfoWindow();
  const setParam = useGraphStore((state) => state.setParam);
  const removeNode = useGraphStore((state) => state.removeNode);
  const published = useGraphStore((state) => state.published);
  const togglePublished = useGraphStore((state) => state.togglePublished);

  // The engine renders params resolved at the playhead, so the controls have to
  // show the same thing — otherwise an animated slider sits at its base value
  // while the output moves.
  const currentFrame = useTimelineStore((state) => state.currentFrame);
  const paramKeyframes = useTimelineStore((state) => state.paramKeyframes);
  const recordParam = useTimelineStore((state) => state.recordParam);
  const removeParamKeyframe = useTimelineStore((state) => state.removeParamKeyframe);
  const fps = useTimelineStore((state) => state.fps);

  const modulators = useModulatorStore((state) => state.byPath);
  const bindModulator = useModulatorStore((state) => state.bind);
  const unbindModulator = useModulatorStore((state) => state.unbind);
  const updateModulator = useModulatorStore((state) => state.update);

  if (!node) {
    return (
      <aside className="inspector">
        <p className="inspector__empty">Select a node to edit its parameters.</p>
      </aside>
    );
  }

  const definition = NODE_DEFS[node.data.defType];
  if (!definition) {
    return (
      <aside className="inspector">
        <p className="inspector__empty">Node {node.data.defType} not found in the registry.</p>
      </aside>
    );
  }

  const isMedia = node.data.defType === "source.media";
  const isHoughLines = node.data.defType === "tracking.lines";
  const isShader = node.data.defType === "fx.shader";
  const isAnalyzer = node.data.defType === "audio.analyzer";
  const isModulatorDrive = node.data.defType === MODULATOR_DRIVE_TYPE;
  const modulatorSource = String(node.data.params.source ?? "lfo");

  return (
    <aside className="inspector">
      <header className="inspector__header">
        <div>
          <h2>{definition.label}</h2>
          <span className="inspector__category">{CATEGORY_LABELS[definition.category]}</span>
        </div>
        <button type="button" className="button button--danger" onClick={() => removeNode(node.id)}>
          Delete
        </button>
      </header>

      <p className="inspector__description">{definition.description}</p>
      {status?.message ? (
        <p className={`inspector__status inspector__status--${status.status}`}>{status.message}</p>
      ) : null}

      <div className="inspector__params">
        {isShader ? (
          <ShaderPresetPicker onPick={(source) => setParam(node.id, "source", source)} />
        ) : null}
        {isAnalyzer ? (
          <AnalyzerBindPanel
            nodeId={node.id}
            params={node.data.params}
            onChange={(key, value) => setParam(node.id, key, value)}
          />
        ) : null}
        {isModulatorDrive ? (
          <ModulatorBindPanel
            nodeId={node.id}
            params={node.data.params}
            onChange={(key, value) => setParam(node.id, key, value)}
          />
        ) : null}
        {definition.params.map((spec) => {
          if (spec.type === "json") return null;
          if (
            isAnalyzer &&
            (spec.key.startsWith("out") ||
              spec.key.endsWith("LoHz") ||
              spec.key.endsWith("HiHz") ||
              spec.key === "targetNode" ||
              spec.key === "targetParam")
          ) {
            return null;
          }
          if (isModulatorDrive) {
            if (modulatorSource === "audio") {
              if (spec.key === "shape" || spec.key === "rateHz" || spec.key === "phase") return null;
            } else if (spec.key === "bandLoHz" || spec.key === "bandHiHz") {
              return null;
            }
          }
          if (isMedia) {
            const mode = String(node.data.params.mode ?? "image");
            const cameraOnly = spec.key === "facing";
            const cameraHidden = new Set([
              "file",
              "playing",
              "muted",
              "volume",
              "speed",
              "syncTimeline",
            ]);
            if (mode === "camera") {
              if (cameraHidden.has(spec.key)) return null;
            } else if (cameraOnly) {
              return null;
            }
          }
          if (isHoughLines) {
            const cannyOn = node.data.params.canny === true;
            if (spec.key === "edgeThreshold" && cannyOn) return null;
            if (
              !cannyOn &&
              (spec.key === "cannyView" ||
                spec.key === "cannyThreshold1" ||
                spec.key === "cannyThreshold2" ||
                spec.key === "cannyAperture" ||
                spec.key === "cannyL2")
            ) {
              return null;
            }
          }

          const acceptOverride =
            isMedia && spec.type === "file" && spec.key === "file"
              ? mediaFileAccept(node.data.params.mode)
              : undefined;

          const base = node.data.params[spec.key];
          const path = paramPath(node.id, spec.key);
          const keys = paramKeyframes[path];
          const frame = Math.round(currentFrame);
          const animated = !!keys?.length;
          let value = animated ? getValueAtFrame(frame, base, keys) : base;
          // File params keep blob URLs that cannot be persisted, so they stay live-only.
          // `json` (soft-binds) is filtered out above — never keyframed.
          const keyable = spec.type !== "file";

          // Show what the engine is actually rendering, modulation included.
          const modulator = modulators[path];
          if (modulator && spec.type === "range") {
            value = modulatedValue(
              spec,
              typeof value === "number" ? value : spec.default,
              modulator,
              currentFrame / fps,
            );
          }

          return (
            <div
              key={spec.key}
              className={`param-block${spec.type === "range" ? " param-block--knob" : ""}`}
            >
              <ParamControl
                spec={spec}
                value={value}
                acceptOverride={acceptOverride}
                onChange={(next) => {
                  if (isMedia && spec.key === "mode" && next === "audio") {
                    setParam(node.id, "mode", "audio");
                    const file = node.data.params.file;
                    const hasFile =
                      file &&
                      typeof file === "object" &&
                      typeof (file as FileParam).url === "string";
                    if (!hasFile) setParam(node.id, "file", { ...DEFAULT_AUDIO_FILE });
                    return;
                  }
                  setParam(node.id, spec.key, next);
                }}
              />
              {spec.type === "range" ? (
                <PublishToggle
                  on={published.includes(path)}
                  onClick={() => togglePublished(path)}
                />
              ) : null}
              {keyable ? (
                <KeyToggle
                  animated={animated}
                  onFrame={!!keys?.some((key) => key.frame === frame)}
                  onClick={() => {
                    if (keys?.some((key) => key.frame === frame)) {
                      removeParamKeyframe(path, frame);
                    } else {
                      recordParam(node.id, spec.key, value);
                    }
                  }}
                />
              ) : null}
              {/* Only a range has the bounds a swing is measured against. */}
              {spec.type === "range" ? (
                <button
                  type="button"
                  className={`param-mod${modulator ? " param-mod--on" : ""}`}
                  title={modulator ? "Release this modulator" : "Modulate this parameter"}
                  onClick={() => (modulator ? unbindModulator(path) : bindModulator(path))}
                >
                  ∿
                </button>
              ) : null}
              {modulator ? (
                <ModulatorPanel
                  modulator={modulator}
                  onChange={(patch) => updateModulator(path, patch)}
                  onRelease={() => unbindModulator(path)}
                />
              ) : null}
            </div>
          );
        })}
        {definition.params.length === 0 ? (
          <p className="inspector__empty">No parameters.</p>
        ) : null}
        {isMedia && mediaInfo ? (
          <>
            <div className="inspector__media-head">
              <span>Source</span>
              <button
                type="button"
                className="button button--small"
                title="Open everything read from this file in its own window"
                onClick={() => openMediaInfo(node.id)}
              >
                Info ↗
              </button>
            </div>
            <MediaInfoPanel info={mediaInfo} />
          </>
        ) : null}
      </div>
    </aside>
  );
}
