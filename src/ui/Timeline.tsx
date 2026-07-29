import { useEffect, useMemo, useRef, useState } from "react";
import {
  getKeyframeMarkerFrames,
  getNextKeyframeFrame,
  getPrevKeyframeFrame,
} from "../lib/keyframes";
import { resamplePeaks } from "../lib/peaks";
import { fileParam } from "../nodes/shared/fileParam";
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
      </div>

      <div className="timeline__body">
        <div className="timeline__labels">
          <div className="timeline__label timeline__label--ruler" />
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
              className="timeline__ruler"
              onPointerDown={onRulerDown}
              onPointerMove={onRulerMove}
              onPointerUp={onRulerUp}
            >
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

            <MediaTrack clips={videoClips} pxPerFrame={pxPerFrame} variant="video" />
            <MediaTrack clips={audioClips} pxPerFrame={pxPerFrame} variant="audio" />

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

function MediaTrack({
  clips,
  pxPerFrame,
  variant,
}: {
  clips: MediaClip[];
  pxPerFrame: number;
  variant: "video" | "audio";
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
              <ClipWaveform url={clip.url} label={clip.label} width={width} height={height} />
            ) : null}
            <span className="timeline__clip-label">{clip.label}</span>
          </div>
        );
      })}
    </div>
  );
}
