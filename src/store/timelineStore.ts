import { create } from "zustand";
import {
  clampKeyframesToDuration,
  DEFAULT_DURATION_FRAMES,
  DEFAULT_FPS,
  moveKeyframeFrame,
  paramPath,
  removeKeyframe,
  upsertKeyframe,
  type ParamKeyframes,
  type ParamPath,
} from "../lib/keyframes";
import {
  computeReelCuts,
  moveCut,
  normalizeCuts,
  scaleCuts,
  type ReelCutsSec,
  type ReelDurationWarning,
} from "../lib/reelMarkers";
import {
  DEFAULT_DEVELOPMENT_BPM,
  DEFAULT_DRONE_BY_ZONE,
  parseDroneByZone,
  type ReelDroneByZone,
  type ReelDroneParams,
} from "../lib/reelCueAudio";
import { appLog } from "./consoleStore";

const MIN_DURATION = DEFAULT_FPS;

export interface ReelZonesState {
  cutsSec: ReelCutsSec;
  /** True after the user dragged a boundary — duration changes scale instead of formula-reset. */
  dirty: boolean;
  warning: ReelDurationWarning;
}

function reelFromDurationFrames(durationInFrames: number, fps: number): ReelZonesState {
  const durationSec = durationInFrames / Math.max(1, fps);
  const { cutsSec, warning } = computeReelCuts(durationSec);
  return { cutsSec, dirty: false, warning };
}

interface TimelineState {
  fps: number;
  durationInFrames: number;
  currentFrame: number;
  isPlaying: boolean;
  /** When on, Inspector param changes write keyframes at the playhead. */
  isRecording: boolean;
  isLooping: boolean;
  paramKeyframes: ParamKeyframes;
  selectedKeyframeFrame: number | null;
  /** Auto Hook/Dev/Climax/CTA zones for short reels. */
  reelZones: ReelZonesState;
  /** Show / hide reel zone overlay (default on). */
  reelZonesVisible: boolean;

  /** Tick when playhead crosses a zone boundary. */
  cueZoneTick: boolean;
  /** Metronome clicks while in Development. */
  cueDevMetronome: boolean;
  /** Sustained drone that follows the active zone. */
  cueDrone: boolean;
  developmentBpm: number;
  droneByZone: ReelDroneByZone;

  seek: (frame: number) => void;
  setDurationInFrames: (durationInFrames: number) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  toggleRecording: () => void;
  toggleLoop: () => void;

  /** Write / update a key at the current frame (used while recording). */
  recordParam: (nodeId: string, key: string, value: unknown) => void;
  /** Adopt the timeline stored in a patch. */
  loadTimeline: (timeline: {
    fps: number;
    durationInFrames: number;
    keyframes: ParamKeyframes;
    reelZones?: { cutsSec: ReelCutsSec; dirty?: boolean } | null;
    cueZoneTick?: boolean;
    cueDevMetronome?: boolean;
    cueDrone?: boolean;
    developmentBpm?: number;
    droneByZone?: unknown;
  }) => void;
  hasKeyframes: (path: ParamPath) => boolean;
  removeParamKeyframe: (path: ParamPath, frame: number) => void;
  selectKeyframe: (frame: number | null) => void;
  moveSelectedKeyframe: (toFrame: number) => void;
  clearKeyframes: () => void;

  resetReelZones: () => void;
  setReelCut: (index: 0 | 1 | 2, sec: number) => void;
  toggleReelZonesVisible: () => void;
  /** Sync composition length from a media clip (sec) and recompute zones. */
  syncDurationFromMediaSec: (durationSec: number) => void;

  setCueZoneTick: (on: boolean) => void;
  setCueDevMetronome: (on: boolean) => void;
  setCueDrone: (on: boolean) => void;
  setDevelopmentBpm: (bpm: number) => void;
  setDroneZoneParams: (zone: keyof ReelDroneByZone, patch: Partial<ReelDroneParams>) => void;
}

