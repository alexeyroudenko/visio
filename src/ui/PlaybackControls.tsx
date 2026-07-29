import { useEffect, useState } from "react";
import { formatTimecode, parseTimecode } from "../lib/keyframes";
import { useTimelineStore } from "../store/timelineStore";

export function PlaybackControls() {
  const isPlaying = useTimelineStore((s) => s.isPlaying);
  const isRecording = useTimelineStore((s) => s.isRecording);
  const isLooping = useTimelineStore((s) => s.isLooping);
  const currentFrame = useTimelineStore((s) => s.currentFrame);
  const fps = useTimelineStore((s) => s.fps);
  const duration = useTimelineStore((s) => s.durationInFrames);
  const togglePlay = useTimelineStore((s) => s.togglePlay);
  const toggleRecording = useTimelineStore((s) => s.toggleRecording);
  const toggleLoop = useTimelineStore((s) => s.toggleLoop);
  const seek = useTimelineStore((s) => s.seek);
  const pause = useTimelineStore((s) => s.pause);
  const setDurationInFrames = useTimelineStore((s) => s.setDurationInFrames);
  const clearKeyframes = useTimelineStore((s) => s.clearKeyframes);

  const [editingFrame, setEditingFrame] = useState(false);
  const [frameDraft, setFrameDraft] = useState("");
  const [editingDuration, setEditingDuration] = useState(false);
  const [durationDraft, setDurationDraft] = useState("");

  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    let last = performance.now();
    let accumulated = useTimelineStore.getState().currentFrame;

    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const state = useTimelineStore.getState();
      accumulated += dt * state.fps;

      if (accumulated >= state.durationInFrames) {
        if (state.isLooping) {
          while (accumulated >= state.durationInFrames) {
            accumulated -= state.durationInFrames;
          }
        } else {
          state.seek(state.durationInFrames);
          state.pause();
          return;
        }
      }

      state.seek(accumulated);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  const commitFrameDraft = () => {
    const parsed = Number.parseInt(frameDraft, 10);
    if (!Number.isNaN(parsed)) {
      pause();
      seek(parsed);
    }
    setEditingFrame(false);
  };

  const commitDurationDraft = () => {
    const parsed = parseTimecode(durationDraft, fps);
    if (parsed !== null) {
      pause();
      setDurationInFrames(parsed);
    }
    setEditingDuration(false);
  };

  const atEnd = currentFrame >= duration;

  return (
    <div className="playback">
      <div className="playback__row">
        <button
          type="button"
          className="button button--small playback__round"
          onClick={() => {
            if (atEnd && !isPlaying) seek(0);
            togglePlay();
          }}
          title={isPlaying ? "Pause timeline" : "Play timeline"}
        >
          {isPlaying ? "❚❚" : "►"}
        </button>
        <button
          type="button"
          className="button button--small playback__round"
          onClick={() => {
            pause();
            seek(0);
          }}
          title="To start"
        >
          ⏮
        </button>
        <button
          type="button"
          className="button button--small playback__round"
          onClick={() => {
            pause();
            seek(Math.round(useTimelineStore.getState().currentFrame) - 1);
          }}
          title="Previous frame"
        >
          ◀
        </button>
        <button
          type="button"
          className="button button--small playback__round"
          onClick={() => {
            pause();
            seek(Math.round(useTimelineStore.getState().currentFrame) + 1);
          }}
          title="Next frame"
        >
          ▶
        </button>
        <button
          type="button"
          className={`button button--small playback__round ${isRecording ? "playback__record--on" : ""}`}
          onClick={toggleRecording}
          title={
            isRecording
              ? "Stop recording keys — param changes write keyframes"
              : "Record keys — param changes write keyframes at playhead"
          }
        >
          ●
        </button>
        <input
          type="range"
          className="playback__scrub"
          min={0}
          max={duration}
          value={Math.min(currentFrame, duration)}
          onChange={(e) => {
            pause();
            seek(Number(e.target.value));
          }}
        />
        <div className="playback__time">
          {editingFrame ? (
            <input
              type="number"
              min={0}
              max={duration}
              value={frameDraft}
              autoFocus
              onChange={(e) => setFrameDraft(e.target.value)}
              onBlur={commitFrameDraft}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitFrameDraft();
                if (e.key === "Escape") setEditingFrame(false);
              }}
            />
          ) : (
            <button
              type="button"
              className="button button--small"
              onClick={() => {
                setFrameDraft(String(Math.round(currentFrame)));
                setEditingFrame(true);
              }}
              title="Click to enter frame"
            >
              F{Math.round(currentFrame)}
            </button>
          )}
          <span>
            {formatTimecode(currentFrame, fps)} /{" "}
            {editingDuration ? (
              <input
                type="text"
                value={durationDraft}
                autoFocus
                placeholder="MM:SS:FF"
                onChange={(e) => setDurationDraft(e.target.value)}
                onBlur={commitDurationDraft}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitDurationDraft();
                  if (e.key === "Escape") setEditingDuration(false);
                }}
              />
            ) : (
              <button
                type="button"
                className="button button--small"
                onClick={() => {
                  setDurationDraft(formatTimecode(duration, fps));
                  setEditingDuration(true);
                }}
                title="Set duration (MM:SS:FF or frames)"
              >
                {formatTimecode(duration, fps)}
              </button>
            )}
          </span>
        </div>
        <button
          type="button"
          className="button button--small"
          onClick={() => {
            if (window.confirm("Clear all parameter keyframes?")) clearKeyframes();
          }}
          title="Clear all keyframes"
        >
          Clear keys
        </button>
      </div>
      <label className="playback__loop">
        <input type="checkbox" checked={isLooping} onChange={() => toggleLoop()} />
        Loop
        {isRecording ? <em className="playback__rec-hint"> · recording keys</em> : null}
      </label>
    </div>
  );
}
