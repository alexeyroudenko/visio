import { useEffect, useState } from "react";
import { formatTimecode, parseTimecode } from "../lib/keyframes";
import { REEL_ZONE_META, type ReelZoneId } from "../lib/reelMarkers";
import type { OscWave } from "../lib/reelCueAudio";
import { useTimelineStore } from "../store/timelineStore";
import { useReelCueAudio } from "./useReelCueAudio";

export function PlaybackControls() {
  useReelCueAudio();

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
  const resetReelZones = useTimelineStore((s) => s.resetReelZones);
  const reelZonesVisible = useTimelineStore((s) => s.reelZonesVisible);
  const toggleReelZonesVisible = useTimelineStore((s) => s.toggleReelZonesVisible);
  const reelDirty = useTimelineStore((s) => s.reelZones.dirty);

  const cueZoneTick = useTimelineStore((s) => s.cueZoneTick);
  const cueDevMetronome = useTimelineStore((s) => s.cueDevMetronome);
  const cueDrone = useTimelineStore((s) => s.cueDrone);
  const developmentBpm = useTimelineStore((s) => s.developmentBpm);
  const droneByZone = useTimelineStore((s) => s.droneByZone);
  const setCueZoneTick = useTimelineStore((s) => s.setCueZoneTick);
  const setCueDevMetronome = useTimelineStore((s) => s.setCueDevMetronome);
  const setCueDrone = useTimelineStore((s) => s.setCueDrone);
  const setDevelopmentBpm = useTimelineStore((s) => s.setDevelopmentBpm);
  const setDroneZoneParams = useTimelineStore((s) => s.setDroneZoneParams);
  const renderInFrame = useTimelineStore((s) => s.renderInFrame);
  const renderOutFrame = useTimelineStore((s) => s.renderOutFrame);
  const setRenderIn = useTimelineStore((s) => s.setRenderIn);
  const setRenderOut = useTimelineStore((s) => s.setRenderOut);
  const clearRenderRange = useTimelineStore((s) => s.clearRenderRange);

  const [editingFrame, setEditingFrame] = useState(false);
  const [frameDraft, setFrameDraft] = useState("");
  const [editingDuration, setEditingDuration] = useState(false);
  const [durationDraft, setDurationDraft] = useState("");
  const [droneOpen, setDroneOpen] = useState(false);
  const [droneTab, setDroneTab] = useState<ReelZoneId>("hook");

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
  const activeDrone = droneByZone[droneTab];
  const hasRenderRange = renderInFrame != null && renderOutFrame != null;
  const rangeStart = hasRenderRange ? Math.min(renderInFrame, renderOutFrame) : 0;
  const rangeEnd = hasRenderRange ? Math.max(renderInFrame, renderOutFrame) : duration;
  const rangeLeftPct = duration > 0 ? (rangeStart / duration) * 100 : 0;
  const rangeWidthPct =
    duration > 0 ? ((rangeEnd - rangeStart) / duration) * 100 : 100;

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
        <button
          type="button"
          className={`button button--small playback__round${
            renderInFrame != null ? " playback__mark--on" : ""
          }`}
          onClick={() => setRenderIn()}
          title="Set render In at playhead (Render exports this range)"
        >
          I
        </button>
        <button
          type="button"
          className={`button button--small playback__round${
            renderOutFrame != null ? " playback__mark--on" : ""
          }`}
          onClick={() => setRenderOut()}
          title="Set render Out at playhead (Render exports this range)"
        >
          O
        </button>
        {hasRenderRange ? (
          <button
            type="button"
            className="button button--small playback__round"
            onClick={clearRenderRange}
            title="Clear render range — Render uses the full timeline"
          >
            ×
          </button>
        ) : null}
        <div
          className={`playback__scrub-wrap${hasRenderRange ? " playback__scrub-wrap--ranged" : ""}`}
        >
          {hasRenderRange ? (
            <div
              className="playback__scrub-range"
              style={{ left: `${rangeLeftPct}%`, width: `${rangeWidthPct}%` }}
              aria-hidden
            />
          ) : null}
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
            title={
              hasRenderRange
                ? `Playhead · render F${rangeStart}–F${rangeEnd}`
                : "Scrub playhead · I / O set render range"
            }
          />
        </div>
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
          {hasRenderRange ? (
            <span
              className="playback__range-label"
              title="Offline Render uses this inclusive frame range"
            >
              R F{rangeStart}–{rangeEnd}
            </span>
          ) : null}
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
        <button
          type="button"
          className={`button button--small${reelZonesVisible ? "" : " playback__reel-off"}`}
          onClick={toggleReelZonesVisible}
          title="Show or hide Hook / Development / Climax / CTA zones"
        >
          Reel
        </button>
        <button
          type="button"
          className="button button--small"
          onClick={resetReelZones}
          disabled={!reelDirty}
          title="Reset zone boundaries to the 7–15s formula"
        >
          Reset formula
        </button>
      </div>

      <div className="playback__cues">
        <label className="playback__cue" title="Click when playhead enters a new reel zone">
          <input
            type="checkbox"
            checked={cueZoneTick}
            onChange={(e) => setCueZoneTick(e.target.checked)}
          />
          Zone tick
        </label>
        <label
          className="playback__cue"
          title="Metronome while playhead is in Development"
        >
          <input
            type="checkbox"
            checked={cueDevMetronome}
            onChange={(e) => setCueDevMetronome(e.target.checked)}
          />
          Dev tick
        </label>
        <label className="playback__cue playback__cue--bpm" title="Development metronome BPM">
          BPM
          <input
            type="number"
            min={40}
            max={240}
            step={1}
            value={developmentBpm}
            disabled={!cueDevMetronome}
            onChange={(e) => setDevelopmentBpm(Number(e.target.value) || 120)}
          />
        </label>
        <label className="playback__cue" title="Sustained tone per reel zone while playing">
          <input
            type="checkbox"
            checked={cueDrone}
            onChange={(e) => setCueDrone(e.target.checked)}
          />
          Drone
        </label>
        <button
          type="button"
          className="button button--small"
          disabled={!cueDrone}
          onClick={() => setDroneOpen((o) => !o)}
          title="Per-zone drone frequency / gain / wave"
        >
          Drone…
        </button>
      </div>

      {droneOpen && cueDrone ? (
        <div className="playback__drone-panel">
          <div className="playback__drone-tabs">
            {REEL_ZONE_META.map((z) => (
              <button
                key={z.id}
                type="button"
                className={`button button--small${droneTab === z.id ? " playback__drone-tab--on" : ""}`}
                onClick={() => setDroneTab(z.id)}
              >
                {z.label}
              </button>
            ))}
          </div>
          <div className="playback__drone-fields">
            <label>
              <input
                type="checkbox"
                checked={activeDrone.enabled}
                onChange={(e) =>
                  setDroneZoneParams(droneTab, { enabled: e.target.checked })
                }
              />
              On
            </label>
            <label>
              Hz
              <input
                type="number"
                min={20}
                max={2000}
                step={1}
                value={activeDrone.freq}
                onChange={(e) =>
                  setDroneZoneParams(droneTab, { freq: Number(e.target.value) || 110 })
                }
              />
            </label>
            <label>
              Gain
              <input
                type="number"
                min={0}
                max={0.35}
                step={0.01}
                value={activeDrone.gain}
                onChange={(e) =>
                  setDroneZoneParams(droneTab, { gain: Number(e.target.value) || 0 })
                }
              />
            </label>
            <label>
              Wave
              <select
                value={activeDrone.type}
                onChange={(e) =>
                  setDroneZoneParams(droneTab, { type: e.target.value as OscWave })
                }
              >
                <option value="sine">sine</option>
                <option value="triangle">triangle</option>
                <option value="sawtooth">saw</option>
                <option value="square">square</option>
              </select>
            </label>
            <label title="Cents between the two stacked oscillators — beating / width">
              Detune
              <input
                type="number"
                min={0}
                max={60}
                step={1}
                value={activeDrone.detune}
                onChange={(e) =>
                  setDroneZoneParams(droneTab, { detune: Number(e.target.value) || 0 })
                }
              />
            </label>
            <label title="Lowpass cutoff (Hz)">
              Cutoff
              <input
                type="number"
                min={60}
                max={8000}
                step={10}
                value={activeDrone.cutoff}
                onChange={(e) =>
                  setDroneZoneParams(droneTab, { cutoff: Number(e.target.value) || 800 })
                }
              />
            </label>
            <label title="Filter LFO speed (Hz); 0 keeps the tone static">
              LFO
              <input
                type="number"
                min={0}
                max={12}
                step={0.1}
                value={activeDrone.lfoRate}
                onChange={(e) =>
                  setDroneZoneParams(droneTab, { lfoRate: Number(e.target.value) || 0 })
                }
              />
            </label>
            <label title="How far the LFO sweeps the cutoff (0..1)">
              Depth
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={activeDrone.lfoDepth}
                onChange={(e) =>
                  setDroneZoneParams(droneTab, { lfoDepth: Number(e.target.value) || 0 })
                }
              />
            </label>
            <label title="Sub oscillator an octave down (0..1)">
              Sub
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={activeDrone.subGain}
                onChange={(e) =>
                  setDroneZoneParams(droneTab, { subGain: Number(e.target.value) || 0 })
                }
              />
            </label>
          </div>
          <div className="playback__drone-fields playback__drone-fields--texture">
            <span className="playback__drone-group">Texture</span>
            <label title="Inharmonic partial ratio for FM and ring mod — non-integer values ring metallic">
              Ratio
              <input
                type="number"
                min={0.25}
                max={8}
                step={0.01}
                value={activeDrone.ratio}
                onChange={(e) =>
                  setDroneZoneParams(droneTab, { ratio: Number(e.target.value) || 2 })
                }
              />
            </label>
            {(
              [
                ["FM", "fm", "FM index — how hard the modulator bends the carrier"],
                ["Ring", "ring", "Ring modulation depth: 0 dry, 1 fully multiplied"],
                ["Noise", "noise", "Resonant noise band mixed under the tone"],
                ["Crush", "crush", "Bit-crush — digital staircase and aliasing"],
                ["Comb", "comb", "Comb feedback — short metallic delay resonance"],
                ["Glitch", "glitch", "Stutter gate: two incommensurate square LFOs chop the voice"],
                ["Drift", "drift", "Random drift on the cutoff"],
              ] as const
            ).map(([label, key, tip]) => (
              <label key={key} title={tip}>
                {label}
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={activeDrone[key]}
                  onChange={(e) =>
                    setDroneZoneParams(droneTab, { [key]: Number(e.target.value) || 0 })
                  }
                />
              </label>
            ))}
          </div>
        </div>
      ) : null}

      <label className="playback__loop">
        <input type="checkbox" checked={isLooping} onChange={() => toggleLoop()} />
        Loop
        {isRecording ? <em className="playback__rec-hint"> · recording keys</em> : null}
      </label>
    </div>
  );
}
