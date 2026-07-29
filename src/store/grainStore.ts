/**
 * Live grain positions per source URL, for drawing on the timeline the way
 * granular-video draws them on its waveform.
 *
 * Deliberately not a zustand store: this changes on every engine tick and every
 * envelope ramp, and pushing that through React would re-render the timeline
 * sixty times a second. The overlay canvas reads it from its own rAF instead.
 */

export interface GrainMark {
  /** Voice id — stable while the rectangle behind it exists. */
  id: number;
  /** Where the loop reads from, as a fraction of the source. */
  pos: number;
  /** Envelope, 0..1: ramps up on attack, down through release. */
  level: number;
  /** Semitones off the source pitch — drives the hue, as in granular-video. */
  pitch: number;
}

interface Entry {
  marks: GrainMark[];
  at: number;
}

/** A node that stops evaluating (deleted, bypassed, muted) leaves its last
 *  marks behind; anything older than this is treated as gone. */
const STALE_MS = 400;

declare global {
  interface Window {
    __visioGrains?: Map<string, Entry>;
  }
}

const byUrl: Map<string, Entry> =
  (typeof window !== "undefined" ? window.__visioGrains : undefined) ?? new Map();

if (typeof window !== "undefined") window.__visioGrains = byUrl;

export function publishGrains(url: string, marks: GrainMark[]): void {
  byUrl.set(url, { marks, at: performance.now() });
}

/** Marks for a source, or an empty list once they go stale. */
export function grainsFor(url: string): GrainMark[] {
  const entry = byUrl.get(url);
  if (!entry) return [];
  if (performance.now() - entry.at > STALE_MS) return [];
  return entry.marks;
}
