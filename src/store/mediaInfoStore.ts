import { create } from "zustand";

/** Live probe of a Media node's source — shown under Fit in the Inspector. */
export interface MediaInfo {
  kind: "camera" | "image" | "video" | "audio";
  width: number;
  height: number;
  name?: string | null;
  /** Container / MIME when known (file.type or track). */
  mime?: string | null;
  /** Best-effort codec hint from MIME subtype or track label. */
  codec?: string | null;
  fps?: number | null;
  durationSec?: number | null;
  currentTimeSec?: number | null;
  /** Floor(currentTime * fps) when fps is known. */
  currentFrame?: number | null;
  /** Floor(duration * fps) when both known. */
  totalFrames?: number | null;
  playing?: boolean;
}

interface MediaInfoState {
  byId: Record<string, MediaInfo>;
  setInfo: (nodeId: string, info: MediaInfo | null) => void;
}

function infoFingerprint(info: MediaInfo | null): string {
  if (!info) return "";
  return [
    info.kind,
    info.width,
    info.height,
    info.name ?? "",
    info.mime ?? "",
    info.codec ?? "",
    info.fps ?? "",
    info.durationSec != null ? info.durationSec.toFixed(2) : "",
    info.currentTimeSec != null ? info.currentTimeSec.toFixed(2) : "",
    info.currentFrame ?? "",
    info.totalFrames ?? "",
    info.playing === true ? "1" : "0",
  ].join("|");
}

declare global {
  interface Window {
    __visioMediaInfoStore?: ReturnType<typeof createMediaInfoStore>;
  }
}

function createMediaInfoStore() {
  const fingerprints = new Map<string, string>();
  return create<MediaInfoState>((set, get) => ({
    byId: {},
    setInfo(nodeId, info) {
      const nextFp = infoFingerprint(info);
      if (fingerprints.get(nodeId) === nextFp) return;
      fingerprints.set(nodeId, nextFp);
      if (!info) {
        if (!(nodeId in get().byId)) return;
        const { [nodeId]: _removed, ...rest } = get().byId;
        set({ byId: rest });
        return;
      }
      set({ byId: { ...get().byId, [nodeId]: info } });
    },
  }));
}

export const useMediaInfoStore =
  typeof window !== "undefined" && window.__visioMediaInfoStore
    ? window.__visioMediaInfoStore
    : createMediaInfoStore();

if (typeof window !== "undefined") {
  window.__visioMediaInfoStore = useMediaInfoStore;
}

export function publishMediaInfo(nodeId: string, info: MediaInfo | null): void {
  useMediaInfoStore.getState().setInfo(nodeId, info);
}
