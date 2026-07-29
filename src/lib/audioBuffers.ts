/**
 * Decoded AudioBuffers keyed by media URL.
 *
 * Nodes ask for a buffer inside `evaluate()`, which is synchronous, so the
 * lookup has to answer immediately — the fetch + decode runs once in the
 * background and the entry flips to "ready" when it lands. Decoding the same
 * file twice (waveform peaks, granular playback) never happens.
 */
import { appLog } from "../store/consoleStore";

export interface AudioBufferEntry {
  status: "loading" | "ready" | "error";
  buffer: AudioBuffer | null;
  message: string | null;
}

declare global {
  interface Window {
    /** Survives Vite HMR so a reload does not re-decode every open file. */
    __visioAudioBuffers?: Map<string, AudioBufferEntry>;
  }
}

const cache: Map<string, AudioBufferEntry> =
  (typeof window !== "undefined" ? window.__visioAudioBuffers : undefined) ?? new Map();

if (typeof window !== "undefined") window.__visioAudioBuffers = cache;

/**
 * Decoding needs a context, but not a running one — an OfflineAudioContext
 * sidesteps the autoplay policy, since nothing is ever played through it.
 */
let decodeCtx: OfflineAudioContext | null = null;
function decoder(): OfflineAudioContext {
  if (!decodeCtx) decodeCtx = new OfflineAudioContext(1, 1, 44100);
  return decodeCtx;
}

/** Start (or join) the decode of `url`. Safe to call every frame. */
export function ensureAudioBuffer(url: string, label?: string): AudioBufferEntry {
  const existing = cache.get(url);
  if (existing) return existing;

  const entry: AudioBufferEntry = { status: "loading", buffer: null, message: null };
  cache.set(url, entry);

  void (async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`fetch failed (${response.status})`);
      const bytes = await response.arrayBuffer();
      // decodeAudioData detaches the ArrayBuffer, so hand it its own copy —
      // the same bytes may be wanted again if this entry is later forgotten.
      const buffer = await decoder().decodeAudioData(bytes.slice(0));
      entry.status = "ready";
      entry.buffer = buffer;
    } catch (error) {
      // A silent video, or a codec the decoder will not take. Not fatal —
      // the consumer just has nothing to play.
      entry.status = "error";
      entry.message = error instanceof Error ? error.message : String(error);
      appLog("info", "audio", `no decodable audio in ${label ?? url.slice(0, 40)}`);
    }
  })();

  return entry;
}

export function forgetAudioBuffer(url: string): void {
  cache.delete(url);
}
