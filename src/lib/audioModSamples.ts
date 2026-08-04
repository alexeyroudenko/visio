import type { ParamPath } from "./keyframes";
import { bandDrive } from "./audioBands";
import { ensureAudioBuffer } from "./audioBuffers";
import type { Modulators } from "./modulators";
import { fileParam } from "../nodes/shared/fileParam";

interface MediaNodeRef {
  id: string;
  params: Record<string, unknown>;
}

/**
 * Pick a Media source that can feed audio modulators: prefer an `audio` mode
 * node with a file, else any video/audio file whose decode is ready or loading.
 */
export function pickAudioMedia(nodes: MediaNodeRef[]): MediaNodeRef | null {
  const media = nodes.filter((n) => {
    const mode = n.params.mode;
    if (mode !== "audio" && mode !== "video") return false;
    return fileParam(n.params) !== null;
  });
  if (media.length === 0) return null;
  const audioFirst = media.find((n) => n.params.mode === "audio");
  return audioFirst ?? media[0]!;
}

/**
 * Playhead in the media file for band lookup. Timeline time (modulator apply
 * clock) maps through Media speed when Sync is on; otherwise the same clock is
 * used so scrubbing the timeline still moves the band.
 */
export function mediaPlayheadSec(
  params: Record<string, unknown>,
  timelineSec: number,
  durationSec: number,
): number {
  const speed =
    typeof params.speed === "number" && Number.isFinite(params.speed)
      ? Math.max(0.001, params.speed)
      : 1;
  let t = timelineSec * speed;
  if (durationSec > 0) {
    t = ((t % durationSec) + durationSec) % durationSec;
  }
  return Math.max(0, t);
}

/**
 * −1..1 samples for every `source: "audio"` modulator path. Missing Media /
 * buffer still decoding → undefined (drive falls to 0 in modulatedValue).
 * Kicks `ensureAudioBuffer` so the next push picks the decode up.
 */
export function audioModulatorSamples(
  modulators: Modulators,
  nodes: MediaNodeRef[],
  timelineSec: number,
): Map<ParamPath, number> {
  const out = new Map<ParamPath, number>();
  const audioPaths = Object.entries(modulators).filter(([, m]) => m.source === "audio");
  if (audioPaths.length === 0) return out;

  const media = pickAudioMedia(nodes);
  if (!media) return out;
  const file = fileParam(media.params);
  if (!file) return out;

  const entry = ensureAudioBuffer(file.url, file.name);
  const buffer = entry.buffer;
  if (!buffer) return out;

  const timeSec = mediaPlayheadSec(media.params, timelineSec, buffer.duration);

  for (const [path, modulator] of audioPaths) {
    const lo = modulator.bandLoHz ?? 20;
    const hi = modulator.bandHiHz ?? 200;
    out.set(path, bandDrive(buffer, timeSec, lo, hi));
  }
  return out;
}
