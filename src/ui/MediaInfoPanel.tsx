import type { MediaInfo } from "../store/mediaInfoStore";

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

/** Rows built from live Media probe (Inspector + node body). */
export function mediaInfoRows(info: MediaInfo): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  rows.push({ label: "Mode", value: info.kind });
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
  return rows;
}

export function MediaInfoPanel({
  info,
  compact = false,
}: {
  info: MediaInfo;
  /** Tighter layout for the graph node body. */
  compact?: boolean;
}) {
  const rows = mediaInfoRows(info);
  if (rows.length === 0) return null;

  return (
    <div
      className={`media-info${compact ? " media-info--compact" : ""}`}
      aria-label="Media info"
    >
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
