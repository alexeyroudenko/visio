/**
 * Reel structure markers for short vertical videos (7–15 s).
 * Four contiguous zones: Hook → Development → Climax → CTA.
 */

export type ReelZoneId = "hook" | "development" | "climax" | "cta";

export interface ReelZoneMeta {
  id: ReelZoneId;
  label: string;
  /** CSS accent token / class suffix. */
  color: string;
  tip: string;
}

export const REEL_ZONE_META: readonly ReelZoneMeta[] = [
  {
    id: "hook",
    label: "Hook",
    color: "hook",
    tip: "Grab attention in the first seconds — strong visual or audio hit.",
  },
  {
    id: "development",
    label: "Development",
    color: "development",
    tip: "Build the story or process — keep momentum without peaking yet.",
  },
  {
    id: "climax",
    label: "Climax",
    color: "climax",
    tip: "Strongest music accent / drop and peak visual beat here.",
  },
  {
    id: "cta",
    label: "CTA",
    color: "cta",
    tip: "Call to action — logo, follow, link, or clear end beat.",
  },
] as const;

/** Absolute end times (sec) of Hook, Development, Climax for a known duration. CTA ends at duration. */
export type ReelCutsSec = readonly [number, number, number];

/** Anchor templates from the editorial table (exact seconds). */
export const REEL_ANCHORS: readonly { durationSec: number; cuts: ReelCutsSec }[] = [
  { durationSec: 7, cuts: [1.5, 4, 6] },
  { durationSec: 8, cuts: [1.8, 5, 7] },
  { durationSec: 10, cuts: [2, 6, 8.5] },
  { durationSec: 12, cuts: [2.5, 7, 10] },
  { durationSec: 15, cuts: [3, 9, 12] },
];

export const REEL_MIN_SEC = 7;
export const REEL_MAX_SEC = 15;

export type ReelDurationWarning = "short" | "long" | null;

export interface ReelMarkersResult {
  durationSec: number;
  /** Formula duration used for lookup / nearest (7 or 15 when out of range). */
  formulaSec: number;
  cutsSec: ReelCutsSec;
  warning: ReelDurationWarning;
}

