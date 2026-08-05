/**
 * Deterministic RMS from a decoded AudioBuffer at a playhead time.
 * Same window helper as band energy so modulators and analyzer stay aligned.
 */

import { windowAt } from "./audioBands";

const DEFAULT_WINDOW = 2048;

/**
 * Root-mean-square of a Hann-weighted mono window centred on `timeSec`,
 * scaled so a full-scale sine ≈ 1. Silent / empty / invalid → 0.
 */
export function rmsAt(
  buffer: AudioBuffer,
  timeSec: number,
  windowSize = DEFAULT_WINDOW,
): number {
  if (!Number.isFinite(timeSec) || buffer.length === 0 || buffer.sampleRate <= 0) return 0;
  const samples = windowAt(buffer, timeSec, windowSize);
  if (samples.length === 0) return 0;

  let sumSq = 0;
  let weight = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i]!;
    // windowAt already applies Hann; recover approximate weight for normalisation.
    const hann = 0.5 - 0.5 * Math.cos((Math.PI * 2 * i) / samples.length);
    sumSq += s * s;
    weight += hann * hann;
  }
  if (!(weight > 0)) return 0;
  // Full-scale sine through Hann → RMS ≈ √(0.5 * mean(hann²)) ≈ 0.5; map to ~1.
  const rms = Math.sqrt(sumSq / samples.length);
  return Math.min(1, rms * 2);
}
