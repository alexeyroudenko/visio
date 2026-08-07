import { useEffect, useMemo, useRef, useState } from "react";
import {
  getKeyframeMarkerFrames,
  getNextKeyframeFrame,
  getPrevKeyframeFrame,
} from "../lib/keyframes";
import { resamplePeaks } from "../lib/peaks";
import {
  formatReelSeconds,
  reelWarningMessage,
  zonesFromCuts,
} from "../lib/reelMarkers";
import { fileParam } from "../nodes/shared/fileParam";
import { grainsFor } from "../store/grainStore";
import { useGraphStore } from "../store/graphStore";
import { useMediaInfoStore } from "../store/mediaInfoStore";
import { useTimelineStore } from "../store/timelineStore";
import { useWaveformStore } from "../store/waveformStore";
import { PlaybackControls } from "./PlaybackControls";

const TRACKS = [
  { id: "video", label: "Video" },
  { id: "audio", label: "Audio" },
  { id: "params", label: "Parameters" },
] as const;

interface MediaClip {
  id: string;
  label: string;
  startFrame: number;
  durationFrames: number;
  sync: boolean;
  /** Inspector Play toggle — free-run when sync is off. */
  playing: boolean;
  /** Source to decode a waveform from; null for camera and images. */
  url: string | null;
}

/**
 * Waveform inside a clip, drawn from cached peaks. Only the column count
 * changes as the timeline zooms, so the decode happens once per file and this
 * just re-buckets.
 */
function ClipWaveform({ url, label, width, height }: {
  url: string;
  label: string;
  width: number;
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const entry = useWaveformStore((state) => state.byUrl[url]);
  const ensure = useWaveformStore((state) => state.ensure);

  useEffect(() => {
    ensure(url, label);
  }, [ensure, url, label]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const peaks = entry?.peaks;
    if (!canvas || !peaks) return;

    const columns = Math.max(1, Math.floor(width));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(columns * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, columns, height);

    const scaled = resamplePeaks(peaks, columns);
    const mid = height / 2;
    // Normalised to the file's own loudest peak: a lane is ~20 px tall, so a
    // quiet recording drawn at true scale is a flat line. The floor stops near
    // silence from being amplified into a wall of noise.
    const gain = 0.9 / Math.max(entry?.peak ?? 1, 0.05);
    ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
    for (let x = 0; x < columns; x += 1) {
      const min = Math.max(-1, scaled[x * 2]! * gain);
      const max = Math.min(1, scaled[x * 2 + 1]! * gain);
      const top = mid - max * mid;
      const bottom = mid - min * mid;
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }, [entry, width, height]);

  if (!entry?.peaks) return null;
  return <canvas ref={canvasRef} className="timeline__wave" style={{ width, height }} />;
}

/**
 * Live grains over the clip — same marks as granular-video's WaveformTimeline:
 * a vertical stroke at each voice's read position, shaded by pitch and scaled
 * by its envelope.
 *
 * Runs its own rAF against a plain store rather than React state — the marks
 * change every frame, and re-rendering the timeline that often for a few
 * strokes would be absurd.
 */
function GrainOverlay({ url, width, height }: { url: string; width: number; height: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let handle = 0;
    let wasEmpty = false;
    const mid = height / 2;
    const draw = () => {
      handle = requestAnimationFrame(draw);
      const marks = grainsFor(url);
      // Nothing playing and nothing left over: skip the clear entirely.
      if (marks.length === 0 && wasEmpty) return;
      wasEmpty = marks.length === 0;

      ctx.clearRect(0, 0, width, height);
      ctx.lineWidth = 1;
      for (const mark of marks) {
        const level = Math.max(0, Math.min(1, mark.level));
        if (level <= 0) continue;
        const x = mark.pos * width;
        // Pitch shifts lightness so low/high still read without hue.
        const light = 45 + Math.max(-24, Math.min(24, mark.pitch));
        ctx.strokeStyle = `hsla(0, 0%, ${light}%, ${(0.15 + level * 0.6).toFixed(3)})`;
        const half = level * height * 0.42;
        ctx.beginPath();
        ctx.moveTo(x, mid - half);
        ctx.lineTo(x, mid + half);
        ctx.stroke();
      }
    };

    draw();
    return () => cancelAnimationFrame(handle);
  }, [url, width, height]);

  return <canvas ref={canvasRef} className="timeline__grains" style={{ width, height }} />;
}