export interface ReelZoneRange {
  id: ReelZoneId;
  label: string;
  color: string;
  tip: string;
  startSec: number;
  endSec: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpCuts(a: ReelCutsSec, b: ReelCutsSec, t: number): ReelCutsSec {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Scale cuts from a template duration onto an actual duration (keep fractions). */
export function scaleCuts(cuts: ReelCutsSec, fromSec: number, toSec: number): ReelCutsSec {
  if (fromSec <= 0) return cuts;
  const s = toSec / fromSec;
  return [cuts[0] * s, cuts[1] * s, cuts[2] * s];
}

/**
 * Compute Hook/Dev/Climax cut points for a video length.
 * - Exact anchors (7/8/10/12/15) use the table.
 * - Between anchors: interpolate cuts, then scale to the real duration.
 * - Outside 7–15: nearest anchor (7 or 15) scaled to real duration + warning.
 */
export function computeReelCuts(durationSec: number): ReelMarkersResult {
  const duration = Math.max(0.1, durationSec);
  let warning: ReelDurationWarning = null;
  let formulaSec = duration;
  let cuts: ReelCutsSec;

  if (duration < REEL_MIN_SEC) {
    warning = "short";
    formulaSec = REEL_MIN_SEC;
    const anchor = REEL_ANCHORS[0]!;
    cuts = scaleCuts(anchor.cuts, anchor.durationSec, duration);
  } else if (duration > REEL_MAX_SEC) {
    warning = "long";
    formulaSec = REEL_MAX_SEC;
    const anchor = REEL_ANCHORS[REEL_ANCHORS.length - 1]!;
    cuts = scaleCuts(anchor.cuts, anchor.durationSec, duration);
  } else {
    const exact = REEL_ANCHORS.find((a) => Math.abs(a.durationSec - duration) < 1e-6);
    if (exact) {
      formulaSec = exact.durationSec;
      cuts = exact.cuts;
    } else {
      let lo = REEL_ANCHORS[0]!;
      let hi = REEL_ANCHORS[REEL_ANCHORS.length - 1]!;
      for (let i = 0; i < REEL_ANCHORS.length - 1; i++) {
        const a = REEL_ANCHORS[i]!;
        const b = REEL_ANCHORS[i + 1]!;
        if (duration >= a.durationSec && duration <= b.durationSec) {
          lo = a;
          hi = b;
          break;
        }
      }
      const t = (duration - lo.durationSec) / (hi.durationSec - lo.durationSec);
      const blended = lerpCuts(lo.cuts, hi.cuts, t);
      // Blended cuts sit on a lerp of anchor lengths; scale onto actual duration.
      const blendedDur = lerp(lo.durationSec, hi.durationSec, t);
      cuts = scaleCuts(blended, blendedDur, duration);
      formulaSec = duration;
    }
  }

  return {
    durationSec: duration,
    formulaSec,
    cutsSec: normalizeCuts(cuts, duration),
    warning,
  };
}

/** Keep three cuts strictly increasing and inside (0, duration). */
export function normalizeCuts(cuts: ReelCutsSec, durationSec: number): ReelCutsSec {
  const dur = Math.max(0.1, durationSec);
  const minGap = Math.min(0.05, dur / 20);
  let a = Math.min(Math.max(cuts[0], minGap), dur - 3 * minGap);
  let b = Math.min(Math.max(cuts[1], a + minGap), dur - 2 * minGap);
  let c = Math.min(Math.max(cuts[2], b + minGap), dur - minGap);
  if (b <= a) b = a + minGap;
  if (c <= b) c = b + minGap;
  if (c >= dur) c = dur - minGap;
  if (b >= c) b = c - minGap;
  if (a >= b) a = b - minGap;
  return [a, b, c];
}

/** Move one interior boundary (0=after Hook, 1=after Dev, 2=after Climax). */
export function moveCut(
  cuts: ReelCutsSec,
  index: 0 | 1 | 2,
  nextSec: number,
  durationSec: number,
): ReelCutsSec {
  const next: [number, number, number] = [cuts[0], cuts[1], cuts[2]];
  next[index] = nextSec;
  return normalizeCuts(next, durationSec);
}

export function zonesFromCuts(cuts: ReelCutsSec, durationSec: number): ReelZoneRange[] {
  const ends = [cuts[0], cuts[1], cuts[2], durationSec];
  let start = 0;
  return REEL_ZONE_META.map((meta, i) => {
    const end = ends[i]!;
    const zone: ReelZoneRange = {
      id: meta.id,
      label: meta.label,
      color: meta.color,
      tip: meta.tip,
      startSec: start,
      endSec: end,
    };
    start = end;
    return zone;
  });
}

export function formatReelSeconds(sec: number): string {
  const clamped = Math.max(0, sec);
  const mins = Math.floor(clamped / 60);
  const rem = clamped - mins * 60;
  const tenths = Math.round(rem * 10) / 10;
  const whole = Math.floor(tenths + 1e-9);
  const frac = Math.round((tenths - whole) * 10);
  const secPart =
    frac === 0 ? String(whole).padStart(2, "0") : `${String(whole).padStart(2, "0")}.${frac}`;
  return `${mins}:${secPart}`;
}

export function reelWarningMessage(warning: ReelDurationWarning): string | null {
  if (warning === "short") {
    return `Video shorter than ${REEL_MIN_SEC}s — using the ${REEL_MIN_SEC}s reel formula scaled to length.`;
  }
  if (warning === "long") {
    return `Video longer than ${REEL_MAX_SEC}s — using the ${REEL_MAX_SEC}s reel formula scaled to length.`;
  }
  return null;
}
