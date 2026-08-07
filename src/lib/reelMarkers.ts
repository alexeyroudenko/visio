/**
 * Reel structure markers for short vertical videos (7–15 s).
 * Five contiguous zones: Hook → FormWait → Development → Climax → CTA.
 */

export type ReelZoneId = "hook" | "formwait" | "development" | "climax" | "cta";

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
    id: "formwait",
    label: "FormWait",
    color: "formwait",
    tip: "Beat of suspense right after the hook — hold the frame, let the form register.",
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

/**
 * Absolute end times (sec) of Hook, FormWait, Development, Climax for a known
 * duration. CTA ends at duration.
 */
export type ReelCutsSec = readonly [number, number, number, number];

/** Legacy 3-cut layout (Hook/Dev/Climax) from patches saved before FormWait. */
export type LegacyReelCutsSec = readonly [number, number, number];

/** Hook always owns the first second — an absolute beat, never scaled by length. */
export const HOOK_END_SEC = 1;
/** FormWait is the short hold right after it, also absolute. */
export const FORMWAIT_END_SEC = 1.2;

/** Anchor templates from the editorial table (exact seconds). */
export const REEL_ANCHORS: readonly { durationSec: number; cuts: ReelCutsSec }[] = [
  { durationSec: 7, cuts: [HOOK_END_SEC, FORMWAIT_END_SEC, 4, 6] },
  { durationSec: 8, cuts: [HOOK_END_SEC, FORMWAIT_END_SEC, 5, 7] },
  { durationSec: 10, cuts: [HOOK_END_SEC, FORMWAIT_END_SEC, 6, 8.5] },
  { durationSec: 12, cuts: [HOOK_END_SEC, FORMWAIT_END_SEC, 7, 10] },
  { durationSec: 15, cuts: [HOOK_END_SEC, FORMWAIT_END_SEC, 9, 12] },
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
  return [
    lerp(a[0], b[0], t),
    lerp(a[1], b[1], t),
    lerp(a[2], b[2], t),
    lerp(a[3], b[3], t),
  ];
}

/** Scale cuts from a template duration onto an actual duration (keep fractions). */
export function scaleCuts(cuts: ReelCutsSec, fromSec: number, toSec: number): ReelCutsSec {
  if (fromSec <= 0) return cuts;
  const s = toSec / fromSec;
  return [cuts[0] * s, cuts[1] * s, cuts[2] * s, cuts[3] * s];
}

/**
 * Accept cuts from a patch: 4 numbers as-is, or a legacy 3-cut array upgraded by
 * inserting the fixed Hook / FormWait pair in front of the old Dev / Climax cuts.
 */
export function cutsFromUnknown(raw: unknown): ReelCutsSec | null {
  if (!Array.isArray(raw)) return null;
  const nums = raw.filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  if (nums.length !== raw.length) return null;
  if (nums.length === 4) return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
  if (nums.length === 3) return [HOOK_END_SEC, FORMWAIT_END_SEC, nums[1]!, nums[2]!];
  return null;
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

  // Hook / FormWait are absolute beats: the first second reads the same in a 7s
  // reel and a 15s one, so they are pinned rather than scaled with the length.
  const pinned: ReelCutsSec = [HOOK_END_SEC, FORMWAIT_END_SEC, cuts[2], cuts[3]];

  return {
    durationSec: duration,
    formulaSec,
    cutsSec: normalizeCuts(pinned, duration),
    warning,
  };
}

/** Keep the four cuts strictly increasing and inside (0, duration). */
export function normalizeCuts(cuts: ReelCutsSec, durationSec: number): ReelCutsSec {
  const dur = Math.max(0.1, durationSec);
  const minGap = Math.min(0.05, dur / 20);
  const out: number[] = [cuts[0], cuts[1], cuts[2], cuts[3]];

  const pushUp = () => {
    for (let i = 0; i < out.length; i++) {
      const floor = i === 0 ? minGap : out[i - 1]! + minGap;
      const value = out[i]!;
      out[i] = Number.isFinite(value) ? Math.max(value, floor) : floor;
    }
  };
  const pullDown = () => {
    for (let i = out.length - 1; i >= 0; i--) {
      const ceil = i === out.length - 1 ? dur - minGap : out[i + 1]! - minGap;
      out[i] = Math.min(out[i]!, ceil);
    }
  };

  pushUp();
  pullDown();
  // pullDown can drag the head below zero on tiny durations; minGap ≤ dur/20
  // leaves room for all cuts, so one more pass settles it.
  pushUp();
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

export type ReelCutIndex = 0 | 1 | 2 | 3;

/** Move one interior boundary (0=after Hook, 1=after FormWait, 2=after Dev, 3=after Climax). */
export function moveCut(
  cuts: ReelCutsSec,
  index: ReelCutIndex,
  nextSec: number,
  durationSec: number,
): ReelCutsSec {
  const next: [number, number, number, number] = [cuts[0], cuts[1], cuts[2], cuts[3]];
  next[index] = nextSec;
  return normalizeCuts(next, durationSec);
}

export function zonesFromCuts(cuts: ReelCutsSec, durationSec: number): ReelZoneRange[] {
  const ends = [cuts[0], cuts[1], cuts[2], cuts[3], durationSec];
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

/** Which reel zone contains `sec` (clamped to the composition). */
export function zoneAtSec(cuts: ReelCutsSec, durationSec: number, sec: number): ReelZoneId {
  const t = Math.max(0, Math.min(sec, Math.max(0, durationSec)));
  if (t < cuts[0]) return "hook";
  if (t < cuts[1]) return "formwait";
  if (t < cuts[2]) return "development";
  if (t < cuts[3]) return "climax";
  return "cta";
}
