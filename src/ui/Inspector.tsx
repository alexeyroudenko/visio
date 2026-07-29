import type { ParamSpec } from "../engine/types";
import { CATEGORY_LABELS, NODE_DEFS } from "../nodes/registry";
import { useGraphStore } from "../store/graphStore";
import { useMediaInfoStore, type MediaInfo } from "../store/mediaInfoStore";

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

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

function MediaInfoPanel({ info }: { info: MediaInfo }) {
  const rows: { label: string; value: string }[] = [];
  if (info.width > 0 && info.height > 0) {
    rows.push({ label: "Size", value: `${info.width}×${info.height}` });
  }
  if (info.name) rows.push({ label: "File", value: info.name });
  if (info.mime) rows.push({ label: "MIME", value: info.mime });
  if (info.codec) rows.push({ label: "Codec", value: info.codec });
  if (info.fps != null) rows.push({ label: "FPS", value: String(info.fps) });
  if (info.durationSec != null) {
    rows.push({ label: "Duration", value: formatDuration(info.durationSec) });
  }
  if (info.kind === "video" || info.kind === "audio") {
    if (info.currentTimeSec != null) {
      rows.push({ label: "Time", value: formatDuration(info.currentTimeSec) });
    }
    if (info.currentFrame != null) {
      const total = info.totalFrames != null ? ` / ${info.totalFrames}` : "";
      rows.push({ label: "Frame", value: `${info.currentFrame}${total}` });
    }
    if (info.playing != null) {
      rows.push({ label: "State", value: info.playing ? "playing" : "paused" });
    }
  } else if (info.kind === "camera" && info.playing != null) {
    rows.push({ label: "State", value: info.playing ? "live" : "paused" });
  }

  return (
    <div className="media-info" aria-label="Media info">
      {rows.map((row) => (
        <div key={row.label} className="media-info__row">
          <span className="media-info__label">{row.label}</span>
          <span className="media-info__value" title={row.value}>
            {row.value}
          </span>
        </div>
      ))}
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
    default:
      return null;
  }
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
          return (
            <div key={spec.key} className="param-block">
              <ParamControl
                spec={spec}
                value={node.data.params[spec.key]}
                acceptOverride={acceptOverride}
                onChange={(next) => setParam(node.id, spec.key, next)}
              />
              {isMedia && spec.key === "fit" && mediaInfo ? (
                <MediaInfoPanel info={mediaInfo} />
              ) : null}
            </div>
          );
        })}
        {definition.params.length === 0 ? (
          <p className="inspector__empty">No parameters.</p>
        ) : null}
      </div>
    </aside>
  );
}
