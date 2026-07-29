import type { ParamSpec } from "../engine/types";
import { getValueAtFrame, paramPath } from "../lib/keyframes";
import {
  modulatedValue,
  MODULATOR_SHAPES,
  type Modulator,
} from "../lib/modulators";
import { CATEGORY_LABELS, NODE_DEFS } from "../nodes/registry";
import { useGraphStore } from "../store/graphStore";
import { useMediaInfoStore } from "../store/mediaInfoStore";
import { useModulatorStore } from "../store/modulatorStore";
import { useTimelineStore } from "../store/timelineStore";
import { MediaInfoPanel } from "./MediaInfoPanel";

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
        <label className="param">
          <span className="param__label">
            {spec.label}
            <em>{current}</em>
          </span>
          <input
            type="range"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={current}
            onChange={(event) => onChange(Number(event.target.value))}
          />
        </label>
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
      const current = value as { name: string; url: string } | null;
      const accept = acceptOverride ?? spec.accept;
      return (
        <label className="param">
          <span className="param__label">{spec.label}</span>
          <input
            key={accept}
            type="file"
            accept={accept}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              if (!fileMatchesAccept(file, accept)) {
                event.target.value = "";
                return;
              }
              // Revoke the previous blob so long sessions don't leak.
              if (current?.url) URL.revokeObjectURL(current.url);
              onChange({
                name: file.name,
                url: URL.createObjectURL(file),
                mime: file.type || undefined,
              });
            }}
          />
          {current ? <em className="param__hint">{current.name}</em> : null}
        </label>
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
    default:
      return null;
  }
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
  return (
    <div className="modulator">
      <div className="modulator__head">
        <span className="modulator__title">Modulator</span>
        <button type="button" className="button button--small" onClick={onRelease}>
          Release
        </button>
      </div>
      <ParamControl
        spec={{ key: "shape", label: "Shape", type: "select", options: MODULATOR_SHAPES, default: "sine" }}
        value={modulator.shape}
        onChange={(next) => onChange({ shape: next as Modulator["shape"] })}
      />
      <ParamControl
        spec={{ key: "rateHz", label: "Rate Hz", type: "range", min: 0, max: 8, step: 0.05, default: 0.5 }}
        value={modulator.rateHz}
        onChange={(next) => onChange({ rateHz: next as number })}
      />
      <ParamControl
        spec={{ key: "depth", label: "Depth", type: "range", min: 0, max: 1, step: 0.01, default: 0.5 }}
        value={modulator.depth}
        onChange={(next) => onChange({ depth: next as number })}
      />
      <ParamControl
        spec={{ key: "bias", label: "Bias", type: "range", min: -1, max: 1, step: 0.01, default: 0 }}
        value={modulator.bias}
        onChange={(next) => onChange({ bias: next as number })}
      />
      <ParamControl
        spec={{ key: "phase", label: "Phase", type: "range", min: 0, max: 1, step: 0.01, default: 0 }}
        value={modulator.phase}
        onChange={(next) => onChange({ phase: next as number })}
      />
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

export function Inspector() {
  const selectedId = useGraphStore((state) => state.selectedId);
  const node = useGraphStore((state) => state.nodes.find((n) => n.id === state.selectedId));
  const status = useGraphStore((state) => (selectedId ? state.statuses[selectedId] : undefined));
  const mediaInfo = useMediaInfoStore((state) =>
    selectedId ? state.byId[selectedId] : undefined,
  );
  const setParam = useGraphStore((state) => state.setParam);
  const removeNode = useGraphStore((state) => state.removeNode);

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
        {definition.params.map((spec) => {
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
            <div key={spec.key} className="param-block">
              <ParamControl
                spec={spec}
                value={value}
                acceptOverride={acceptOverride}
                onChange={(next) => setParam(node.id, spec.key, next)}
              />
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
        {isMedia && mediaInfo ? <MediaInfoPanel info={mediaInfo} /> : null}
      </div>
    </aside>
  );
}
