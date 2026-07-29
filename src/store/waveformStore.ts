import { create } from "zustand";
import { computePeaks, PEAK_COLUMNS } from "../lib/peaks";
import { appLog } from "./consoleStore";

export interface WaveformEntry {
  status: "loading" | "ready" | "error";
  peaks: Float32Array | null;
  durationSec: number;
  /** Loudest absolute peak, so drawing can scale a quiet file to fit the lane. */
  peak: number;
  message?: string;
}

interface WaveformState {
  byUrl: Record<string, WaveformEntry>;
  /** Decode once per URL; repeat calls for the same one are ignored. */
  ensure: (url: string, label?: string) => void;
  forget: (url: string) => void;
}

declare global {
  interface Window {
    __visioWaveformStore?: ReturnType<typeof createWaveformStore>;
  }
}

/**
 * Decoding needs a context, but not a running one — an OfflineAudioContext
 * sidesteps the autoplay policy entirely, since nothing is ever played here.
 */
let decodeCtx: OfflineAudioContext | null = null;
function decoder(): OfflineAudioContext {
  if (!decodeCtx) decodeCtx = new OfflineAudioContext(1, 1, 44100);
  return decodeCtx;
}

function createWaveformStore() {
  return create<WaveformState>((set, get) => ({
    byUrl: {},

    ensure(url, label) {
      if (!url || get().byUrl[url]) return;
      set({
        byUrl: { ...get().byUrl, [url]: { status: "loading", peaks: null, durationSec: 0, peak: 0 } },
      });

      void (async () => {
        try {
          const response = await fetch(url);
          const bytes = await response.arrayBuffer();
          const buffer = await decoder().decodeAudioData(bytes);
          const peaks = computePeaks(buffer, PEAK_COLUMNS);
          let peak = 0;
          for (let i = 0; i < peaks.length; i += 1) {
            const value = Math.abs(peaks[i]!);
            if (value > peak) peak = value;
          }
          set({
            byUrl: {
              ...get().byUrl,
              [url]: { status: "ready", peaks, durationSec: buffer.duration, peak },
            },
          });
        } catch (error) {
          // A silent video, or a codec the decoder will not take. Not fatal:
          // the clip simply stays a plain block.
          const message = error instanceof Error ? error.message : String(error);
          set({
            byUrl: {
              ...get().byUrl,
              [url]: { status: "error", peaks: null, durationSec: 0, peak: 0, message },
            },
          });
          appLog("info", "waveform", `no audio track in ${label ?? url.slice(0, 40)}`);
        }
      })();
    },

    forget(url) {
      const { [url]: removed, ...rest } = get().byUrl;
      if (removed) set({ byUrl: rest });
    },
  }));
}

export const useWaveformStore =
  typeof window !== "undefined" && window.__visioWaveformStore
    ? window.__visioWaveformStore
    : createWaveformStore();

if (typeof window !== "undefined") {
  window.__visioWaveformStore = useWaveformStore;
}
