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
import { appLog } from "./consoleStore";

const MIN_DURATION = DEFAULT_FPS;

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

  seek: (frame: number) => void;
  setDurationInFrames: (durationInFrames: number) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  toggleRecording: () => void;
  toggleLoop: () => void;

  /** Write / update a key at the current frame (used while recording). */
  recordParam: (nodeId: string, key: string, value: unknown) => void;
  removeParamKeyframe: (path: ParamPath, frame: number) => void;
  selectKeyframe: (frame: number | null) => void;
  moveSelectedKeyframe: (toFrame: number) => void;
  clearKeyframes: () => void;
}

declare global {
  interface Window {
    __visioTimelineStore?: ReturnType<typeof createTimelineStore>;
  }
}

function createTimelineStore() {
  return create<TimelineState>((set, get) => ({
    fps: DEFAULT_FPS,
    durationInFrames: DEFAULT_DURATION_FRAMES,
    currentFrame: 0,
    isPlaying: false,
    isRecording: false,
    isLooping: false,
    paramKeyframes: {},
    selectedKeyframeFrame: null,

    seek(frame) {
      const { durationInFrames } = get();
      set({ currentFrame: Math.max(0, Math.min(frame, durationInFrames)) });
    },

    setDurationInFrames(durationInFrames) {
      const state = get();
      const next = Math.max(MIN_DURATION, Math.round(durationInFrames));
      set({
        durationInFrames: next,
        currentFrame: Math.min(state.currentFrame, next),
        paramKeyframes: clampKeyframesToDuration(state.paramKeyframes, next),
        selectedKeyframeFrame:
          state.selectedKeyframeFrame !== null && state.selectedKeyframeFrame <= next
            ? state.selectedKeyframeFrame
            : null,
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
  }));
}

export const useTimelineStore =
  typeof window !== "undefined" && window.__visioTimelineStore
    ? window.__visioTimelineStore
    : createTimelineStore();

if (typeof window !== "undefined") {
  window.__visioTimelineStore = useTimelineStore;
}