function collectMediaClips(
  kind: "video" | "audio",
  nodes: ReturnType<typeof useGraphStore.getState>["nodes"],
  mediaById: Record<string, { name?: string | null; durationSec?: number | null; totalFrames?: number | null }>,
  fps: number,
  timelineDuration: number,
): MediaClip[] {
  const clips: MediaClip[] = [];
  for (const node of nodes) {
    if (node.data.defType !== "source.media") continue;
    if (node.data.params.mode !== kind) continue;
    const info = mediaById[node.id];
    const file = fileParam(node.data.params);
    const label = info?.name || file?.name || node.id;
    let durationFrames = timelineDuration;
    if (info?.totalFrames != null && info.totalFrames > 0) {
      durationFrames = info.totalFrames;
    } else if (info?.durationSec != null && info.durationSec > 0) {
      durationFrames = Math.ceil(info.durationSec * fps);
    }
    durationFrames = Math.max(1, Math.min(durationFrames, timelineDuration));
    clips.push({
      id: node.id,
      label,
      startFrame: 0,
      durationFrames,
      sync: node.data.params.syncTimeline === true,
      playing: node.data.params.playing !== false,
      url: file?.url ?? null,
    });
  }
  return clips;
}

export function Timeline() {
  const fps = useTimelineStore((s) => s.fps);
  const durationInFrames = useTimelineStore((s) => s.durationInFrames);
  const currentFrame = useTimelineStore((s) => s.currentFrame);
  const seek = useTimelineStore((s) => s.seek);
  const pause = useTimelineStore((s) => s.pause);
  const paramKeyframes = useTimelineStore((s) => s.paramKeyframes);
  const selectedKeyframeFrame = useTimelineStore((s) => s.selectedKeyframeFrame);
  const selectKeyframe = useTimelineStore((s) => s.selectKeyframe);
  const moveSelectedKeyframe = useTimelineStore((s) => s.moveSelectedKeyframe);
  const reelZones = useTimelineStore((s) => s.reelZones);
  const reelZonesVisible = useTimelineStore((s) => s.reelZonesVisible);
  const setReelCut = useTimelineStore((s) => s.setReelCut);
  const syncDurationFromMediaSec = useTimelineStore((s) => s.syncDurationFromMediaSec);

  const nodes = useGraphStore((s) => s.nodes);
  const mediaById = useMediaInfoStore((s) => s.byId);

  const videoClips = useMemo(
    () => collectMediaClips("video", nodes, mediaById, fps, durationInFrames),
    [nodes, mediaById, fps, durationInFrames],
  );
  const audioClips = useMemo(
    () => collectMediaClips("audio", nodes, mediaById, fps, durationInFrames),
    [nodes, mediaById, fps, durationInFrames],
  );

  // When a video clip reports a real duration, match the composition length
  // (reel formula recalculates). Fingerprint avoids fighting manual duration edits
  // until the source length actually changes.
  const primaryVideoSec = useMemo(() => {
    let best = 0;
    for (const clip of videoClips) {
      const info = mediaById[clip.id];
      const sec =
        info && Number.isFinite(info.durationSec) && info.durationSec > 0
          ? info.durationSec
          : clip.durationFrames / Math.max(1, fps);
      if (sec > best) best = sec;
    }
    return best;
  }, [videoClips, mediaById, fps]);
  const lastSyncedVideoSec = useRef(0);
  useEffect(() => {
    if (primaryVideoSec < 0.5) return;
    if (Math.abs(primaryVideoSec - lastSyncedVideoSec.current) < 0.05) return;
    const targetFrames = Math.round(primaryVideoSec * fps);
    // Already matching composition length — don't wipe manual zone edits.
    if (Math.abs(targetFrames - durationInFrames) <= 1) {
      lastSyncedVideoSec.current = primaryVideoSec;
      return;
    }
    lastSyncedVideoSec.current = primaryVideoSec;
    syncDurationFromMediaSec(primaryVideoSec);
  }, [primaryVideoSec, syncDurationFromMediaSec, fps, durationInFrames]);

  const durationSec = durationInFrames / Math.max(1, fps);
  const reelRanges = useMemo(
    () => zonesFromCuts(reelZones.cutsSec, durationSec),
    [reelZones.cutsSec, durationSec],
  );
  const warningText = reelWarningMessage(reelZones.warning);
  const [zoom, setZoom] = useState(3);
  const [dragPreview, setDragPreview] = useState<number | null>(null);
  const pxPerFrame = zoom;
  const totalFrames = Math.max(durationInFrames, fps * 5);
  const trackWidth = totalFrames * pxPerFrame + 160;

  const rulerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  const keyframeDrag = useRef(false);
  const dragOrigin = useRef<number | null>(null);

  const frameFromClientX = (clientX: number): number => {
    const el = rulerRef.current;
    const scrollEl = scrollRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + (scrollEl?.scrollLeft ?? 0);
    return Math.max(0, Math.min(Math.round(x / pxPerFrame), durationInFrames));
  };

  const onRulerDown = (e: React.PointerEvent) => {
    scrubbing.current = true;
    pause();
    seek(frameFromClientX(e.clientX));
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onRulerMove = (e: React.PointerEvent) => {
    if (!scrubbing.current) return;
    seek(frameFromClientX(e.clientX));
  };
  const onRulerUp = (e: React.PointerEvent) => {
    scrubbing.current = false;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  const secondCount = Math.ceil(totalFrames / fps) + 1;
  const markers = Array.from({ length: secondCount }, (_, i) => i);
  const keyframeFrames = getKeyframeMarkerFrames(paramKeyframes);
  const prevKeyframe = getPrevKeyframeFrame(paramKeyframes, currentFrame);
  const nextKeyframe = getNextKeyframeFrame(paramKeyframes, currentFrame);

  const jumpToKeyframe = (frame: number) => {
    pause();
    seek(frame);
    selectKeyframe(frame);
  };

  const playheadFrame = dragPreview ?? currentFrame;

  return (
    <div className="timeline">
      <div className="timeline__toolbar">
        <span className="timeline__title">Timeline</span>
        <PlaybackControls />
        <div className="timeline__nav">
          <button
            type="button"
            className="button button--small"
            disabled={prevKeyframe === null}
            onClick={() => prevKeyframe !== null && jumpToKeyframe(prevKeyframe)}
          >
            Prev key
          </button>
          <button
            type="button"
            className="button button--small"
            disabled={nextKeyframe === null}
            onClick={() => nextKeyframe !== null && jumpToKeyframe(nextKeyframe)}
          >
            Next key
          </button>
          <span className="timeline__zoom-label">Zoom</span>
          <button
            type="button"
            className="button button--small"
            onClick={() => setZoom((z) => Math.max(1, z - 1))}
          >
            −
          </button>
          <button
            type="button"
            className="button button--small"
            onClick={() => setZoom((z) => Math.min(12, z + 1))}
          >
            +
          </button>
        </div>
        {warningText ? (
          <span className="timeline__reel-warn" title={warningText}>
            Reel: {reelZones.warning === "short" ? "<7s" : ">15s"}
          </span>
        ) : null}
      </div>

      <div className="timeline__body">
        <div className="timeline__labels">
          <div
            className={`timeline__label timeline__label--ruler${
              reelZonesVisible ? " timeline__label--ruler-reel" : ""
            }`}
          />
          {TRACKS.map((track) => (
            <div key={track.id} className="timeline__label">
              {track.label}
            </div>
          ))}
        </div>

        <div ref={scrollRef} className="timeline__scroll">
          <div className="timeline__tracks" style={{ width: trackWidth }}>
            <div
              ref={rulerRef}
              className={`timeline__ruler${reelZonesVisible ? " timeline__ruler--reel" : ""}`}
              onPointerDown={onRulerDown}
              onPointerMove={onRulerMove}
              onPointerUp={onRulerUp}
            >
              {reelZonesVisible
                ? reelRanges.map((zone) => {
                    const left = zone.startSec * fps * pxPerFrame;
                    const width = Math.max(
                      (zone.endSec - zone.startSec) * fps * pxPerFrame,
                      2,
                    );
                    return (
                      <div
                        key={zone.id}
                        className={`timeline__reel-zone timeline__reel-zone--${zone.color}`}
                        style={{ left, width }}
                        title={`${zone.label}: ${formatReelSeconds(zone.startSec)} – ${formatReelSeconds(zone.endSec)}\n${zone.tip}`}
                      >
                        <span className="timeline__reel-zone-label">
                          {zone.label}{" "}
                          <em>
                            {formatReelSeconds(zone.startSec)}–{formatReelSeconds(zone.endSec)}
                          </em>
                        </span>
                      </div>
                    );
                  })
                : null}
              {reelZonesVisible
                ? ([0, 1, 2] as const).map((index) => {
                    const sec = reelZones.cutsSec[index];
                    return (
                      <div
                        key={`cut-${index}`}
                        className="timeline__reel-handle"
                        style={{ left: sec * fps * pxPerFrame }}
                        title="Drag zone boundary"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          pause();
                          const target = e.currentTarget;
                          target.setPointerCapture(e.pointerId);
                          const onMove = (ev: PointerEvent) => {
                            const frame = frameFromClientX(ev.clientX);
                            setReelCut(index, frame / Math.max(1, fps));
                          };
                          const onUp = (ev: PointerEvent) => {
                            target.releasePointerCapture(ev.pointerId);
                            window.removeEventListener("pointermove", onMove);
                            window.removeEventListener("pointerup", onUp);
                          };
                          window.addEventListener("pointermove", onMove);
                          window.addEventListener("pointerup", onUp);
                        }}
                      />
                    );
                  })
                : null}
              {markers.map((sec) => (
                <div
                  key={sec}
                  className="timeline__tick"
                  style={{ left: sec * fps * pxPerFrame }}
                >
                  {sec}s
                </div>
              ))}
            </div>

            <MediaTrack
              clips={videoClips}
              pxPerFrame={pxPerFrame}
              timelineFps={fps}
              variant="video"
              mediaById={mediaById}
            />
            <MediaTrack
              clips={audioClips}
              pxPerFrame={pxPerFrame}
              timelineFps={fps}
              variant="audio"
              mediaById={mediaById}
            />

            <div className="timeline__track">
              {keyframeFrames.map((frame) => {
                const selected = selectedKeyframeFrame === frame;
                const left =
                  (dragPreview !== null && selected ? dragPreview : frame) * pxPerFrame;
                return (
                  <button
                    key={frame}
                    type="button"
                    className={`timeline__key ${selected ? "timeline__key--selected" : ""}`}
                    style={{ left }}
                    title={`Keyframe @ F${frame}`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      pause();
                      selectKeyframe(frame);
                      seek(frame);
                      keyframeDrag.current = true;
                      dragOrigin.current = frame;
                      (e.target as HTMLElement).setPointerCapture(e.pointerId);
                    }}
                    onPointerMove={(e) => {
                      if (!keyframeDrag.current) return;
                      setDragPreview(frameFromClientX(e.clientX));
                    }}
                    onPointerUp={(e) => {
                      if (!keyframeDrag.current) return;
                      keyframeDrag.current = false;
                      const to = frameFromClientX(e.clientX);
                      setDragPreview(null);
                      if (dragOrigin.current !== null) moveSelectedKeyframe(to);
                      dragOrigin.current = null;
                      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
                    }}
                  />
                );
              })}
            </div>

            <div
              className="timeline__playhead"
              style={{ left: playheadFrame * pxPerFrame }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function mediaPlayheadOffsetPx(
  clip: MediaClip,
  info:
    | {
        currentFrame?: number | null;
        currentTimeSec?: number | null;
        durationSec?: number | null;
      }
    | undefined,
  timelineFps: number,
  pxPerFrame: number,
): number | null {
  if (clip.sync || !clip.playing || !info) return null;

  // Progress along the clip bar — independent of video vs timeline fps.
  if (
    info.currentTimeSec != null &&
    Number.isFinite(info.currentTimeSec) &&
    info.durationSec != null &&
    info.durationSec > 0
  ) {
    const ratio = Math.max(0, Math.min(1, info.currentTimeSec / info.durationSec));
    return clip.startFrame * pxPerFrame + ratio * clip.durationFrames * pxPerFrame;
  }

  const frame =
    info.currentTimeSec != null && Number.isFinite(info.currentTimeSec)
      ? Math.floor(info.currentTimeSec * timelineFps)
      : info.currentFrame;
  if (frame == null) return null;
  return (
    clip.startFrame * pxPerFrame +
    Math.max(0, Math.min(frame - clip.startFrame, clip.durationFrames)) * pxPerFrame
  );
}

function MediaTrack({
  clips,
  pxPerFrame,
  timelineFps,
  variant,
  mediaById,
}: {
  clips: MediaClip[];
  pxPerFrame: number;
  timelineFps: number;
  variant: "video" | "audio";
  mediaById: ReturnType<typeof useMediaInfoStore.getState>["byId"];
}) {
  const count = Math.max(1, clips.length);
  const slotH = 20 / count;

  return (
    <div className="timeline__track">
      {clips.map((clip, index) => {
        const width = Math.max(clip.durationFrames * pxPerFrame, 8);
        const height = Math.max(slotH, 10);
        return (
          <div
            key={clip.id}
            className={`timeline__clip timeline__clip--${variant}${clip.sync ? " timeline__clip--sync" : ""}`}
            style={{
              left: clip.startFrame * pxPerFrame,
              width,
              top: 4 + index * (slotH + 2),
              height,
            }}
            title={`${clip.label}${clip.sync ? " · sync" : ""} · ${clip.durationFrames}f`}
          >
            {clip.url ? (
              <>
                <ClipWaveform url={clip.url} label={clip.label} width={width} height={height} />
                <GrainOverlay url={clip.url} width={width} height={height} />
              </>
            ) : null}
            <span className="timeline__clip-label">{clip.label}</span>
          </div>
        );
      })}
      {clips.map((clip) => {
        const left = mediaPlayheadOffsetPx(
          clip,
          mediaById[clip.id],
          timelineFps,
          pxPerFrame,
        );
        if (left == null) return null;
        return (
          <div
            key={`${clip.id}-playhead`}
            className="timeline__media-playhead"
            style={{ left }}
            title={clip.label}
          />
        );
      })}
    </div>
  );
}
