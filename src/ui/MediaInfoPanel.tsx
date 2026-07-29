import type { MediaInfo } from "../store/mediaInfoStore";
import { formatBitrate, formatBytes } from "../lib/mediaMeta";

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

/** Rows built from live Media probe (Inspector + node body). */
export function mediaInfoRows(info: MediaInfo): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  // Native filename first — everything else is "what's on it now".
  if (info.name) rows.push({ label: "File", value: info.name });
  rows.push({ label: "Mode", value: info.kind });
  if (info.width > 0 && info.height > 0) {
    const aspect = info.aspectRatio ? ` · ${info.aspectRatio}` : "";
    rows.push({ label: "Size", value: `${info.width}×${info.height}${aspect}` });
  }
  if (info.container) rows.push({ label: "Container", value: info.container });
  if (info.mime) rows.push({ label: "MIME", value: info.mime });
  if (info.videoCodec) rows.push({ label: "Video", value: info.videoCodec });
  if (info.audioCodec) rows.push({ label: "Audio", value: info.audioCodec });
  // MIME codecs= fallback when the container sniff has not finished yet.
  if (!info.videoCodec && !info.audioCodec && info.codec) {
    rows.push({ label: "Codec", value: info.codec });
  }
  if (info.sizeBytes != null && info.sizeBytes > 0) {
    rows.push({ label: "File size", value: formatBytes(info.sizeBytes) });
  }
  if (info.bitrateBps != null && info.bitrateBps > 0) {
    rows.push({ label: "Bitrate", value: `${formatBitrate(info.bitrateBps)} avg` });
  }
  if (info.fps != null) rows.push({ label: "FPS", value: String(info.fps) });
  if (info.sampleRate != null) {
    const ch =
      info.channels != null
        ? ` · ${info.channels} ch`
        : "";
    rows.push({ label: "Sample rate", value: `${info.sampleRate} Hz${ch}` });
  } else if (info.channels != null) {
    rows.push({ label: "Channels", value: String(info.channels) });
  }
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

/** Label/value table shared by the Media probe and the per-node debug panel. */
export function InfoRows({
  rows,
  label,
  compact = false,
}: {
  rows: { label: string; value: string }[];
  label: string;
  /** Tighter layout for the graph node body. */
  compact?: boolean;
}) {
  if (rows.length === 0) return null;

  return (
    <div className={`media-info${compact ? " media-info--compact" : ""}`} aria-label={label}>
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

export function MediaInfoPanel({
  info,
  compact = false,
}: {
  info: MediaInfo;
  compact?: boolean;
}) {
  return <InfoRows rows={mediaInfoRows(info)} label="Media info" compact={compact} />;
}