declare global {
  interface Window {
    __visioTimelineStore?: ReturnType<typeof createTimelineStore>;
  }
}

function createTimelineStore() {
  const initialDuration = DEFAULT_DURATION_FRAMES;
  const initialFps = DEFAULT_FPS;

  return create<TimelineState>((set, get) => ({
    fps: initialFps,
    durationInFrames: initialDuration,
    currentFrame: 0,
    isPlaying: false,
    isRecording: false,
    isLooping: false,
    paramKeyframes: {},
    selectedKeyframeFrame: null,
    reelZones: reelFromDurationFrames(initialDuration, initialFps),
    reelZonesVisible: true,
    cueZoneTick: false,
    cueDevMetronome: false,
    cueDrone: false,
    developmentBpm: DEFAULT_DEVELOPMENT_BPM,
    droneByZone: {
      hook: { ...DEFAULT_DRONE_BY_ZONE.hook },
      development: { ...DEFAULT_DRONE_BY_ZONE.development },
      climax: { ...DEFAULT_DRONE_BY_ZONE.climax },
      cta: { ...DEFAULT_DRONE_BY_ZONE.cta },
    },

    seek(frame) {
      const { durationInFrames } = get();
      set({ currentFrame: Math.max(0, Math.min(frame, durationInFrames)) });
    },

    setDurationInFrames(durationInFrames) {
      const state = get();
      const next = Math.max(MIN_DURATION, Math.round(durationInFrames));
      const nextSec = next / Math.max(1, state.fps);
      let reelZones: ReelZonesState;
      if (state.reelZones.dirty) {
        const scaled = scaleCuts(
          state.reelZones.cutsSec,
          state.durationInFrames / Math.max(1, state.fps),
          nextSec,
        );
        const { warning } = computeReelCuts(nextSec);
        reelZones = {
          cutsSec: normalizeCuts(scaled, nextSec),
          dirty: true,
          warning,
        };
      } else {
        reelZones = reelFromDurationFrames(next, state.fps);
      }
      set({
        durationInFrames: next,
        currentFrame: Math.min(state.currentFrame, next),
        paramKeyframes: clampKeyframesToDuration(state.paramKeyframes, next),
        selectedKeyframeFrame:
          state.selectedKeyframeFrame !== null && state.selectedKeyframeFrame <= next
            ? state.selectedKeyframeFrame
            : null,
        reelZones,
      });
    },

    play: () => set({ isPlaying: true }),
    pause: () => set({ isPlaying: false }),
    togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),

    toggleRecording: () => {
      const next = !get().isRecording;
      set({ isRecording: next });
      appLog("info", "timeline", next ? "recording keys" : "keys armed off");
    },

    toggleLoop: () => set((s) => ({ isLooping: !s.isLooping })),

    recordParam(nodeId, key, value) {
      const state = get();
      const path = paramPath(nodeId, key);
      set({
        paramKeyframes: upsertKeyframe(
          state.paramKeyframes,
          path,
          Math.round(state.currentFrame),
          value,
        ),
      });
    },

    loadTimeline({
      fps,
      durationInFrames,
      keyframes,
      reelZones,
      cueZoneTick,
      cueDevMetronome,
      cueDrone,
      developmentBpm,
      droneByZone,
    }) {
      const nextFps = Math.max(1, fps);
      const duration = Math.max(MIN_DURATION, Math.round(durationInFrames));
      const durationSec = duration / nextFps;
      let nextReel: ReelZonesState;
      if (reelZones?.cutsSec && reelZones.cutsSec.length === 3) {
        const { warning } = computeReelCuts(durationSec);
        nextReel = {
          cutsSec: normalizeCuts(reelZones.cutsSec, durationSec),
          dirty: !!reelZones.dirty,
          warning,
        };
      } else {
        nextReel = reelFromDurationFrames(duration, nextFps);
      }
      set({
        fps: nextFps,
        durationInFrames: duration,
        paramKeyframes: clampKeyframesToDuration(keyframes, duration),
        currentFrame: 0,
        isPlaying: false,
        selectedKeyframeFrame: null,
        reelZones: nextReel,
        ...(typeof cueZoneTick === "boolean" ? { cueZoneTick } : {}),
        ...(typeof cueDevMetronome === "boolean" ? { cueDevMetronome } : {}),
        ...(typeof cueDrone === "boolean" ? { cueDrone } : {}),
        ...(typeof developmentBpm === "number" && Number.isFinite(developmentBpm)
          ? { developmentBpm: Math.max(40, Math.min(240, developmentBpm)) }
          : {}),
        ...(droneByZone ? { droneByZone: parseDroneByZone(droneByZone) } : {}),
      });
      const tracks = Object.keys(keyframes).length;
      if (tracks > 0) appLog("ok", "timeline", `restored ${tracks} keyframed params`);
    },

    hasKeyframes(path) {
      const keys = get().paramKeyframes[path];
      return !!keys && keys.length > 0;
    },

    removeParamKeyframe(path, frame) {
      set({ paramKeyframes: removeKeyframe(get().paramKeyframes, path, frame) });
    },

    selectKeyframe(frame) {
      set({ selectedKeyframeFrame: frame });
    },

    moveSelectedKeyframe(toFrame) {
      const state = get();
      if (state.selectedKeyframeFrame === null) return;
      const clamped = Math.max(0, Math.min(Math.round(toFrame), state.durationInFrames));
      set({
        paramKeyframes: moveKeyframeFrame(
          state.paramKeyframes,
          state.selectedKeyframeFrame,
          clamped,
        ),
        selectedKeyframeFrame: clamped,
        currentFrame: clamped,
      });
    },

    clearKeyframes() {
      set({ paramKeyframes: {}, selectedKeyframeFrame: null });
      appLog("info", "timeline", "cleared keyframes");
    },

    resetReelZones() {
      const { durationInFrames, fps } = get();
      set({ reelZones: reelFromDurationFrames(durationInFrames, fps) });
      appLog("info", "timeline", "reel zones reset to formula");
    },

    setReelCut(index, sec) {
      const state = get();
      const durationSec = state.durationInFrames / Math.max(1, state.fps);
      set({
        reelZones: {
          cutsSec: moveCut(state.reelZones.cutsSec, index, sec, durationSec),
          dirty: true,
          warning: state.reelZones.warning,
        },
      });
    },

    toggleReelZonesVisible() {
      set((s) => ({ reelZonesVisible: !s.reelZonesVisible }));
    },

    syncDurationFromMediaSec(durationSec) {
      const state = get();
      const frames = Math.max(MIN_DURATION, Math.round(durationSec * state.fps));
      // Force formula from media length (new clip → clean zones).
      set({
        durationInFrames: frames,
        currentFrame: Math.min(state.currentFrame, frames),
        paramKeyframes: clampKeyframesToDuration(state.paramKeyframes, frames),
        reelZones: reelFromDurationFrames(frames, state.fps),
      });
    },

    setCueZoneTick(on) {
      set({ cueZoneTick: on });
    },
    setCueDevMetronome(on) {
      set({ cueDevMetronome: on });
    },
    setCueDrone(on) {
      set({ cueDrone: on });
    },
    setDevelopmentBpm(bpm) {
      set({ developmentBpm: Math.max(40, Math.min(240, Math.round(bpm))) });
    },
    setDroneZoneParams(zone, patch) {
      const state = get();
      const prev = state.droneByZone[zone];
      set({
        droneByZone: {
          ...state.droneByZone,
          [zone]: parseDroneByZone({ [zone]: { ...prev, ...patch } })[zone],
        },
      });
    },
  }));
}

export const useTimelineStore =
  typeof window !== "undefined" &&
  window.__visioTimelineStore &&
  "cueZoneTick" in window.__visioTimelineStore.getState()
    ? window.__visioTimelineStore
    : createTimelineStore();

if (typeof window !== "undefined") {
  window.__visioTimelineStore = useTimelineStore;
}
